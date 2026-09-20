import { guard, json } from "@/lib/api";
import { requestCancel } from "@/lib/jobs";
import { AppError } from "@/lib/util/errors";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Ctx) {
  return guard(async () => {
    const { id } = await params;
    const job = requestCancel(id);
    if (!job) throw new AppError("job_not_found", "That analysis job does not exist.", 404);
    return json({ job });
  });
}
