import { eq } from "drizzle-orm";
import { guard, json, projectSummary } from "@/lib/api";
import { getDb, schema } from "@/lib/db/client";
import { finishUploadSession } from "@/lib/ingest/sessions";
import { enqueueAnalysis } from "@/lib/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
type Ctx = { params: Promise<{ id: string }> };

/** POST /api/projects/upload/sessions/:id/finish — ingest the received files and start the analysis (or open a Brody export). */
export async function POST(_req: Request, { params }: Ctx) {
  return guard(async () => {
    const { id } = await params;
    const done = await finishUploadSession(id);
    if (done.kind === "bundle") {
      const ip = getDb().select().from(schema.projects).where(eq(schema.projects.id, done.imported.projectId)).get()!;
      return json({ project: projectSummary(ip), warnings: done.imported.warnings, imported: true }, 201);
    }
    const { outcome } = done;
    const job = enqueueAnalysis(outcome.projectId);
    const p = getDb().select().from(schema.projects).where(eq(schema.projects.id, outcome.projectId)).get()!;
    return json({ project: projectSummary(p), jobId: job.id, warnings: outcome.warnings, stats: { included: outcome.stats.included, excluded: outcome.stats.excluded, binary: outcome.stats.binary } }, 201);
  });
}
