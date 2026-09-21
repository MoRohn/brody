/**
 * The deck is laid out once, on a 1280 x 720 canvas, as a list of simple shapes and pre-wrapped text. The HTML, PDF and
 * PowerPoint renderers only draw these shapes, so the three formats always look the same and none has layout logic of its own.
 */
export const W = 1280;
export const H = 720;

export type FontKind = "sans" | "serif";

export type Prim =
  | { t: "rect"; x: number; y: number; w: number; h: number; fill?: string; stroke?: string; sw?: number; r?: number; opacity?: number }
  | { t: "ellipse"; x: number; y: number; w: number; h: number; fill?: string; stroke?: string; sw?: number }
  | { t: "poly"; pts: [number, number][]; fill?: string; stroke?: string; sw?: number; opacity?: number; open?: boolean }
  | { t: "line"; x1: number; y1: number; x2: number; y2: number; color: string; sw: number; dash?: boolean }
  | { t: "text"; x: number; y: number; w: number; h: number; lines: string[]; size: number; lh: number; color: string; bold?: boolean; italic?: boolean; font: FontKind; align: "l" | "c" | "r"; valign: "t" | "m" | "b"; spacing?: number }
  | { t: "table"; x: number; y: number; cols: number[]; rowH: number[]; cells: TableCell[][]; header: boolean };

export interface TableCell {
  lines: string[];
  size: number;
  color: string;
  bold?: boolean;
  align: "l" | "c" | "r";
  fill?: string;
  /** A small filled pill drawn behind the text (severity, priority). */
  pill?: string;
}

export interface Slide {
  id: string;
  title: string;
  kicker: string;
  /** The report section this slide is connected to, e.g. "5. Major Functional Areas". */
  ref?: string;
  /** Speaker notes: the talking points and where the detail lives in the report. */
  notes: string;
  dark?: boolean;
  prims: Prim[];
}

export interface DeckSlides {
  title: string;
  projectName: string;
  generatedAt: number;
  slides: Slide[];
}

/** All the text of a slide, in reading order, for accessibility and for tests. */
export function slideText(s: Slide): string[] {
  const out: string[] = [];
  for (const p of s.prims) {
    if (p.t === "text") out.push(p.lines.join(" "));
    else if (p.t === "table") for (const row of p.cells) for (const c of row) out.push(c.lines.join(" "));
  }
  return out.filter((x) => x.trim().length > 0);
}

/** "#RRGGBB" or "#RRGGBBAA" split into the opaque colour and its alpha, for formats that keep them apart. */
export function splitColor(c: string): { hex: string; alpha: number } {
  const h = c.replace("#", "");
  return h.length === 8 ? { hex: h.slice(0, 6).toUpperCase(), alpha: parseInt(h.slice(6), 16) / 255 } : { hex: h.slice(0, 6).toUpperCase(), alpha: 1 };
}
