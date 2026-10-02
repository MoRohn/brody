/**
 * Explanation storage: rows in SQLite, files under EXPLAINER_DIR/<explanationId>/.
 *
 *   <dir>/<explanationId>/
 *     stages/tts/<key>/        section audio and word timings, keyed by the spoken text, voice and provider
 *     stages/render/<key>/     conformed scene videos, keyed by the scene's full hash (objects, actions and timing)
 *     runs/<jobId>/            one job's outputs: plan, narration, captions, transcript, scene plan, storyboard,
 *                              video, thumbnail and manifest
 *
 * Stage outputs are content addressed, so a retried, resumed or partially regenerated job reuses every stage whose
 * inputs did not change, and can never reuse one whose inputs did.
 */
import fs from "node:fs";
import path from "node:path";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import type { ExplanationRow, VideoJobRow } from "../db/schema";
import { AppError } from "../util/errors";
import { newId, sha256 } from "../util/ids";
import { explainerConfig } from "./config";
import type { ExplanationSource } from "./compile";
import type { ExplanationArtifactSpec, ModeRecommendation } from "./types";

const ID = /^[A-Za-z0-9_-]{4,64}$/;

export function explanationDir(explanationId: string): string {
  if (!ID.test(explanationId)) throw new AppError("invalid_id", "Invalid explanation id.", 400);
  return path.join(explainerConfig().dir, explanationId);
}
export const runDir = (explanationId: string, jobId: string) => { if (!ID.test(jobId)) throw new AppError("invalid_id", "Invalid job id.", 400); return path.join(explanationDir(explanationId), "runs", jobId); };
export const stageDir = (explanationId: string, stage: "tts" | "render", key: string) => path.join(explanationDir(explanationId), "stages", stage, key.replace(/[^a-f0-9]/gi, "").slice(0, 40));

/**
 * Resolve a file requested over HTTP inside an explanation's directory. Only plain relative paths that stay inside the
 * directory and name an existing regular file are accepted.
 */
export function resolveArtifact(explanationId: string, rel: string): string {
  const base = explanationDir(explanationId);
  if (!rel || rel.includes("\0") || path.isAbsolute(rel) || rel.split(/[\\/]/).some((p) => p === ".." || p.startsWith("."))) throw new AppError("not_found", "No such file.", 404);
  const full = path.resolve(base, rel);
  if (!full.startsWith(base + path.sep)) throw new AppError("not_found", "No such file.", 404);
  let st: fs.Stats;
  try { st = fs.lstatSync(full); } catch { throw new AppError("not_found", "No such file.", 404); }
  if (!st.isFile()) throw new AppError("not_found", "No such file.", 404);
  return full;
}

export const specHash = (spec: ExplanationArtifactSpec) => sha256(JSON.stringify({ ...spec, provenance: [] })).slice(0, 20);

export function insertExplanation(projectId: string, source: ExplanationSource, sourceRunId: string, spec: ExplanationArtifactSpec, router: ModeRecommendation, compile: Record<string, unknown>): ExplanationRow {
  const id = newId("ex");
  spec.id = id;
  const now = Date.now();
  const row: typeof schema.explanations.$inferInsert = { id, projectId, sourceRunId, source: source as unknown as Record<string, unknown>, title: spec.title, audience: spec.audience.level, spec: spec as unknown as Record<string, unknown>, specHash: specHash(spec), router: router as unknown as Record<string, unknown>, compile, version: 1, createdAt: now, updatedAt: now };
  getDb().insert(schema.explanations).values(row).run();
  return getExplanation(id)!;
}

export function getExplanation(id: string): ExplanationRow | undefined {
  return getDb().select().from(schema.explanations).where(eq(schema.explanations.id, id)).get();
}

export function requireExplanation(id: string): ExplanationRow {
  const e = ID.test(id) ? getExplanation(id) : undefined;
  if (!e) throw new AppError("not_found", "That explanation does not exist.", 404);
  return e;
}

export function specOf(row: ExplanationRow): ExplanationArtifactSpec {
  return row.spec as unknown as ExplanationArtifactSpec;
}

/** Replace the spec (a refinement edit). Bumps the version; old jobs keep the spec hash they were made from. */
export function updateSpec(id: string, spec: ExplanationArtifactSpec, router?: ModeRecommendation): ExplanationRow {
  const cur = requireExplanation(id);
  getDb().update(schema.explanations).set({ spec: spec as unknown as Record<string, unknown>, specHash: specHash(spec), title: spec.title, audience: spec.audience.level, ...(router ? { router: router as unknown as Record<string, unknown> } : {}), version: cur.version + 1, updatedAt: Date.now() }).where(eq(schema.explanations.id, id)).run();
  return getExplanation(id)!;
}

export function listExplanations(projectId: string): ExplanationRow[] {
  return getDb().select().from(schema.explanations).where(eq(schema.explanations.projectId, projectId)).orderBy(desc(schema.explanations.updatedAt)).all();
}

export function findExplanation(projectId: string, sourceRunId: string): ExplanationRow | undefined {
  return getDb().select().from(schema.explanations).where(and(eq(schema.explanations.projectId, projectId), eq(schema.explanations.sourceRunId, sourceRunId))).orderBy(desc(schema.explanations.updatedAt)).limit(1).get();
}

export function jobsFor(explanationId: string): VideoJobRow[] {
  return getDb().select().from(schema.videoJobs).where(eq(schema.videoJobs.explanationId, explanationId)).orderBy(desc(schema.videoJobs.createdAt)).all();
}

export function latestReadyJob(explanationId: string): VideoJobRow | undefined {
  return getDb().select().from(schema.videoJobs).where(and(eq(schema.videoJobs.explanationId, explanationId), eq(schema.videoJobs.status, "ready"))).orderBy(desc(schema.videoJobs.finishedAt)).limit(1).get();
}

/** Remove every explanation of a project, its jobs and its files (called when the project is deleted). */
export function deleteProjectExplanations(projectId: string): void {
  const db = getDb();
  const ids = db.select({ id: schema.explanations.id }).from(schema.explanations).where(eq(schema.explanations.projectId, projectId)).all().map((r) => r.id);
  db.transaction((tx) => {
    tx.delete(schema.videoJobs).where(eq(schema.videoJobs.projectId, projectId)).run();
    if (ids.length) tx.delete(schema.explanations).where(inArray(schema.explanations.id, ids)).run();
  });
  for (const id of ids) fs.rmSync(path.join(explainerConfig().dir, id), { recursive: true, force: true });
}

/** Total bytes under a directory (artifact size metrics). */
export function dirBytes(dir: string): number {
  let n = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? dirBytes(p) : fs.statSync(p).size;
  }
  return n;
}
