import { beforeAll, describe, expect, it } from "vitest";
import mammoth from "mammoth";
import { askRepository } from "@/lib/ask";
import { parseReport } from "@/lib/export/document";
import { exportFile, buildMarkdown, SCOPES, type ReportScope } from "@/lib/export";
import { extractZip } from "@/lib/ingest/zip";
import { analyze, fixtureFiles, freshDb } from "./helpers";

let pid: string;
beforeAll(async () => {
  freshDb();
  pid = (await analyze(fixtureFiles(), "sample-shop")).projectId;
  await askRepository(pid, "Which components depend on createOrder?");
});

async function pdfText(buf: Buffer): Promise<{ pages: number; text: string; outline: number }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: false, verbosity: 0 }).promise;
  let text = "";
  for (let i = 1; i <= doc.numPages; i++) { const page = await doc.getPage(i); const c = await page.getTextContent(); text += c.items.map((it) => ("str" in it ? it.str : "")).join(" ") + "\n"; }
  const outline = (await doc.getOutline())?.length ?? 0;
  return { pages: doc.numPages, text, outline };
}

describe("report document model", () => {
  it("parses headings, inline styles, lists, tables, code and diagrams", () => {
    const d = parseReport("# Title\n\nsample  \nGenerated today\n\n## 1. Section\n\nText with **bold**, _italic_, `code` and [link](https://example.com).\n\n- one\n- two\n  - nested\n\n1. first\n2. second\n\n| A | B |\n| --- | --- |\n| x | `y` |\n\n```text\nbox\n```\n\n```mermaid\nflowchart LR\n```\n");
    expect(d.title).toBe("Title");
    expect(d.subtitle.join(" ")).toContain("sample");
    const types = d.blocks.map((b) => b.type);
    expect(types).toEqual(["heading", "paragraph", "list", "list", "table", "code", "note"]);
    const para = d.blocks[1] as Extract<(typeof d.blocks)[number], { type: "paragraph" }>;
    expect(para.runs.some((r) => r.bold && r.text === "bold")).toBe(true);
    expect(para.runs.some((r) => r.italic)).toBe(true);
    expect(para.runs.some((r) => r.code && r.text === "code")).toBe(true);
    expect(para.runs.some((r) => r.href === "https://example.com")).toBe(true);
    const table = d.blocks[4] as Extract<(typeof d.blocks)[number], { type: "table" }>;
    expect(table.rows[0][1][0]).toMatchObject({ code: true, text: "y" });
    expect((d.blocks[6] as { text: string }).text).toContain("Diagram omitted");
  });
});

