import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { GET as explainGet, POST as explainPost } from "@/app/api/projects/[id]/explain/route";
import { getDb, schema } from "@/lib/db/client";
import type { Architecture } from "@/lib/discover/types";
import { setAIProvider } from "@/lib/ai";
import { loadDocInputs } from "@/lib/docs";
import { narrateModule } from "@/lib/docs/ai";
import { explainCollection, resolveSelection } from "@/lib/docs/modules";
import type { DocReport } from "@/lib/docs/types";
import { analyze, fixtureFiles, freshDb, fromStrings, MockProvider } from "./helpers";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const jsonReq = (url: string, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) => new Request(`http://localhost${url}`, { method: "POST", headers, body: JSON.stringify(body) });

let pid: string;
let docs: DocReport;
let arch: Architecture;
beforeAll(async () => {
  freshDb();
  const r = await analyze(fixtureFiles(), "sample-shop");
  pid = r.projectId;
  const analysis = getDb().select().from(schema.projects).where(eq(schema.projects.id, pid)).get()!.analysis as { docs: DocReport; architecture: Architecture };
  docs = analysis.docs;
  arch = analysis.architecture;
});

describe("collection level: folders explained as a unit", () => {
  it("produces a folder explanation for every folder holding several source files, linked into a tree", () => {
    const mods = docs.modules!;
    const paths = mods.map((m) => m.path);
    expect(paths).toEqual(expect.arrayContaining(["src", "src/services", "src/routes", "src/db"]));
    const services = mods.find((m) => m.path === "src/services")!;
    expect(services).toMatchObject({ kind: "folder", fileCount: 2, parent: "src", origin: "deterministic" });
    expect(mods.find((m) => m.path === "src")!.children).toEqual(expect.arrayContaining(["src/services", "src/routes"]));
    // A folder with a single source file is not a collection worth explaining.
    expect(paths).not.toContain("worker");
  });

  it("explains how the files work TOGETHER: structure and interface, not a list of what each file does", () => {
    const m = docs.modules!.find((x) => x.path === "src/services")!;
    expect(m.howFilesWork).toMatch(/paymentService\.ts is imported by orderService\.ts/);
    expect(m.howFilesWork).toMatch(/Code outside reaches this collection through .*createOrder/);
    expect(m.internalLinks).toEqual([{ from: "src/services/orderService.ts", to: "src/services/paymentService.ts" }]);
    expect(m.publicSurface.map((p) => p.name)).toEqual(expect.arrayContaining(["createOrder", "getOrderById", "listOrders"]));
    expect(m.publicSurface.every((p) => p.usedBy >= 1)).toBe(true);
    expect(m.usedBy).toContain("src/routes");
    expect(m.dependsOn).toEqual(expect.arrayContaining(["src/db", "src/utils"]));
    expect(m.areas).toContain("Core Services");
  });

  it("keeps the levels distinct: file explanations stay per-file and are linked from the folder, not repeated in it", () => {
    const m = docs.modules!.find((x) => x.path === "src/services")!;
    const file = docs.files.find((f) => f.path === "src/services/orderService.ts")!;
    // The folder lists the file with the file's own one-line explanation, so the reader can drill down.
    expect(m.files.find((f) => f.path === file.path)!.purpose).toBe(file.purpose);
    // The collaboration text belongs to the folder level only.
    expect(file.purpose + file.howItOperates).not.toMatch(/work together|imports connect|import connects/);
    expect(m.purpose).not.toContain(file.howItOperates);
    // And the whole-system level does not enumerate files.
    expect(docs.executiveSummary.map((s) => s.text).join(" ")).not.toContain("orderService.ts is a service-layer");
  });

  it("reports review findings and tests that touch the collection", () => {
    const routes = docs.modules!.find((m) => m.path === "src/routes")!;
    expect(routes.findings.total).toBeGreaterThan(0);
    expect(routes.findings.top.length).toBeGreaterThan(0);
  });

  it("does not emit a pass-through parent that would only repeat its single child", async () => {
    freshDb();
    const r = await analyze(fromStrings({ "a/b/x.ts": "export const x = 1;\n", "a/b/y.ts": "import { x } from './x';\nexport const y = x + 1;\n", "README.md": "# r\n" }), "nest");
    const d = (getDb().select().from(schema.projects).where(eq(schema.projects.id, r.projectId)).get()!.analysis as { docs: DocReport }).docs;
    expect(d.modules!.map((m) => m.path)).toEqual(["a/b"]);
    expect(d.modules![0].howFilesWork).toMatch(/1 import connects/);
  });
});

