import path from "node:path";
import PDFDocument from "pdfkit";
import * as fontkit from "fontkit";
import { outline, plain, type Block, type ReportDocument, type Run } from "./document";
import { maxOf } from "../util/arrays";
import type { ExecutiveBrief } from "../docs/types";

// DejaVu covers the box-drawing and geometric symbols used by the code map legend, unlike the built-in PDF fonts.
const FONT_DIR = path.join(process.cwd(), "node_modules", "dejavu-fonts-ttf", "ttf");
const F = { r: "Body", b: "Body-Bold", i: "Body-Italic", bi: "Body-BoldItalic", m: "Mono", mb: "Mono-Bold", symSans: "Sym-Sans", symSerif: "Sym-Serif" };
const COLORS = { text: "#0A1A26", muted: "#3D5265", accent: "#006C96", navy: "#1B4965", line: "#C4D5E0", head: "#DFEAF1", code: "#EAF1F5" };

const PAGE = { width: 595.28, height: 841.89, left: 54, right: 54, top: 58, bottom: 62 };
const CONTENT_W = PAGE.width - PAGE.left - PAGE.right;

type Doc = InstanceType<typeof PDFDocument>;

function setup(doc: Doc) {
  doc.registerFont(F.r, path.join(FONT_DIR, "DejaVuSansCondensed.ttf"));
  doc.registerFont(F.b, path.join(FONT_DIR, "DejaVuSansCondensed-Bold.ttf"));
  doc.registerFont(F.i, path.join(FONT_DIR, "DejaVuSansCondensed-Oblique.ttf"));
  doc.registerFont(F.bi, path.join(FONT_DIR, "DejaVuSansCondensed-BoldOblique.ttf"));
  doc.registerFont(F.m, path.join(FONT_DIR, "DejaVuSansMono.ttf"));
  doc.registerFont(F.mb, path.join(FONT_DIR, "DejaVuSansMono-Bold.ttf"));
  doc.registerFont(F.symSans, path.join(FONT_DIR, "DejaVuSans.ttf"));
  doc.registerFont(F.symSerif, path.join(FONT_DIR, "DejaVuSerif.ttf"));
}

/**
 * No single DejaVu face covers every symbol on the legend (hexagon, cycle and hooked arrows are spread over three),
 * so characters the primary face lacks are drawn from a fallback face.
 */
const coverage = new Map<string, { hasGlyphForCodePoint(cp: number): boolean }>();
function covers(file: string, cp: number): boolean {
  let f = coverage.get(file);
  if (!f) { f = fontkit.openSync(path.join(FONT_DIR, file)) as unknown as { hasGlyphForCodePoint(cp: number): boolean }; coverage.set(file, f); }
  return f.hasGlyphForCodePoint(cp);
}
const FILE_OF: Record<string, string> = { [F.r]: "DejaVuSansCondensed.ttf", [F.b]: "DejaVuSansCondensed-Bold.ttf", [F.i]: "DejaVuSansCondensed-Oblique.ttf", [F.bi]: "DejaVuSansCondensed-BoldOblique.ttf", [F.m]: "DejaVuSansMono.ttf", [F.mb]: "DejaVuSansMono-Bold.ttf" };

function withFallback(text: string, primary: string): { text: string; font: string }[] {
  const out: { text: string; font: string }[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    let font = primary;
    if (cp > 0x7f && !covers(FILE_OF[primary] ?? "DejaVuSans.ttf", cp)) font = covers("DejaVuSans.ttf", cp) ? F.symSans : covers("DejaVuSerif.ttf", cp) ? F.symSerif : primary;
    const last = out[out.length - 1];
    if (last && last.font === font) last.text += ch; else out.push({ text: ch, font });
  }
  return out;
}

const fontFor = (r: Run, forceBold = false): string => (r.code ? (r.bold || forceBold ? F.mb : F.m) : (r.bold || forceBold) && r.italic ? F.bi : r.bold || forceBold ? F.b : r.italic ? F.i : F.r);
const bottom = () => PAGE.height - PAGE.bottom;

