import { guard, json } from "@/lib/api";
import { createExplanation, explanationView } from "@/lib/explainer";
import { jsonBody } from "@/lib/explainer/http";
import { createSchema } from "@/lib/explainer/schemas";
import { listExplanations } from "@/lib/explainer/store";
import { AppError } from "@/lib/util/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

/**
 * POST /api/explanations  { projectId, source: { kind: "question", id } | { kind: "file", path } | ..., audience?, intent? }
 * Compile a grounded Brody result into the Explanation IR and recommend explanation modes. Reuses the existing
 * explanation of the same result unless `reuse: false`.
 */
export async function POST(req: Request) {
  return guard(async () => {
    const body = await jsonBody(req, createSchema, 'Send { "projectId": "...", "source": { "kind": "question", "id": "q_..." } }.');
    const { explanation, created } = await createExplanation(body);
    return json({ explanation, created }, created ? 201 : 200);
  });
}

/** GET /api/explanations?projectId=...  Every explanation of a project, newest first. */
export async function GET(req: Request) {
  return guard(async () => {
    const projectId = new URL(req.url).searchParams.get("projectId");
    if (!projectId) throw new AppError("invalid_request", "Give ?projectId=.", 400);
    return json({ explanations: listExplanations(projectId).map((e) => { const v = explanationView(e); return { id: v.id, sourceRunId: v.sourceRunId, title: v.title, audience: v.audience, router: v.router, ready: v.ready ? { id: v.ready.id, urls: v.ready.urls, durationMs: v.ready.artifacts.durationMs } : null, latest: v.latest ? { id: v.latest.id, status: v.latest.status } : null, updatedAt: v.updatedAt }; }) });
  });
}
