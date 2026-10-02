import { guard, json } from "@/lib/api";
import { cancelJob } from "@/lib/explainer";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** POST /api/video-jobs/:id/cancel */
export async function POST(_req: Request, { params }: Ctx) {
  return guard(async () => json({ job: cancelJob((await params).id) }));
}