/** Write styled runs as one flowing paragraph. Runs change font mid-line using pdfkit's `continued` mode. */
function writeRuns(doc: Doc, rs: Run[], o: { x: number; y?: number; width: number; size: number; color?: string; bold?: boolean; lineGap?: number; align?: "left" | "center" }) {
  const segs: { text: string; font: string; run: Run }[] = [];
  for (const r of rs) if (r.text.length > 0) for (const p of withFallback(r.text, fontFor(r, o.bold))) segs.push({ ...p, run: r });
  if (segs.length === 0) return;
  segs.forEach((sg, i) => {
    const r = sg.run;
    doc.font(sg.font).fontSize(r.code ? o.size - 0.8 : o.size).fillColor(r.href ? COLORS.accent : r.code ? "#3B3F46" : (o.color ?? COLORS.text));
    const last = i === segs.length - 1;
    const opts = { width: o.width, continued: !last, link: r.href && /^https?:/.test(r.href) ? r.href : undefined, underline: !!r.href, lineGap: o.lineGap ?? 2, align: o.align ?? "left" } as const;
    if (i === 0) doc.text(sg.text, o.x, o.y ?? doc.y, opts);
    else doc.text(sg.text, opts);
  });
}

function ensureSpace(doc: Doc, need: number) {
  if (doc.y + need > bottom()) doc.addPage();
}

function textHeight(doc: Doc, rs: Run[], width: number, size: number, bold = false): number {
  // Monospaced runs are wider, so a cell containing code is measured with the monospaced face to avoid overflow.
  const hasCode = rs.some((r) => r.code);
  doc.font(hasCode ? F.m : bold ? F.b : F.r).fontSize(hasCode ? size - 0.8 : size);
  return doc.heightOfString(plain(rs) || " ", { width, lineGap: 1.5 }) + 0.5;
}

function longestWord(doc: Doc, rs: Run[], size: number, bold: boolean): number {
  let w = 0;
  for (const r of rs) {
    doc.font(r.code ? F.m : bold || r.bold ? F.b : F.r).fontSize(r.code ? size - 0.8 : size);
    for (const word of r.text.split(/\s+/)) w = Math.max(w, doc.widthOfString(word));
  }
  return w;
}

function drawCode(doc: Doc, text: string, x: number, width: number) {
  const raw = text.replace(/\t/g, "    ").split("\n");
  while (raw.length > 1 && raw[raw.length - 1] === "") raw.pop();
  const longest = maxOf(raw.map((l) => l.length), 1);
  const size = Math.max(5.6, Math.min(8, (width - 8) / (longest * 0.602)));
  const maxChars = Math.max(20, Math.floor((width - 8) / (size * 0.602)));
  const lines: string[] = [];
  for (const l of raw) { if (l.length <= maxChars) lines.push(l); else for (let i = 0; i < l.length; i += maxChars) lines.push(l.slice(i, i + maxChars)); }
  const lineH = size * 1.32;
  doc.moveDown(0.15);
  let idx = 0;
  while (idx < lines.length) {
    const avail = bottom() - doc.y - 8;
    const n = Math.min(lines.length - idx, Math.floor(avail / lineH));
    if (n < Math.min(3, lines.length - idx)) { doc.addPage(); continue; }
    const y0 = doc.y;
    doc.save().rect(x, y0 - 3, width, n * lineH + 6).fill(COLORS.code).restore();
    doc.font(F.m).fontSize(size).fillColor(COLORS.text);
    for (let k = 0; k < n; k++) {
      const segs = withFallback(lines[idx + k] === "" ? " " : lines[idx + k], F.m);
      segs.forEach((sg, si) => {
        doc.font(sg.font).fontSize(size);
        if (si === 0) doc.text(sg.text, x + 4, y0 + k * lineH, { lineBreak: false, continued: si < segs.length - 1 });
        else doc.text(sg.text, { lineBreak: false, continued: si < segs.length - 1 });
      });
    }
    idx += n;
    doc.x = x;
    doc.y = y0 + n * lineH + 8;
  }
  doc.moveDown(0.3);
}

