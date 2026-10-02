import { guard, json } from "@/lib/api";
import { getJobView } from "@/lib/explainer";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** GET /api/video-jobs/:id  Status, stages, progress, the artifacts available so far, validation and metrics. */
export async function GET(_req: Request, { params }: Ctx) {
  return guard(async () => json({ job: getJobView((await params).id) }));
}
