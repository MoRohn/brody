import { guard, json, getProject, projectSummary } from "@/lib/api";
import { deleteProject } from "@/lib/ingest/store";
import { listJobs, requestCancel } from "@/lib/jobs";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  return guard(async () => {
    const { id } = await params;
    return json({ project: projectSummary(getProject(id)) });
  });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  return guard(async () => {
    const { id } = await params;
    getProject(id);
    for (const j of listJobs(id)) if (j.status === "queued" || j.status === "running") requestCancel(j.id);
    deleteProject(id);
    return json({ deleted: true });
  });
}
