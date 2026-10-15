import { eq } from "drizzle-orm";
import { guard, getProject, json, projectSummary } from "@/lib/api";
import { getDb, schema } from "@/lib/db/client";
import { decryptSecret } from "@/lib/ingest/credentials";
import { fetchGitHubMetadata, parseGitHubUrl } from "@/lib/ingest/github";
import { createPendingProject } from "@/lib/ingest/store";
import { enqueueAnalysis } from "@/lib/jobs";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** What Re-analyze can do for this project. Upload-sourced projects keep only a snapshot, so new code has to be uploaded. */
interface ReanalyzePlan {
  source: "github" | "upload";
  sourceType: string;
  current: { commit: string | null; branch: string | null };
  /** GitHub only: the head of the same branch now, or why it could not be read. */
  latest?: { commit: string; branch: string } | null;
  upToDate?: boolean;
  checkError?: string;
}

export async function GET(_req: Request, { params }: Ctx) {
  return guard(async () => {
    const { id } = await params;
    const project = getProject(id);
    const current = { commit: project.commit, branch: project.branch };
    if (project.sourceType !== "github" || !project.sourceUrl) return json({ source: "upload", sourceType: project.sourceType, current } satisfies ReanalyzePlan);
    try {
      const cred = getDb().select().from(schema.credentials).where(eq(schema.credentials.projectId, id)).get();
      const ref = parseGitHubUrl(project.sourceUrl);
      ref.ref = project.branch ?? undefined;
      const meta = await fetchGitHubMetadata(ref, cred ? decryptSecret(cred.encrypted) : undefined);
      return json({ source: "github", sourceType: project.sourceType, current, latest: { commit: meta.commit, branch: meta.branch }, upToDate: meta.commit === project.commit } satisfies ReanalyzePlan);
    } catch (e) {
      return json({ source: "github", sourceType: project.sourceType, current, latest: null, checkError: e instanceof Error ? e.message : String(e) } satisfies ReanalyzePlan);
    }
  });
}

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
