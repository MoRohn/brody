import PptxGenJS from "pptxgenjs";
import { textLines } from "./build";
import { H, splitColor, W, type DeckSlides, type Prim } from "./scene";
import { FONTS } from "./theme";

/**
 * The deck as a PowerPoint file. Shapes, text and charts are real, editable objects; tables are native PowerPoint tables;
 * every slide carries its speaker notes. Positions come from the same layout as the HTML and PDF versions.
 */
const PX = 96; // canvas pixels per inch (1280 x 720 px = 13.333 x 7.5 in)
const inch = (v: number) => Math.round((v / PX) * 10000) / 10000;
const pt = (v: number) => Math.round(v * 0.75 * 100) / 100;

type Slide = ReturnType<InstanceType<typeof PptxGenJS>["addSlide"]>;

const fillOf = (c: string | undefined, opacity = 1) => {
  if (!c) return undefined;
  const s = splitColor(c);
  return { color: s.hex, transparency: Math.round((1 - s.alpha * opacity) * 100) };
};
const lineOf = (c: string | undefined, w: number, opacity = 1) => {
  if (!c) return undefined;
  const s = splitColor(c);
  return { color: s.hex, width: pt(w), transparency: Math.round((1 - s.alpha * opacity) * 100) };
};

function add(pptx: PptxGenJS, slide: Slide, p: Prim): void {
  const T = pptx.ShapeType;
  switch (p.t) {
    case "rect": {
      const round = !!p.r && p.r > 0.5;
      slide.addShape(round ? T.roundRect : T.rect, { x: inch(p.x), y: inch(p.y), w: inch(p.w), h: inch(p.h), fill: fillOf(p.fill, p.opacity) ?? { type: "none" }, line: lineOf(p.stroke, p.sw ?? 1) ?? { type: "none" }, ...(round ? { rectRadius: inch(Math.min(p.r!, p.w / 2, p.h / 2)) } : {}) });
      return;
    }
    case "ellipse":
      slide.addShape(T.ellipse, { x: inch(p.x), y: inch(p.y), w: inch(p.w), h: inch(p.h), fill: fillOf(p.fill, p.opacity) ?? { type: "none" }, line: lineOf(p.stroke, p.sw ?? 1, p.opacity) ?? { type: "none" } });
      return;
    case "poly": {
      if (p.pts.length < 2) return;
      const xs = p.pts.map((q) => q[0]), ys = p.pts.map((q) => q[1]);
      const x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(1, Math.max(...xs) - x0), h = Math.max(1, Math.max(...ys) - y0);
      const points: { x: number; y: number; moveTo?: boolean; close?: boolean }[] = p.pts.map(([x, y], i) => ({ x: inch(x - x0), y: inch(y - y0), ...(i === 0 ? { moveTo: true } : {}) }));
      if (!p.open) points.push({ x: 0, y: 0, close: true });
      slide.addShape("custGeom" as never, { x: inch(x0), y: inch(y0), w: inch(w), h: inch(h), points, fill: p.open ? { type: "none" } : (fillOf(p.fill, p.opacity) ?? { type: "none" }), line: lineOf(p.stroke, p.sw ?? 1, p.opacity) ?? { type: "none" } } as never);
      return;
    }
    case "line": {
      const x = Math.min(p.x1, p.x2), y = Math.min(p.y1, p.y2);
      const flipV = (p.x2 - p.x1) * (p.y2 - p.y1) < 0;
      slide.addShape(T.line, { x: inch(x), y: inch(y), w: inch(Math.abs(p.x2 - p.x1)), h: inch(Math.abs(p.y2 - p.y1)), flipV, line: { ...lineOf(p.color, p.sw)!, dashType: p.dash ? "dash" : "solid" } });
      return;
    }
    case "text": {
      const face = FONTS[p.font].pptx;
      const lines = textLines(p);
      // With exact line spacing PowerPoint sets each line in a box of that height, and text sits a little low in it.
      const y = lines[0].top - (p.lh - p.size * 1.2) / 2 + 3;
      const runs = p.lines.map((line, i) => ({ text: line || " ", options: { breakLine: i < p.lines.length - 1 } }));
      slide.addText(runs, { x: inch(p.x), y: inch(y), w: inch(p.w), h: inch(p.lh * p.lines.length), fontFace: face, fontSize: pt(p.size), color: splitColor(p.color).hex, bold: !!p.bold, italic: !!p.italic, align: p.align === "l" ? "left" : p.align === "c" ? "center" : "right", valign: "top", margin: 0, lineSpacing: pt(p.lh), charSpacing: p.spacing ? pt(p.spacing) : undefined, wrap: false, fit: "none" } as never);
      return;
    }
    case "table": {
      const rows = p.cells.map((row) => row.map((c) => ({
        text: c.lines.join("\n") || " ",
        options: { fontFace: FONTS.sans.pptx, fontSize: pt(c.size), bold: !!c.bold, color: splitColor(c.pill ?? c.color).hex, align: c.align === "l" ? "left" : c.align === "c" ? "center" : "right", valign: "middle", fill: c.fill ? { color: splitColor(c.fill).hex } : undefined, margin: [pt(4), pt(10), pt(4), pt(10)] },
      })));
      slide.addTable(rows as never, { x: inch(p.x), y: inch(p.y), w: inch(p.cols.reduce((a, b) => a + b, 0)), h: inch(p.rowH.reduce((a, b) => a + b, 0)), colW: p.cols.map(inch), rowH: p.rowH.map(inch), border: { type: "solid", color: "D5E1EA", pt: 0.75 }, autoPage: false });
      return;
    }
  }
}

export async function renderDeckPptx(d: DeckSlides): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "BRODY_16x9", width: W / PX, height: H / PX });
  pptx.layout = "BRODY_16x9";
  pptx.title = d.title;
  pptx.author = "Brody";
  pptx.company = "Brody";
  pptx.subject = "Executive summary deck";
  for (const s of d.slides) {
    const slide = pptx.addSlide();
    // The full-page background rectangle is the slide background, so it is not left as a shape to be dragged by accident.
    const bg = s.prims.find((p): p is Extract<Prim, { t: "rect" }> => p.t === "rect" && p.x === 0 && p.y === 0 && p.w === W && p.h === H);
    if (bg?.fill) slide.background = { color: splitColor(bg.fill).hex };
    for (const p of s.prims) if (p !== bg) add(pptx, slide, p);
    slide.addNotes(s.notes);
  }
  const out = await pptx.write({ outputType: "nodebuffer" });
  return Buffer.from(out as Buffer);
}
