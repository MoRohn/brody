import { beforeAll, describe, expect, it } from "vitest";
import { architectureDiagramText, architectureMermaid, areaGraph, changeImpact, erMermaid, graphToMermaid, legendText, loadModel, moduleGraph, NODE_LEGEND, repositoryTree, symbolGraph, symbolNeighborhood, treeToText } from "@/lib/map";
import { askRepository } from "@/lib/ask";
import { search, retrieveContext } from "@/lib/retrieval";
import { buildHtmlDocument, markdownToHtml } from "@/lib/export/html";
import { buildMarkdown } from "@/lib/export";
import { analyze, fixtureFiles, freshDb, fromStrings } from "./helpers";

let pid: string;
beforeAll(async () => {
  freshDb();
  pid = (await analyze(fixtureFiles(), "sample-shop")).projectId;
});

describe("code map generation", () => {
  it("builds an annotated repository tree from real data", () => {
    const text = treeToText(repositoryTree(pid), { name: "sample-shop" });
    expect(text).toContain("sample-shop/");
    expect(text).toContain("├── ");
    expect(text).toContain("orderService.ts");
    expect(text).toMatch(/routes\/.*#/);
    expect(repositoryTree(pid, { includeExcluded: true }).files).toBeGreaterThanOrEqual(17);
  });

  it("produces functional-area and module graphs with meaningful edges and risk marks", () => {
    const ag = areaGraph(pid);
    expect(ag.nodes.some((n) => n.label === "API Layer")).toBe(true);
    expect(ag.edges.some((e) => e.source === "API Layer" && e.target === "Core Services")).toBe(true);
    expect(ag.nodes.some((n) => n.type === "external" && n.label === "Stripe")).toBe(true);
    const mg = moduleGraph(pid, { area: "Core Services" });
    expect(mg.nodes.map((n) => n.id).sort()).toEqual(["src/services/orderService.ts", "src/services/paymentService.ts"]);
    expect(moduleGraph(pid, { limit: 5 }).truncated).toBe(true);
    expect(moduleGraph(pid).nodes.find((n) => n.id === "src/config.ts")!.risk).toBe("critical");
  });

  it("explores a symbol: callers, callees, data access, routes, tests", () => {
    const m = loadModel(pid);
    const createOrder = m.symbols.find((s) => s.name === "createOrder")!;
    const n = symbolNeighborhood(pid, createOrder.id)!;
    expect(n.calledBy.map((c) => c.name)).toContain("POST /api/orders");
    expect(n.calls.map((c) => c.name)).toEqual(expect.arrayContaining(["chargeCustomer", "calculateTotal"]));
    expect(n.writes.join(" ")).toContain("Order");
    const total = symbolNeighborhood(pid, m.symbols.find((s) => s.name === "calculateTotal")!.id)!;
    expect(total.testedBy).toContain("tests/pricing.test.ts");
    const g = symbolGraph(pid, createOrder.id, 2);
    expect(g.nodes.length).toBeGreaterThan(3);
  });

  it("answers 'what could I affect if I change this?' with upstream chains to routes", () => {
    const m = loadModel(pid);
    const imp = changeImpact(pid, { type: "symbol", id: m.symbols.find((s) => s.name === "calculateTotal")!.id })!;
    expect(imp.chains.some((c) => c[0] === "calculateTotal" && c[c.length - 1] === "POST /api/orders")).toBe(true);
    expect(imp.affectedRoutes.map((r) => r.route)).toContain("POST /api/orders");
    expect(imp.affectedTests).toContain("tests/pricing.test.ts");
    const fileImp = changeImpact(pid, { type: "file", id: "src/utils/pricing.ts" })!;
    expect(fileImp.upstream.map((u) => u.id)).toEqual(expect.arrayContaining(["src/services/orderService.ts", "src/routes/orders.ts"]));
    expect(fileImp.summary).toContain("Changing src/utils/pricing.ts");
    expect(changeImpact(pid, { type: "file", id: "nope.ts" })).toBeUndefined();
  });

  it("renders architecture, ER and dependency diagrams with the shared legend", () => {
    expect(architectureDiagramText(pid)).toContain("API Layer");
    expect(architectureDiagramText(pid)).toContain("External Services");
    expect(architectureMermaid(pid)).toMatch(/^flowchart LR/);
    const er = erMermaid(pid)!;
    expect(er).toContain("erDiagram");
    expect(er).toMatch(/Order \}o--\|\| User/);
    const mm = graphToMermaid(moduleGraph(pid));
    expect(mm).toContain("-.->"); // imports are dashed
    const legend = legendText();
    for (const n of NODE_LEGEND) expect(legend).toContain(`${n.glyph} ${n.label}`);
    expect(legend).toContain("Risk:");
    // Not colour-only: every node label carries a glyph.
    expect(mm).toMatch(/\["[●◆■▲⬢○★TC⟳▣]/u);
  });
});

describe("retrieval and repository Q&A", () => {
  it("combines lexical, structural and importance signals and applies filters", async () => {
    const hits = await search(pid, "charge customer payment");
    expect(hits[0].title).toBe("chargeCustomer");
    expect(hits[0].signals.lexical).toBeGreaterThan(0);
    expect(hits.some((h) => h.kind === "file" && h.path === "src/services/paymentService.ts")).toBe(true);
    // Structural expansion pulls in neighbours that share no query terms.
    const structural = await search(pid, "chargeCustomer", { kinds: ["symbol"] });
    expect(structural.some((h) => h.signals.structural > 0)).toBe(true);
    expect((await search(pid, "createOrder", { kinds: ["symbol"], symbolKind: "function" })).every((h) => h.meta?.symbolKind === "function")).toBe(true);
    expect((await search(pid, "order", { language: "Python" })).every((h) => h.meta?.language === "Python")).toBe(true);
    expect((await search(pid, "eval", { kinds: ["finding"], category: "Security" })).length).toBe(1);
    expect((await search(pid, "eval", { kinds: ["finding"], category: "Performance" })).length).toBe(0);
    expect((await search(pid, "xylophone quasar")).length).toBe(0);
  });

  it("searches raw code and assembles cited context with real line ranges", async () => {
    const code = await search(pid, "INSERT INTO receipt_queue", { kinds: ["code"], includeCode: true });
    expect(code[0]).toMatchObject({ kind: "code", path: "src/services/orderService.ts", line: 14 });
    const ctx = await retrieveContext(pid, "how is the payment charged");
    expect(ctx.evidence.length).toBeGreaterThan(0);
    expect(ctx.evidence[0].text).toBeTruthy();
    expect(ctx.evidence.every((e) => e.startLine >= 1 && e.endLine >= e.startLine)).toBe(true);
  });

  it("answers structural questions exactly from the graph and never claims unsupported knowledge", async () => {
    const dep = await askRepository(pid, "Which components depend on calculateTotal?");
    expect(dep.mode).toBe("graph");
    expect(dep.answer).toContain("createOrder");
    expect(dep.answer).toContain("tests/pricing.test.ts");
    const where = await askRepository(pid, "Where is toCents defined?");
    expect(where.answer).toContain("src/utils/pricing.ts:");
    expect(where.citations[0]).toMatchObject({ path: "src/utils/pricing.ts" });
    const flow = await askRepository(pid, "What happens after POST /api/orders?");
    expect(flow.answer).toContain("createOrder");
    expect(flow.answer).toContain("chargeCustomer");
    const writes = await askRepository(pid, "What writes to the orders table?");
    expect(writes.answer).toContain("createOrder");
    const none = await askRepository(pid, "Explain the kubernetes cluster autoscaler");
    expect(none.insufficientEvidence).toBe(true);
    expect(none.citations).toHaveLength(0);
    // Every citation resolves to a real file and line.
    const real = new Set(fixtureFiles().map((f) => f.path));
    for (const a of [dep, where, flow, writes]) for (const c of a.citations) { expect(real.has(c.path)).toBe(true); expect(c.startLine).toBeGreaterThanOrEqual(1); }
  });
});

describe("report rendering safety", () => {
  it("escapes HTML in every position of the exported report", () => {
    const md = "# T <img src=x onerror=alert(1)>\n\n| a | b |\n| --- | --- |\n| `<script>x</script>` | **<b>bold</b>** |\n\n- item <i>1</i>\n\n```html\n<script>alert(1)</script>\n```\n";
    const html = markdownToHtml(md);
    expect(html).not.toMatch(/<script>|<img |<b>|<i>/);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(buildHtmlDocument("<x>", md)).toContain("<title>&lt;x&gt;</title>");
  });

  it("does not let hostile repository content inject markup into the HTML report", async () => {
    freshDb();
    const files = fromStrings({
      "package.json": JSON.stringify({ name: "x", description: "<img src=x onerror=alert(1)> app" }),
      "src/<script>alert(1)</script>.ts": "export function evil() { return eval('<script>alert(2)</script>'); }\n",
      "README.md": "# <script>alert(3)</script>\n\nA readme.\n",
    });
    const r = await analyze(files, "evil");
    const html = (await import("@/lib/export")).buildHtml(r.projectId);
    const body = html.slice(html.indexOf("<main>"));
    expect(body).not.toMatch(/<script>alert|<img src=x/);
    expect(buildMarkdown(r.projectId)).toContain("Repository Intelligence Report");
  });
});
