import { guard, json } from "@/lib/api";
import { editNarration } from "@/lib/explainer";
import { jsonBody } from "@/lib/explainer/http";
import { narrationSchema } from "@/lib/explainer/schemas";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** PUT /api/explanations/:id/narration  { narration: { "<sectionId>": "new words" } }  Re-voices and re-renders only those sections. */
export async function PUT(req: Request, { params }: Ctx) {
  return guard(async () => {
    const body = await jsonBody(req, narrationSchema, 'Send { "narration": { "n2": "..." } }.');
    return json({ job: editNarration((await params).id, body.narration) }, 202);
  });
}
