import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb, schema } from "./db/client";
import type { ProjectRow } from "./db/schema";
import { scrubToken } from "./ingest/credentials";
import { AppError, isAppError } from "./util/errors";

export function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function fail(e: unknown): NextResponse {
  if (isAppError(e)) return NextResponse.json({ error: { code: e.code, message: e.message, hint: e.hint } }, { status: e.status, headers: { "Cache-Control": "no-store" } });
  const message = scrubToken(e instanceof Error ? e.message : String(e));
  console.error("[brody] unhandled API error:", scrubToken(e instanceof Error ? (e.stack ?? message) : message));
  return NextResponse.json({ error: { code: "internal_error", message: `The server hit an unexpected error: ${message.slice(0, 300)}`, hint: "Check the server log for details, then retry." } }, { status: 500, headers: { "Cache-Control": "no-store" } });
}

/** Wrap a handler so AppErrors become structured JSON with actionable hints. */
export async function guard(fn: () => Promise<Response> | Response): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    return fail(e);
  }
}

export function getProject(id: string): ProjectRow {
  const p = getDb().select().from(schema.projects).where(eq(schema.projects.id, id)).get();
  if (!p) throw new AppError("project_not_found", "That project does not exist. It may have been deleted.", 404, "Return to the start page and import the code again.");
  return p;
}

export function getReadyProject(id: string): ProjectRow {
  const p = getProject(id);
  if (p.status === "failed") throw new AppError("analysis_failed", "Analysis of this project failed, so there are no results to show.", 409, "Open the project's analysis status for the error, fix the cause and re-run the analysis.");
  if (p.status !== "ready") throw new AppError("analysis_not_ready", "Analysis of this project has not finished yet.", 409, "Wait for the analysis to complete; progress is shown on the project page.");
  return p;
}

export function projectSummary(p: ProjectRow) {
  const db = getDb();
  const job = db.select().from(schema.jobs).where(eq(schema.jobs.projectId, p.id)).orderBy(desc(schema.jobs.createdAt)).limit(1).get();
  return {
    id: p.id, name: p.name, sourceType: p.sourceType, sourceUrl: p.sourceUrl, owner: p.owner, branch: p.branch, commit: p.commit, fileCount: p.fileCount, sourceFileCount: p.sourceFileCount,
    totalBytes: p.totalBytes, lineCount: p.lineCount, languages: p.languages, status: p.status, imported: (p.analysis as { imported?: { at: number; exportedAt: number } } | null)?.imported ?? null, incremental: p.incremental, previousProjectId: p.previousProjectId, createdAt: p.createdAt, updatedAt: p.updatedAt,
    job: job ? { id: job.id, status: job.status, currentStage: job.currentStage, stages: job.stages, error: job.error, createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt, log: (job.log ?? []).slice(-40), summary: job.summary } : null,
  };
}

export function intParam(v: string | null, def: number, min = 1, max = 500): number {
  const n = Number(v);
  return Number.isFinite(n) && v !== null && v !== "" ? Math.min(max, Math.max(min, Math.floor(n))) : def;
}
