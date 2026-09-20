import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import type { JobRow, JobStage } from "../db/schema";
import { explainAIError, getAIProvider, providerStatus, UsageMeter } from "../ai";
import { resolveEmbeddingModel } from "../ai/settings";
import { discoverArchitecture } from "../discover";
import { generateDocs } from "../docs";
import { buildGraph } from "../graph/build";
import { decryptSecret, scrubToken } from "../ingest/credentials";
import { downloadGitHubSnapshot, parseGitHubUrl } from "../ingest/github";
import { normalizeFiles } from "../ingest/normalize";
import { attachFiles } from "../ingest/store";
import { architectureDiagramText, architectureMermaid, erMermaid, legendText, repositoryTree, treeToText, loadModel } from "../map";
import { buildSearchIndex } from "../retrieval";
import { runReview } from "../review";
import { AppError } from "../util/errors";
import { newId } from "../util/ids";
import { initialStages, STAGE_DEFS } from "./stages";

export { STAGE_DEFS, initialStages } from "./stages";

const HEARTBEAT_STALE_MS = 90_000;

export function enqueueAnalysis(projectId: string): JobRow {
  const db = getDb();
  const project = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!project) throw new AppError("project_not_found", "That project does not exist or was deleted.", 404);
  const active = db.select().from(schema.jobs).where(and(eq(schema.jobs.projectId, projectId), inArray(schema.jobs.status, ["queued", "running"]))).get();
  if (active) return active;
  const job: typeof schema.jobs.$inferInsert = { id: newId("job"), projectId, status: "queued", stages: initialStages(), createdAt: Date.now() };
  db.insert(schema.jobs).values(job).run();
  db.update(schema.projects).set({ status: "analyzing", updatedAt: Date.now() }).where(eq(schema.projects.id, projectId)).run();
  return db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id)).get()!;
}

export function getJob(jobId: string): JobRow | undefined {
  return getDb().select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).get();
}

export function latestJobForProject(projectId: string): JobRow | undefined {
  return getDb().select().from(schema.jobs).where(eq(schema.jobs.projectId, projectId)).orderBy(desc(schema.jobs.createdAt)).limit(1).get();
}

export function requestCancel(jobId: string): JobRow | undefined {
  const db = getDb();
  const job = getJob(jobId);
  if (!job) return undefined;
  if (job.status === "queued") {
    db.update(schema.jobs).set({ status: "cancelled", finishedAt: Date.now(), error: "Cancelled before it started." }).where(eq(schema.jobs.id, jobId)).run();
    db.update(schema.projects).set({ status: "created", updatedAt: Date.now() }).where(eq(schema.projects.id, job.projectId)).run();
  } else if (job.status === "running") {
    db.update(schema.jobs).set({ cancelRequested: true }).where(eq(schema.jobs.id, jobId)).run();
  }
  return getJob(jobId);
}

class Cancelled extends Error {
  constructor() { super("Analysis was cancelled."); }
}

class Tracker {
  private lastCheck = 0;
  private cancelled = false;
  private stages: JobStage[];
  private log: string[];
  constructor(private jobId: string, job: JobRow) {
    this.stages = job.stages.length ? job.stages : initialStages();
    this.log = job.log ?? [];
  }
  private flush(extra: Partial<typeof schema.jobs.$inferInsert> = {}) {
    getDb().update(schema.jobs).set({ stages: this.stages, log: this.log.slice(-300), heartbeatAt: Date.now(), ...extra }).where(eq(schema.jobs.id, this.jobId)).run();
  }
  isCancelled = (): boolean => {
    const now = Date.now();
    if (!this.cancelled && now - this.lastCheck > 400) {
      this.lastCheck = now;
      this.cancelled = !!getDb().select({ c: schema.jobs.cancelRequested }).from(schema.jobs).where(eq(schema.jobs.id, this.jobId)).get()?.c;
    }
    return this.cancelled;
  };
  check() { if (this.isCancelled()) throw new Cancelled(); }
  start(key: string, detail?: string) {
    this.check();
    const s = this.stages.find((x) => x.key === key);
    if (s) { s.status = "running"; s.startedAt = Date.now(); if (detail) s.detail = detail; }
    this.flush({ currentStage: key });
  }
  detail(key: string, detail: string) {
    const s = this.stages.find((x) => x.key === key);
    if (s) s.detail = detail;
    this.flush();
  }
  done(key: string, detail?: string) {
    const s = this.stages.find((x) => x.key === key);
    if (s) { s.status = "done"; s.finishedAt = Date.now(); if (detail) s.detail = detail; }
    this.flush();
  }
  skip(key: string, detail: string) {
    const s = this.stages.find((x) => x.key === key);
    if (s) { s.status = "skipped"; s.finishedAt = Date.now(); s.detail = detail; }
    this.flush();
  }
  /** Completed, but not as intended (for example every AI request failed). Shown distinctly from success. */
  warn(key: string, detail: string) {
    const s = this.stages.find((x) => x.key === key);
    if (s) { s.status = "warning"; s.finishedAt = s.finishedAt ?? Date.now(); s.detail = detail; }
    this.flush();
  }
  fail(key: string | null | undefined, detail: string) {
    const s = this.stages.find((x) => x.key === key);
    if (s) { s.status = "failed"; s.finishedAt = Date.now(); s.detail = detail; }
    this.flush();
  }
  note(msg: string) {
    this.log.push(`${new Date().toISOString().slice(11, 19)} ${scrubToken(msg)}`);
    this.flush();
  }
  heartbeat() { this.flush(); }
}