function drawTable(doc: Doc, header: Run[][], rows: Run[][][], x: number, width: number) {
  const cols = Math.max(header.length, 1);
  const weights = Array.from({ length: cols }, (_, c) => {
    const lens = [plain(header[c] ?? []).length, ...rows.map((r) => plain(r[c] ?? []).length)];
    const sorted = lens.sort((a, b) => a - b);
    // Use a high percentile so one very long cell does not starve the others.
    const base = Math.min(60, Math.max(6, sorted[Math.floor(sorted.length * 0.85)] ?? 6));
    return rows.some((r) => (r[c] ?? []).some((x) => x.code)) ? base * 1.15 : base;
  });
  const sum = weights.reduce((a, b) => a + b, 0);
  const pad = 3.5;
  const size = 7.8;
  // A column is never narrower than its longest header word, so headers do not break mid-word.
  const minWs = Array.from({ length: cols }, (_, c) => Math.max(36, longestWord(doc, header[c] ?? [], size, true) + pad * 2 + 2));
  let widths = weights.map((w, c) => Math.max(minWs[c], (w / sum) * width));
  for (let guard = 0; guard < 6; guard++) {
    const total = widths.reduce((a, b) => a + b, 0);
    if (Math.abs(total - width) < 0.5) break;
    const flex = widths.map((w, c) => (w > minWs[c] + 0.5 ? w - minWs[c] : 0));
    const flexSum = flex.reduce((a, b) => a + b, 0) || 1;
    widths = widths.map((w, c) => Math.max(minWs[c], w + ((width - total) * flex[c]) / flexSum));
  }

  const drawRow = (cells: Run[][], isHeader: boolean) => {
    const heights = widths.map((w, c) => textHeight(doc, cells[c] ?? [], w - pad * 2, size, isHeader));
    const rowH = maxOf(heights, 0) + pad * 2;
    if (doc.y + Math.min(rowH, 200) > bottom()) { doc.addPage(); if (!isHeader) drawRow(header, true); }
    const y0 = doc.y;
    let cx = x;
    const fits = rowH < bottom() - PAGE.top;
    widths.forEach((w, c) => {
      if (isHeader) doc.save().rect(cx, y0, w, rowH).fill(COLORS.head).restore();
      if (fits) doc.save().lineWidth(0.4).strokeColor(COLORS.line).rect(cx, y0, w, rowH).stroke().restore();
      writeRuns(doc, cells[c] ?? [], { x: cx + pad, y: y0 + pad, width: w - pad * 2, size, bold: isHeader, lineGap: 1.5 });
      cx += w;
    });
    doc.x = x;
    doc.y = fits ? y0 + rowH : Math.max(doc.y, y0 + rowH);
  };
  drawRow(header, true);
  for (const r of rows) drawRow(r, false);
  doc.x = x;
  doc.moveDown(0.6);
}

interface Ctx { outlineParents: { h2?: PDFKit.PDFOutline }; pages: number[]; headingIdx: number }

function drawBlocks(doc: Doc, blocks: Block[], ctx: Ctx, x = PAGE.left, width = CONTENT_W, level = 0) {
  for (const b of blocks) {
    doc.x = x;
    switch (b.type) {
      case "heading": {
        const size = b.level <= 1 ? 20 : b.level === 2 ? 15 : b.level === 3 ? 12 : 10;
        ensureSpace(doc, size * 3 + 30);
        if (b.level === 2) doc.moveDown(0.6);
        else doc.moveDown(b.level === 3 ? 0.5 : 0.35);
        const title = plain(b.runs);
        if (b.level === 2) {
          ctx.pages[ctx.headingIdx++] = doc.bufferedPageRange().count;
          ctx.outlineParents.h2 = doc.outline.addItem(title);
        } else if (b.level === 3 && ctx.outlineParents.h2) ctx.outlineParents.h2.addItem(title);
        writeRuns(doc, b.runs, { x, width, size, bold: true, color: b.level === 1 ? COLORS.navy : b.level === 2 ? COLORS.accent : b.level >= 4 ? COLORS.muted : COLORS.text, lineGap: 1 });
        if (b.level <= 2) { doc.save().moveTo(x, doc.y + 1).lineTo(x + width, doc.y + 1).lineWidth(0.6).strokeColor(COLORS.line).stroke().restore(); doc.moveDown(0.45); } else doc.moveDown(0.2);
        break;
      }
      case "paragraph":
        writeRuns(doc, b.runs, { x, width, size: 9.4, lineGap: 2.2 });
        doc.moveDown(0.55);
        break;
      case "note":
        writeRuns(doc, [{ text: b.text, italic: true }], { x, width, size: 8.6, color: COLORS.muted });
        doc.moveDown(0.5);
        break;
      case "rule":
        doc.save().moveTo(x, doc.y).lineTo(x + width, doc.y).lineWidth(0.5).strokeColor(COLORS.line).stroke().restore();
        doc.moveDown(0.6);
        break;
      case "code":
        drawCode(doc, b.text, x, width);
        break;
      case "quote":
        drawBlocks(doc, b.blocks, ctx, x + 12, width - 12, level);
        break;
      case "table":
        drawTable(doc, b.header, b.rows, x, width);
        break;
      case "list": {
        b.items.forEach((item, n) => {
          const marker = b.ordered ? `${n + 1}.` : level === 0 ? "•" : "–";
          const indent = 14 + level * 4;
          item.forEach((blk, i) => {
            if (blk.type === "paragraph") {
              ensureSpace(doc, 24);
              const y0 = doc.y;
              if (i === 0) { doc.font(F.r).fontSize(9.4).fillColor(COLORS.muted).text(marker, x + 2, y0, { width: indent, lineBreak: false }); }
              writeRuns(doc, blk.runs, { x: x + indent + 4, y: y0, width: width - indent - 4, size: 9.4, lineGap: 2 });
              doc.moveDown(0.25);
            } else drawBlocks(doc, [blk], ctx, x + indent + 4, width - indent - 4, level + 1);
          });
        });
        doc.x = x;
        doc.moveDown(0.35);
        break;
      }
    }
  }
}


