import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { strToU8, unzipSync, zipSync } from "fflate";
import yauzl from "yauzl";
import { beforeAll, describe, expect, it } from "vitest";
import { GET as exportRoute } from "@/app/api/projects/[id]/export/route";
import { GET as filesRoute } from "@/app/api/projects/[id]/files/route";
import { GET as contentRoute } from "@/app/api/projects/[id]/files/content/route";
import { GET as findingsRoute } from "@/app/api/projects/[id]/findings/route";
import { GET as askHistory, POST as ask } from "@/app/api/projects/[id]/ask/route";
import { GET as overviewRoute } from "@/app/api/projects/[id]/overview/route";
import { GET as searchRoute } from "@/app/api/projects/[id]/search/route";
import { POST as importRoute } from "@/app/api/projects/import-bundle/route";
import { POST as uploadRoute } from "@/app/api/projects/upload/route";
import { buildBundle, importBundle, isBundleZip } from "@/lib/bundle";
import { getDb, schema } from "@/lib/db/client";
import { buildMarkdown } from "@/lib/export";
import type { DocReport } from "@/lib/docs/types";
import { analyze, fixtureFiles, freshDb } from "./helpers";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const KEY = "AKIAJ4Q7ZK3M2WXN5PTB";
let bundle: Buffer;
let originalId: string;
let originalMd: string;
let originalCounts: Record<string, number>;

const count = (table: "files" | "symbols" | "relationships" | "findings" | "questions", id: string) =>
  (getDb().select().from(schema[table]).where(eq(schema[table].projectId, id)).all() as unknown[]).length;

async function form(file: Buffer, name = "export.zip", mode?: string, field = "files"): Promise<FormData> {
  const f = new FormData();
  if (mode) f.set("mode", mode);
  f.append(field, new File([new Uint8Array(file)], name));
  return f;
}
const multipart = (f: FormData) => new Request("http://localhost/x", { method: "POST", body: f });

beforeAll(async () => {
  freshDb();
  originalId = (await analyze(fixtureFiles(), "sample-shop")).projectId;
  await ask(new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "Who depends on createOrder?" }) }), ctx(originalId));
  originalMd = buildMarkdown(originalId);
  originalCounts = Object.fromEntries((["files", "symbols", "relationships", "findings", "questions"] as const).map((t) => [t, count(t, originalId)]));
  bundle = (await buildBundle(originalId)).body;
});

describe("Brody bundle: what the zip contains", () => {
  it("holds the manifest, data, source, reports, README and launchers", () => {
    const names = Object.keys(unzipSync(new Uint8Array(bundle)));
    for (const n of ["manifest.json", "README.txt", "Open in Brody.command", "open-in-brody.sh", "Open in Brody.bat", "data/project.json", "data/files.json", "data/symbols.json", "data/relationships.json", "data/findings.json", "data/questions.json", "data/jobs.json", "source/src/services/orderService.ts", "reports/Report.pdf", "reports/Report.docx", "reports/Report.md", "reports/Report.html", "reports/Complete-Technical-Report.md"]) expect(names, n).toContain(n);
    const manifest = JSON.parse(Buffer.from(unzipSync(new Uint8Array(bundle))["manifest.json"]).toString());
    expect(manifest).toMatchObject({ format: "brody-bundle", version: 1, sourceRedacted: true, project: { name: "sample-shop" } });
    expect(manifest.counts).toEqual(originalCounts);
  });

  it("never contains a credential from the source, anywhere in the archive", () => {
    const all = unzipSync(new Uint8Array(bundle));
    for (const [name, data] of Object.entries(all)) if (!/\.(pdf|docx)$/.test(name)) expect(Buffer.from(data).toString("utf8"), name).not.toContain(KEY);
    expect(Buffer.from(all["source/src/config.ts"]).toString()).toMatch(/REDACTED/i);
  });

  it("marks the launchers executable so they run by double-click", async () => {
    const attrs = await new Promise<Record<string, number>>((resolve, reject) => {
      yauzl.fromBuffer(bundle, { lazyEntries: true }, (e, z) => {
        if (e || !z) return reject(e);
        const out: Record<string, number> = {};
        z.on("entry", (en) => { out[en.fileName] = (en.externalFileAttributes >>> 16) & 0o777; z.readEntry(); });
        z.on("end", () => resolve(out));
        z.readEntry();
      });
    });
    expect(attrs["Open in Brody.command"]).toBe(0o755);
    expect(attrs["open-in-brody.sh"]).toBe(0o755);
  });

  it("is served by the export API as an attachment", async () => {
    const res = await exportRoute(new Request("http://localhost/x?format=bundle"), ctx(originalId));
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="sample-shop-brody-bundle.zip"');
    expect(await isBundleZip(Buffer.from(await res.arrayBuffer()))).toBe(true);
  });

  it("is recognised by its manifest, and ordinary zips are not mistaken for one", async () => {
    expect(await isBundleZip(bundle)).toBe(true);
    expect(await isBundleZip(Buffer.from(zipSync({ "a.txt": strToU8("hi") })))).toBe(false);
    expect(await isBundleZip(Buffer.from("not a zip"))).toBe(false);
  });
});

