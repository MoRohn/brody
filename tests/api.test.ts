import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb, schema } from "@/lib/db/client";
import { normalizeFiles } from "@/lib/ingest/normalize";
import { createProject } from "@/lib/ingest/store";
import { enqueueAnalysis } from "@/lib/jobs";
import { analyze, fixtureFiles, freshDb, fromStrings } from "./helpers";
import { makeZip } from "./helpers/zip";
import { POST as upload } from "@/app/api/projects/upload/route";
import { GET as listProjects } from "@/app/api/projects/route";
import { GET as getProject, DELETE as deleteProject } from "@/app/api/projects/[id]/route";
import { GET as overview } from "@/app/api/projects/[id]/overview/route";
import { GET as findings } from "@/app/api/projects/[id]/findings/route";
import { GET as report } from "@/app/api/projects/[id]/report/route";
import { GET as filesRoute } from "@/app/api/projects/[id]/files/route";
import { GET as fileContent } from "@/app/api/projects/[id]/files/content/route";
import { GET as symbolRoute } from "@/app/api/projects/[id]/symbols/[symbolId]/route";
import { GET as graphRoute } from "@/app/api/projects/[id]/graph/route";
import { GET as impactRoute } from "@/app/api/projects/[id]/impact/route";
import { GET as searchRoute } from "@/app/api/projects/[id]/search/route";
import { GET as askHistory, POST as ask } from "@/app/api/projects/[id]/ask/route";
import { GET as exportRoute } from "@/app/api/projects/[id]/export/route";
import { GET as architecture } from "@/app/api/projects/[id]/architecture/route";
import { POST as githubValidate } from "@/app/api/github/validate/route";
import { POST as githubImport } from "@/app/api/projects/github/route";
import { GET as getJob } from "@/app/api/jobs/[id]/route";
import { POST as cancelJob } from "@/app/api/jobs/[id]/cancel/route";
import { GET as status } from "@/app/api/status/route";

const ctx = <E extends Record<string, string> = Record<never, string>>(id: string, extra?: E) => ({ params: Promise.resolve({ id, ...(extra ?? {}) } as { id: string } & E) });
const req = (url: string, init?: RequestInit) => new Request(`http://localhost${url}`, init);
const body = async (r: Response) => ({ status: r.status, json: await r.clone().json().catch(() => null), text: await r.text() });

let pid: string;
beforeAll(async () => {
  freshDb();
  pid = (await analyze(fixtureFiles(), "sample-shop")).projectId;
});

