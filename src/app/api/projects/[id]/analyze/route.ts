import { eq } from "drizzle-orm";
import { guard, getProject, json, projectSummary } from "@/lib/api";
import { getDb, schema } from "@/lib/db/client";
import { decryptSecret } from "@/lib/ingest/credentials";
import { fetchGitHubMetadata, parseGitHubUrl } from "@/lib/ingest/github";
import { createPendingProject } from "@/lib/ingest/store";
import { enqueueAnalysis } from "@/lib/jobs";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/**
 * Re-run analysis. For GitHub projects the latest commit of the same ref is fetched;
 * a new commit creates a new project so files can be diffed against the previous run
 * (incremental analysis). An unchanged commit simply re-runs the pipeline.
 */
export async function POST(_req: Request, { params }: Ctx) {
  return guard(async () => {
    const { id } = await params;
    const project = getProject(id);
    const db = getDb();
    if (project.sourceType === "github" && project.sourceUrl && project.status !== "importing") {
      const cred = db.select().from(schema.credentials).where(eq(schema.credentials.projectId, id)).get();
      const token = cred ? decryptSecret(cred.encrypted) : undefined;
      const ref = parseGitHubUrl(project.sourceUrl);
      ref.ref = project.branch ?? undefined;
      const meta = await fetchGitHubMetadata(ref, token);
      if (meta.commit !== project.commit) {
        const newId = createPendingProject({ type: "github", name: project.name, url: project.sourceUrl, owner: project.owner ?? undefined, branch: meta.branch, commit: meta.commit }, token);
        const job = enqueueAnalysis(newId);
        return json({ project: projectSummary(db.select().from(schema.projects).where(eq(schema.projects.id, newId)).get()!), jobId: job.id, newCommit: true }, 201);
      }
    }
    const job = enqueueAnalysis(id);
    return json({ project: projectSummary(getProject(id)), jobId: job.id, newCommit: false }, 202);
  });
}