describe("Brody bundle: opening it recreates the project, complete and working", () => {
  let importedId: string;
  beforeAll(async () => {
    freshDb(); // a different Brody: nothing from the original exists here
    importedId = (await importBundle(bundle)).projectId;
  });

  it("restores every table, with new ids and no re-analysis", () => {
    expect(importedId).not.toBe(originalId);
    for (const t of ["files", "symbols", "relationships", "findings", "questions"] as const) expect(count(t, importedId), t).toBe(originalCounts[t]);
    const p = getDb().select().from(schema.projects).where(eq(schema.projects.id, importedId)).get()!;
    expect(p).toMatchObject({ status: "ready", name: "sample-shop", previousProjectId: null });
    expect((p.analysis as { imported: { exportedAt: number } }).imported.exportedAt).toBeGreaterThan(0);
    expect(getDb().select().from(schema.jobs).where(eq(schema.jobs.projectId, importedId)).all()).toHaveLength(1);
  });

  it("keeps the data internally consistent: every relationship and symbol points at rows that exist", () => {
    const db = getDb();
    const fileIds = new Set(db.select().from(schema.files).where(eq(schema.files.projectId, importedId)).all().map((f) => f.id));
    const symbols = db.select().from(schema.symbols).where(eq(schema.symbols.projectId, importedId)).all();
    const symIds = new Set(symbols.map((s) => s.id));
    for (const s of symbols) expect(fileIds.has(s.fileId), `symbol ${s.name}`).toBe(true);
    for (const r of db.select().from(schema.relationships).where(eq(schema.relationships.projectId, importedId)).all()) {
      const has = (t: string, id: string) => (t === "file" ? fileIds.has(id) : t === "symbol" ? symIds.has(id) : true);
      expect(has(r.sourceType, r.sourceId) && has(r.targetType, r.targetId), `${r.kind} ${r.sourceId} -> ${r.targetId}`).toBe(true);
    }
    // Ids inside the analysis and documentation were remapped too.
    const docs = (db.select().from(schema.projects).where(eq(schema.projects.id, importedId)).get()!.analysis as { docs: DocReport }).docs;
    for (const s of docs.symbols) expect(symIds.has(s.symbolId), s.name).toBe(true);
  });

  it("produces the same report as the original project", () => {
    expect(buildMarkdown(importedId)).toBe(originalMd);
  });

  it("serves every view: overview, findings, files, source, search and ask history", async () => {
    const ov = await (await overviewRoute(new Request("http://localhost/x"), ctx(importedId))).json();
    expect(ov.brief.headline).toMatch(/Order taking backend/);
    expect(ov.project.imported.exportedAt).toBeGreaterThan(0);
    const fnd = await (await findingsRoute(new Request("http://localhost/x?severity=Critical"), ctx(importedId))).json();
    expect(fnd.findings.length).toBeGreaterThan(0);
    const files = await (await filesRoute(new Request("http://localhost/x"), ctx(importedId))).json();
    expect(files.files.some((f: { path: string }) => f.path === "src/services/orderService.ts")).toBe(true);
    const src = await (await contentRoute(new Request("http://localhost/x?path=src/services/orderService.ts"), ctx(importedId))).json();
    expect(src.content ?? src.text).toContain("export async function createOrder");
    const hits = await (await searchRoute(new Request("http://localhost/x?q=createOrder"), ctx(importedId))).json();
    expect(hits.hits.some((h: { title: string }) => /createOrder/.test(h.title))).toBe(true);
    const doc = await (await searchRoute(new Request("http://localhost/x?q=payment&kinds=doc"), ctx(importedId))).json();
    expect(doc.hits.length).toBeGreaterThan(0);
    const hist = await (await askHistory(new Request("http://localhost/x"), ctx(importedId))).json();
    expect(hist.history.some((h: { question: string }) => /createOrder/.test(h.question))).toBe(true);
  });

  it("can be exported again, and that export imports too", async () => {
    const again = (await buildBundle(importedId)).body;
    const third = (await importBundle(again)).projectId;
    expect(count("files", third)).toBe(originalCounts.files);
  });

  it("can be imported repeatedly, and into the same Brody as the original, without collisions", async () => {
    const a = (await importBundle(bundle)).projectId;
    const b = (await importBundle(bundle)).projectId;
    expect(new Set([importedId, a, b]).size).toBe(3);
    for (const id of [a, b]) expect(count("symbols", id)).toBe(originalCounts.symbols);
  });
});

