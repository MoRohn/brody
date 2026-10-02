import { guard, json } from "@/lib/api";
import { regenerateSection } from "@/lib/explainer";
import { jsonBody } from "@/lib/explainer/http";
import { regenerateSchema } from "@/lib/explainer/schemas";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/video-jobs/:id/regenerate-section  { sectionId, instruction? }
 * Re-plan (with an instruction) or re-render (without one) one section of a finished video. Everything else is reused.
 */
export async function POST(req: Request, { params }: Ctx) {
  return guard(async () => {
    const body = await jsonBody(req, regenerateSchema, 'Send { "sectionId": "n3", "instruction": "show how dynamic scheduling fixes this" }.');
    return json({ job: regenerateSection((await params).id, body) }, 202);
  });
}
