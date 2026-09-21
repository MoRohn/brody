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
  ellipse(x: number, y: number, w: number, h: number, o: { fill?: string; stroke?: string; sw?: number; opacity?: number } = {}): void {
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

  /**
   * A soft card: a tinted surface with no outline, a faint layered shadow, and (optionally) a coloured line along its top edge.
   * The shadow is a few translucent shapes, so it looks the same in the browser, in PDF and in PowerPoint.
   */
  card(x: number, y: number, w: number, h: number, o: { accent?: string; fill?: string; stroke?: string; r?: number; shadow?: boolean } = {}): void {
    const r = o.r ?? 16;
    if (o.shadow) for (const [dy, op] of [[6, 0.03], [4, 0.035], [2, 0.045]] as const) this.rect(x + 1, y + dy, w - 2, h, { fill: C.text, r, opacity: op });
    this.rect(x, y, w, h, { fill: o.fill ?? C.mist, stroke: o.stroke, sw: o.stroke ? 1.2 : undefined, r });
    if (o.accent) this.rect(x + r, y, w - r * 2, 5, { fill: o.accent, r: 2.5 });
  }

  /** A disc that may overhang the page: drawn as a polygon clipped to the canvas, so nothing sits off the slide in PowerPoint. */
  disc(cx: number, cy: number, r: number, o: { fill: string; opacity?: number }, box = { w: 1280, h: 720 }): void {
    const pts: [number, number][] = [];
    for (let i = 0; i < 120; i++) { const a = (i / 120) * 2 * Math.PI; pts.push([Math.min(box.w, Math.max(0, cx + r * Math.cos(a))), Math.min(box.h, Math.max(0, cy + r * Math.sin(a)))]); }
    this.poly(pts, o);
  }

  /** A vertical or diagonal colour ramp made of thin strips (gradients are not portable across formats; strips are). */
  gradient(x: number, y: number, w: number, h: number, from: string, to: string, steps = 32): void {
    const a = parseInt(from.slice(1), 16), b = parseInt(to.slice(1), 16);
    const ch = (c: number, s: number) => (c >> s) & 255;
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      const mix = (s: number) => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * t);
      const hex = `#${[16, 8, 0].map((s) => mix(s).toString(16).padStart(2, "0")).join("")}`;
      const y0 = y + (h * i) / steps;
      this.rect(x, y0, w, Math.min(h / steps + 4, y + h - y0), { fill: hex });
    }
  }

  /** A status lozenge: a coloured dot and a word (never colour alone). */
  status(label: string, x: number, y: number, color: string, o: { size?: number; h?: number } = {}): number {
    const size = o.size ?? 14, h = o.h ?? Math.round(size * 2);
    const w = Math.ceil(textWidth(label, size, "sans", true)) + h + 14;
    this.rect(x, y, w, h, { fill: color, r: h / 2, opacity: 0.14 });
    this.ellipse(x + h * 0.36, y + h * 0.32, h * 0.36, h * 0.36, { fill: color });
    this.text(label, x + h * 0.9, y, w - h, h, { size, color, bold: true, valign: "m", maxLines: 1 });
    return w;
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
  icon(kind: string, cx: number, cy: number, r: number, color: string, o: { plain?: boolean } = {}): void {
    if (!o.plain) this.ellipse(cx - r, cy - r, r * 2, r * 2, { fill: color });
    const w = o.plain ? color : C.white, s = r * 0.5, sw = Math.max(1.6, r * 0.09);
    const L = (x1: number, y1: number, x2: number, y2: number) => this.line(cx + x1 * s, cy + y1 * s, cx + x2 * s, cy + y2 * s, { color: w, sw });
    const P = (pts: [number, number][], open = false, fill = false) => this.poly(pts.map(([x, y]) => [cx + x * s, cy + y * s] as [number, number]), fill ? { fill: w } : { stroke: w, sw, open });
    const E = (x: number, y: number, dw: number, dh: number, fill = false) => this.ellipse(cx + (x - dw / 2) * s, cy + (y - dh / 2) * s, dw * s, dh * s, fill ? { fill: w } : { stroke: w, sw });
    switch (kind) {
      case "ui": this.rect(cx - s * 1.05, cy - s * 0.8, s * 2.1, s * 1.6, { stroke: w, sw, r: 3 }); L(-1.05, -0.3, 1.05, -0.3); break;
      case "api": P([[-1.1, -0.8], [-0.1, 0], [-1.1, 0.8]], true); P([[0.1, -0.8], [1.1, 0], [0.1, 0.8]], true); break;
      case "service": P([[0, -1.1], [1.1, 0], [0, 1.1], [-1.1, 0]]); E(0, 0, 0.64, 0.64, true); break;
      case "data": for (const dy of [-0.65, 0, 0.65]) E(0, dy, 2, 0.56); break;
      case "job": E(0, 0, 2, 2); L(0, 0, 0, -0.65); L(0, 0, 0.5, 0.25); break;
      case "infra": P([[-0.55, -1], [0.55, -1], [1.1, 0], [0.55, 1], [-0.55, 1], [-1.1, 0]]); break;
      case "util": for (const [dx, dy] of [[-0.55, -0.55], [0.15, -0.55], [-0.55, 0.15], [0.15, 0.15]]) this.rect(cx + dx * s, cy + dy * s, s * 0.7, s * 0.7, { fill: w, r: 1.5 }); break;
      case "external": case "globe": E(0, 0, 2.1, 2.1); E(0, 0, 0.9, 2.1); L(-1.05, 0, 1.05, 0); break;
      case "shield": P([[0, -1.15], [1, -0.7], [1, 0.1], [0, 1.15], [-1, 0.1], [-1, -0.7]]); P([[-0.4, 0], [-0.1, 0.35], [0.5, -0.4]], true); break;
      case "pulse": P([[-1.2, 0.1], [-0.5, 0.1], [-0.2, -0.9], [0.25, 0.9], [0.55, 0.1], [1.2, 0.1]], true); break;
      case "check": E(0, 0, 2.1, 2.1); P([[-0.5, 0.05], [-0.1, 0.45], [0.6, -0.4]], true); break;
      case "sliders": for (const [y, x] of [[-0.7, -0.4], [0, 0.5], [0.7, -0.1]] as const) { L(-1, y, 1, y); E(x, y, 0.5, 0.5, true); } break;
      case "gear": E(0, 0, 1.4, 1.4); for (let i = 0; i < 8; i++) { const a = (i * Math.PI) / 4; L(Math.cos(a) * 0.85, Math.sin(a) * 0.85, Math.cos(a) * 1.15, Math.sin(a) * 1.15); } break;
      case "box": P([[0, -1.1], [1, -0.55], [1, 0.6], [0, 1.15], [-1, 0.6], [-1, -0.55]]); L(0, 0.05, 0, 1.15); L(0, 0.05, 1, -0.55); L(0, 0.05, -1, -0.55); break;
      case "files": this.rect(cx - s * 0.95, cy - s * 0.7, s * 1.4, s * 1.7, { stroke: w, sw, r: 2 }); this.rect(cx - s * 0.45, cy - s * 1.0, s * 1.4, s * 1.7, { stroke: w, sw, r: 2 }); break;
      case "code": P([[-0.4, -0.8], [-1.1, 0], [-0.4, 0.8]], true); P([[0.4, -0.8], [1.1, 0], [0.4, 0.8]], true); L(0.15, -0.9, -0.15, 0.9); break;
      case "layers": for (const dy of [-0.55, 0, 0.55]) P([[0, dy - 0.45], [1.1, dy], [0, dy + 0.45], [-1.1, dy]]); break;
      case "alert": P([[0, -1.05], [1.15, 0.95], [-1.15, 0.95]]); L(0, -0.25, 0, 0.35); E(0, 0.65, 0.16, 0.16, true); break;
      case "target": E(0, 0, 2.1, 2.1); E(0, 0, 1.2, 1.2); E(0, 0, 0.34, 0.34, true); break;
      case "list": for (const y of [-0.7, 0, 0.7]) { E(-0.85, y, 0.22, 0.22, true); L(-0.4, y, 1.1, y); } break;
      case "users": E(0, -0.45, 0.8, 0.8); P([[-1, 1], [-0.85, 0.3], [0, 0.1], [0.85, 0.3], [1, 1]], true); break;
      case "lock": this.rect(cx - s * 0.85, cy - s * 0.15, s * 1.7, s * 1.1, { stroke: w, sw, r: 2 }); P([[-0.5, -0.15], [-0.5, -0.7], [0, -1], [0.5, -0.7], [0.5, -0.15]], true); break;
      case "star": P([[0, -1.1], [0.3, -0.3], [1.1, -0.25], [0.45, 0.25], [0.7, 1.05], [0, 0.55], [-0.7, 1.05], [-0.45, 0.25], [-1.1, -0.25], [-0.3, -0.3]], false, true); break;
      default: E(0, 0, 1.1, 1.1, true);
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
        return { lines, size: s, color: c.color ?? (isHead ? C.navy : C.text), bold, align: c.align ?? "l", fill: c.fill ?? (isHead ? C.mist2 : C.white), pill: c.pill } satisfies TableCell;
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
      out.push({ t: "rect", x, y, w, h, fill: cell.fill, stroke: C.rule, sw: 1 });
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
