import { guard, json } from "@/lib/api";
import { retryJob } from "@/lib/explainer";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** POST /api/video-jobs/:id/retry  Resume a failed or cancelled job; finished stages are reused. */
export async function POST(_req: Request, { params }: Ctx) {
  return guard(async () => json({ job: retryJob((await params).id) }, 202));
}
