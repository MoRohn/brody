import { AlignmentType, BorderStyle, Document, ExternalHyperlink, Footer, Header, HeadingLevel, LevelFormat, Packer, PageNumber, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType, type ParagraphChild } from "docx";
import { outline, plain, type Block, type ReportDocument, type Run } from "./document";

const FONT = "Calibri";
const MONO = "Consolas";
const LINK = "006C96";
const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_4];

function children(rs: Run[], size?: number): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  for (const r of rs) {
    const parts = r.text.split("\n");
    parts.forEach((part, i) => {
      const run = new TextRun({ text: part, bold: r.bold, italics: r.italic, font: r.code ? MONO : undefined, size: size ? size : r.code ? 18 : undefined, color: r.href ? LINK : undefined, underline: r.href ? {} : undefined, shading: r.code ? { type: ShadingType.CLEAR, fill: "E3EDF3", color: "auto" } : undefined, break: i > 0 ? 1 : undefined });
      out.push(r.href && /^https?:/.test(r.href) ? new ExternalHyperlink({ link: r.href, children: [run] }) : run);
    });
  }
  return out;
}

function render(blocks: Block[], level = 0): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "heading":
        out.push(new Paragraph({ heading: HEADINGS[Math.min(b.level, 5)], children: children(b.runs), keepNext: true, spacing: { before: b.level <= 2 ? 360 : 240, after: 120 }, pageBreakBefore: false }));
        break;
      case "paragraph":
        out.push(new Paragraph({ children: children(b.runs), spacing: { after: 120, line: 276 } }));
        break;
      case "note":
        out.push(new Paragraph({ children: [new TextRun({ text: b.text, italics: true, color: "3D5265" })], spacing: { after: 120 } }));
        break;
      case "rule":
        out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "C4D5E0", space: 1 } }, spacing: { after: 120 } }));
        break;
      case "quote":
        for (const p of render(b.blocks, level)) out.push(p);
        break;
      case "code": {
        const lines = b.text.replace(/\t/g, "    ").split("\n");
        lines.forEach((line, i) => out.push(new Paragraph({
          children: [new TextRun({ text: line === "" ? " " : line, font: MONO, size: lines.some((l) => l.length > 100) ? 14 : 17 })],
          shading: { type: ShadingType.CLEAR, fill: "EAF1F5", color: "auto" },
          spacing: { after: i === lines.length - 1 ? 160 : 0, line: 240 },
          keepLines: true,
          keepNext: i < lines.length - 1 && lines.length <= 30,
          indent: { left: 60, right: 60 },
        })));
        break;
      }
      case "list":
        b.items.forEach((item) => {
          item.forEach((blk, i) => {
            if (blk.type === "paragraph") out.push(new Paragraph({ children: children(blk.runs), numbering: i === 0 ? { reference: b.ordered ? "numbers" : "bullets", level: Math.min(level, 2) } : undefined, indent: i === 0 ? undefined : { left: 720 + level * 360 }, spacing: { after: 60 } }));
            else out.push(...render([blk], level + 1));
          });
        });
        break;
      case "table": {
        const cols = Math.max(b.header.length, 1);
        const border = { style: BorderStyle.SINGLE, size: 4, color: "C4D5E0" };
        const cell = (rs: Run[], header: boolean) => new TableCell({
          children: [new Paragraph({ children: children(header ? rs.map((r) => ({ ...r, bold: true })) : rs, 17), spacing: { after: 0 } })],
          shading: header ? { type: ShadingType.CLEAR, fill: "DFEAF1", color: "auto" } : undefined,
          margins: { top: 50, bottom: 50, left: 80, right: 80 },
          borders: { top: border, bottom: border, left: border, right: border },
        });
        out.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [new TableRow({ tableHeader: true, cantSplit: true, children: b.header.map((h) => cell(h, true)) }), ...b.rows.map((r) => new TableRow({ cantSplit: true, children: Array.from({ length: cols }, (_, i) => cell(r[i] ?? [], false)) }))],
        }));
        out.push(new Paragraph({ spacing: { after: 160 } }));
        break;
      }
    }
  }
  return out;
}

/** Render the report as a Word document. */
export async function renderDocx(doc: ReportDocument, meta: { footer: string; author?: string }): Promise<Buffer> {
  const toc = outline(doc);
  const cover: Paragraph[] = [
    new Paragraph({ children: [new TextRun({ text: doc.title, bold: true, size: 44, font: FONT })], heading: HeadingLevel.TITLE, spacing: { before: 200, after: 200 } }),
    ...doc.subtitle.map((line) => new Paragraph({ children: [new TextRun({ text: line.replace(/[*_`]/g, ""), color: "3D5265", size: 20 })], spacing: { after: 60 } })),
    ...(toc.length ? [new Paragraph({ children: [new TextRun({ text: "Contents", bold: true, size: 26 })], spacing: { before: 400, after: 120 } }), ...toc.map((t) => new Paragraph({ children: [new TextRun({ text: t, size: 21 })], spacing: { after: 40 } }))] : []),
    new Paragraph({ pageBreakBefore: true, children: [] }),
  ];
  const document = new Document({
    creator: meta.author ?? "Brody",
    title: doc.title,
    description: "Generated by Brody repository intelligence",
    styles: {
      default: { document: { run: { font: FONT, size: 21 } } },
      paragraphStyles: [
        { id: "Title", name: "Title", basedOn: "Normal", run: { size: 44, bold: true, font: FONT } },
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 34, bold: true, color: "1B4965" }, paragraph: { spacing: { before: 360, after: 160 } } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 28, bold: true, color: "006C96" }, paragraph: { spacing: { before: 360, after: 120 } } },
        { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 24, bold: true, color: "0A1A26" }, paragraph: { spacing: { before: 240, after: 100 } } },
        { id: "Heading4", name: "Heading 4", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 21, bold: true, color: "3D5265" }, paragraph: { spacing: { before: 200, after: 80 } } },
      ],
    },
    numbering: {
      config: [
        { reference: "bullets", levels: [0, 1, 2].map((level) => ({ level, format: LevelFormat.BULLET, text: level === 0 ? "•" : level === 1 ? "◦" : "▪", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540 + level * 360, hanging: 260 } } } })) },
        { reference: "numbers", levels: [0, 1, 2].map((level) => ({ level, format: LevelFormat.DECIMAL, text: `%${level + 1}.`, alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540 + level * 360, hanging: 300 } } } })) },
      ],
    },
    sections: [{
      properties: { page: { margin: { top: 1000, bottom: 1000, left: 1100, right: 1100 } } },
      headers: { default: new Header({ children: [new Paragraph({ children: [new TextRun({ text: doc.title, size: 16, color: "8A93A0" })], alignment: AlignmentType.RIGHT })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `${meta.footer}  ·  Page `, size: 16, color: "8A93A0" }), new TextRun({ children: [PageNumber.CURRENT], size: 16, color: "8A93A0" }), new TextRun({ text: " of ", size: 16, color: "8A93A0" }), new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: "8A93A0" })] })] }) },
      children: [...cover, ...render(doc.blocks)],
    }],
  });
  return Buffer.from(await Packer.toBuffer(document));
}

export { plain };
