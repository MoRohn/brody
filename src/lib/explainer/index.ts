/**
 * The explainer service: one typed interface used by the HTTP API, the agent tool (tool.ts), the MCP server
 * (scripts/explainer-mcp.mts) and the UI, so every caller gets the same behaviour and the same contracts.
 *
 *   createExplanation  grounded Brody result → Explanation IR (+ mode recommendation)
 *   requestVideo       IR → durable video job
 *   refineExplanation  "make this shorter" → structured edit → job that reuses everything unchanged
 *   regenerateSection  re-plan and re-render one section
 *   editNarration      the user's own words for a section
 */
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import type { ExplanationRow, VideoJobRow } from "../db/schema";
import { AppError } from "../util/errors";
import { compileExplanation, sourceRunId, type ExplanationSource } from "./compile";
import { effectiveRouting } from "./config";
import { clearText, mermaidDiagram } from "./formats";
import { cancelVideoJob, DEFAULT_PARAMS, enqueueVideoJob, requireVideoJob, retryVideoJob } from "./pipeline";
import { resolveRefinement, type RefinePlan } from "./refine";
import { routeModes } from "./router";
import { findExplanation, insertExplanation, jobsFor, latestReadyJob, requireExplanation, runDir, specOf, updateSpec } from "./store";
import { getTtsProvider } from "./tts";
import type { AudienceLevel, DurationMode, ExplanationArtifactSpec, ModeRecommendation, NarrationPlan, VideoJobParams } from "./types";

export type { ExplanationSource } from "./compile";

export interface JobView {
  id: string;
  explanationId: string;
  kind: string;
  status: string;
  params: VideoJobParams;
  stages: VideoJobRow["stages"];
  currentStage: string | null;
  progress: { stage: string; fraction: number; message: string } | null;
  artifacts: Record<string, unknown>;
  urls: Record<string, string | string[]>;
  error: string | null;
  validation: unknown;
  summary: unknown;
  attempts: number;
  parentJobId: string | null;
  log: string[];
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface ExplanationView {
  id: string;
  projectId: string;
  sourceRunId: string;
  source: ExplanationSource;
  title: string;
  audience: AudienceLevel;
  version: number;
  spec: ExplanationArtifactSpec;
  router: ModeRecommendation;
  compile: Record<string, unknown> | null;
  clear: ReturnType<typeof clearText>;
  diagram: string | null;
  jobs: JobView[];
  /** The most recent job, whatever its state. */
  latest: JobView | null;
  /** The most recent job with a finished video. */
  ready: JobView | null;
  createdAt: number;
  updatedAt: number;
}

export const fileUrl = (explanationId: string, rel: string) => `/api/explanations/${explanationId}/files/${rel.split("/").map(encodeURIComponent).join("/")}`;

export function jobView(j: VideoJobRow): JobView {
  const urls: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(j.artifacts ?? {})) {
    if (typeof v === "string" && /\.[a-z0-9]+$/i.test(v)) urls[k] = fileUrl(j.explanationId, v);
    else if (Array.isArray(v)) urls[k] = v.filter((x): x is string => typeof x === "string").map((x) => fileUrl(j.explanationId, x));
  }
  return {
    id: j.id, explanationId: j.explanationId, kind: j.kind, status: j.status, params: j.params as unknown as VideoJobParams, stages: j.stages, currentStage: j.currentStage,
    progress: (j.progress as JobView["progress"]) ?? null, artifacts: j.artifacts ?? {}, urls, error: j.error, validation: j.validation ?? null, summary: j.summary ?? null,
    attempts: j.attempts, parentJobId: j.parentJobId, log: (j.log ?? []).slice(-60), createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt,
  };
}

