import { guard, json } from "@/lib/api";
import { getExplanationView, setAudience } from "@/lib/explainer";
import { jsonBody } from "@/lib/explainer/http";
import { patchSchema } from "@/lib/explainer/schemas";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** GET /api/explanations/:id  The spec, mode recommendation, clear text, diagram and video jobs. */
export async function GET(_req: Request, { params }: Ctx) {
  return guard(async () => json({ explanation: getExplanationView((await params).id) }));
}

/** PATCH /api/explanations/:id  { audience }  Same facts, different viewer. */
export async function PATCH(req: Request, { params }: Ctx) {
  return guard(async () => {
    const body = await jsonBody(req, patchSchema, 'Send { "audience": "beginner" | "intermediate" | "expert" }.');
    return json({ explanation: setAudience((await params).id, body.audience) });
  });
}
