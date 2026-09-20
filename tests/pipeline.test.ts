import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb, schema } from "@/lib/db/client";
import type { Architecture } from "@/lib/discover/types";
import { enqueueAnalysis, getJob, requestCancel } from "@/lib/jobs";
import { drainQueue } from "@/lib/jobs/worker";
import { STAGE_DEFS } from "@/lib/jobs/stages";
import { normalizeFiles } from "@/lib/ingest/normalize";
import { createProject } from "@/lib/ingest/store";
import { analyze, fixtureFiles, freshDb, fromStrings } from "./helpers";

const arch = (p: { analysis: unknown }) => (p.analysis as { architecture: Architecture }).architecture;

describe("end-to-end pipeline on the fixture repository (no AI)", () => {
  let res: Awaited<ReturnType<typeof analyze>>;
  beforeAll(async () => {
    freshDb();
    res = await analyze(fixtureFiles(), "sample-shop");
  });

  it("completes every stage with real progress details and marks the project ready", () => {
    expect(res.job.status).toBe("succeeded");
    expect(res.project.status).toBe("ready");
    expect(res.job.stages.map((s) => s.key)).toEqual(STAGE_DEFS.map((s) => s.key));
    for (const s of res.job.stages) expect(["done", "skipped"]).toContain(s.status);
    expect(res.job.stages.find((s) => s.key === "review")!.status).toBe("skipped");
    expect(res.job.stages.find((s) => s.key === "graph")!.detail).toMatch(/\d+ symbols, \d+ relationships/);
  });

  it("discovers files, languages, symbols and real dependencies", () => {
    const db = getDb();
    const files = db.select().from(schema.files).where(eq(schema.files.projectId, res.projectId)).all();
    expect(files.length).toBe(17);
    expect(new Set(files.map((f) => f.language))).toEqual(expect.objectContaining({}));
    expect(files.some((f) => f.language === "Python")).toBe(true);
    const symbols = db.select().from(schema.symbols).where(eq(schema.symbols.projectId, res.projectId)).all();
    expect(symbols.map((s) => s.name)).toEqual(expect.arrayContaining(["createOrder", "chargeCustomer", "calculateTotal", "requireAuth", "send_receipt", "Order", "User"]));
    const rels = db.select().from(schema.relationships).where(eq(schema.relationships.projectId, res.projectId)).all();
    const byName = new Map(symbols.map((s) => [s.id, s.name]));
    const calls = rels.filter((r) => r.kind === "CALLS").map((r) => `${byName.get(r.sourceId)}>${byName.get(r.targetId)}`);
    expect(calls).toEqual(expect.arrayContaining(["createOrder>chargeCustomer", "createOrder>calculateTotal", "chargeCustomer>toCents"]));
    expect(rels.some((r) => r.kind === "IMPORTS")).toBe(true);
    expect(rels.some((r) => r.kind === "WRITES_TO" && byName.get(r.targetId) === "Order")).toBe(true);
    expect(rels.some((r) => r.kind === "TESTS")).toBe(true);
    expect(rels.some((r) => r.kind === "DEPENDS_ON" && r.targetId === "pkg:stripe")).toBe(true);
    expect(rels.some((r) => r.kind === "ROUTES_TO")).toBe(true);
  });

  it("detects architecture: pattern, entry points, an API route, models, services, env, tests", () => {
    const a = arch(res.project as { analysis: unknown });
    expect(a.pattern.label).toContain("monolith");
    expect(a.entryPoints.some((e) => e.path === "src/server.ts" && e.kind === "web-server")).toBe(true);
    expect(a.entryPoints.some((e) => e.path === "worker/tasks.py" && e.kind === "worker")).toBe(true);
    const post = a.routes.find((r) => r.method === "POST" && r.path === "/api/orders")!;
    expect(post).toBeDefined();
    expect(post.auth).toBe("authenticated");
    expect(a.routes.find((r) => r.path === "/api/orders/:id")!.auth).toBe("unknown");
    expect(a.routes.find((r) => r.path === "/api/login")!.auth).toBe("public");
    expect(a.models.map((m) => m.name).sort()).toEqual(["Order", "User", "receipt_queue"]);
    expect(a.models.find((m) => m.name === "Order")!.references).toContain("User");
    expect(a.externalServices.map((s) => s.name)).toEqual(expect.arrayContaining(["Stripe", "PostgreSQL", "Redis"]));
    expect(a.envVars.map((e) => e.name)).toEqual(expect.arrayContaining(["DATABASE_URL", "STRIPE_SECRET_KEY", "PORT"]));
    expect(a.tests.files[0]).toMatchObject({ path: "tests/pricing.test.ts", framework: "Vitest" });
    expect(a.tests.files[0].targets).toContain("src/utils/pricing.ts");
    expect(a.stack.frameworks.map((f) => f.name)).toEqual(expect.arrayContaining(["Express", "Sequelize"]));
  });

  it("traces at least one data flow through call and data-access relationships", () => {
    const flow = arch(res.project as { analysis: unknown }).flows.find((f) => f.name === "POST /api/orders")!;
    expect(flow).toBeDefined();
    expect(flow.steps.map((s) => s.label)).toEqual(expect.arrayContaining(["createOrder", "chargeCustomer", "writes Order"]));
    expect(flow.models).toContain("Order");
  });

  it("produces verified, evidence-carrying findings from static analysis only", () => {
    const findings = getDb().select().from(schema.findings).where(eq(schema.findings.projectId, res.projectId)).all();
    const titles = findings.map((f) => f.title);
    expect(titles).toEqual(expect.arrayContaining(["Dynamic code evaluation with eval()", "SQL query assembled by string concatenation or interpolation", "Exception swallowed by an empty catch/except block"]));
    expect(findings.some((f) => f.title.includes("Likely secret committed in src/config.ts"))).toBe(true);
    expect(findings.every((f) => f.origin === "static" && f.verification === "verified")).toBe(true);
    const ev = findings.find((f) => f.title.includes("eval()"))!;
    expect(ev.filePath).toBe("src/routes/auth.ts");
    expect(ev.startLine).toBe(20);
    expect(ev.evidence).toContain("eval(req.body.expression)");
    expect(findings.every((f) => /^[A-Z]{3,4}-\d{3}$/.test(f.code))).toBe(true);
    // The committed secret's value must never be stored.
    expect(JSON.stringify(findings)).not.toContain("AKIAJ4Q7ZK3M2WXN5PTB");
    expect(findings.every((f) => f.whatHappens && f.whyItMatters && f.remediation)).toBe(true);
  });

  it("generates deterministic documentation with the required hierarchy and evidence", () => {
    const docs = (res.project.analysis as { docs: import("@/lib/docs/types").DocReport }).docs;
    expect(docs.executiveSummary.length).toBeGreaterThan(3);
    expect(docs.areas.length).toBeGreaterThan(3);
    expect(docs.files.length).toBeGreaterThan(5);
    expect(docs.symbols.find((s) => s.name === "createOrder")!.purpose).toContain("Create an order");
    expect(docs.symbols.find((s) => s.name === "createOrder")!.usedBy.join(",")).toContain("POST /api/orders");
    expect(docs.executiveSummary.every((s) => s.origin === "deterministic")).toBe(true);
    expect(docs.meta.aiUsed).toBe(false);
    const paths = new Set(fixtureFiles().map((f) => f.path));
    for (const s of docs.executiveSummary) for (const e of s.evidence) expect(paths.has(e.split(":")[0])).toBe(true);
  });
});

