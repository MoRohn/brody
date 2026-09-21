import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "@/lib/config";
import { projectRows, schema } from "@/lib/db/client";
import { parseMany, poolInfo, resetPool, shutdownPool } from "@/lib/parse/pool";
import { runParseJob, type ParseJob } from "@/lib/parse/run";
import { analyze, fixtureFiles, freshDb } from "./helpers";
import { buildWorker } from "../tools/build-worker.mjs";

const saved = { ...config.parse };
let bundle: string;

const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};
const LANG: Record<string, string> = { ".ts": "TypeScript", ".tsx": "TypeScript", ".py": "Python", ".go": "Go", ".js": "JavaScript", ".sql": "SQL", ".md": "Markdown", ".yml": "YAML" };
function corpus(): ParseJob[] {
  const roots = ["src", "fixtures", "tests"].map((d) => path.resolve(d));
  const jobs: ParseJob[] = [];
  for (const f of roots.flatMap((r) => walk(r))) {
    const language = LANG[path.extname(f)];
    if (!language) continue;
    jobs.push({ path: path.relative(process.cwd(), f), language, source: fs.readFileSync(f, "utf8"), syntax: /\.(ts|tsx|js)$/.test(f), lint: /\.(ts|tsx|js)$/.test(f) });
  }
  // A few files that must produce diagnostics and messages.
  jobs.push({ path: "broken.ts", language: "TypeScript", source: "export function f( {\nconst o = { a: 1, a: 2 };\n", syntax: true, lint: true });
  jobs.push({ path: "lint.js", language: "JavaScript", source: "const o = { a: 1, a: 2 };\nif (x === NaN) {}\n", syntax: true, lint: true });
  return jobs;
}

beforeAll(async () => {
  // Built inside the repository so its external requires (web-tree-sitter, typescript, eslint) resolve from node_modules.
  bundle = await buildWorker(path.resolve("node_modules", ".cache", "brody-test", "parse-worker.cjs"));
  Object.assign(config.parse, { workers: 3, minFiles: 1, workerPath: bundle });
  resetPool();
});
afterAll(async () => {
  await shutdownPool();
  Object.assign(config.parse, saved);
  resetPool();
});

describe("parse worker threads", () => {
  it("return exactly what in-process parsing returns, for every language and check", async () => {
    const jobs = corpus();
    expect(jobs.length).toBeGreaterThan(150);
    const viaWorkers = await parseMany(jobs);
    expect(poolInfo()).toMatchObject({ mode: "workers" });
    expect(poolInfo().workers).toBeGreaterThan(1);
    const inline: Awaited<ReturnType<typeof runParseJob>>[] = [];
    for (const j of jobs) inline.push(await runParseJob(j));
    expect(viaWorkers.length).toBe(jobs.length);
    for (let i = 0; i < jobs.length; i++) expect(viaWorkers[i], jobs[i].path).toEqual(inline[i]);
    const broken = viaWorkers[jobs.findIndex((j) => j.path === "broken.ts")].parsed!;
    expect(broken.checks!.syntax!.length).toBeGreaterThan(0);
    const lint = viaWorkers[jobs.findIndex((j) => j.path === "lint.js")].parsed!.checks!.lint!;
    expect(lint.messages.map((m) => m.ruleId)).toEqual(expect.arrayContaining(["no-dupe-keys", "use-isnan"]));
  });

  it("run off the main thread, so the event loop keeps turning while files are parsed", async () => {
    const jobs = corpus();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    await parseMany(jobs.concat(jobs, jobs));
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(10);
  });

  it("ignore an explicit worker path that does not exist and use the default one", async () => {
    config.parse.workerPath = path.join(os.tmpdir(), "does-not-exist.cjs");
    resetPool();
    await shutdownPool();
    const jobs = corpus().slice(0, 30);
    const out = await parseMany(jobs);
    expect(out).toEqual(await Promise.all(jobs.map((j) => runParseJob(j))));
    config.parse.workerPath = bundle;
    resetPool();
  });

  it("recover from a worker that crashes, re-parsing its files in-process", async () => {
    const bad = path.resolve("node_modules", ".cache", "brody-test", "crash.cjs");
    fs.writeFileSync(bad, "process.exit(3);\n");
    config.parse.workerPath = bad;
    resetPool();
    await shutdownPool();
    const jobs = corpus().slice(0, 40);
    const out = await parseMany(jobs);
    const expected = await Promise.all(jobs.map((j) => runParseJob(j)));
    expect(out).toEqual(expected);
    expect(poolInfo().mode).toBe("inline");
    config.parse.workerPath = bundle;
    resetPool();
    await shutdownPool();
  });

  it("stay off for a small batch on a cold pool, and when switched off", async () => {
    await shutdownPool();
    config.parse.minFiles = 500;
    await parseMany(corpus().slice(0, 10));
    expect(poolInfo()).toMatchObject({ mode: "inline" });
    expect(poolInfo().reason).toMatch(/only 10 files/);
    config.parse.minFiles = 1;
    config.parse.workers = 0;
    await parseMany(corpus().slice(0, 10));
    expect(poolInfo().reason).toMatch(/PARSE_WORKERS=0/);
    config.parse.workers = 3;
  });

  it("stop early and report the error when progress reporting throws (analysis cancelled)", async () => {
    const jobs = corpus();
    let seen = 0;
    await expect(parseMany(jobs, { onProgress: (n) => { seen = n; if (n >= 24) throw new Error("cancelled by user"); } })).rejects.toThrow("cancelled by user");
    expect(seen).toBeLessThan(jobs.length);
    const again = await parseMany(jobs.slice(0, 50)); // the pool is still healthy afterwards
    expect(again.every((o) => o.parsed)).toBe(true);
  });
});

