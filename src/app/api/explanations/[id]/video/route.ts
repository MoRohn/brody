import { guard, json } from "@/lib/api";
import { requestVideo } from "@/lib/explainer";
import { jsonBody } from "@/lib/explainer/http";
import { videoSchema } from "@/lib/explainer/schemas";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/explanations/:id/video  { duration?, audience?, style?, renderer?, execution?, ttsProvider?, voice?, allowExternal? }
 * Start a durable video job. Returns at once; follow it at /api/video-jobs/:id or its /events stream.
 */
export async function POST(req: Request, { params }: Ctx) {
  return guard(async () => {
    const body = await jsonBody(req, videoSchema, "See the explainer API in docs/EXPLAINER.md.");
    return json({ job: requestVideo((await params).id, body) }, 202);
  });
}
