import { textWidth, wrap } from "./measure";
import type { FontKind, Prim, TableCell } from "./scene";
import { C } from "./theme";

/** Drawing helpers shared by every slide: shapes plus text that is measured and wrapped here, once, for all formats. */
export interface TextOpts { size: number; color?: string; bold?: boolean; italic?: boolean; font?: FontKind; align?: "l" | "c" | "r"; valign?: "t" | "m" | "b"; lh?: number; maxLines?: number; spacing?: number }

export class Canvas {
  prims: Prim[] = [];

  rect(x: number, y: number, w: number, h: number, o: { fill?: string; stroke?: string; sw?: number; r?: number; opacity?: number } = {}): void {
    this.prims.push({ t: "rect", x, y, w, h, ...o });
  }
  ellipse(x: number, y: number, w: number, h: number, o: { fill?: string; stroke?: string; sw?: number } = {}): void {
    this.prims.push({ t: "ellipse", x, y, w, h, ...o });
  }
  poly(pts: [number, number][], o: { fill?: string; stroke?: string; sw?: number; opacity?: number; open?: boolean } = {}): void {
    this.prims.push({ t: "poly", pts, ...o });
  }
  /** A line; with `arrow` a small triangle head is drawn as a polygon, so every format shows it the same way. */
  line(x1: number, y1: number, x2: number, y2: number, o: { color?: string; sw?: number; dash?: boolean; arrow?: boolean } = {}): void {
    const color = o.color ?? C.line, sw = o.sw ?? 1.5;
    if (!o.arrow) { this.prims.push({ t: "line", x1, y1, x2, y2, color, sw, dash: o.dash }); return; }
    const len = Math.hypot(x2 - x1, y2 - y1) || 1, ux = (x2 - x1) / len, uy = (y2 - y1) / len, head = 6 + sw * 2;
    this.prims.push({ t: "line", x1, y1, x2: x2 - ux * head * 0.7, y2: y2 - uy * head * 0.7, color, sw, dash: o.dash });
    this.poly([[x2, y2], [x2 - ux * head - uy * head * 0.5, y2 - uy * head + ux * head * 0.5], [x2 - ux * head + uy * head * 0.5, y2 - uy * head - ux * head * 0.5]], { fill: color });
  }

  /** Wrapped, clamped text. Returns the number of lines drawn. */
  text(str: string, x: number, y: number, w: number, h: number, o: TextOpts): number {
    const font = o.font ?? "sans";
    const lh = o.lh ?? Math.round(o.size * 1.34);
    const maxLines = Math.max(1, Math.min(o.maxLines ?? 99, Math.floor((h + 0.5) / lh)));
    const lines = wrap(str, w, { size: o.size, font, bold: o.bold, maxLines });
    if (lines.length === 0) return 0;
    this.prims.push({ t: "text", x, y, w, h, lines, size: o.size, lh, color: o.color ?? C.text, bold: o.bold, italic: o.italic, font, align: o.align ?? "l", valign: o.valign ?? "t", spacing: o.spacing });
    return lines.length;
  }

  /** Text that shrinks (down to `min`) until it fits its box. */
  fit(str: string, x: number, y: number, w: number, h: number, o: TextOpts & { min: number }): number {
    let size = o.size;
    for (; size > o.min; size--) {
      const lh = o.lh ? Math.round((o.lh * size) / o.size) : Math.round(size * 1.34);
      if (wrap(str, w, { size, font: o.font, bold: o.bold }).length * lh <= h) break;
    }
    return this.text(str, x, y, w, h, { ...o, size, lh: o.lh ? Math.round((o.lh * size) / o.size) : undefined });
  }

  card(x: number, y: number, w: number, h: number, o: { accent?: string; fill?: string; stroke?: string; r?: number } = {}): void {
    this.rect(x, y, w, h, { fill: o.fill ?? C.card, stroke: o.stroke ?? C.line, sw: 1.2, r: o.r ?? 10 });
    if (o.accent) this.rect(x, y + 10, 5, h - 20, { fill: o.accent, r: 2.5 });
  }

  /** A filled label; returns its width so callers can lay pills out in a row. */
  pill(label: string, x: number, y: number, o: { fill: string; color?: string; size?: number; h?: number; bold?: boolean; padX?: number }): number {
    const size = o.size ?? 13;
    const h = o.h ?? Math.round(size * 1.9);
    const w = Math.ceil(textWidth(label, size, "sans", o.bold ?? true)) + (o.padX ?? 20);
    this.rect(x, y, w, h, { fill: o.fill, r: h / 2 });
    this.text(label, x, y, w, h, { size, color: o.color ?? C.white, bold: o.bold ?? true, align: "c", valign: "m", maxLines: 1 });
    return w;
  }

