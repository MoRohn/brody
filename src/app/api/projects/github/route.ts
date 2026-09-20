import { z } from "zod";
import { guard, json, projectSummary } from "@/lib/api";
import { getDb, schema } from "@/lib/db/client";
import { config } from "@/lib/config";
import { fetchGitHubMetadata, parseGitHubUrl } from "@/lib/ingest/github";
import { createPendingProject } from "@/lib/ingest/store";
import { enqueueAnalysis } from "@/lib/jobs";
import { AppError } from "@/lib/util/errors";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

const Body = z.object({ url: z.string().min(1), ref: z.string().optional(), token: z.string().optional() });

/** Validate the repository, create the project and queue analysis. The download happens inside the job so progress and failures persist. */
export async function POST(req: Request) {
  return guard(async () => {
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new AppError("invalid_request", "Provide a GitHub repository URL.", 400, "Example: https://github.com/owner/repository");
    const ref = parseGitHubUrl(parsed.data.url);
    if (parsed.data.ref?.trim()) ref.ref = parsed.data.ref.trim();
    const token = parsed.data.token?.trim() || undefined;
    const meta = await fetchGitHubMetadata(ref, token);
    const limitKb = config.limits.maxTotalBytes / 1024;
    if (meta.sizeKb > limitKb * 1.5) throw new AppError("repo_too_large", `${meta.fullName} is about ${Math.round(meta.sizeKb / 1024)} MB, above the ${Math.round(config.limits.maxTotalBytes / 1024 / 1024)} MB limit.`, 413, "Analyse a subdirectory by uploading it, or raise MAX_TOTAL_BYTES.");
    const projectId = createPendingProject({ type: "github", name: meta.repo, url: `https://github.com/${meta.owner}/${meta.repo}`, owner: meta.owner, branch: meta.branch, commit: meta.commit }, token);
    getDb().update(schema.projects).set({ languages: Object.fromEntries(Object.entries(meta.languages)) }).where(eq(schema.projects.id, projectId)).run();
    const job = enqueueAnalysis(projectId);
    const p = getDb().select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()!;
    return json({ project: projectSummary(p), jobId: job.id, metadata: meta }, 201);
  });
}
