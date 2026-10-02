/**
 * Small line pictograms for diagram nodes, defined as geometric primitives on a 24 x 24 grid so the SVG renderer and the
 * Manim renderer draw exactly the same marks. Strokes only, one weight, no fills except the dots: quiet, legible at
 * 22 px, never decorative. Browser-safe.
 */
import type { ConceptGlyph } from "./types";

export type GlyphPrim =
  | { t: "rect"; x: number; y: number; w: number; h: number; r?: number }
  | { t: "circle"; cx: number; cy: number; r: number; fill?: boolean }
  | { t: "line"; x1: number; y1: number; x2: number; y2: number }
  | { t: "poly"; pts: [number, number][]; closed?: boolean };

export const GLYPHS: Record<ConceptGlyph, GlyphPrim[]> = {
  machine: [{ t: "rect", x: 3, y: 3, w: 18, h: 6, r: 1.5 }, { t: "rect", x: 3, y: 11, w: 18, h: 6, r: 1.5 }, { t: "circle", cx: 7, cy: 6, r: 1, fill: true }, { t: "circle", cx: 7, cy: 14, r: 1, fill: true }, { t: "line", x1: 8, y1: 21, x2: 16, y2: 21 }, { t: "line", x1: 12, y1: 17, x2: 12, y2: 21 }],
  gpu: [{ t: "rect", x: 5, y: 5, w: 14, h: 14, r: 1.5 }, { t: "rect", x: 9, y: 9, w: 6, h: 6 }, { t: "line", x1: 9, y1: 2, x2: 9, y2: 5 }, { t: "line", x1: 15, y1: 2, x2: 15, y2: 5 }, { t: "line", x1: 9, y1: 19, x2: 9, y2: 22 }, { t: "line", x1: 15, y1: 19, x2: 15, y2: 22 }, { t: "line", x1: 2, y1: 9, x2: 5, y2: 9 }, { t: "line", x1: 2, y1: 15, x2: 5, y2: 15 }, { t: "line", x1: 19, y1: 9, x2: 22, y2: 9 }, { t: "line", x1: 19, y1: 15, x2: 22, y2: 15 }],
  pod: [{ t: "poly", pts: [[12, 2.5], [20.5, 7.25], [20.5, 16.75], [12, 21.5], [3.5, 16.75], [3.5, 7.25]], closed: true }, { t: "poly", pts: [[3.5, 7.25], [12, 12], [20.5, 7.25]] }, { t: "line", x1: 12, y1: 12, x2: 12, y2: 21.5 }],
  service: [{ t: "rect", x: 3, y: 5, w: 18, h: 14, r: 2 }, { t: "line", x1: 3, y1: 9, x2: 21, y2: 9 }, { t: "circle", cx: 6, cy: 7, r: 0.8, fill: true }, { t: "line", x1: 7, y1: 13, x2: 17, y2: 13 }, { t: "line", x1: 7, y1: 16, x2: 13, y2: 16 }],
  scheduler: [{ t: "circle", cx: 12, cy: 12, r: 8.5 }, { t: "line", x1: 12, y1: 12, x2: 12, y2: 6.5 }, { t: "line", x1: 12, y1: 12, x2: 16, y2: 14.5 }, { t: "circle", cx: 12, cy: 12, r: 1.2, fill: true }],
  database: [{ t: "poly", pts: [[4, 6], [4, 18]] }, { t: "poly", pts: [[20, 6], [20, 18]] }, { t: "rect", x: 4, y: 3, w: 16, h: 6, r: 3 }, { t: "poly", pts: [[4, 12], [8, 14.5], [16, 14.5], [20, 12]] }, { t: "poly", pts: [[4, 18], [8, 20.5], [16, 20.5], [20, 18]] }],
  queue: [{ t: "rect", x: 2.5, y: 8, w: 5, h: 8, r: 1 }, { t: "rect", x: 9.5, y: 8, w: 5, h: 8, r: 1 }, { t: "rect", x: 16.5, y: 8, w: 5, h: 8, r: 1 }, { t: "line", x1: 2, y1: 20, x2: 22, y2: 20 }],
  user: [{ t: "circle", cx: 12, cy: 8, r: 4 }, { t: "poly", pts: [[4, 21], [5.5, 15.5], [9, 13.5], [15, 13.5], [18.5, 15.5], [20, 21]] }],
  file: [{ t: "poly", pts: [[6, 2.5], [14.5, 2.5], [19, 7], [19, 21.5], [6, 21.5]], closed: true }, { t: "poly", pts: [[14.5, 2.5], [14.5, 7], [19, 7]] }, { t: "line", x1: 9, y1: 12, x2: 16, y2: 12 }, { t: "line", x1: 9, y1: 16, x2: 16, y2: 16 }],
  function: [{ t: "poly", pts: [[9, 4], [6, 4], [5, 7], [5, 10.5], [3, 12], [5, 13.5], [5, 17], [6, 20], [9, 20]] }, { t: "poly", pts: [[15, 4], [18, 4], [19, 7], [19, 10.5], [21, 12], [19, 13.5], [19, 17], [18, 20], [15, 20]] }],
  external: [{ t: "poly", pts: [[7, 18], [4, 18], [2.5, 15.5], [3.5, 12.5], [6.5, 11.5], [7.5, 8], [11, 6], [14.5, 7], [16.5, 9.5], [19.5, 10], [21.5, 13], [20.5, 17], [17.5, 18], [7, 18]], closed: true }],
  config: [{ t: "line", x1: 4, y1: 7, x2: 20, y2: 7 }, { t: "line", x1: 4, y1: 12, x2: 20, y2: 12 }, { t: "line", x1: 4, y1: 17, x2: 20, y2: 17 }, { t: "circle", cx: 9, cy: 7, r: 2, fill: true }, { t: "circle", cx: 16, cy: 12, r: 2, fill: true }, { t: "circle", cx: 7, cy: 17, r: 2, fill: true }],
  generic: [{ t: "rect", x: 4, y: 4, w: 16, h: 16, r: 3 }, { t: "circle", cx: 12, cy: 12, r: 2.5, fill: true }],
};