async function stored(pid: string) {
  const files = projectRows(schema.files, pid).map((f) => ({ path: f.path, importance: f.importance, area: f.area, role: f.role, parse: f.parseStatus, imports: f.imports, exports: f.exports })).sort((a, b) => a.path.localeCompare(b.path));
  const symbols = projectRows(schema.symbols, pid).map((s) => ({ k: `${s.filePath}:${s.startLine}:${s.qualifiedName}:${s.kind}`, meta: s.meta, importance: s.importance, inbound: s.inboundCount })).sort((a, b) => a.k.localeCompare(b.k));
  const findings = projectRows(schema.findings, pid).map((f) => [f.title, f.filePath, f.startLine, f.severity, f.category, f.evidence].join("|")).sort();
  return { files, symbols, findings, rels: projectRows(schema.relationships, pid).length };
}

describe("analysis with worker threads", () => {
  it("stores exactly what an in-process analysis stores, and reports how it ran", async () => {
    config.parse.workers = 0;
    freshDb();
    const local = await analyze(fixtureFiles(), "sample-shop");
    const a = await stored(local.projectId);

    Object.assign(config.parse, { workers: 3, minFiles: 1, workerPath: bundle });
    resetPool();
    freshDb();
    const threaded = await analyze(fixtureFiles(), "sample-shop");
    const b = await stored(threaded.projectId);

    expect(b).toEqual(a);
    expect(a.findings.length).toBeGreaterThan(0);
    const build = (threaded.project.analysis as { pipeline: { build: { mode: { mode: string; workers: number } } } }).pipeline.build;
    expect(build.mode.mode).toBe("workers");
    expect(threaded.job.log.some((l) => /worker threads/.test(l))).toBe(true);
    expect((local.project.analysis as { pipeline: { build: { mode: { mode: string } } } }).pipeline.build.mode.mode).toBe("inline");
  });

  it("re-analysis reuses cached parses, including their checks, without starting workers", async () => {
    await shutdownPool();
    const again = await analyze(fixtureFiles(), "sample-shop");
    const build = (again.project.analysis as { pipeline: { build: { reused: number; parsed: number } } }).pipeline.build;
    expect(build.reused).toBe(build.parsed); // every file came from the cache
    expect(build.reused).toBeGreaterThan(10);
  });
});