describe("incremental analysis", () => {
  it("reports changed, unchanged, added and removed files and reuses cached parses", async () => {
    freshDb();
    const base = fixtureFiles();
    const first = await analyze(base, "shop");
    expect(first.incremental).toMatchObject({ added: 17, unchanged: 0, changed: 0, removed: 0 });

    const modified = base.filter((f) => f.path !== "tests/pricing.test.ts").map((f) => (f.path === "src/utils/pricing.ts" ? { ...f, content: Buffer.from(f.content.toString() + "\nexport const NEW_CONST = 1;\n") } : f));
    modified.push({ path: "src/added.ts", content: Buffer.from("export const added = true;\n") });
    const second = await analyze(modified, "shop");
    expect(second.incremental).toMatchObject({ changed: 1, unchanged: 15, added: 1, removed: 1 });
    const build = (second.job.summary as { build: { reused: number; parsed: number } }).build;
    expect(build.reused).toBeGreaterThanOrEqual(15);
    expect(build.reused).toBeLessThan(build.parsed);
    expect(second.project.previousProjectId).toBe(first.projectId);
    expect(second.job.stages.find((s) => s.key === "enumerate")!.detail).toContain("1 changed");
  });
});

describe("job lifecycle: failures and cancellation", () => {
  it("fails with an actionable message when no source code is present", async () => {
    freshDb();
    const r = await analyze(fromStrings({ "README.md": "# hi\n", "notes.txt": "text" }), "docs-only");
    expect(r.job.status).toBe("failed");
    expect(r.job.error).toContain("No source code was found");
    expect(r.project.status).toBe("failed");
    expect(r.job.stages.some((s) => s.status === "failed")).toBe(true);
  });

  it("cancels a queued job without running it and a running job at the next checkpoint", async () => {
    freshDb();
    const { files, stats } = normalizeFiles(fixtureFiles());
    const { projectId } = createProject({ type: "folder", name: "c" }, files, stats);
    const queued = enqueueAnalysis(projectId);
    expect(requestCancel(queued.id)!.status).toBe("cancelled");
    expect(await drainQueue()).toBe(0);

    const job2 = enqueueAnalysis(projectId);
    getDb().update(schema.jobs).set({ cancelRequested: true }).where(eq(schema.jobs.id, job2.id)).run();
    await drainQueue();
    const done = getJob(job2.id)!;
    expect(done.status).toBe("cancelled");
    expect(getDb().select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()!.status).toBe("created");
  });

  it("does not create a second job while one is active and survives a stale-worker restart", async () => {
    freshDb();
    const { files, stats } = normalizeFiles(fixtureFiles());
    const { projectId } = createProject({ type: "folder", name: "d" }, files, stats);
    const a = enqueueAnalysis(projectId);
    expect(enqueueAnalysis(projectId).id).toBe(a.id);
    const { recoverStaleJobs, claimNextJob } = await import("@/lib/jobs");
    const claimed = claimNextJob()!;
    expect(claimed.status).toBe("running");
    expect(recoverStaleJobs(Date.now() + 10 * 60_000)).toBe(1);
    expect(getJob(a.id)!.status).toBe("queued");
    await drainQueue();
    expect(getJob(a.id)!.status).toBe("succeeded");
  });
});
