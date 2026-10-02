/**
 * The explainer as an agent tool. The same definitions and dispatcher back the HTTP tool endpoint
 * (POST /api/explainer/tool), the MCP server (scripts/explainer-mcp.mts) and the Brody agent skill
 * (skills/brody-explainer/SKILL.md), so the contract is identical everywhere.
 *
 * The tool operates on TRUSTED Brody state: the caller names a result by its sourceRunId ("question:q_…",
 * "file:src/x.ts", "finding:SEC-004", "system"); it never passes the answer text, so a model cannot restate, embellish or
 * inject the material being explained.
 */
import { z } from "zod";
import { AppError } from "../util/errors";
import { createExplanation, getExplanationView, getJobView, refineExplanation, regenerateSection, requestVideo, type ExplanationView, type JobView } from "./index";
import type { ExplanationSource } from "./compile";
import { audienceSchema, durationSchema } from "./schemas";

export function parseSourceRunId(id: string): ExplanationSource {
  const [kind, ...rest] = id.split(":");
  const v = rest.join(":");
  switch (kind) {
    case "question": return { kind, id: v };
    case "file": return { kind, path: v };
    case "area": return { kind, id: v };
    case "module": return { kind, path: v };
    case "finding": return { kind, code: v };
    case "system": return { kind: "system" };
    default: throw new AppError("invalid_source", `Unknown result "${id}". Use question:<id>, file:<path>, area:<id>, module:<path>, finding:<code> or system.`, 400);
  }
}

export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown> }

export const TOOLS: ToolDefinition[] = [
  {
    name: "create_explainer",
    description: "Convert a grounded Brody result into an educational explanation: clear text, a diagram, an interactive explainer, or a narrated, animated video synchronised to measured speech. Works on Brody's stored result, so pass its id, not its text. Video runs as a background job; poll get_video_job.",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "The Brody project id." },
        sourceRunId: { type: "string", description: "The result to explain: question:<id> (an Ask answer), file:<path>, area:<id>, module:<path>, finding:<code>, or system." },
        mode: { type: "string", enum: ["text", "diagram", "interactive", "video", "auto"], description: "auto follows Brody's mode recommendation." },
        duration: { type: "string", enum: ["quick", "standard", "deep"], description: "quick 30-60 s, standard 1-3 min, deep 3-10 min." },
        audience: { type: "string", enum: ["beginner", "intermediate", "expert"] },
        style: { type: "string", enum: ["brody", "brody-light", "calm"] },
      },
      required: ["projectId", "sourceRunId"],
    },
  },
  {
    name: "get_video_job",
    description: "Status of an explainer video job: stage, progress, artifacts available so far (plan, transcript, audio, storyboard, video), validation results.",
    parameters: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] },
  },
  {
    name: "refine_explainer",
    description: "Apply a plain-language change to an explainer video (\"make this shorter\", \"explain it for a beginner\", \"redo just the final section and show how X fixes this\"). Only the affected sections are regenerated.",
    parameters: { type: "object", properties: { explanationId: { type: "string" }, request: { type: "string" } }, required: ["explanationId", "request"] },
  },
  {
    name: "regenerate_section",
    description: "Re-plan (with an instruction) or re-render (without one) a single section of a finished explainer video.",
    parameters: { type: "object", properties: { jobId: { type: "string" }, sectionId: { type: "string" }, instruction: { type: "string" } }, required: ["jobId", "sectionId"] },
  },
];

const CreateArgs = z.object({ projectId: z.string().min(4).max(64), sourceRunId: z.string().min(3).max(600), mode: z.enum(["text", "diagram", "interactive", "video", "auto"]).optional(), duration: durationSchema.optional(), audience: audienceSchema.optional(), style: z.enum(["brody", "brody-light", "calm"]).optional() });
const JobArgs = z.object({ jobId: z.string().min(4).max(64) });
const RefineArgs = z.object({ explanationId: z.string().min(4).max(64), request: z.string().min(3).max(600) });
const RegenArgs = z.object({ jobId: z.string().min(4).max(64), sectionId: z.string().min(1).max(40), instruction: z.string().max(600).optional() });

const summarize = (e: ExplanationView) => ({ explanationId: e.id, title: e.title, recommendedModes: e.router.recommendedModes, videoValueScore: e.router.videoValueScore, reasons: e.router.reasons, confidence: e.spec.confidence, sources: e.spec.sources.map((s) => s.label) });
const jobSummary = (j: JobView) => ({ jobId: j.id, status: j.status, stage: j.currentStage, progress: j.progress, artifacts: j.urls, error: j.error });

export async function invokeTool(name: string, args: unknown): Promise<Record<string, unknown>> {
  const parse = <T>(s: z.ZodType<T>) => { const r = s.safeParse(args); if (!r.success) throw new AppError("invalid_arguments", `Invalid arguments for ${name}: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`, 400); return r.data; };
  switch (name) {
    case "create_explainer": {
      const a = parse(CreateArgs);
      const { explanation } = await createExplanation({ projectId: a.projectId, source: parseSourceRunId(a.sourceRunId), audience: a.audience });
      const mode = a.mode === "auto" || !a.mode ? (explanation.router.recommendedModes.includes("video") ? "video" : explanation.router.recommendedModes.includes("diagram") ? "diagram" : "text") : a.mode;
      const base = { ...summarize(explanation), mode };
      if (mode === "text") return { ...base, text: explanation.clear };
      if (mode === "diagram") return { ...base, mermaid: explanation.diagram, text: explanation.clear };
      // Interactive and video both need narration timing; interactive is ready at the storyboard stage, video at the end.
      const existing = explanation.latest && ["queued", "running"].includes(explanation.latest.status) ? explanation.latest : null;
      const job = existing ?? requestVideo(explanation.id, { duration: a.duration, audience: a.audience, style: a.style });
      return { ...base, job: jobSummary(job), page: `/p/${explanation.projectId}/explainers?e=${explanation.id}` };
    }
    case "get_video_job": return jobSummary(getJobView(parse(JobArgs).jobId));
    case "refine_explainer": {
      const a = parse(RefineArgs);
      const r = await refineExplanation(a.explanationId, a.request);
      return { understood: r.refine.understood, sections: r.refine.sections, job: jobSummary(r.job) };
    }
    case "regenerate_section": {
      const a = parse(RegenArgs);
      return { job: jobSummary(regenerateSection(a.jobId, { sectionId: a.sectionId, instruction: a.instruction })) };
    }
    default: throw new AppError("unknown_tool", `No tool named ${name}.`, 404, `Tools: ${TOOLS.map((t) => t.name).join(", ")}.`);
  }
}

export { getExplanationView };
