import { themes, type PrismTheme } from "prism-react-renderer";

/**
 * Syntax colours for the code viewer. The stock Prism themes were tuned for pure white and pure black, so on Brody's
 * tinted surfaces several token colours fall below WCAG AA. Every colour is nudged (darker on light levels, lighter on
 * dark levels) until it reaches 4.6:1 against the most demanding surface of its group, keeping its hue.
 */
// The hardest cases: the row-hover tint over the darkest light surface, and over the lightest dark surface.
export const LIGHT_WORST_BACKGROUND = "#a8c8d8";
export const DARK_WORST_BACKGROUND = "#315973";

const TARGET = 4.6;

/** Parses "#rgb", "#rrggbb", "rgb(r, g, b)" and "rgba(r, g, b, a)" (the stock Prism themes use both forms). */
export function parseColor(input: string): [number, number, number] | null {
  const value = input.trim();
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split("").map((c) => c + c).join("") : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
  }
  const fn = value.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*(?:,\s*[\d.]+\s*)?\)$/i);
  return fn ? [Number(fn[1]), Number(fn[2]), Number(fn[3])] : null;
}
const toHex = (c: number[]) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;
function luminance([r, g, b]: number[]): number {
  const f = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function contrast(a: number[], b: number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Move a colour toward black or white, in small steps, until it meets the target against the background. */
export function ensureContrast(color: string, background: string, toward: "black" | "white"): string {
  const c = parseColor(color);
  const bg = parseColor(background);
  if (!c || !bg) return color;
  let cur = c;
  const end = toward === "black" ? 0 : 255;
  for (let i = 0; i < 40 && contrast(cur, bg) < TARGET; i++) cur = cur.map((v) => v + (end - v) * 0.08) as [number, number, number];
  return toHex(cur);
}

function adjust(base: PrismTheme, background: string, toward: "black" | "white"): PrismTheme {
  const fix = (style: Record<string, unknown>) => (typeof style.color === "string" ? { ...style, color: ensureContrast(style.color, background, toward) } : style);
  return {
    plain: { ...fix(base.plain as Record<string, unknown>), backgroundColor: "transparent" },
    styles: base.styles.map((s) => ({ ...s, style: fix(s.style as Record<string, unknown>) })),
  } as PrismTheme;
}

export const LIGHT_SYNTAX = adjust(themes.github, LIGHT_WORST_BACKGROUND, "black");
export const DARK_SYNTAX = adjust(themes.vsDark, DARK_WORST_BACKGROUND, "white");