// ---------------------------------------------------------------------------
// Executive summary slides: landscape 16:9 pages with big type, for the business reader.
// ---------------------------------------------------------------------------
const SLIDE = { w: 841.89, h: 473.56 };
const SLIDE_MARGIN = 40;
const SLIDE_W = SLIDE.w - SLIDE_MARGIN * 2;
const PRIORITY_COLOR: Record<string, string> = { Now: "#B3261E", Next: "#006C96", Later: "#5B6E7C" };

function slidePage(pdf: Doc, title: string, kicker: string, projectName: string, first = false) {
  pdf.addPage({ size: [SLIDE.w, SLIDE.h], margins: { top: 0, left: 0, right: 0, bottom: 0 } });
  if (first) pdf.outline.addItem("Executive summary (slides)");
  pdf.rect(0, 0, SLIDE.w, SLIDE.h).fill("#F4F8FB");
  pdf.rect(0, 0, SLIDE.w, 74).fill(COLORS.navy);
  pdf.rect(0, 74, SLIDE.w, 4).fill(COLORS.accent);
  pdf.font(F.r).fontSize(8.5).fillColor("#9FD3E8").text(kicker.toUpperCase(), SLIDE_MARGIN, 18, { width: 400, characterSpacing: 1.4, lineBreak: false });
  pdf.font(F.r).fontSize(8.5).fillColor("#9FD3E8").text(projectName, SLIDE_MARGIN, 18, { width: SLIDE_W, align: "right", lineBreak: false });
  pdf.font(F.b).fontSize(24).fillColor("#FFFFFF").text(title, SLIDE_MARGIN, 33, { width: SLIDE_W, lineBreak: false });
}

/** Text clamped to a box: it ends with an ellipsis rather than spilling onto the next page. */
function boxText(pdf: Doc, text: string, x: number, y: number, w: number, h: number, o: { font?: string; size: number; color?: string; lineGap?: number }) {
  pdf.font(o.font ?? F.r).fontSize(o.size).fillColor(o.color ?? COLORS.text).text(text, x, y, { width: w, height: h, ellipsis: true, lineGap: o.lineGap ?? 2 });
}

function card(pdf: Doc, x: number, y: number, w: number, h: number, accent?: string) {
  pdf.save().roundedRect(x, y, w, h, 7).fillAndStroke("#FFFFFF", COLORS.line).restore();
  if (accent) pdf.save().roundedRect(x, y, 5, h, 2).fill(accent).restore();
}