export function explanationView(row: ExplanationRow): ExplanationView {
  const spec = specOf(row);
  const jobs = jobsFor(row.id);
  const ready = latestReadyJob(row.id);
  return {
    id: row.id, projectId: row.projectId, sourceRunId: row.sourceRunId, source: row.source as unknown as ExplanationSource, title: row.title, audience: row.audience as AudienceLevel, version: row.version,
    spec, router: (row.router as unknown as ModeRecommendation) ?? routeModes(spec), compile: row.compile ?? null,
    clear: clearText(spec), diagram: mermaidDiagram(spec),
    jobs: jobs.slice(0, 10).map(jobView), latest: jobs[0] ? jobView(jobs[0]) : null, ready: ready ? jobView(ready) : null,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

export interface CreateInput { projectId: string; source: ExplanationSource; audience?: AudienceLevel; intent?: string; reuse?: boolean; useAI?: boolean }

/** Compile (or reuse) the explanation of one Brody result. Reuse is the default: the same result explains the same way. */
export async function createExplanation(input: CreateInput): Promise<{ explanation: ExplanationView; created: boolean }> {
  const project = getDb().select({ id: schema.projects.id, status: schema.projects.status }).from(schema.projects).where(eq(schema.projects.id, input.projectId)).get();
  if (!project) throw new AppError("project_not_found", "That project does not exist.", 404);
  if (project.status !== "ready") throw new AppError("analysis_not_ready", "The project has not finished analysis yet.", 409);
  const rid = sourceRunId(input.source);
  if (input.reuse !== false) {
    const existing = findExplanation(input.projectId, rid);
    if (existing && (!input.audience || existing.audience === input.audience)) return { explanation: explanationView(existing), created: false };
  }
  const out = await compileExplanation(input.projectId, input.source, { audience: input.audience, useAI: input.useAI });
  const router = routeModes(out.spec, { intent: input.intent, localRender: effectiveRouting().execution !== "cloud" });
  const row = insertExplanation(input.projectId, input.source, rid, out.spec, router, { ai: out.ai.used, model: out.ai.model ?? null, dropped: out.ai.dropped, error: out.ai.error ?? null, usage: out.ai.usage ?? null, statements: out.result.statements.length });
  return { explanation: explanationView(row), created: true };
}

export function getExplanationView(id: string): ExplanationView {
  return explanationView(requireExplanation(id));
}

export interface VideoRequest { duration?: DurationMode; audience?: AudienceLevel; style?: VideoJobParams["style"]; renderer?: VideoJobParams["renderer"]; execution?: VideoJobParams["execution"]; ttsProvider?: string; voice?: string; allowExternal?: boolean; motion?: VideoJobParams["motion"]; forceScenes?: string[] }

export function requestVideo(explanationId: string, req: VideoRequest = {}): JobView {
  const ex = requireExplanation(explanationId);
  const router = ex.router as unknown as ModeRecommendation | null;
  return jobView(enqueueVideoJob(explanationId, { duration: req.duration ?? router?.suggestedDuration ?? DEFAULT_PARAMS.duration, ...req }));
}

function planOf(job: VideoJobRow): NarrationPlan {
  const file = path.join(runDir(job.explanationId, job.id), "plan.json");
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as NarrationPlan; } catch { throw new AppError("no_plan", "That job has no narration plan yet.", 409, "Wait until the narration is written, or regenerate the whole video."); }
}

/** The job a refinement builds on: the latest finished one, else the latest one with a plan. */
function baseJob(explanationId: string): VideoJobRow {
  const ready = latestReadyJob(explanationId);
  if (ready) return ready;
  const withPlan = jobsFor(explanationId).find((j) => (j.artifacts as Record<string, unknown>)?.plan);
  if (!withPlan) throw new AppError("no_video", "Make a video first, then refine it.", 409);
  return withPlan;
}

async function nextVoice(job: VideoJobRow): Promise<string | undefined> {
  const manifest = job.manifest as { ttsProvider?: string; voice?: string } | null;
  const provider = manifest?.ttsProvider ? getTtsProvider(manifest.ttsProvider) : undefined;
  const voices = (await provider?.voices?.().catch(() => [])) ?? [];
  if (!voices.length) return undefined;
  const i = voices.findIndex((v) => v.id === manifest?.voice);
  // Prefer a different voice of the same family, then any other.
  return voices[(i + 1) % voices.length].id;
}

export async function refineExplanation(explanationId: string, request: string): Promise<{ refine: RefinePlan; job: JobView }> {
  const ex = requireExplanation(explanationId);
  const base = baseJob(explanationId);
  const params = base.params as unknown as VideoJobParams;
  const plan = planOf(base);
  const r = await resolveRefinement(request, plan, specOf(ex), params);
  const next: Partial<VideoJobParams> = { ...params, sections: undefined, instruction: undefined, edits: undefined, forceScenes: undefined, lengthFactor: undefined, ...r.params };
  if (next.voice === "__next__") next.voice = await nextVoice(base);
  // Edits accumulate: a hold or a dropped intro survives later refinements.
  const prevEdits = params.edits ?? {};
  const edits = r.params.edits ?? {};
  next.edits = { ...prevEdits, ...edits, drop: [...new Set([...(prevEdits.drop ?? []), ...(edits.drop ?? [])])], holdMs: { ...(prevEdits.holdMs ?? {}), ...(edits.holdMs ?? {}) }, layouts: { ...(prevEdits.layouts ?? {}), ...(edits.layouts ?? {}) }, addClaims: { ...(prevEdits.addClaims ?? {}), ...(edits.addClaims ?? {}) }, narration: { ...(prevEdits.narration ?? {}), ...(edits.narration ?? {}) } };
  if (r.sections.length) next.sections = r.sections;
  const job = enqueueVideoJob(explanationId, next, { kind: r.replanAll ? "video" : "section", parentJobId: r.replanAll ? undefined : base.id });
  getDb().update(schema.videoJobs).set({ log: [`${new Date().toISOString().slice(11, 19)} Refinement: "${request.slice(0, 200)}"`, ...r.understood.map((u) => `  → ${u}`)] }).where(eq(schema.videoJobs.id, job.id)).run();
  return { refine: r, job: jobView(requireVideoJob(job.id)) };
}

export function regenerateSection(jobId: string, req: { sectionId?: string; sections?: string[]; instruction?: string }): JobView {
  const base = requireVideoJob(jobId);
  const plan = planOf(base);
  const ids = [...new Set([...(req.sections ?? []), ...(req.sectionId ? [req.sectionId] : [])])];
  const unknown = ids.filter((id) => !plan.sections.some((s) => s.id === id));
  if (!ids.length || unknown.length) throw new AppError("invalid_section", unknown.length ? `Unknown section ${unknown.join(", ")}.` : "Name the section to regenerate.", 400, `Sections: ${plan.sections.map((s) => s.id).join(", ")}.`);
  const params = base.params as unknown as VideoJobParams;
  return jobView(enqueueVideoJob(base.explanationId, { ...params, sections: ids, instruction: req.instruction?.slice(0, 600), forceScenes: req.instruction ? undefined : ids.map((id) => `scene-${id}`) }, { kind: "section", parentJobId: base.id }));
}

export function editNarration(explanationId: string, narration: Record<string, string>): JobView {
  const base = baseJob(explanationId);
  const plan = planOf(base);
  const ids = Object.keys(narration);
  const unknown = ids.filter((id) => !plan.sections.some((s) => s.id === id));
  if (unknown.length) throw new AppError("invalid_section", `Unknown section ${unknown.join(", ")}.`, 400);
  for (const [id, text] of Object.entries(narration)) if (!text.trim() || text.length > 4000) throw new AppError("invalid_narration", `The narration for ${id} must be 1 to 4000 characters.`, 400);
  const params = base.params as unknown as VideoJobParams;
  const edits = { ...(params.edits ?? {}), narration: { ...(params.edits?.narration ?? {}), ...narration } };
  return jobView(enqueueVideoJob(explanationId, { ...params, sections: undefined, instruction: undefined, forceScenes: undefined, edits }, { kind: "narration", parentJobId: base.id }));
}

export function cancelJob(id: string): JobView { return jobView(cancelVideoJob(id)); }
export function retryJob(id: string): JobView { return jobView(retryVideoJob(id)); }
export function getJobView(id: string): JobView { return jobView(requireVideoJob(id)); }

/** Change the explanation's audience: the spec is the same facts for a different viewer. */
export function setAudience(explanationId: string, audience: AudienceLevel): ExplanationView {
  const ex = requireExplanation(explanationId);
  const spec = { ...specOf(ex), audience: { ...specOf(ex).audience, level: audience } };
  return explanationView(updateSpec(explanationId, spec));
}