/** Run one job to completion. Never throws: failures are persisted on the job and project. */
export async function processJob(jobId: string): Promise<void> {
  const db = getDb();
  const job = getJob(jobId);
  if (!job) return;
  const t = new Tracker(jobId, job);
  const projectId = job.projectId;
  db.update(schema.jobs).set({ status: "running", startedAt: Date.now(), heartbeatAt: Date.now() }).where(eq(schema.jobs.id, jobId)).run();
  let currentStage: string | null = null;
  const beat = setInterval(() => t.heartbeat(), 15_000);
  const meter = new UsageMeter();
  try {
    const project = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
    if (!project) throw new AppError("project_not_found", "The project was deleted while analysis was queued.", 404);
    const provider = getAIProvider();
    t.note(provider ? `AI provider: ${provider.name} (${provider.model})` : `AI provider unavailable: ${providerStatus().reason}`);

    // 1. Import ---------------------------------------------------------
    currentStage = "import"; t.start("import");
    if (project.status === "importing" || project.sourceHash === "pending") {
      if (project.sourceType !== "github" || !project.sourceUrl) throw new AppError("import_incomplete", "This project has no files and no repository to download.", 400);
      const cred = db.select().from(schema.credentials).where(eq(schema.credentials.projectId, projectId)).get();
      const token = cred ? decryptSecret(cred.encrypted) : undefined;
      if (cred && !token) throw new AppError("credential_expired", "The stored GitHub credential can no longer be decrypted (the server restarted without CREDENTIAL_SECRET set).", 400, "Re-import the repository and supply the token again, or set CREDENTIAL_SECRET so stored credentials survive restarts.");
      const ref = parseGitHubUrl(project.sourceUrl);
      t.detail("import", `Downloading ${ref.owner}/${ref.repo} @ ${(project.commit ?? "").slice(0, 8)}`);
      const snap = await downloadGitHubSnapshot(ref, project.commit ?? ref.ref ?? "HEAD", token);
      t.check();
      const { files, stats } = normalizeFiles(snap.files);
      if (files.filter((f) => !f.isExcluded).length === 0) throw new AppError("no_source", "The repository contains no files that can be analysed after default exclusions.", 400, "Check that the branch contains source code, or inspect the excluded files list.");
      attachFiles(projectId, { type: "github", name: project.name, url: project.sourceUrl, owner: project.owner ?? undefined, branch: project.branch ?? undefined, commit: project.commit ?? undefined }, files, stats);
      for (const w of [...snap.warnings, ...stats.warnings]) t.note(w);
      t.done("import", `Downloaded ${files.length} files`);
    } else {
      t.done("import", `Source already loaded (${project.fileCount} files)`);
    }
    const loaded = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()!;

    // 2. Enumerate ------------------------------------------------------
    currentStage = "enumerate"; t.start("enumerate");
    const fileRows = db.select().from(schema.files).where(eq(schema.files.projectId, projectId)).all();
    const included = fileRows.filter((f) => !f.isExcluded);
    if (included.length === 0) throw new AppError("no_source", "There are no files to analyse. All files were excluded or the upload was empty.", 400, "Upload source code, or import a repository that contains source files.");
    if (!included.some((f) => f.classification === "source" || f.classification === "schema")) throw new AppError("no_source_code", "No source code was found. The project contains only documentation, configuration, binaries or data.", 400, "Analysis needs at least one file in a supported programming language.");
    const inv = { total: fileRows.length, included: included.length, excluded: fileRows.length - included.length, binary: fileRows.filter((f) => f.isBinary).length, large: included.filter((f) => f.isLarge).length, duplicates: included.filter((f) => f.duplicateOf).length, tests: included.filter((f) => f.isTest).length, generated: included.filter((f) => f.isGenerated).length };
    db.update(schema.projects).set({ analysis: { ...(loaded.analysis ?? {}), inventory: inv }, updatedAt: Date.now() }).where(eq(schema.projects.id, projectId)).run();
    const inc = loaded.incremental as { changed?: number; unchanged?: number; added?: number; removed?: number } | null;
    t.done("enumerate", `${inv.included} files analysed, ${inv.excluded} excluded${loaded.previousProjectId && inc ? `; since last analysis: ${inc.added} added, ${inc.changed} changed, ${inc.unchanged} unchanged, ${inc.removed} removed` : ""}`);

    // 3-4. Parse and graph ---------------------------------------------
    currentStage = "parse"; t.start("parse");
    let graphStarted = false;
    const build = await buildGraph(projectId, (done, total) => { t.check(); t.detail(graphStarted ? "graph" : "parse", `${done}/${total} files`); }, (phase) => {
      if (phase === "graph") { graphStarted = true; t.done("parse", "Source parsed"); currentStage = "graph"; t.start("graph"); }
    });
    t.done("graph", `${build.symbols} symbols, ${build.relationships} relationships; ${build.astParsed} AST-parsed, ${build.textParsed} text-parsed, ${build.reused} reused from cache${build.errors.length ? `, ${build.errors.length} parse warnings` : ""}`);
    // Update the parse stage detail with the final numbers.
    t.detail("parse", `${build.parsed} files parsed (${build.astParsed} AST, ${build.textParsed} text fallback, ${build.skipped} skipped)`);

    // 5. Index ----------------------------------------------------------
    currentStage = "index"; t.start("index");
    const embed = !!provider?.embed && !!resolveEmbeddingModel();
    const idx = await buildSearchIndex(projectId, { embed });
    t.done("index", `${idx.entries} entries${embed ? `, ${idx.embedded} embedded` : " (lexical + structural; semantic embeddings not configured)"}`);

    // 6. Architecture ---------------------------------------------------
    currentStage = "architecture"; t.start("architecture");
    const arch = await discoverArchitecture(projectId);
    t.done("architecture", `${arch.pattern.label}; ${arch.routes.length} routes, ${arch.models.length} models, ${arch.areas.length} functional areas, ${arch.externalServices.length} external services`);

    // 7-9. Review -------------------------------------------------------
    currentStage = "static"; t.start("static");
    let reviewStage: "static" | "ai" | "verify" = "static";
    const review = await runReview({
      projectId, arch, provider, meter, isCancelled: t.isCancelled, onProgress: (m) => t.note(m),
      onStage: (s) => {
        if (s === "ai") { t.done("static", "Static analysis complete"); if (provider) { currentStage = "review"; t.start("review", "Running AI review passes"); } else { t.skip("review", providerStatus().reason ?? "No AI provider"); } }
        if (s === "verify") { if (reviewStage === "ai" && provider) t.done("review", "AI review passes complete"); else if (reviewStage === "static") { t.done("static", "Static analysis complete"); t.skip("review", providerStatus().reason ?? "No AI provider"); } currentStage = "verify"; t.start("verify"); }
        reviewStage = s;
      },
    });
    t.check();
    t.done("verify", `${review.findings} findings: ${review.verified} verified, ${review.needsVerification} need verification; ${review.rejected} AI candidates rejected`);
    const aiCalls = review.ai.passes.reduce((a, p) => a + p.calls, 0);
    const aiFailed = review.ai.passes.reduce((a, p) => a + p.failed, 0);
    if (provider && aiCalls > 0 && aiFailed === aiCalls) {
      const why = explainAIError(review.ai.failures[0]?.error ?? "");
      t.warn("review", `All ${aiCalls} AI review requests failed. ${why.summary} ${why.hint}`);
      t.note(`AI review failed: ${review.ai.failures[0]?.error.slice(0, 300) ?? "unknown error"}`);
    } else if (provider && aiFailed > 0) t.detail("review", `${aiFailed} of ${aiCalls} AI review requests failed; results are partial`);
    if (review.ai.failures.length) t.note(`${review.ai.failures.length} AI request(s) failed: ${review.ai.failures.slice(0, 2).map((f) => f.error).join(" | ").slice(0, 300)}`);

    // 10. Docs ----------------------------------------------------------
    currentStage = "docs"; t.start("docs");
    const docs = await generateDocs({ projectId, arch, provider, meter, onProgress: (m) => { t.check(); t.note(m); }, isCancelled: t.isCancelled });
    if (provider && !docs.meta.aiUsed) {
      const why = explainAIError(meter.failures[0]?.error ?? "");
      t.done("docs", `Deterministic documentation (${docs.symbols.length} symbols, ${docs.files.length} files)`);
      t.warn("docs", `AI documentation could not be generated. ${why.summary} ${why.hint} Deterministic documentation was used instead.`);
    } else t.done("docs", docs.meta.aiUsed ? `AI-authored documentation with ${docs.symbols.length} symbol and ${docs.files.length} file explanations` : `Deterministic documentation (${docs.symbols.length} symbols, ${docs.files.length} files)`);

    // 11. Map -----------------------------------------------------------
    currentStage = "map"; t.start("map");
    loadModel(projectId);
    const tree = repositoryTree(projectId);
    const mapArtifacts = { tree: treeToText(tree, { name: project.name }), architectureText: architectureDiagramText(projectId), architectureMermaid: architectureMermaid(projectId), er: erMermaid(projectId) ?? null, legend: legendText() };
    const cur = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()!;
    db.update(schema.projects).set({ analysis: { ...(cur.analysis ?? {}), map: mapArtifacts }, updatedAt: Date.now() }).where(eq(schema.projects.id, projectId)).run();
    t.done("map", "Tree, architecture map, dependency graphs and legend ready");

    // 12. Finalize ------------------------------------------------------
    currentStage = "finalize"; t.start("finalize");
    const fin = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()!;
    const summary = { usage: meter.usage, aiFailures: meter.failures, analyzers: review.analyzers, ai: review.ai, build: { ...build, errors: build.errors.slice(0, 20) }, model: provider ? { provider: provider.name, model: provider.model } : null };
    db.update(schema.projects).set({ status: "ready", analysis: { ...(fin.analysis ?? {}), pipeline: summary }, updatedAt: Date.now() }).where(eq(schema.projects.id, projectId)).run();
    t.done("finalize", "Report ready");
    db.update(schema.jobs).set({ status: "succeeded", finishedAt: Date.now(), currentStage: null, summary: summary as unknown as Record<string, unknown> }).where(eq(schema.jobs.id, jobId)).run();
  } catch (e) {
    const cancelled = e instanceof Cancelled;
    const message = cancelled ? "Analysis was cancelled." : e instanceof AppError ? `${e.message}${e.hint ? ` ${e.hint}` : ""}` : `Unexpected error${currentStage ? ` while ${STAGE_DEFS.find((s) => s.key === currentStage)?.label.toLowerCase()}` : ""}: ${scrubToken(e instanceof Error ? e.message : String(e))}`;
    if (!cancelled) t.fail(currentStage, message.slice(0, 400));
    else t.fail(currentStage, "Cancelled");
    db.update(schema.jobs).set({ status: cancelled ? "cancelled" : "failed", error: message, finishedAt: Date.now() }).where(eq(schema.jobs.id, jobId)).run();
    const p = db.select({ id: schema.projects.id, status: schema.projects.status }).from(schema.projects).where(eq(schema.projects.id, projectId)).get();
    if (p) db.update(schema.projects).set({ status: cancelled ? "created" : "failed", updatedAt: Date.now() }).where(eq(schema.projects.id, projectId)).run();
    if (!cancelled) console.error(`[brody] job ${jobId} failed:`, scrubToken(e instanceof Error ? (e.stack ?? e.message) : String(e)));
  } finally {
    clearInterval(beat);
  }
}