function drawBriefSlides(pdf: Doc, b: ExecutiveBrief, projectName: string) {
  // 1. At a glance: the message, then the numbers.
  slidePage(pdf, "At a glance", "Executive summary", projectName, true);
  boxText(pdf, b.headline, SLIDE_MARGIN, 96, SLIDE_W, 74, { font: F.b, size: 19, color: COLORS.navy, lineGap: 3 });
  boxText(pdf, b.summary, SLIDE_MARGIN, 176, SLIDE_W, 62, { size: 11.5, color: COLORS.text, lineGap: 3 });
  const tileW = (SLIDE_W - 3 * 16) / 4;
  b.metrics.slice(0, 8).forEach((m, i) => {
    const x = SLIDE_MARGIN + (i % 4) * (tileW + 16);
    const y = 258 + Math.floor(i / 4) * 86;
    card(pdf, x, y, tileW, 74, i === 7 ? PRIORITY_COLOR.Now : COLORS.accent);
    boxText(pdf, m.value, x + 16, y + 10, tileW - 26, 34, { font: F.b, size: m.value.length > 12 ? 12 : 22, color: COLORS.navy, lineGap: 1 });
    boxText(pdf, m.label, x + 16, y + 48, tileW - 26, 16, { size: 9, color: COLORS.muted });
  });

  // 2. Key points: one message per card.
  if (b.keyPoints.length) {
    slidePage(pdf, "Key points", "Executive summary", projectName);
    const cw = (SLIDE_W - 2 * 18) / 3;
    b.keyPoints.slice(0, 6).forEach((k, i) => {
      const x = SLIDE_MARGIN + (i % 3) * (cw + 18);
      const y = 100 + Math.floor(i / 3) * 172;
      card(pdf, x, y, cw, 156, COLORS.accent);
      boxText(pdf, k.title, x + 20, y + 16, cw - 34, 22, { font: F.b, size: 14, color: COLORS.accent });
      boxText(pdf, k.detail, x + 20, y + 46, cw - 34, 96, { size: 11.5, color: COLORS.text, lineGap: 3 });
    });
  }

  // 3. What it does.
  if (b.capabilities.length) {
    slidePage(pdf, "What it does", "Executive summary", projectName);
    const colW = (SLIDE_W - 30) / 2;
    b.capabilities.slice(0, 8).forEach((c, i) => {
      const col = i < 4 ? 0 : 1;
      const row = i % 4;
      const x = SLIDE_MARGIN + col * (colW + 30);
      const y = 100 + row * 74;
      card(pdf, x, y, colW, 62, COLORS.accent);
      boxText(pdf, c, x + 20, y + 12, colW - 34, 42, { size: 11.5, color: COLORS.text, lineGap: 3 });
    });
    if (b.audience && !/^not stated/i.test(b.audience)) boxText(pdf, `Who it serves: ${b.audience}`, SLIDE_MARGIN, 408, SLIDE_W, 30, { font: F.i, size: 10.5, color: COLORS.muted });
  }

  // 4. Health and risk.
  slidePage(pdf, "Health and risk", "Executive summary", projectName);
  const tone = /^needs attention/i.test(b.health.verdict) ? PRIORITY_COLOR.Now : /^generally sound/i.test(b.health.verdict) ? "#B26A00" : "#1B7F4B";
  card(pdf, SLIDE_MARGIN, 98, SLIDE_W, 66, tone);
  boxText(pdf, b.health.verdict, SLIDE_MARGIN + 22, 112, SLIDE_W - 40, 46, { font: F.b, size: 13.5, color: COLORS.navy, lineGap: 3 });
  const half = (SLIDE_W - 20) / 2;
  const listBox = (title: string, items: string[], x: number, color: string) => {
    card(pdf, x, 178, half, 250);
    boxText(pdf, title, x + 20, 192, half - 40, 20, { font: F.b, size: 12.5, color });
    let y = 220;
    for (const it of items.slice(0, 4)) {
      pdf.save().circle(x + 26, y + 6, 2.6).fill(color).restore();
      const h = Math.min(54, pdf.font(F.r).fontSize(10.5).heightOfString(it, { width: half - 62, lineGap: 2 }));
      boxText(pdf, it, x + 38, y, half - 62, 54, { size: 10.5, color: COLORS.text });
      y += h + 12;
    }
    if (items.length === 0) boxText(pdf, "None identified.", x + 20, 220, half - 40, 20, { size: 10.5, color: COLORS.muted });
  };
  listBox("Strengths", b.health.strengths, SLIDE_MARGIN, "#1B7F4B");
  listBox("Concerns", b.health.concerns, SLIDE_MARGIN + half + 20, PRIORITY_COLOR.Now);

  // 5. Recommended next steps.
  if (b.nextSteps.length) {
    slidePage(pdf, "Recommended next steps", "Executive summary", projectName);
    b.nextSteps.slice(0, 5).forEach((n, i) => {
      const y = 98 + i * 68;
      card(pdf, SLIDE_MARGIN, y, SLIDE_W, 58);
      const c = PRIORITY_COLOR[n.priority] ?? COLORS.accent;
      pdf.save().roundedRect(SLIDE_MARGIN + 16, y + 18, 54, 22, 11).fill(c).restore();
      pdf.font(F.b).fontSize(9.5).fillColor("#FFFFFF").text(n.priority, SLIDE_MARGIN + 16, y + 24, { width: 54, align: "center", lineBreak: false });
      boxText(pdf, n.action, SLIDE_MARGIN + 88, y + 10, SLIDE_W - 108, n.why ? 22 : 38, { font: F.b, size: 12, color: COLORS.navy });
      if (n.why) boxText(pdf, n.why, SLIDE_MARGIN + 88, y + 32, SLIDE_W - 108, 22, { size: 10, color: COLORS.muted });
    });
  }
}

