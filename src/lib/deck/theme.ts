import { contrast, fromHex, oklchHex, toOklch } from "../util/color";
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
  mist: "#F1F6FA",
  mist2: "#E3EDF4",
  rule: "#D5E1EA",
  good: "#1B7F4B",
  watch: "#D98A00",
  act: "#C7372F",
  deep: "#0B2436",
  /** On dark slides: a bright accent for rules and highlights, and three light tints for text. */
  glow: "#7CCBEE",
  onDarkSoft: "#E4F0F7",
  onDarkBody: "#C9DCE8",
  onDarkMuted: "#9FBBCC",
  /** The second lens colour (Engineering), and a shade between accent and navy. */
  accent2: "#5B4B9A",
  accentMid: "#2C6E8F",
} as const;

/** A deck palette: Brody's own (C), or one derived from a project's brand colour. Status and severity colours never change. */
export type Palette = { [K in keyof typeof C]: string };

/** The lightest shade of a colour with at least `min` contrast against `bg`, keeping its hue and as much chroma as fits. */
function shadeFor(l: number, c: number, h: number, bg: string, min: number, darker = true): string {
  let hex = oklchHex(l, c, h);
  for (let i = 0; i < 100 && contrast(hex, bg) < min; i++) { l += darker ? -0.01 : 0.01; hex = oklchHex(l, c, h); }
  return hex;
}

/**
 * A complete palette in the hue of a brand colour: the brand colour itself (made dark enough to read on white) as the
 * accent, deep shades for titles and dark slides, and faint tints for surfaces. Warm hues (reds, oranges, yellows) get
 * near-charcoal darks, since their own dark shades turn brown; cool hues keep a tinted navy. A nearly grey brand colour
 * gives a monochrome palette. `secondary`, when it is a distinct colour, becomes the second lens colour; otherwise that
 * is a deeper, quieter shade of the brand.
 */
export function brandPalette(primary: string, secondary?: string): Palette {
  const rgb = fromHex(primary);
  if (!rgb) return { ...C };
  const { l, c, h } = toOklch(rgb);
  const neutral = c < 0.035;
  const k = neutral ? Math.min(c, 0.012) : c;
  const cool = h >= 150 && h <= 320;
  const dark = Math.min(k, cool ? 0.06 : 0.02);
  const tint = (lt: number, ct: number) => oklchHex(lt, Math.min(k, ct), h);
  const accent = shadeFor(Math.min(l, 0.62), neutral ? k : Math.max(k, 0.09), h, "#FFFFFF", 4.6);
  const second = secondary ? fromHex(secondary) : undefined;
  const s2 = second ? toOklch(second) : undefined;
  const distinct = s2 && s2.c >= 0.06 && Math.min(Math.abs(s2.h - h), 360 - Math.abs(s2.h - h)) >= 40;
  const deep = oklchHex(0.2, dark, h);
  const navy = shadeFor(0.33, Math.min(k, cool ? 0.09 : 0.03), h, "#FFFFFF", 9);
  return {
    ...C,
    navy,
    navyDark: oklchHex(0.25, dark, h),
    deep,
    accent,
    accentMid: oklchHex((toOklch(fromHex(accent)!).l + toOklch(fromHex(navy)!).l) / 2, Math.min(k, 0.08), h),
    accentLight: tint(0.84, 0.07),
    accent2: distinct ? shadeFor(Math.min(s2.l, 0.55), s2.c, s2.h, "#FFFFFF", 4.6) : shadeFor(0.42, Math.min(k, cool ? 0.08 : 0.04), h, "#FFFFFF", 7),
    glow: shadeFor(Math.max(l, 0.78), Math.min(Math.max(k, neutral ? 0 : 0.09), 0.14), h, deep, 6.5, false),
    sky: tint(0.94, 0.02),
    skyDeep: tint(0.88, 0.03),
    bg: tint(0.975, 0.006),
    mist: tint(0.966, 0.008),
    mist2: tint(0.925, 0.013),
    rule: tint(0.89, 0.012),
    line: tint(0.85, 0.018),
    text: oklchHex(0.2, Math.min(k, 0.015), h),
    muted: shadeFor(0.46, Math.min(k, 0.025), h, tint(0.966, 0.008), 4.8),
    onDarkSoft: tint(0.95, 0.015),
    onDarkBody: tint(0.88, 0.02),
    onDarkMuted: tint(0.78, 0.025),
  };
}

export const SEVERITY_COLOR: Record<string, string> = { Critical: C.crit, High: C.high, Medium: C.med, Low: C.low, Informational: C.info };
export const STATUS_COLOR: Record<string, string> = { good: C.good, watch: C.watch, act: C.act };
export const STATUS_LABEL: Record<string, string> = { good: "On track", watch: "Watch", act: "Needs attention" };
export const priorityColor = (P: Palette): Record<string, string> => ({ Now: P.crit, Next: P.accent, Later: P.info });

/** Font families per renderer. The layout is measured with DejaVu (the report PDF's face), which is at least as wide as these. */
export const FONTS: Record<FontKind, { css: string; pptx: string }> = {
  sans: { css: '"Segoe UI", -apple-system, "Helvetica Neue", Arial, sans-serif', pptx: "Calibri" },
  serif: { css: 'Georgia, "Playfair Display", "Times New Roman", serif', pptx: "Georgia" },
};

export const MARGIN = 64;
export const BODY = { x: MARGIN, y: 164, w: 1280 - MARGIN * 2, h: 496 };