describe("API: valid requests", () => {
  it("lists projects and returns one project with job state", async () => {
    const list = await body(await listProjects());
    expect(list.json.projects[0]).toMatchObject({ id: pid, status: "ready", name: "sample-shop" });
    const one = await body(await getProject(req("/"), ctx(pid)));
    expect(one.json.project.job.status).toBe("succeeded");
    expect(one.json.project.job.stages).toHaveLength(12);
  });

  it("serves overview, findings (with filters and facets), report, architecture", async () => {
    const o = (await body(await overview(req("/"), ctx(pid)))).json;
    expect(o.ready).toBe(true);
    expect(o.review.bySeverity.Critical).toBeGreaterThan(0);
    expect(o.architecture.stats.routes).toBe(5);
    const all = (await body(await findings(req("/api/x"), ctx(pid)))).json;
    expect(all.total).toBeGreaterThan(5);
    expect(all.facets.severity).toBeDefined();
    const filtered = (await body(await findings(req("/api/x?severity=Critical,High&category=Security&origin=static&q=eval"), ctx(pid)))).json;
    expect(filtered.findings.map((f: { title: string }) => f.title)).toEqual(["Dynamic code evaluation with eval()"]);
    expect((await body(await findings(req("/api/x?severity=Low&file=worker/tasks.py"), ctx(pid)))).json.findings).toHaveLength(1);
    const rep = (await body(await report(req("/"), ctx(pid)))).json;
    expect(rep.docs.files.length).toBeGreaterThan(5);
    const arch = (await body(await architecture(req("/"), ctx(pid)))).json;
    expect(arch.diagram.text).toContain("API Layer");
    expect(arch.legend.nodes.length).toBeGreaterThan(8);
  });

  it("serves the file tree, file intelligence, symbols, graphs, impact and search", async () => {
    const f = (await body(await filesRoute(req("/"), ctx(pid)))).json;
    expect(f.files.length).toBe(17);
    expect(f.treeText).toContain("orderService.ts");
    const c = (await body(await fileContent(req("/api/x?path=src/services/orderService.ts"), ctx(pid)))).json;
    expect(c.content).toContain("export async function createOrder");
    expect(c.dependencies.outgoing).toContain("src/services/paymentService.ts");
    expect(c.dependencies.incoming).toContain("src/routes/orders.ts");
    const sym = c.symbols.find((s: { name: string }) => s.name === "createOrder");
    const s = (await body(await symbolRoute(req("/"), ctx(pid, { symbolId: sym.id })))).json;
    expect(s.neighborhood.calls.map((x: { name: string }) => x.name)).toContain("chargeCustomer");
    expect(s.neighborhood.writes.join(" ")).toContain("Order");
    expect(s.code).toContain("createOrder");
    const g = (await body(await graphRoute(req("/api/x?type=area"), ctx(pid)))).json;
    expect(g.graph.nodes.length).toBeGreaterThan(5);
    const mg = (await body(await graphRoute(req("/api/x?type=module&mermaid=1"), ctx(pid)))).json;
    expect(mg.mermaid).toContain("flowchart LR");
    const sg = (await body(await graphRoute(req(`/api/x?type=symbol&symbol=${sym.id}&depth=2`), ctx(pid)))).json;
    expect(sg.graph.nodes.length).toBeGreaterThan(2);
    const imp = (await body(await impactRoute(req("/api/x?type=file&id=src/utils/pricing.ts"), ctx(pid)))).json;
    expect(imp.impact.affectedRoutes.length).toBeGreaterThan(0);
    expect(imp.impact.affectedTests).toContain("tests/pricing.test.ts");
    const se = (await body(await searchRoute(req("/api/x?q=charge+customer&kinds=symbol"), ctx(pid)))).json;
    expect(se.hits[0].title).toBe("chargeCustomer");
    const sf = (await body(await searchRoute(req("/api/x?q=eval&kinds=finding&severity=High"), ctx(pid)))).json;
    expect(sf.hits.length).toBe(1);
    expect((await body(await searchRoute(req("/api/x?q=Order&symbolKind=model&language=TypeScript"), ctx(pid)))).json.hits.some((h: { title: string }) => h.title === "Order")).toBe(true);
    expect((await body(await searchRoute(req("/api/x?q="), ctx(pid)))).json.hits).toEqual([]);
  });

  it("answers repository questions with citations and keeps history", async () => {
    const r = await body(await ask(req("/", { method: "POST", body: JSON.stringify({ question: "What writes to the orders table?" }) }), ctx(pid)));
    expect(r.status).toBe(200);
    expect(r.json.answer.mode).toBe("graph");
    expect(r.json.answer.answer).toContain("createOrder");
    expect(r.json.answer.citations.some((c: { path: string; snippet?: string }) => c.path === "src/services/orderService.ts" && c.snippet)).toBe(true);
    const off = await body(await ask(req("/", { method: "POST", body: JSON.stringify({ question: "How many unicorns live in the warehouse?" }) }), ctx(pid)));
    expect(off.json.answer.insufficientEvidence).toBe(true);
    expect((await body(await askHistory(req("/"), ctx(pid)))).json.history.length).toBeGreaterThanOrEqual(2);
  });

  it("exports Markdown in the required section order, HTML (escaped) and JSON with every layer", async () => {
    const md = (await body(await exportRoute(req("/api/x?format=md"), ctx(pid)))).text;
    const order = Array.from({ length: 19 }, (_, i) => md.indexOf(`## ${i + 1}. `));
    expect(order.every((x) => x >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(md).toContain("## 18. Detailed Code Map");
    for (const t of ["### 1. Repository Tree", "### 2. Functional Component Map", "### 3. Runtime / Data Flow Map", "### 4. Dependency Map", "### 5. API Map", "### 6. Data Model Map", "### 7. Test Map", "### 8. External Integration Map", "### 9. High-Risk Component Map", "### 10. Change Impact Relationships", "### 11. Legend"]) expect(md).toContain(t);
    expect(md.trimEnd().endsWith("```")).toBe(true);
    expect(md).toContain("● Application Entry Point");
    expect(md).not.toContain("AKIAJ4Q7ZK3M2WXN5PTB");
    const json = JSON.parse((await body(await exportRoute(req("/api/x?format=json"), ctx(pid)))).text);
    expect(Object.keys(json)).toEqual(["project", "architecture", "files", "symbols", "relationships", "findings", "documentation", "flows", "dependencies", "metadata"]);
    expect(JSON.stringify(json)).not.toContain("AKIAJ4Q7ZK3M2WXN5PTB");
    const html = await exportRoute(req("/api/x?format=html"), ctx(pid));
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(html.headers.get("content-disposition")).toContain("attachment");
    expect(await html.text()).toContain("<h2 id=\"1-executive-summary\">");
    const print = await (await exportRoute(req("/api/x?format=print"), ctx(pid))).text();
    expect(print).toContain("window.print()");
    const pdf = await exportRoute(req("/api/x?format=pdf&scope=review"), ctx(pid));
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toBe('attachment; filename="sample-shop-code-review.pdf"');
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
    const viewed = await exportRoute(req("/api/x?format=pdf&download=0"), ctx(pid));
    expect(viewed.headers.get("content-disposition")).toContain("inline");
    const docx = await exportRoute(req("/api/x?format=docx&download=0"), ctx(pid));
    expect(docx.headers.get("content-disposition")).toContain("attachment"); // Word files cannot be shown in a browser
    expect(docx.headers.get("content-type")).toContain("wordprocessingml");
    const mdView = await exportRoute(req("/api/x?format=md&download=0"), ctx(pid));
    expect(mdView.headers.get("content-type")).toContain("text/plain");
  });
});

describe("API: invalid requests and failure states", () => {
  it("returns 404 with guidance for a missing project on every route", async () => {
    const missing = ctx("prj_missing");
    const calls: Promise<Response>[] = [
      Promise.resolve(getProject(req("/"), missing)), Promise.resolve(overview(req("/"), missing)), Promise.resolve(findings(req("/"), missing)),
      Promise.resolve(report(req("/"), missing)), Promise.resolve(filesRoute(req("/"), missing)), Promise.resolve(searchRoute(req("/api/x?q=a"), missing)),
      Promise.resolve(exportRoute(req("/"), missing)), Promise.resolve(ask(req("/", { method: "POST", body: JSON.stringify({ question: "hello there" }) }), missing)),
      Promise.resolve(graphRoute(req("/api/x?type=area"), missing)), Promise.resolve(architecture(req("/"), missing)),
    ];
    for (const r of await Promise.all(calls)) {
      const b = await body(r);
      expect(b.status).toBe(404);
      expect(b.json.error.code).toBe("project_not_found");
      expect(b.json.error.hint).toBeTruthy();
    }
  });

  it("rejects malformed input with 400 and a useful message", async () => {
    expect((await body(await ask(req("/", { method: "POST", body: "{}" }), ctx(pid)))).status).toBe(400);
    expect((await body(await ask(req("/", { method: "POST", body: JSON.stringify({ question: "x" }) }), ctx(pid)))).json.error.message).toContain("question");
    expect((await body(await graphRoute(req("/api/x?type=bogus"), ctx(pid)))).json.error.hint).toContain("area, module or symbol");
    expect((await body(await graphRoute(req("/api/x?type=symbol"), ctx(pid)))).status).toBe(400);
    expect((await body(await impactRoute(req("/api/x?type=nope"), ctx(pid)))).status).toBe(400);
    expect((await body(await impactRoute(req("/api/x?type=file&id=does/not/exist.ts"), ctx(pid)))).status).toBe(404);
    expect((await body(await exportRoute(req("/api/x?format=rtf"), ctx(pid)))).json.error.hint).toContain("pdf");
    expect((await body(await exportRoute(req("/api/x?format=pdf&scope=nope"), ctx(pid)))).json.error.hint).toContain("review");
    expect((await body(await exportRoute(req("/api/x?format=json&scope=review"), ctx(pid)))).status).toBe(400);
    expect((await body(await fileContent(req("/api/x"), ctx(pid)))).status).toBe(400);
    expect((await body(await fileContent(req("/api/x?path=nope.ts"), ctx(pid)))).status).toBe(404);
    expect((await body(await symbolRoute(req("/"), ctx(pid, { symbolId: "sym_nope" })))).status).toBe(404);
    expect((await body(await githubValidate(req("/", { method: "POST", body: "{" })))).status).toBe(400);
    expect((await body(await githubValidate(req("/", { method: "POST", body: JSON.stringify({ url: "https://example.com/x/y" }) })))).json.error.code).toBe("invalid_github_url");
    expect((await body(await githubImport(req("/", { method: "POST", body: JSON.stringify({}) })))).status).toBe(400);
  });

  it("uploads: valid ZIP starts a job; empty, invalid mode, malformed and hostile archives are rejected", async () => {
    const form = (mode: string, files: { name: string; data: Buffer }[]) => { const f = new FormData(); f.set("mode", mode); for (const x of files) { f.append("files", new File([new Uint8Array(x.data)], x.name)); f.append("paths", x.name); } return f; };
    const ok = await body(await upload(req("/", { method: "POST", body: form("zip", [{ name: "p.zip", data: makeZip([{ name: "a.ts", data: "export const a = 1;\n" }]) }]) })));
    expect(ok.status).toBe(201);
    expect(ok.json.jobId).toMatch(/^job_/);
    expect(ok.json.project.status).toBe("analyzing");
    expect((await body(await upload(req("/", { method: "POST", body: form("files", []) })))).json.error.code).toBe("empty_upload");
    expect((await body(await upload(req("/", { method: "POST", body: form("weird", [{ name: "a.ts", data: Buffer.from("x") }]) })))).json.error.code).toBe("invalid_request");
    expect((await body(await upload(req("/", { method: "POST", body: form("zip", [{ name: "b.zip", data: Buffer.from("garbage") }]) })))).json.error.code).toBe("bad_zip");
    expect((await body(await upload(req("/", { method: "POST", body: form("zip", [{ name: "e.zip", data: makeZip([{ name: "../evil.ts", data: "x" }]) }]) })))).json.error.code).toBe("path_traversal");
    expect((await body(await upload(req("/", { method: "POST", body: "not multipart", headers: { "content-type": "text/plain" } })))).json.error.code).toBe("invalid_upload");
    const big = await upload(new Request("http://localhost/", { method: "POST", headers: { "content-length": String(10 * 1024 * 1024 * 1024) }, body: "x" }));
    expect((await body(big)).json.error.code).toBe("upload_too_large");
  });

  it("reports 409 while analysis is unfinished and for failed analyses, with the failure reason available", async () => {
    const { files, stats } = normalizeFiles(fromStrings({ "a.ts": "export const a = 1;\n" }));
    const { projectId } = createProject({ type: "folder", name: "pending" }, files, stats);
    const job = enqueueAnalysis(projectId);
    const notReady = await body(await overview(req("/"), ctx(projectId)));
    expect(notReady.json.ready).toBe(false);
    const f = await body(await findings(req("/"), ctx(projectId)));
    expect(f.status).toBe(409);
    expect(f.json.error.code).toBe("analysis_not_ready");
    // Cancel the queued job through the API.
    const c = await body(await cancelJob(req("/", { method: "POST" }), ctx(job.id)));
    expect(c.json.job.status).toBe("cancelled");

    const failed = await analyze(fromStrings({ "README.md": "# nothing to analyse\n" }), "docs-only");
    const j = await body(await getJob(req("/"), ctx(failed.jobId)));
    expect(j.json.job.status).toBe("failed");
    expect(j.json.job.error).toContain("No source code");
    const r = await body(await findings(req("/"), ctx(failed.projectId)));
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("analysis_failed");
    expect((await body(await getJob(req("/"), ctx("job_missing")))).status).toBe(404);
  });

  it("deletes a project and everything hanging off it", async () => {
    const extra = await analyze(fromStrings({ "x.ts": "export function x() { return 1; }\n" }), "to-delete");
    expect((await body(await deleteProject(req("/", { method: "DELETE" }), ctx(extra.projectId)))).json.deleted).toBe(true);
    const db = getDb();
    for (const t of [schema.files, schema.symbols, schema.relationships, schema.findings, schema.jobs, schema.indexEntries]) expect(db.select().from(t).where(eq(t.projectId, extra.projectId)).all()).toHaveLength(0);
    expect((await body(await getProject(req("/"), ctx(extra.projectId)))).status).toBe(404);
  });

  it("reports AI/analyzer availability without exposing keys", async () => {
    const s = (await body(await status(req("/api/status")))).json;
    expect(s.ai.available).toBe(false);
    expect(JSON.stringify(s)).not.toMatch(/sk-ant|apiKey/i);
    expect(s.limits.maxUploadBytes).toBeGreaterThan(0);
  });
});
