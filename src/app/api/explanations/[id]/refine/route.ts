import { guard, json } from "@/lib/api";
import { refineExplanation } from "@/lib/explainer";
import { jsonBody } from "@/lib/explainer/http";
import { refineSchema } from "@/lib/explainer/schemas";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
type Ctx = { params: Promise<{ id: string }> };

/** POST /api/explanations/:id/refine  { request: "Make this shorter." }  → what was understood, and the job applying it. */
export async function POST(req: Request, { params }: Ctx) {
  return guard(async () => {
    const body = await jsonBody(req, refineSchema, 'Send { "request": "Explain it for a beginner." }.');
    return json(await refineExplanation((await params).id, body.request), 202);
  });
}
