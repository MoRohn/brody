import fs from "node:fs";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { POST as importBundleRoute } from "@/app/api/projects/import-bundle/route";
import { POST as uploadRoute } from "@/app/api/projects/upload/route";
import { GET as deckRoute } from "@/app/api/projects/[id]/deck/route";
import { GET as exportRoute } from "@/app/api/projects/[id]/export/route";
import { GET as findingsRoute } from "@/app/api/projects/[id]/findings/route";
import { GET as fileContentRoute } from "@/app/api/projects/[id]/files/content/route";
import { scanText } from "@/lib/analysis/rules";
import { AnthropicProvider } from "@/lib/ai/anthropic";
import { tryAnalyze, UsageMeter } from "@/lib/ai";
import { withDeadline } from "@/lib/ai/deadline";
import type { AIProvider } from "@/lib/ai";
import { config } from "@/lib/config";
import { getDb, ident, projectRows, schema, sqlText } from "@/lib/db/client";
import { claimNextJob, enqueueAnalysis, getJob, processJob, requestCancel } from "@/lib/jobs";
import { normalizeFiles } from "@/lib/ingest/normalize";
import { createProject } from "@/lib/ingest/store";
import { readCappedForm } from "@/lib/util/body";
import { analyze, fixtureFiles, freshDb } from "./helpers";