describe("collection level: any group of files on demand", () => {
  beforeAll(async () => {
    freshDb();
    pid = (await analyze(fixtureFiles(), "sample-shop")).projectId;
    const a = getDb().select().from(schema.projects).where(eq(schema.projects.id, pid)).get()!.analysis as { docs: DocReport; architecture: Architecture };
    docs = a.docs; arch = a.architecture;
  });

  it("explains a hand-picked group that spans folders", () => {
    const inputs = loadDocInputs(pid, arch);
    const c = explainCollection(inputs, docs.files, ["src/services/orderService.ts", "src/routes/orders.ts"])!;
    expect(c).toMatchObject({ kind: "selection", fileCount: 2 });
    expect(c.title).toBe("2 selected files");
    expect(c.howFilesWork).toMatch(/imports? connects?|import/);
    expect(c.areas.length).toBeGreaterThan(1);
  });

  it("accepts folders and files together, and a lone folder is reported as a folder", () => {
    const inputs = loadDocInputs(pid, arch);
    expect(resolveSelection(inputs, ["src/db", "src/utils/pricing.ts"]).map((f) => f.path).sort()).toEqual(["src/db/client.ts", "src/db/models.ts", "src/utils/pricing.ts"]);
    const folder = explainCollection(inputs, docs.files, ["src/db/"])!;
    expect(folder).toMatchObject({ kind: "folder", path: "src/db", fileCount: 2 });
  });

  it("returns nothing for paths that match no source file", () => {
    const inputs = loadDocInputs(pid, arch);
    expect(explainCollection(inputs, docs.files, ["nope/missing"])).toBeNull();
    expect(explainCollection(inputs, docs.files, ["../../etc/passwd"])).toBeNull();
  });

  it("is served by the API: stored folders, folders computed on demand, and validated custom selections", async () => {
    const stored = await (await explainGet(new Request("http://localhost/x?path=src/services"), ctx(pid))).json();
    expect(stored).toMatchObject({ source: "stored", collection: { path: "src/services" } });
    const computed = await (await explainGet(new Request("http://localhost/x?path=migrations"), ctx(pid))).json();
    expect(computed).toMatchObject({ source: "computed", collection: { kind: "folder", path: "migrations", fileCount: 1 } });
    expect((await explainGet(new Request("http://localhost/x?path=nothing/here"), ctx(pid))).status).toBe(404);
    expect((await explainGet(new Request("http://localhost/x"), ctx(pid))).status).toBe(400);

    const ok = await explainPost(jsonReq("/x", { paths: ["src/services", "src/utils/pricing.ts"] }), ctx(pid));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.collection.fileCount).toBe(3);
    expect(body.ai).toEqual({ requested: false, available: false, used: false });
    expect((await explainPost(jsonReq("/x", { paths: ["src"] }, { "content-type": "text/plain" }), ctx(pid))).status).toBe(415);
    expect((await explainPost(jsonReq("/x", { paths: [] }), ctx(pid))).status).toBe(400);
    expect((await explainPost(jsonReq("/x", { paths: ["nothing/here"] }), ctx(pid))).status).toBe(404);
  });

  it("says plainly when AI narration was requested but no provider is configured", async () => {
    setAIProvider(null);
    const body = await (await explainPost(jsonReq("/x", { paths: ["src/services"], ai: true }), ctx(pid))).json();
    expect(body.ai).toMatchObject({ requested: true, available: false, used: false });
    expect(body.collection.origin).toBe("deterministic");
  });

  it("narrates a selection with the AI from the file summaries, validates the answer, and caches it", async () => {
    const provider = new MockProvider((req) => (req.task.startsWith("docs:module:")
      ? { purpose: "AI: the pair handles ordering and payment.", howFilesWork: "AI: orders call payments.", dataIn: "an order", dataOut: "a charge", keyFileNotes: [{ path: "src/services/orderService.ts", why: "entry" }, { path: "elsewhere.ts", why: "not a member" }], evidence: ["src/services/orderService.ts:10", "made/up.ts:3"] }
      : undefined));
    setAIProvider(provider);
    try {
      const first = await (await explainPost(jsonReq("/x", { paths: ["src/services"], ai: true }), ctx(pid))).json();
      expect(first.ai).toMatchObject({ requested: true, available: true, used: true });
      expect(first.collection).toMatchObject({ origin: "ai", purpose: "AI: the pair handles ordering and payment." });
      expect(first.collection.keyFiles).toEqual([{ path: "src/services/orderService.ts", why: "entry" }]);
      expect(first.collection.evidence).toEqual(["src/services/orderService.ts:10"]);
      // The prompt states the scale and forbids restating each file.
      const prompt = provider.calls[0].prompt;
      expect(prompt).toMatch(/macro explanation of a collection/);
      expect(prompt).toMatch(/Do NOT restate what each file does one by one/);
      expect(prompt).toContain("src/services/paymentService.ts");
      expect(prompt).toContain("<untrusted_repository_content>");
      // The same selection is served from the cache the second time.
      const second = await (await explainPost(jsonReq("/x", { paths: ["src/services"], ai: true }), ctx(pid))).json();
      expect(second.ai.used).toBe(true);
      expect(provider.calls).toHaveLength(1);
    } finally { setAIProvider(null); }
  });

  it("reports an AI failure without losing the structural explanation", async () => {
    setAIProvider(new MockProvider(() => { throw new Error("401 invalid x-api-key"); }));
    try {
      const body = await (await explainPost(jsonReq("/x", { paths: ["src/routes"], ai: true }), ctx(pid))).json();
      expect(body.ai).toMatchObject({ requested: true, available: true, used: false });
      expect(body.ai.error.summary).toMatch(/rejected the API key/);
      expect(body.collection.howFilesWork.length).toBeGreaterThan(20);
    } finally { setAIProvider(null); }
  });

  it("gives each level its own scale instruction in the prompt, so file, folder, area and system explanations do not blur", async () => {
    freshDb();
    const provider = new MockProvider(() => undefined);
    setAIProvider(provider);
    try {
      await analyze(fixtureFiles(), "sample-shop");
      const byTask = (t: string) => provider.calls.find((c) => c.task.startsWith(t))?.prompt ?? "";
      expect(byTask("docs:files")).toMatch(/covers ONE file on its own/);
      expect(byTask("docs:module:")).toMatch(/macro explanation of a collection/);
      expect(byTask("docs:area:")).toMatch(/macro explanation of a group of files that together deliver one capability/);
    } finally { setAIProvider(null); }
  });

  it("narrateModule falls back to the structural text for empty fields and ignores key files outside the collection", async () => {
    freshDb();
    pid = (await analyze(fixtureFiles(), "sample-shop")).projectId;
    const a = getDb().select().from(schema.projects).where(eq(schema.projects.id, pid)).get()!.analysis as { docs: DocReport; architecture: Architecture };
    docs = a.docs; arch = a.architecture;
    const inputs = loadDocInputs(pid, arch);
    const c = explainCollection(inputs, docs.files, ["src/db"])!;
    const provider = new MockProvider(() => ({ purpose: "p", howFilesWork: "", dataIn: "", dataOut: "", keyFileNotes: [{ path: "src/services/orderService.ts", why: "x" }], evidence: [] }));
    const { UsageMeter } = await import("@/lib/ai");
    const r = await narrateModule({ provider, meter: new UsageMeter(), inputs, module: c, fileDocs: new Map(docs.files.map((f) => [f.path, f])), filesByPath: new Map(inputs.files.map((f) => [f.path, f])) });
    expect(r.ok).toBe(true);
    // An empty narrative field falls back to the structural text; a non-member key file is ignored.
    expect(c.howFilesWork.length).toBeGreaterThan(10);
    expect(c.keyFiles.every((k) => k.path.startsWith("src/db/"))).toBe(true);
  });
});