  /** A ring chart. Each segment is a polygon so all three formats draw it identically. */
  donut(cx: number, cy: number, r: number, thick: number, segments: { value: number; color: string }[]): void {
    const total = segments.reduce((a, s) => a + s.value, 0);
    if (total <= 0) { this.ring(cx, cy, r, thick, C.skyDeep); return; }
    let a0 = -90;
    const step = 3;
    const nonZero = segments.filter((s) => s.value > 0);
    for (const s of nonZero) {
      const sweep = (s.value / total) * 360;
      const gap = nonZero.length > 1 ? Math.min(1.2, sweep / 4) : 0;
      const from = a0 + gap / 2, to = a0 + sweep - gap / 2;
      const pts: [number, number][] = [];
      const n = Math.max(2, Math.ceil((to - from) / step));
      for (let i = 0; i <= n; i++) { const a = ((from + ((to - from) * i) / n) * Math.PI) / 180; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
      for (let i = n; i >= 0; i--) { const a = ((from + ((to - from) * i) / n) * Math.PI) / 180; pts.push([cx + (r - thick) * Math.cos(a), cy + (r - thick) * Math.sin(a)]); }
      this.poly(pts, { fill: s.color });
      a0 += sweep;
    }
  }
  private ring(cx: number, cy: number, r: number, thick: number, color: string): void {
    const pts: [number, number][] = [];
    for (let i = 0; i <= 120; i++) { const a = (i / 120) * 2 * Math.PI; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
    for (let i = 120; i >= 0; i--) { const a = (i / 120) * 2 * Math.PI; pts.push([cx + (r - thick) * Math.cos(a), cy + (r - thick) * Math.sin(a)]); }
    this.poly(pts, { fill: color });
  }

  /** A horizontal bar: a track and a filled portion. */
  bar(x: number, y: number, w: number, h: number, frac: number, color: string, track: string = C.sky): void {
    this.rect(x, y, w, h, { fill: track, r: h / 2 });
    const f = Math.max(0, Math.min(1, frac));
    if (f > 0) this.rect(x, y, Math.max(h, w * f), h, { fill: color, r: h / 2 });
  }

  /** A block arrow pointing right. */
  arrow(x: number, y: number, w: number, thick: number, color: string, opacity = 1): void {
    const head = Math.min(w * 0.45, thick * 1.2);
    const t = thick / 2;
    this.poly([[x, y - t * 0.55], [x + w - head, y - t * 0.55], [x + w - head, y - t], [x + w, y], [x + w - head, y + t], [x + w - head, y + t * 0.55], [x, y + t * 0.55]], { fill: color, opacity });
  }

  /** A pointed step of a process chain. */
  chevron(x: number, y: number, w: number, h: number, fill: string, first = false): void {
    const p = Math.min(22, h * 0.4);
    this.poly(first ? [[x, y], [x + w - p, y], [x + w, y + h / 2], [x + w - p, y + h], [x, y + h]] : [[x, y], [x + w - p, y], [x + w, y + h / 2], [x + w - p, y + h], [x, y + h], [x + p, y + h / 2]], { fill });
  }

  /** A small pictogram for a kind of capability, drawn in white on a coloured disc. */
  icon(kind: string, cx: number, cy: number, r: number, color: string): void {
    this.ellipse(cx - r, cy - r, r * 2, r * 2, { fill: color });
    const w = C.white, s = r * 0.5;
    switch (kind) {
      case "ui": this.rect(cx - s * 1.05, cy - s * 0.8, s * 2.1, s * 1.6, { stroke: w, sw: 2, r: 3 }); this.line(cx - s * 1.05, cy - s * 0.3, cx + s * 1.05, cy - s * 0.3, { color: w, sw: 2 }); break;
      case "api": this.poly([[cx - s * 1.1, cy - s * 0.8], [cx - s * 0.1, cy], [cx - s * 1.1, cy + s * 0.8]], { stroke: w, sw: 2.4, open: true }); this.poly([[cx + s * 0.1, cy - s * 0.8], [cx + s * 1.1, cy], [cx + s * 0.1, cy + s * 0.8]], { stroke: w, sw: 2.4, open: true }); break;
      case "service": this.poly([[cx, cy - s * 1.1], [cx + s * 1.1, cy], [cx, cy + s * 1.1], [cx - s * 1.1, cy]], { stroke: w, sw: 2 }); this.ellipse(cx - s * 0.32, cy - s * 0.32, s * 0.64, s * 0.64, { fill: w }); break;
      case "data": for (const dy of [-0.65, 0, 0.65]) this.ellipse(cx - s, cy + dy * s - s * 0.28, s * 2, s * 0.56, { stroke: w, sw: 1.8 }); break;
      case "job": this.ellipse(cx - s, cy - s, s * 2, s * 2, { stroke: w, sw: 2 }); this.line(cx, cy, cx, cy - s * 0.65, { color: w, sw: 2 }); this.line(cx, cy, cx + s * 0.5, cy + s * 0.25, { color: w, sw: 2 }); break;
      case "infra": this.poly([[cx - s * 0.55, cy - s], [cx + s * 0.55, cy - s], [cx + s * 1.1, cy], [cx + s * 0.55, cy + s], [cx - s * 0.55, cy + s], [cx - s * 1.1, cy]], { stroke: w, sw: 2 }); break;
      case "util": for (const [dx, dy] of [[-0.55, -0.55], [0.15, -0.55], [-0.55, 0.15], [0.15, 0.15]]) this.rect(cx + dx * s, cy + dy * s, s * 0.7, s * 0.7, { fill: w, r: 1.5 }); break;
      case "external": this.poly([[cx, cy - s * 1.1], [cx + s * 0.3, cy - s * 0.3], [cx + s * 1.1, cy - s * 0.25], [cx + s * 0.45, cy + s * 0.25], [cx + s * 0.7, cy + s * 1.05], [cx, cy + s * 0.55], [cx - s * 0.7, cy + s * 1.05], [cx - s * 0.45, cy + s * 0.25], [cx - s * 1.1, cy - s * 0.25], [cx - s * 0.3, cy - s * 0.3]], { fill: w }); break;
      default: this.ellipse(cx - s * 0.55, cy - s * 0.55, s * 1.1, s * 1.1, { fill: w });
    }
  }

  /** A native table (PowerPoint gets a real, editable one). Cell text is wrapped here so row heights are exact. */
  table(x: number, y: number, cols: number[], rows: { text: string; size?: number; color?: string; bold?: boolean; align?: "l" | "c" | "r"; fill?: string; pill?: string; maxLines?: number }[][], o: { size?: number; minRowH?: number; padX?: number; padY?: number; header?: boolean; maxH?: number } = {}): number {
    const size = o.size ?? 14;
    const padX = o.padX ?? 10, padY = o.padY ?? 7;
    const cells: TableCell[][] = [];
    const rowH: number[] = [];
    let total = 0;
    rows.forEach((row, ri) => {
      const isHead = !!o.header && ri === 0;
      let h = o.minRowH ?? 0;
      const out = row.map((c, ci) => {
        const s = c.size ?? size;
        const bold = c.bold ?? isHead;
        const lines = wrap(c.text, cols[ci] - padX * 2, { size: s, bold, maxLines: c.maxLines ?? 4 });
        h = Math.max(h, Math.round(lines.length * s * 1.3) + padY * 2);
        return { lines, size: s, color: c.color ?? (isHead ? C.white : C.text), bold, align: c.align ?? "l", fill: c.fill ?? (isHead ? C.navy : ri % 2 === 0 ? C.card : "#F7FAFC"), pill: c.pill } satisfies TableCell;
      });
      if (o.maxH !== undefined && total + h > o.maxH && cells.length > 0) return;
      cells.push(out);
      rowH.push(h);
      total += h;
    });
    this.prims.push({ t: "table", x, y, cols, rowH, cells, header: !!o.header });
    return total;
  }
}

/** Where each line of a text prim sits: shared by every renderer so text lands in the same place in every format. */
export function textLines(p: Extract<Prim, { t: "text" }>): { x: number; top: number; anchor: "start" | "middle" | "end"; line: string }[] {
  const total = p.lines.length * p.lh;
  const y0 = p.valign === "t" ? p.y : p.valign === "m" ? p.y + (p.h - total) / 2 : p.y + p.h - total;
  const x = p.align === "l" ? p.x : p.align === "c" ? p.x + p.w / 2 : p.x + p.w;
  return p.lines.map((line, i) => ({ x, top: y0 + i * p.lh, anchor: p.align === "l" ? "start" : p.align === "c" ? "middle" : "end", line }));
}

/**
 * A table drawn from plain shapes and text, for the formats without native tables (HTML, PDF). PowerPoint gets a real table
 * instead, but from the same cells, widths and row heights, so the two look alike.
 */
export function tablePrims(p: Extract<Prim, { t: "table" }>): Prim[] {
  const out: Prim[] = [];
  let y = p.y;
  p.cells.forEach((row, ri) => {
    let x = p.x;
    row.forEach((cell, ci) => {
      const w = p.cols[ci], h = p.rowH[ri];
      out.push({ t: "rect", x, y, w, h, fill: cell.fill, stroke: C.line, sw: 1 });
      const total = cell.lines.length * Math.round(cell.size * 1.3);
      if (cell.pill) {
        const pw = Math.min(w - 12, Math.ceil(textWidth(cell.lines[0] ?? "", cell.size, "sans", true)) + 22), ph = Math.round(cell.size * 1.9);
        out.push({ t: "rect", x: x + (w - pw) / 2, y: y + (h - ph) / 2, w: pw, h: ph, fill: cell.pill, r: ph / 2 });
      }
      out.push({ t: "text", x: x + 10, y: y + (h - total) / 2, w: w - 20, h: total, lines: cell.lines, size: cell.size, lh: Math.round(cell.size * 1.3), color: cell.color, bold: cell.bold, font: "sans", align: cell.align, valign: "t" });
      x += w;
    });
    y += p.rowH[ri];
  });
  return out;
}