let pid: string;
beforeAll(async () => {
  freshDb();
  pid = (await analyze(fixtureFiles(), "sample-shop")).projectId;
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (url: string, init?: RequestInit) => new Request(`http://localhost${url}`, init);

/** A streamed multipart request with no Content-Length, as a chunked upload arrives; `pulled` shows how much was actually read. */
function streamedUpload(totalBytes: number, opts: { declared?: number; chunk?: number } = {}) {
  const boundary = "----brodytest";
  const chunk = opts.chunk ?? 1024;
  const enc = new TextEncoder();
  const head = enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\n`);
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const state = { pulled: 0, sent: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.sent === 0) { controller.enqueue(head); state.sent = 1; state.pulled += head.length; return; }
      const remaining = totalBytes - (state.pulled - head.length);
      if (remaining <= 0) { controller.enqueue(tail); controller.close(); return; }
      const n = Math.min(chunk, remaining);
      controller.enqueue(new Uint8Array(n).fill(97));
      state.pulled += n;
    },
  });
  const headers: Record<string, string> = { "content-type": `multipart/form-data; boundary=${boundary}` };
  if (opts.declared !== undefined) headers["content-length"] = String(opts.declared);
  return { request: new Request("http://localhost/api/x", { method: "POST", body: body as unknown as BodyInit, headers, duplex: "half" } as RequestInit), state };
}

describe("uploads are capped on the bytes actually received (OPS-001, OPS-002)", () => {
  it("rejects an oversized chunked upload that states no Content-Length, and stops reading early", async () => {
    const { request, state } = streamedUpload(10_000_000);
    await expect(readCappedForm(request, 50_000, "The upload")).rejects.toMatchObject({ code: "upload_too_large", status: 413 });
    expect(state.pulled).toBeLessThan(200_000); // it stopped near the cap instead of buffering the whole stream
  });

  it("rejects a request whose stated length is small but whose body is large", async () => {
    const { request } = streamedUpload(500_000, { declared: 100 });
    await expect(readCappedForm(request, 50_000, "The upload")).rejects.toMatchObject({ code: "upload_too_large" });
  });

  it("refuses a request that declares too much without reading it at all", async () => {
    const { request, state } = streamedUpload(1_000_000, { declared: 900_000 });
    await expect(readCappedForm(request, 50_000, "The upload")).rejects.toMatchObject({ code: "upload_too_large" });
    expect(state.pulled).toBeLessThan(1000); // only the stream's own first prefetch (the multipart header); the body was never consumed
  });

  it("still accepts a normal upload", async () => {
    const { request } = streamedUpload(2_000);
    const form = await readCappedForm(request, 50_000, "The upload");
    const f = form.get("files") as File;
    expect(f.name).toBe("a.txt");
    expect(f.size).toBe(2_000);
  });

  it("refuses a body that is not a multipart form", async () => {
    const r = new Request("http://localhost/x", { method: "POST", body: "not a form", headers: { "content-type": "multipart/form-data; boundary=zzz" } });
    await expect(readCappedForm(r, 50_000, "The upload")).rejects.toMatchObject({ code: "invalid_upload", status: 400 });
  });

  for (const [name, route] of [["upload", uploadRoute], ["import-bundle", importBundleRoute]] as const) {
    it(`the ${name} route answers 413 for an oversized stream with no Content-Length`, async () => {
      const saved = config.limits.maxUploadBytes;
      config.limits.maxUploadBytes = 30_000;
      try {
        const { request } = streamedUpload(5_000_000);
        const res = await route(request);
        expect(res.status).toBe(413);
        expect((await res.json()).error.code).toBe("upload_too_large");
      } finally { config.limits.maxUploadBytes = saved; }
    });
  }
});

describe("AI calls cannot hang (OPS-003)", () => {
  const hanging: AIProvider = { name: "hang", model: "m", analyze: () => new Promise(() => undefined) } as unknown as AIProvider;

  it("withDeadline gives up on work that never settles, and lets work that finishes through", async () => {
    await expect(withDeadline(new Promise(() => undefined), 30, "The thing")).rejects.toThrow(/The thing timed out after/);
    await expect(withDeadline(Promise.resolve(7), 1000, "x")).resolves.toBe(7);
  });

  it("a hung analysis request is recorded as a timeout instead of holding the job", async () => {
    const saved = config.ai.callDeadlineMs;
    config.ai.callDeadlineMs = 40;
    try {
      const meter = new UsageMeter();
      const out = await tryAnalyze(hanging, meter, { task: "review", system: "s", prompt: "p", schema: { parse: (x: unknown) => x } } as never);
      expect(out).toBeUndefined();
      expect(meter.failures[0].error).toMatch(/timed out/);
    } finally { config.ai.callDeadlineMs = saved; }
  });

  it("the Anthropic client is created with a request timeout and bounded retries", () => {
    const p = new AnthropicProvider({ apiKey: "sk-test" });
    const client = (p as unknown as { client: { timeout: number; maxRetries: number } }).client;
    expect(client.timeout).toBe(config.ai.requestTimeoutMs);
    expect(client.timeout).toBeLessThanOrEqual(300_000);
    expect(client.maxRetries).toBeLessThanOrEqual(2);
  });
});

/** The original in-memory implementation, kept as the reference the SQL one must reproduce. */
function referenceFindings(id: string, p: URLSearchParams) {
  const SEV = ["Critical", "High", "Medium", "Low", "Informational"];
  const q = (p.get("q") ?? "").toLowerCase().trim();
  const list = (k: string) => (p.get(k) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const sev = list("severity"), cat = list("category"), origin = list("origin"), ver = list("verification"), area = list("area"), conf = list("confidence");
  const file = p.get("file");
  let rows = projectRows(schema.findings, id).filter((f) => f.verification !== "rejected");
  const facets = (k: (f: (typeof rows)[number]) => string | null) => { const m: Record<string, number> = {}; for (const f of rows) { const v = k(f); if (v) m[v] = (m[v] ?? 0) + 1; } return m; };
  const facetData = { severity: facets((f) => f.severity), category: facets((f) => f.category), origin: facets((f) => f.origin), verification: facets((f) => f.verification), area: facets((f) => f.area), confidence: facets((f) => f.confidence) };
  rows = rows.filter((f) => (!sev.length || sev.includes(f.severity)) && (!cat.length || cat.includes(f.category)) && (!origin.length || origin.includes(f.origin)) && (!ver.length || ver.includes(f.verification)) && (!area.length || (f.area && area.includes(f.area))) && (!conf.length || conf.includes(f.confidence)) && (!file || f.filePath === file) && (!q || `${f.code} ${f.title} ${f.filePath ?? ""} ${f.whatHappens} ${f.category}`.toLowerCase().includes(q)));
  rows.sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity) || a.code.localeCompare(b.code));
  const limit = Math.min(1000, Math.max(1, Number(p.get("limit") ?? 200) || 200));
  const offset = Math.max(0, Number(p.get("offset") ?? 0) || 0);
  return { total: rows.length, facets: facetData, findings: rows.slice(offset, offset + limit).map(({ projectId: _p, ...f }) => f) };
}

describe("findings are filtered and paged in the database (PERF-002)", () => {
  const queries = ["", "severity=Critical,High", "category=Security&origin=static&q=eval", "severity=Low&file=worker/tasks.py", "q=SQL", "q=100%25_", "verification=verified", "limit=2", "limit=2&offset=2", "limit=3&offset=1&severity=Medium,High,Critical", "confidence=High", "area=API%20Layer", "q=nothing-matches-this"];
  for (const query of queries) {
    it(`returns exactly what the in-memory version returned for "${query || "no filters"}"`, async () => {
      const res = await findingsRoute(req(`/api/x?${query}`), ctx(pid));
      const got = await res.json();
      const want = referenceFindings(pid, new URLSearchParams(query));
      expect(got.total).toBe(want.total);
      expect(got.facets).toEqual(want.facets);
      expect(got.findings).toEqual(want.findings);
    });
  }

  it("reads one page of rows, not the whole table", async () => {
    const before = projectRows(schema.findings, pid).length;
    expect(before).toBeGreaterThan(3);
    const got = await (await findingsRoute(req("/api/x?limit=2"), ctx(pid))).json();
    expect(got.findings).toHaveLength(2);
    expect(got.total).toBe(before);
  });
});

/** The original whole-table implementation of a file's dependencies, as the reference. */
function referenceDeps(id: string, path: string) {
  const file = getDb().select().from(schema.files).where(and(eq(schema.files.projectId, id), eq(schema.files.path, path))).get()!;
  const symbols = getDb().select().from(schema.symbols).where(and(eq(schema.symbols.projectId, id), eq(schema.symbols.fileId, file.id))).all();
  const symbolIds = new Set(symbols.map((s) => s.id));
  const rels = projectRows(schema.relationships, id);
  const filesById = new Map(projectRows(schema.files, id).map((f) => [f.id, f]));
  const symbolsById = new Map(projectRows(schema.symbols, id).map((s) => [s.id, s]));
  const outgoing = new Set<string>(), incoming = new Set<string>(), tests = new Set<string>(), externals = new Set<string>();
  for (const r of rels) {
    const srcIn = r.sourceId === file.id || symbolIds.has(r.sourceId);
    const tgtIn = r.targetId === file.id || symbolIds.has(r.targetId);
    if (r.kind === "TESTS" && tgtIn) { const tf = filesById.get(r.sourceId); if (tf) tests.add(tf.path); continue; }
    if (srcIn && !tgtIn && ["IMPORTS", "CALLS", "USES", "INSTANTIATES", "EXTENDS", "IMPLEMENTS", "READS_FROM", "WRITES_TO"].includes(r.kind)) {
      const tp = r.targetType === "file" ? filesById.get(r.targetId)?.path : r.targetType === "symbol" ? symbolsById.get(r.targetId)?.filePath : undefined;
      if (tp && tp !== file.path) outgoing.add(tp);
    }
    if (srcIn && r.kind === "DEPENDS_ON") externals.add(r.targetId.replace(/^pkg:/, ""));
    if (tgtIn && !srcIn && ["IMPORTS", "CALLS", "USES", "INSTANTIATES", "EXTENDS", "IMPLEMENTS", "ROUTES_TO"].includes(r.kind)) {
      const sp = r.sourceType === "file" ? filesById.get(r.sourceId)?.path : r.sourceType === "symbol" ? symbolsById.get(r.sourceId)?.filePath : undefined;
      if (sp && sp !== file.path) incoming.add(sp);
    }
  }
  return { outgoing: [...outgoing].sort(), incoming: [...incoming].sort(), external: [...externals].sort(), tests: [...tests].sort() };
}

describe("a file's connections are read by the file, not from whole tables (PERF-001)", () => {
  it("gives every file the same dependencies as the whole-table version", async () => {
    const files = projectRows(schema.files, pid).filter((f) => !f.isBinary && f.hasContent);
    expect(files.length).toBeGreaterThan(8);
    let withConnections = 0;
    for (const f of files) {
      const res = await fileContentRoute(req(`/api/x?path=${encodeURIComponent(f.path)}`), ctx(pid));
      const body = await res.json();
      expect(body.dependencies, f.path).toEqual(referenceDeps(pid, f.path));
      if (body.dependencies.outgoing.length + body.dependencies.incoming.length > 0) withConnections++;
    }
    expect(withConnections).toBeGreaterThan(3);
  });
});

describe("cancelling a job cannot overwrite a job that already started (REL-001)", () => {
  function queued() {
    const { files, stats } = normalizeFiles([{ path: "a.ts", content: Buffer.from("export const a = 1;\n") }]);
    const { projectId } = createProject({ type: "folder", name: "c" }, files, stats);
    return { projectId, job: enqueueAnalysis(projectId) };
  }

  it("cancels a queued job and returns its project to the created state", () => {
    const { projectId, job } = queued();
    const after = requestCancel(job.id)!;
    expect(after.status).toBe("cancelled");
    expect(getDb().select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()!.status).toBe("created");
  });

  it("only asks a running job to stop: its status and its project are left alone", () => {
    const { projectId, job } = queued();
    const claimed = claimNextJob()!;
    expect(claimed.id).toBe(job.id);
    const after = requestCancel(job.id)!;
    expect(after.status).toBe("running");
    expect(after.cancelRequested).toBe(true);
    expect(getDb().select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()!.status).toBe("analyzing");
  });

  it("a stale view of a queued job cannot cancel it once another process has claimed it", () => {
    const { projectId, job } = queued();
    expect(getJob(job.id)!.status).toBe("queued"); // what a slow canceller saw
    claimNextJob(); // another process claims it in the gap
    const after = requestCancel(job.id)!; // the canceller now acts on its old view
    expect(after.status).toBe("running");
    expect(getDb().select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()!.status).toBe("analyzing");
  });

  it("never brings a cancelled job back to life", async () => {
    const { job } = queued();
    requestCancel(job.id);
    await processJob(job.id);
    expect(getJob(job.id)!.status).toBe("cancelled");
  });

  it("leaves finished jobs alone", () => {
    const done = getDb().select().from(schema.jobs).where(eq(schema.jobs.status, "succeeded")).get()!;
    expect(requestCancel(done.id)!.status).toBe("succeeded");
  });
});

describe("HTML served from the app is sandboxed (SEC-001)", () => {
  const get = (url: string, route: typeof exportRoute) => route(req(url), ctx(pid));

  it("the report's web page and print view carry a sandboxing policy that allows only its own script and the diagram library", async () => {
    for (const format of ["html", "print"]) {
      const res = await get(`/api/x?format=${format}&scope=full&download=0`, exportRoute);
      const csp = res.headers.get("content-security-policy")!;
      expect(csp, format).toMatch(/default-src 'none'/);
      expect(csp).toMatch(/sandbox allow-scripts allow-modals/);
      expect(csp).toMatch(/connect-src 'none'/);
      expect(csp).toMatch(/script-src 'unsafe-inline' https:\/\/cdn\.jsdelivr\.net/);
      expect(csp).not.toMatch(/allow-same-origin/);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  it("the deck's web page is sandboxed too, and needs no outside script host", async () => {
    const res = await deckRoute(req("/api/x?format=html&download=0"), ctx(pid));
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toMatch(/sandbox allow-scripts allow-modals/);
    expect(csp).not.toMatch(/jsdelivr|https:/);
    expect(csp).toMatch(/frame-ancestors 'self'/);
  });

  it("downloads of other formats are not given a page policy", async () => {
    expect((await get("/api/x?format=md&scope=full", exportRoute)).headers.get("content-security-policy")).toBeNull();
    expect((await get("/api/x?format=pdf&scope=full", exportRoute)).headers.get("content-security-policy")).toBeNull();
  });

  it("repository text is escaped in the page, so a hostile file name or finding cannot inject markup", async () => {
    const { files, stats } = normalizeFiles([{ path: "src/<img src=x onerror=alert(1)>.ts", content: Buffer.from("export const a = 1;\n") }, { path: "package.json", content: Buffer.from("{}") }]);
    const { projectId } = createProject({ type: "folder", name: "<script>alert(1)</script>" }, files, stats);
    enqueueAnalysis(projectId);
    const { drainQueue } = await import("@/lib/jobs/worker");
    await drainQueue();
    const res = await exportRoute(req("/api/x?format=html&scope=full&download=0"), ctx(projectId));
    const html = await res.text();
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

describe("SQL built by the bulk helpers uses validated identifiers only (SEC-002, SEC-003)", () => {
  it("accepts schema names and refuses anything else as an identifier", () => {
    expect(ident("files")).toBe('"files"');
    expect(ident("project_id")).toBe('"project_id"');
    for (const bad of ['x"; DROP TABLE files; --', "a b", "", "1abc", "name'", "a.b", 'a"b']) expect(() => ident(bad), bad).toThrow(/Refusing/);
  });

  it("builds statements whose values are all placeholders", () => {
    expect(sqlText.insert("files", ["id", "path"], false)).toBe('INSERT INTO "files" ("id", "path") VALUES (?, ?)');
    expect(sqlText.insert("blobs", ["hash"], true)).toBe('INSERT OR IGNORE INTO "blobs" ("hash") VALUES (?)');
    expect(sqlText.update("files", ["area", "role"], ["id"])).toBe('UPDATE "files" SET "area" = ?, "role" = ? WHERE "id" = ?');
    expect(sqlText.select("symbols", ["id", "name"], "project_id")).toBe('SELECT "id", "name" FROM "symbols" WHERE "project_id" = ?');
    expect(() => sqlText.insert("files", ['id"); DROP TABLE files; --'], false)).toThrow();
    expect(() => sqlText.select("files; DROP TABLE x", ["id"], "project_id")).toThrow();
  });

  it("the analyzer's own SQL rule finds nothing in the files that build or run these statements", () => {
    for (const path of ["src/lib/db/client.ts", "src/app/api/projects/[id]/findings/route.ts", "src/app/api/projects/[id]/files/content/route.ts"]) {
      const hits = scanText(path, "TypeScript", fs.readFileSync(path, "utf8"), false).filter((f) => f.analyzer === "brody-rules/sql-concat");
      expect(hits.map((h) => `${path}:${h.startLine}`), path).toEqual([]);
    }
  });
});