describe("Brody bundle: opening it through the API", () => {
  beforeAll(() => freshDb());

  it("import-bundle recreates the project and returns it", async () => {
    const res = await importRoute(multipart(await form(bundle, "export.zip", undefined, "file")));
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j).toMatchObject({ imported: true, project: { name: "sample-shop", status: "ready" } });
    expect(j.project.imported.exportedAt).toBeGreaterThan(0);
  });

  it("a bundle dropped on the ordinary upload is opened, not analysed as source code", async () => {
    const res = await uploadRoute(multipart(await form(bundle, "sample-shop-brody-bundle.zip", "zip")));
    const j = await res.json();
    expect(res.status).toBe(201);
    expect(j.imported).toBe(true);
    expect(j.project.fileCount).toBe(originalCounts.files);
  });

  it("refuses an empty request and a non-zip file with an actionable message", async () => {
    const empty = await importRoute(new Request("http://localhost/x", { method: "POST", body: new FormData() }));
    expect(empty.status).toBe(400);
    const junk = await importRoute(multipart(await form(Buffer.from("this is not a zip"), "x.zip", undefined, "file")));
    expect(junk.status).toBe(400);
    expect((await junk.json()).error.code).toBe("bad_zip");
  });
});

describe("Brody bundle: a damaged or hostile bundle is refused, and nothing is half-imported", () => {
  const tamper = (fn: (files: Record<string, Uint8Array>) => void): Buffer => {
    const files = unzipSync(new Uint8Array(bundle));
    fn(files);
    return Buffer.from(zipSync(files));
  };
  const projectsBefore = () => getDb().select().from(schema.projects).all().length;
  const refuses = async (b: Buffer, code: string, message?: RegExp) => {
    const before = projectsBefore();
    const err = await importBundle(b).catch((e) => e);
    expect(err.code).toBe(code);
    if (message) expect(err.message).toMatch(message);
    expect(projectsBefore()).toBe(before);
  };
  beforeAll(() => freshDb());

  it("needs a manifest of the right format and a supported version", async () => {
    await refuses(Buffer.from(zipSync({ "a.txt": strToU8("x") })), "invalid_bundle", /not a Brody export/);
    await refuses(tamper((f) => { f["manifest.json"] = strToU8(JSON.stringify({ format: "something-else", version: 1, createdAt: 1, project: { name: "x", sourceType: "zip" } })); }), "invalid_bundle", /manifest/);
    await refuses(tamper((f) => { const m = JSON.parse(Buffer.from(f["manifest.json"]).toString()); m.version = 99; f["manifest.json"] = strToU8(JSON.stringify(m)); }), "invalid_bundle", /newer Brody/);
  });

  it("needs every data file, valid JSON, and correctly typed rows", async () => {
    await refuses(tamper((f) => { delete f["data/files.json"]; }), "invalid_bundle", /missing data\/files\.json/);
    await refuses(tamper((f) => { f["data/symbols.json"] = strToU8("{ not json"); }), "invalid_bundle", /not valid JSON/);
    await refuses(tamper((f) => { const rows = JSON.parse(Buffer.from(f["data/files.json"]).toString()); rows[0].lines = "many"; f["data/files.json"] = strToU8(JSON.stringify(rows)); }), "invalid_bundle", /wrong type/);
    await refuses(tamper((f) => { const rows = JSON.parse(Buffer.from(f["data/findings.json"]).toString()); delete rows[0].title; f["data/findings.json"] = strToU8(JSON.stringify(rows)); }), "invalid_bundle", /missing "title"/);
  });

  it("rejects ids that do not look like Brody's, so a crafted bundle cannot overwrite or forge rows", async () => {
    await refuses(tamper((f) => { const rows = JSON.parse(Buffer.from(f["data/files.json"]).toString()); rows[0].id = "x' OR 1=1 --"; f["data/files.json"] = strToU8(JSON.stringify(rows)); }), "invalid_bundle", /unexpected file id/);
  });

  it("requires a finished analysis and exactly one project", async () => {
    await refuses(tamper((f) => { const p = JSON.parse(Buffer.from(f["data/project.json"]).toString()); p.analysis = {}; f["data/project.json"] = strToU8(JSON.stringify(p)); }), "invalid_bundle", /finished analysis/);
    await refuses(tamper((f) => { const p = JSON.parse(Buffer.from(f["data/project.json"]).toString()); f["data/project.json"] = strToU8(JSON.stringify([p, p])); }), "invalid_bundle");
  });

  it("imports with a warning, not a failure, when some source is missing", async () => {
    const r = await importBundle(tamper((f) => { delete f["source/src/utils/pricing.ts"]; }));
    expect(r.warnings.join(" ")).toContain("src/utils/pricing.ts");
    const row = getDb().select().from(schema.files).where(eq(schema.files.projectId, r.projectId)).all().find((x) => x.path === "src/utils/pricing.ts")!;
    expect(row.hasContent).toBe(false);
  });
});

