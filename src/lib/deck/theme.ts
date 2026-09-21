import type { FontKind } from "./scene";

/** Brody's own palette, as used by the report's PDF slides and the app: deep navy, cerulean, soft blue-grey surfaces. */
export const C = {
  navy: "#1B4965",
  navyDark: "#0F2F45",
  accent: "#006C96",
  accentLight: "#9FD3E8",
  sky: "#DFEAF1",
  skyDeep: "#C8D9E4",
  bg: "#F4F8FB",
  card: "#FFFFFF",
  line: "#C4D5E0",
  text: "#0A1A26",
  muted: "#3D5265",
  crit: "#B3261E",
  high: "#D9731A",
  med: "#E0A100",
  low: "#2F7FBF",
  info: "#7A8CA0",
  ok: "#1B7F4B",
  white: "#FFFFFF",
} as const;

export const SEVERITY_COLOR: Record<string, string> = { Critical: C.crit, High: C.high, Medium: C.med, Low: C.low, Informational: C.info };
export const PRIORITY_COLOR: Record<string, string> = { Now: C.crit, Next: C.accent, Later: C.info };

/** Font families per renderer. The layout is measured with DejaVu (the report PDF's face), which is at least as wide as these. */
export const FONTS: Record<FontKind, { css: string; pptx: string }> = {
  sans: { css: '"Segoe UI", -apple-system, "Helvetica Neue", Arial, sans-serif', pptx: "Calibri" },
  serif: { css: 'Georgia, "Playfair Display", "Times New Roman", serif', pptx: "Georgia" },
};

export const MARGIN = 56;
export const BODY = { x: MARGIN, y: 122, w: 1280 - MARGIN * 2, h: 548 };