/** Atomically claim the oldest queued job. */
export function claimNextJob(): JobRow | undefined {
  const db = getDb();
  return db.transaction((tx) => {
    const next = tx.select().from(schema.jobs).where(eq(schema.jobs.status, "queued")).orderBy(schema.jobs.createdAt).limit(1).get();
    if (!next) return undefined;
    const res = tx.update(schema.jobs).set({ status: "running", startedAt: Date.now(), heartbeatAt: Date.now() }).where(and(eq(schema.jobs.id, next.id), eq(schema.jobs.status, "queued"))).run();
    return res.changes ? { ...next, status: "running" } : undefined;
  });
}

/** Requeue jobs whose worker died (no heartbeat), so a restart never leaves analysis stuck. */
export function recoverStaleJobs(now = Date.now()): number {
  const db = getDb();
  const stale = db.select().from(schema.jobs).where(and(eq(schema.jobs.status, "running"), lt(schema.jobs.heartbeatAt, now - HEARTBEAT_STALE_MS))).all();
  for (const j of stale) db.update(schema.jobs).set({ status: "queued", stages: initialStages(), currentStage: null, startedAt: null, log: [...(j.log ?? []), "Worker stopped unexpectedly; the job was requeued."] }).where(eq(schema.jobs.id, j.id)).run();
  return stale.length;
}

export function listJobs(projectId: string): JobRow[] {
  return getDb().select().from(schema.jobs).where(eq(schema.jobs.projectId, projectId)).orderBy(desc(schema.jobs.createdAt)).all();
}