describe("Brody bundle: the one-click launcher", () => {
  const hasTools = spawnSync("sh", ["-c", "command -v zip && command -v curl"]).status === 0 && process.platform !== "win32";
  it.skipIf(!hasTools)("sends the export to a running Brody and opens the imported project", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brody-launch-"));
    const files = unzipSync(new Uint8Array(bundle));
    for (const [name, data] of Object.entries(files)) { const p = path.join(dir, "export", name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); }
    // A fake Brody that accepts the upload and answers like the real import endpoint.
    let received = 0;
    const server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/api/projects/import-bundle") {
        req.on("data", (c) => (received += c.length));
        req.on("end", () => { res.writeHead(201, { "content-type": "application/json" }); res.end(JSON.stringify({ project: { id: "prj_0123456789abcdef0123", name: "x" }, imported: true })); });
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    // `open` and `xdg-open` are replaced so no browser starts; they record the URL instead.
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    for (const b of ["open", "xdg-open"]) { fs.writeFileSync(path.join(bin, b), `#!/bin/sh\necho "$1" > "${dir}/opened.txt"\n`, { mode: 0o755 }); }
    const script = path.join(dir, "export", "open-in-brody.sh");
    fs.chmodSync(script, 0o755);
    const r = await new Promise<{ status: number | null; out: string }>((resolve) => {
      const child = spawnSyncAsync("bash", [script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BRODY_URL: `http://127.0.0.1:${port}` } });
      child.then(resolve);
    });
    server.close();
    expect(r.status, r.out).toBe(0);
    expect(received).toBeGreaterThan(10_000); // the export really was uploaded
    expect(fs.readFileSync(path.join(dir, "opened.txt"), "utf8").trim()).toBe(`http://127.0.0.1:${port}/p/prj_0123456789abcdef0123`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!hasTools)("reports a clear problem, and exits non-zero, when Brody is not running", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brody-launch2-"));
    const files = unzipSync(new Uint8Array(bundle));
    fs.mkdirSync(path.join(dir, "export"), { recursive: true });
    fs.writeFileSync(path.join(dir, "export", "manifest.json"), files["manifest.json"]);
    fs.writeFileSync(path.join(dir, "export", "open-in-brody.sh"), files["open-in-brody.sh"], { mode: 0o755 });
    const r = await spawnSyncAsync("bash", [path.join(dir, "export", "open-in-brody.sh")], { env: { ...process.env, BRODY_URL: "http://127.0.0.1:9" }, input: "\n" });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/Could not import into Brody/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/** spawnSync would block the event loop that the fake server needs, so run the script asynchronously. */
function spawnSyncAsync(cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; input?: string }): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve) => {
    void import("node:child_process").then(({ spawn }) => {
      const c = spawn(cmd, args, { env: opts.env });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.stderr.on("data", (d) => (out += d));
      c.on("close", (status) => resolve({ status, out }));
      c.stdin.end(opts.input ?? "");
    });
  });
}