describe("scoped reports", () => {
  it("numbers sections sequentially within each scope and keeps the required order in the full report", () => {
    const full = buildMarkdown(pid);
    const order = [...full.matchAll(/^## (\d+)\. (.+)$/gm)];
    expect(order.map((m) => Number(m[1]))).toEqual(Array.from({ length: 19 }, (_, i) => i + 1));
    expect(order[0][2]).toBe("Executive Summary");
    expect(order[17][2]).toBe("Detailed Code Map");
    expect(order[18][2]).toBe("Legend");
    for (const scope of ["review", "explain", "architecture", "map", "ask"] as ReportScope[]) {
      const md = buildMarkdown(pid, { scope });
      expect(md.startsWith(`# ${SCOPES[scope].title}`)).toBe(true);
      expect([...md.matchAll(/^## (\d+)\./gm)][0]?.[1]).toBe("1");
    }
    expect(buildMarkdown(pid, { scope: "review" })).toContain("SEC-");
    expect(buildMarkdown(pid, { scope: "review" })).not.toContain("Detailed Code Map");
    expect(buildMarkdown(pid, { scope: "map" })).toContain("### 1. Repository Tree");
    const qa = buildMarkdown(pid, { scope: "ask" });
    expect(qa).toContain("Which components depend on createOrder?");
    expect(qa).toContain("src/services/orderService.ts");
  });
});

describe("PDF export", () => {
  it("produces a valid, searchable PDF with cover, contents, bookmarks and every section", async () => {
    const r = await exportFile(pid, "pdf", "full");
    const buf = r.body as Buffer;
    expect(r.contentType).toBe("application/pdf");
    expect(r.filename).toBe("sample-shop-report.pdf");
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(buf.subarray(-8).toString()).toContain("%%EOF");
    const { pages, text, outline } = await pdfText(buf);
    expect(pages).toBeGreaterThan(10);
    expect(outline).toBe(20); // 19 sections plus the executive slides
    expect(text).toContain("Repository Intelligence Report");
    expect(text).toContain("Contents");
    for (const t of ["Executive Summary", "Code Review", "Detailed Code Map", "Legend", "POST /api/orders", "SEC-", "createOrder", "At a glance", "Key points", "Health and risk", "Recommended next steps"]) expect(text).toContain(t);
    expect(text).toMatch(/Page \d+ of \d+/);
    // Legend glyphs are embedded, including ones that need a fallback face.
    for (const g of ["●", "◆", "▲", "★", "⬢", "⟳"]) expect(text).toContain(g);
  });

  it("lists the same page numbers in the contents as the sections actually start on", async () => {
    const buf = (await exportFile(pid, "pdf", "review")).body as Buffer;
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), verbosity: 0 }).promise;
    const first = (await (await doc.getPage(1)).getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join(" ");
    const listed = [...first.matchAll(/\d+\. Code Review\s+(\d+)/g)].map((m) => Number(m[1]));
    expect(listed.length).toBe(1);
    const target = (await (await doc.getPage(listed[0])).getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join(" ");
    expect(target).toContain("Code Review");
  });

  it("scoped PDFs are smaller and self-consistent", async () => {
    const full = (await exportFile(pid, "pdf", "full")).body as Buffer;
    const map = await exportFile(pid, "pdf", "map");
    expect((map.body as Buffer).length).toBeLessThan(full.length);
    expect(map.filename).toBe("sample-shop-code-map.pdf");
    const t = await pdfText(map.body as Buffer);
    expect(t.text).toContain("Repository Tree");
    expect(t.text).not.toContain("Executive Summary");
  });
});

describe("Word export", () => {
  it("produces a valid .docx with real headings, tables, lists and code that a document parser can read", async () => {
    const r = await exportFile(pid, "docx", "full");
    const buf = r.body as Buffer;
    expect(r.contentType).toContain("wordprocessingml");
    expect(r.filename).toBe("sample-shop-report.docx");
    const zip = await extractZip(buf);
    const names = zip.files.map((f) => f.path);
    expect(names).toEqual(expect.arrayContaining(["word/document.xml", "word/styles.xml", "word/numbering.xml", "[Content_Types].xml", "docProps/core.xml"]));
    const xml = zip.files.find((f) => f.path === "word/document.xml")!.content.toString();
    expect(xml).toContain('w:val="Heading2"');
    expect(xml).toContain("<w:tbl>");
    expect(xml).toContain("Consolas");
    const html = (await mammoth.convertToHtml({ buffer: buf })).value;
    expect(html).toContain("<h2>");
    expect(html).toContain("<table>");
    expect(html).toContain("<ul>");
    const text = (await mammoth.extractRawText({ buffer: buf })).value;
    for (const t of ["Repository Intelligence Report", "Executive Summary", "POST /api/orders", "Detailed Code Map", "Legend"]) expect(text).toContain(t);
    const messages = (await mammoth.convertToHtml({ buffer: buf })).messages.filter((m) => m.type === "error");
    expect(messages).toEqual([]);
  });
});

describe("Markdown and HTML exports", () => {
  it("names the full Markdown CODEBASE_REPORT.md and scoped ones by scope", async () => {
    expect((await exportFile(pid, "md", "full")).filename).toBe("CODEBASE_REPORT.md");
    expect((await exportFile(pid, "md", "review")).filename).toBe("sample-shop-code-review.md");
    const html = await exportFile(pid, "html", "explain");
    expect(html.filename).toBe("sample-shop-system-explanation.html");
    expect(html.body).toContain("<title>System Explanation: sample-shop</title>");
  });
  it("serves repeated requests from cache (except live Q&A)", async () => {
    const a = await exportFile(pid, "pdf", "review");
    const b = await exportFile(pid, "pdf", "review");
    expect(b).toBe(a);
    const q1 = await exportFile(pid, "md", "ask");
    await askRepository(pid, "Where is toCents defined?");
    const q2 = await exportFile(pid, "md", "ask");
    expect(q2.body).not.toBe(q1.body);
    expect(q2.body).toContain("Where is toCents defined?");
  });
});
