import path from "node:path";
import PDFDocument from "pdfkit";
import { tablePrims, textLines } from "./build";
import { H, splitColor, W, type DeckSlides, type Prim } from "./scene";

/** The deck as a PDF: one 16:9 page per slide, drawn from the same shapes as the HTML and PowerPoint versions. */
const DIR = path.join(process.cwd(), "node_modules", "dejavu-fonts-ttf", "ttf");
const K = 0.75; // canvas pixels to PDF points: 1280 px -> 960 pt (13.33 in)
const FONT = { sans: "Deck-Sans", "sans-bold": "Deck-Sans-Bold", serif: "Deck-Serif", "serif-bold": "Deck-Serif-Bold" } as const;

type Doc = InstanceType<typeof PDFDocument>;

function fill(doc: Doc, color: string | undefined, opacity = 1): boolean {
  if (!color) return false;
  const c = splitColor(color);
  doc.fillColor(`#${c.hex}`).fillOpacity(c.alpha * opacity);
  return true;
}
function stroke(doc: Doc, color: string | undefined, w: number, opacity = 1): boolean {
  if (!color) return false;
  const c = splitColor(color);
  doc.strokeColor(`#${c.hex}`).strokeOpacity(c.alpha * opacity).lineWidth(w * K);
  return true;
}
function paint(doc: Doc, f: boolean, s: boolean) {
  if (f && s) doc.fillAndStroke(); else if (f) doc.fill(); else if (s) doc.stroke(); else doc.undash().stroke();
}

function draw(doc: Doc, p: Prim): void {
  switch (p.t) {
    case "rect": {
      doc.save();
      const f = fill(doc, p.fill, p.opacity), s = stroke(doc, p.stroke, p.sw ?? 1, p.opacity);
      if (p.r) doc.roundedRect(p.x * K, p.y * K, p.w * K, p.h * K, Math.min(p.r, p.w / 2, p.h / 2) * K); else doc.rect(p.x * K, p.y * K, p.w * K, p.h * K);
      if (f || s) paint(doc, f, s);
      doc.restore();
      return;
    }
    case "ellipse": {
      doc.save();
      const f = fill(doc, p.fill, p.opacity), s = stroke(doc, p.stroke, p.sw ?? 1, p.opacity);
      doc.ellipse((p.x + p.w / 2) * K, (p.y + p.h / 2) * K, (p.w / 2) * K, (p.h / 2) * K);
      if (f || s) paint(doc, f, s);
      doc.restore();
      return;
    }
    case "poly": {
      if (p.pts.length < 2) return;
      doc.save();
      const f = fill(doc, p.open ? undefined : p.fill, p.opacity), s = stroke(doc, p.stroke, p.sw ?? 1, p.opacity);
      doc.moveTo(p.pts[0][0] * K, p.pts[0][1] * K);
      for (const [x, y] of p.pts.slice(1)) doc.lineTo(x * K, y * K);
      if (!p.open) doc.closePath();
      doc.lineJoin("round").lineCap("round");
      if (f || s) paint(doc, f, s);
      doc.restore();
      return;
    }
    case "line": {
      doc.save();
      stroke(doc, p.color, p.sw);
      doc.lineCap("round");
      if (p.dash) doc.dash(6 * K, { space: 5 * K });
      doc.moveTo(p.x1 * K, p.y1 * K).lineTo(p.x2 * K, p.y2 * K).stroke();
      doc.restore();
      return;
    }
    case "text": {
      const font = FONT[`${p.font}${p.bold ? "-bold" : ""}` as keyof typeof FONT] ?? FONT.sans;
      doc.save();
      doc.font(font).fontSize(p.size * K);
      fill(doc, p.color);
      const ascent = (doc as unknown as { _font: { ascender: number } })._font.ascender / 1000;
      for (const l of textLines(p)) {
        if (!l.line) continue;
        const yTop = (l.top + p.lh / 2 + p.size * 0.36 - ascent * p.size) * K;
        const o = { lineBreak: false, characterSpacing: (p.spacing ?? 0) * K } as const;
        if (l.anchor === "start") doc.text(l.line, p.x * K, yTop, o);
        else doc.text(l.line, p.x * K, yTop, { ...o, width: p.w * K, align: l.anchor === "middle" ? "center" : "right" });
      }
      doc.restore();
      return;
    }
    case "table": for (const q of tablePrims(p)) draw(doc, q); return;
  }
}

export function renderDeckPdf(d: DeckSlides): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false, size: [W * K, H * K], margins: { top: 0, left: 0, right: 0, bottom: 0 }, info: { Title: d.title, Author: "Brody", Subject: "Executive summary deck", Creator: "Brody" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.registerFont(FONT.sans, path.join(DIR, "DejaVuSansCondensed.ttf"));
    doc.registerFont(FONT["sans-bold"], path.join(DIR, "DejaVuSansCondensed-Bold.ttf"));
    doc.registerFont(FONT.serif, path.join(DIR, "DejaVuSerif.ttf"));
    doc.registerFont(FONT["serif-bold"], path.join(DIR, "DejaVuSerif-Bold.ttf"));
    for (const s of d.slides) {
      doc.addPage();
      doc.outline.addItem(s.title);
      for (const p of s.prims) draw(doc, p);
    }
    doc.end();
  });
}
