/**
 * The Brody Explainer design system: one visual language for every explainer renderer (the live SVG player, the
 * server-side SVG renderer and the Manim renderer), so a scene looks the same whichever engine drew it.
 *
 * Character: an instrument panel, not a slide deck. A quiet ground, one ink, one accent that marks the single thing being
 * talked about, one signal colour for trouble (contention, blocked, idle capacity) and one for the healthy state. Motion
 * only ever means something: a thing appears when it is named, is outlined when it is discussed, a dot travels a line
 * while data flows along it, and nothing moves when nothing is happening.
 *
 * Every colour that carries text is checked against the ground it sits on (tests/explainer-design.test.ts), and the
 * layout validator refuses text below MIN_FONT_PX. Browser-safe: no Node imports.
 */
import type { ObjectState, VisualStyle } from "./types";

export interface Palette {
  ground: string;
  panel: string;
  panelRaised: string;
  ink: string;
  inkSecondary: string;
  /** Large, de-emphasised type only (>= 24 px). Never captions or labels. */
  inkFaint: string;
  hairline: string;
  rule: string;
  accent: string;
  accentInk: string;
  signal: string;
  ok: string;
  waiting: string;
  codeGround: string;
  codeHighlight: string;
  scrim: string;
}

export const PALETTES: Record<VisualStyle, Palette> = {
  // Default: deep navy ground from Brody's darkest level, cerulean accent lightened for a dark ground.
  brody: {
    ground: "#0B1822",
    panel: "#11222F",
    panelRaised: "#16303F",
    ink: "#E4EEF4",
    inkSecondary: "#A7BCCA",
    inkFaint: "#7F97A8",
    hairline: "#27404F",
    rule: "#3A5566",
    accent: "#5CC6F0",
    accentInk: "#06131B",
    signal: "#F0A35C",
    ok: "#6CD3A0",
    waiting: "#C9B458",
    codeGround: "#0E1D28",
    codeHighlight: "#173A4D",
    scrim: "#0B1822",
  },
  // Paper: Brody's light surfaces and the brand cerulean.
  "brody-light": {
    ground: "#F3F7FA",
    panel: "#FFFFFF",
    panelRaised: "#E6EFF5",
    ink: "#0A1A26",
    inkSecondary: "#38505F",
    inkFaint: "#6B8191",
    hairline: "#C9D8E2",
    rule: "#93ABBB",
    accent: "#006C96",
    accentInk: "#FFFFFF",
    signal: "#A8461A",
    ok: "#14613B",
    waiting: "#7A5B00",
    codeGround: "#E9F0F5",
    codeHighlight: "#CFE4F0",
    scrim: "#F3F7FA",
  },
  // Lower contrast between surfaces and a softer accent, for long deep explainers.
  calm: {
    ground: "#141B21",
    panel: "#1A242C",
    panelRaised: "#202D37",
    ink: "#E2E8EC",
    inkSecondary: "#AAB7C0",
    inkFaint: "#86949E",
    hairline: "#2D3B46",
    rule: "#43535F",
    accent: "#8CC9E0",
    accentInk: "#0D1418",
    signal: "#E3A774",
    ok: "#8FCFAE",
    waiting: "#CDBB78",
    codeGround: "#172129",
    codeHighlight: "#24384A",
    scrim: "#141B21",
  },
};

export const CANVAS = { width: 1280, height: 720, fps: 30 } as const;

/** Layout grid on the 1280 x 720 canvas. The bottom band is kept free for the player's caption track. */
export const GRID = {
  marginX: 64,
  top: 40,
  titleBottom: 104,
  contentTop: 128,
  contentBottom: 600,
  captionSafeTop: 612,
  gutter: 24,
  columns: 12,
} as const;
export const CONTENT = { x: GRID.marginX, y: GRID.contentTop, w: CANVAS.width - 2 * GRID.marginX, h: GRID.contentBottom - GRID.contentTop };

export const TYPE = {
  kicker: 16,
  title: 34,
  statement: 44,
  heading: 26,
  node: 22,
  nodeSub: 17,
  chip: 16,
  body: 20,
  code: 17,
  metric: 76,
  metricLabel: 18,
  source: 14,
} as const;
/** Smallest text the validator accepts on the 720p canvas, except source markers, which are deliberately small. */
export const MIN_FONT_PX = 16;
export const MIN_SOURCE_FONT_PX = 13;
export const LINE_HEIGHT = 1.28;

export const FONT = {
  sans: "DejaVu Sans Condensed",
  mono: "DejaVu Sans Mono",
  files: { sans: "DejaVuSansCondensed.ttf", sansBold: "DejaVuSansCondensed-Bold.ttf", mono: "DejaVuSansMono.ttf", monoBold: "DejaVuSansMono-Bold.ttf" },
} as const;

export const SHAPE = { radius: 10, stroke: 1.6, strokeActive: 2.6, connector: 1.8, cellGap: 8, padX: 16, padY: 12 } as const;

/** Motion durations in ms. Every animation is clamped to the beat that triggers it. */
export const MOTION = { appear: 420, disappear: 320, draw: 640, highlight: 260, state: 320, value: 900, scrim: 360, camera: 900, lines: 360, emphasis: 520, flowPxPerSec: 240, rise: 10 } as const;

/** Most objects visible at once before a scene is judged too dense to read while listening. */
export const MAX_VISIBLE_OBJECTS = 24;

export function stateColor(p: Palette, s: ObjectState | undefined): string {
  switch (s) {
    case "busy": return p.accent;
    case "blocked": return p.signal;
    case "waiting": return p.waiting;
    case "ok": return p.ok;
    default: return p.rule;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Contrast (WCAG 2.x relative luminance)
// ---------------------------------------------------------------------------------------------------------------------
function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
export function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Text/ground pairs the renderers actually draw, with the floor each must clear. */
export function contrastPairs(p: Palette): { name: string; fg: string; bg: string; min: number }[] {
  return [
    { name: "ink on ground", fg: p.ink, bg: p.ground, min: 7 },
    { name: "ink on panel", fg: p.ink, bg: p.panel, min: 7 },
    { name: "secondary on ground", fg: p.inkSecondary, bg: p.ground, min: 4.5 },
    { name: "secondary on panel", fg: p.inkSecondary, bg: p.panel, min: 4.5 },
    { name: "faint (large only) on ground", fg: p.inkFaint, bg: p.ground, min: 3 },
    { name: "accent text on ground", fg: p.accent, bg: p.ground, min: 4.5 },
    { name: "accent text on panel", fg: p.accent, bg: p.panel, min: 4.5 },
    { name: "ink on accent fill", fg: p.accentInk, bg: p.accent, min: 4.5 },
    { name: "signal text on panel", fg: p.signal, bg: p.panel, min: 4.5 },
    { name: "ok text on panel", fg: p.ok, bg: p.panel, min: 4.5 },
    { name: "ink on code ground", fg: p.ink, bg: p.codeGround, min: 7 },
    { name: "ink on code highlight", fg: p.ink, bg: p.codeHighlight, min: 4.5 },
    { name: "secondary on code ground", fg: p.inkSecondary, bg: p.codeGround, min: 4.5 },
  ];
}
