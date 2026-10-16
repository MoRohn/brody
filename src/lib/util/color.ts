/**
 * Colour helpers for deriving a palette from a project's brand colour: parsing the colour syntaxes projects declare
 * (hex, rgb(), hsl(), oklch(), and the bare "H S% L%" triplets of shadcn-style CSS variables), OKLCH (a perceptual
 * space, so shades of one hue look like one family), and WCAG contrast.
 */
export type RGB = [number, number, number];
export interface OKLCH { l: number; c: number; h: number }

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function toHex([r, g, b]: RGB): string {
  return `#${[r, g, b].map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

export function fromHex(hex: string): RGB | undefined {
  let h = hex.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3,4}$/i.test(h)) h = h.slice(0, 3).split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) return undefined;
  // A mostly transparent colour is not a brand colour.
  if (h.length === 8 && parseInt(h.slice(6), 16) < 128) return undefined;
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

function hslToRgb(h: number, s: number, l: number): RGB {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

const num = (s: string, scale: number) => (s.endsWith("%") ? (parseFloat(s) / 100) * scale : parseFloat(s));
const hue = (s: string) => (s.endsWith("turn") ? parseFloat(s) * 360 : s.endsWith("rad") ? (parseFloat(s) * 180) / Math.PI : parseFloat(s));

/** Parse a CSS colour value. Undefined for anything that is not a plain, mostly opaque colour (keywords, var(), gradients). */
export function parseColor(input: string): RGB | undefined {
  const v = input.trim().toLowerCase().replace(/\s*!important$/, "");
  if (v.startsWith("#")) return fromHex(v);
  const fn = v.match(/^(rgba?|hsla?|oklch)\(\s*([^)]*)\)$/);
  // shadcn/ui-style variables hold a bare "222.2 47.4% 11.2%" triplet that hsl() wraps where it is used.
  const parts = (fn ? fn[2] : /^-?[\d.]+(deg)?\s+[\d.]+%\s+[\d.]+%$/.test(v) ? v : "").split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return undefined;
  if (parts[3] !== undefined && num(parts[3], 1) < 0.5) return undefined;
  const kind = fn ? fn[1] : "hsl";
  if (kind.startsWith("rgb")) return [num(parts[0], 255) / 255, num(parts[1], 255) / 255, num(parts[2], 255) / 255].map(clamp01) as RGB;
  if (kind.startsWith("hsl")) return hslToRgb(((hue(parts[0]) % 360) + 360) % 360, clamp01(num(parts[1], 1)), clamp01(num(parts[2], 1)));
  const l = parts[0].endsWith("%") ? parseFloat(parts[0]) / 100 : parseFloat(parts[0]);
  const c = parts[1].endsWith("%") ? (parseFloat(parts[1]) / 100) * 0.4 : parseFloat(parts[1]);
  if (![l, c, hue(parts[2])].every(Number.isFinite)) return undefined;
  return fromOklch({ l, c, h: hue(parts[2]) });
}

// sRGB <-> linear <-> OKLab (Björn Ottosson's reference matrices).
const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const gam = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

export function toOklch([r, g, b]: RGB): OKLCH {
  const [lr, lg, lb] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

function oklchToLinear({ l: L, c, h }: OKLCH): RGB {
  const A = c * Math.cos((h * Math.PI) / 180), B = c * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

/** OKLCH to sRGB, reducing chroma (never lightness or hue) until the colour fits the sRGB gamut. */
export function fromOklch(o: OKLCH): RGB {
  const inGamut = (rgb: RGB) => rgb.every((v) => v >= -0.0005 && v <= 1.0005);
  let c = o.c;
  if (!inGamut(oklchToLinear({ ...o, c }))) {
    let lo = 0, hi = c;
    for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (inGamut(oklchToLinear({ ...o, c: mid }))) lo = mid; else hi = mid; }
    c = lo;
  }
  return oklchToLinear({ ...o, c }).map((v) => clamp01(gam(clamp01(v)))) as RGB;
}

export const oklchHex = (l: number, c: number, h: number) => toHex(fromOklch({ l: clamp01(l), c: Math.max(0, c), h }));

export function luminance([r, g, b]: RGB): number {
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two "#RRGGBB" colours (1 to 21). */
export function contrast(a: string, b: string): number {
  const la = luminance(fromHex(a) ?? [0, 0, 0]), lb = luminance(fromHex(b) ?? [0, 0, 0]);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** "#RRGGBB" a fraction `t` of the way from `a` to `b`. */
export function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1, 7), 16), pb = parseInt(b.slice(1, 7), 16);
  return `#${[16, 8, 0].map((s) => Math.round(((pa >> s) & 255) + (((pb >> s) & 255) - ((pa >> s) & 255)) * t).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}