async function build(doc: ReportDocument, meta: { footer: string; author?: string }, knownPages: number[] | null, deck?: { brief: ExecutiveBrief; projectName: string }): Promise<{ buffer: Buffer; pages: number[]; total: number }> {
  const pdf = new PDFDocument({ size: "A4", margins: { top: PAGE.top, bottom: PAGE.bottom, left: PAGE.left, right: PAGE.right }, bufferPages: true, info: { Title: doc.title, Author: meta.author ?? "Brody", Creator: "Brody repository intelligence", Producer: "Brody" }, autoFirstPage: true });
  // Do not pass the body font as the constructor default: pdfkit then fails to cache it by its registered name
  // and re-reads the font file on every font() call (thousands of times for a large report).
  setup(pdf);
  const chunks: Buffer[] = [];
  pdf.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => { pdf.on("end", () => resolve(Buffer.concat(chunks))); pdf.on("error", reject); });

  // Cover and contents
  const toc = outline(doc);
  pdf.font(F.b).fontSize(26).fillColor(COLORS.navy).text(doc.title, PAGE.left, 130, { width: CONTENT_W });
  pdf.moveDown(0.6);
  pdf.save().rect(PAGE.left, pdf.y, 64, 3).fill(COLORS.accent).restore();
  pdf.moveDown(1);
  for (const line of doc.subtitle) { pdf.font(F.r).fontSize(10.5).fillColor(COLORS.muted).text(line.replace(/[*_`]/g, ""), PAGE.left, pdf.y, { width: CONTENT_W, lineGap: 3 }); }
  if (toc.length) {
    pdf.moveDown(2.2);
    pdf.font(F.b).fontSize(13).fillColor(COLORS.text).text("Contents", PAGE.left, pdf.y);
    pdf.moveDown(0.5);
    toc.forEach((t, i) => {
      if (pdf.y > bottom() - 20) pdf.addPage();
      const y = pdf.y;
      pdf.font(F.r).fontSize(10).fillColor(COLORS.text).text(t, PAGE.left + 4, y, { width: CONTENT_W - 50, lineBreak: false });
      pdf.font(F.r).fontSize(10).fillColor(COLORS.muted).text(String(knownPages?.[i] ?? 0), PAGE.left, y, { width: CONTENT_W, align: "right", lineBreak: false });
      pdf.y = y + 15.5;
    });
  }

  if (deck) drawBriefSlides(pdf, deck.brief, deck.projectName);
  pdf.addPage({ size: "A4", margins: { top: PAGE.top, bottom: PAGE.bottom, left: PAGE.left, right: PAGE.right } });
  const ctx: Ctx = { outlineParents: {}, pages: [], headingIdx: 0 };
  drawBlocks(pdf, doc.blocks, ctx);

  // Running footer with page numbers, drawn once the total is known.
  const range = pdf.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    pdf.switchToPage(range.start + i);
    const savedBottom = pdf.page.margins.bottom;
    pdf.page.margins.bottom = 0;
    pdf.font(F.r).fontSize(7.5).fillColor("#8A93A0");
    // Slides are landscape; the footer sits lower and spans their wider page.
    const pw = pdf.page.width;
    const fy = pdf.page.height - (pw > pdf.page.height ? 22 : 34);
    const fx = pw > pdf.page.height ? SLIDE_MARGIN : PAGE.left;
    const fw = pw - fx * 2;
    pdf.text(meta.footer, fx, fy, { width: fw * 0.7, lineBreak: false, align: "left" });
    if (i > 0) pdf.text(`Page ${i + 1} of ${range.count}`, fx, fy, { width: fw, lineBreak: false, align: "right" });
    pdf.page.margins.bottom = savedBottom;
  }
  pdf.end();
  return { buffer: await done, pages: ctx.pages, total: range.count };
}

/** Render the report as a PDF with cover, contents with page numbers, bookmarks and a running footer. */
export async function renderPdf(doc: ReportDocument, meta: { footer: string; author?: string }, deck?: { brief: ExecutiveBrief; projectName: string }): Promise<Buffer> {
  // Two passes: the first learns which page each section lands on, the second prints those numbers in the contents.
  const first = await build(doc, meta, null, deck);
  const second = await build(doc, meta, first.pages, deck);
  return second.buffer;
}
