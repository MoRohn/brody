import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import type { ImageMeta } from "../db/schema";
import { toHex, toOklch, type RGB } from "../util/color";
import { isDefaultExcludedPath } from "./classify";

/**
 * A project's own visuals (its logo, app icon, social card and screenshots), found by their paths and the images its
 * README shows, so exports such as the executive deck can carry the project's branding. Only a handful of files per
 * project are kept, each re-encoded within a fixed size.
 */
export type VisualKind = "logo" | "icon" | "hero" | "screenshot";

export interface VisualCandidate {
  path: string;
  kind: VisualKind;
  score: number;
  /** The README's description of the image, when it shows it. */
  alt?: string;
  /** Made for dark backgrounds (logo-white.svg, logo-dark-bg.png). */
  forDark?: boolean;
}

const RASTER = /\.(png|jpe?g|gif)$/i;
const VECTOR = /\.svg$/i;
const MAX_RASTER_BYTES = 12 * 1024 * 1024;
const MAX_SVG_BYTES = 1024 * 1024;
const LIMITS: Record<VisualKind, number> = { logo: 4, icon: 2, hero: 2, screenshot: 6 };

const word = (w: string) => new RegExp(`(^|[^a-z])(${w})([^a-z]|$)`);
const LOGO = word("logo|logos|logotype|wordmark|brandmark|logomark|brand|emblem");
const ICON = /^(icon|app-?icon|favicon|apple-touch-icon|apple-icon|android-chrome|mstile|maskable-icon|pwa-icon)([-_.@\d]|x|$)/;
const HERO = word("og|og-image|opengraph-image|opengraph|twitter-image|social|social-card|social-preview|banner|hero|cover|header-image|splash");
const SCREEN = word("screenshot|screenshots|screen|screens|screencap|demo|preview|dashboard|showcase|walkthrough");
const SCREEN_DIR = /(^|\/)(screenshots?|screens|screencaps|showcase|media|marketing|press)\//i;
const BRAND_DIR = /(^|\/)(brand|branding|logos?|identity)\//i;
const FOR_DARK = word("white|light|inverse|inverted|negative|reversed|ondark|on-dark|dark-bg|darkbg|for-dark");
const NOT_PRODUCT = /(^|\/)(tests?|__tests__|spec|specs|fixtures?|__snapshots__|__mocks__|e2e|examples?|samples?|stories|storybook-static|coverage)\//i;
/** Framework starter images that say nothing about the project. */
const BOILERPLATE = new Set(["next.svg", "vercel.svg", "vite.svg", "react.svg", "file.svg", "globe.svg", "window.svg", "nuxt.svg", "svelte.svg", "astro.svg", "tauri.svg", "typescript.svg", "javascript.svg", "logo192.png", "logo512.png"]);

/** Images a README shows, resolved against the README's folder: `![alt](path)` and `<img src="path" alt="...">`. */
export function readmeImages(readmePath: string, text: string): { path: string; alt: string; order: number }[] {
  const dir = readmePath.includes("/") ? readmePath.slice(0, readmePath.lastIndexOf("/")) : "";
  const out: { path: string; alt: string; order: number }[] = [];
  const add = (src: string, alt: string, at: number) => {
    const clean = src.trim().replace(/^<|>$/g, "").split(/[?#]/)[0];
    if (!clean || /^[a-z]+:/i.test(clean) || clean.startsWith("//")) return; // remote images are not in the repository
    const rel = path.posix.normalize(clean.startsWith("/") ? clean.slice(1) : path.posix.join(dir, clean));
    if (rel.startsWith("..")) return;
    let decoded = rel;
    try { decoded = decodeURI(rel); } catch { /* keep it as written */ }
    out.push({ path: decoded, alt: alt.trim(), order: at });
  };
  for (const m of text.matchAll(/!\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)/g)) add(m[2], m[1], m.index ?? 0);
  for (const m of text.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) add(m[1], m[0].match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1] ?? "", m.index ?? 0);
  return out.sort((a, b) => a.order - b.order);
}

/**
 * Choose, from paths and sizes alone, the image files worth keeping: logos, app icons, social cards and screenshots, plus
 * the images the README shows. Dependency, build, test and example folders are ignored, as are framework starter images.
 */
export function pickVisuals(files: { path: string; size: number }[], readmes: { path: string; text: string }[]): VisualCandidate[] {
  const shown = new Map<string, { alt: string; first: boolean }>();
  for (const r of readmes) readmeImages(r.path, r.text).forEach((img, i) => { if (!shown.has(img.path)) shown.set(img.path, { alt: img.alt, first: i === 0 && img.order < 1500 }); });
  const picked: VisualCandidate[] = [];
  for (const f of files) {
    const vector = VECTOR.test(f.path);
    if (!vector && !RASTER.test(f.path)) continue;
    if (f.size === 0 || f.size > (vector ? MAX_SVG_BYTES : MAX_RASTER_BYTES)) continue;
    if (isDefaultExcludedPath(f.path) || NOT_PRODUCT.test(f.path)) continue;
    const base = f.path.split("/").pop()!.toLowerCase();
    if (BOILERPLATE.has(base)) continue;
    const name = base.replace(/\.[a-z]+$/, "");
    const readme = shown.get(f.path);
    const depth = f.path.split("/").length - 1;
    let kind: VisualKind | undefined;
    let score = 0;
    if (LOGO.test(name) || BRAND_DIR.test(f.path)) { kind = "logo"; score = 100 + (name.includes("logo") ? 20 : 0) + (vector ? 15 : 0); }
    else if (ICON.test(name) || (name === "icon" && /(^|\/)(app|public|src\/app)\//.test(f.path))) { kind = "icon"; score = 60 + (vector ? 10 : Math.min(20, f.size / 4096)); }
    else if (HERO.test(name)) { kind = "hero"; score = 70 + (/opengraph|og-image|^og$/.test(name) ? 20 : 0); }
    else if (SCREEN.test(name) || SCREEN_DIR.test(f.path)) { kind = "screenshot"; score = 50; }
    else if (readme) { kind = readme.first ? "hero" : "screenshot"; score = 45; }
    if (!kind) continue;
    if (readme) score += 40;
    score -= depth * 2;
    picked.push({ path: f.path, kind, score, alt: readme?.alt || undefined, forDark: kind === "logo" && FOR_DARK.test(name) ? true : undefined });
  }
  picked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const count: Record<VisualKind, number> = { logo: 0, icon: 0, hero: 0, screenshot: 0 };
  return picked.filter((p) => count[p.kind]++ < LIMITS[p.kind]);
}

/** Width and height from a PNG, GIF or JPEG header, without decoding the image. */
export function imageSize(b: Buffer): { width: number; height: number; mime: string } | undefined {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), mime: "image/png" };
  if (b.length > 10 && b.toString("latin1", 0, 3) === "GIF") return { width: b.readUInt16LE(6), height: b.readUInt16LE(8), mime: "image/gif" };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5), mime: "image/jpeg" };
      i += 2 + len;
    }
  }
  return undefined;
}

export interface ProcessedImage { mime: "image/png" | "image/jpeg"; width: number; height: number; data: Buffer; meta: ImageMeta }

const FONT = path.join(process.cwd(), "node_modules", "dejavu-fonts-ttf", "ttf", "DejaVuSans.ttf");
const MAX_SIDE: Record<VisualKind, number> = { logo: 720, icon: 512, hero: 1600, screenshot: 1600 };
const MAX_PIXELS = 40_000_000;

/** Only inline (data:) and in-document (#id) references survive, so an SVG can never point the renderer at a file or URL. */
function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?>/gi, "")
    .replace(/\b((?:xlink:)?href)\s*=\s*(["'])(?!data:image\/(?:png|jpeg|gif);|#)[\s\S]*?\2/gi, '$1=""')
    .replace(/url\(\s*(["']?)(?!#|data:image\/(?:png|jpeg|gif);)[^)]*\)/gi, "none")
    .replace(/@import[^;]+;/gi, "");
}

/** Light, dark or colourful; whether the image fills its corners; its most prominent saturated colours. `seen`: visible pixels sampled. */
export function measurePixels(px: Buffer, width: number, height: number): ImageMeta & { seen: number } {
  const at = (x: number, y: number) => px[(y * width + x) * 4 + 3];
  const opaque = [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)].every((a) => a > 240);
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 40_000)));
  let seen = 0, light = 0, dark = 0;
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let y = 0; y < height; y += step) for (let x = 0; x < width; x += step) {
    const i = (y * width + x) * 4;
    if (px[i + 3] < 128) continue;
    seen++;
    const rgb: RGB = [px[i] / 255, px[i + 1] / 255, px[i + 2] / 255];
    const o = toOklch(rgb);
    if (o.l > 0.86) light++;
    else if (o.l < 0.4) dark++;
    if (o.c > 0.07 && o.l > 0.3 && o.l < 0.9) {
      const k = Math.round(o.h / 15) % 24;
      const bk = buckets.get(k) ?? { n: 0, r: 0, g: 0, b: 0 };
      bk.n++; bk.r += rgb[0]; bk.g += rgb[1]; bk.b += rgb[2];
      buckets.set(k, bk);
    }
  }
  const colors = [...buckets.values()].filter((b) => b.n >= Math.max(3, seen * 0.03)).sort((a, b) => b.n - a.n).slice(0, 3).map((b) => toHex([b.r / b.n, b.g / b.n, b.b / b.n]));
  const tone = seen && light / seen > 0.7 ? "light" : seen && dark / seen > 0.6 ? "dark" : "color";
  return { tone, opaque, colors, seen };
}

/**
 * Decode an image within fixed bounds and re-encode it as PNG (a JPEG already small enough is kept as it is). SVG is
 * rasterised with every external reference removed. Undefined when the file cannot be read as an image, or is so large in
 * pixels that decoding it would be a hazard.
 */
export function processImage(filePath: string, bytes: Buffer, kind: VisualKind): ProcessedImage | undefined {
  const max = MAX_SIDE[kind];
  try {
    let svg: string;
    let src: { width: number; height: number; mime: string } | undefined;
    if (VECTOR.test(filePath)) {
      svg = sanitizeSvg(bytes.toString("utf8"));
    } else {
      src = imageSize(bytes);
      if (!src || src.width < 16 || src.height < 16 || src.width * src.height > MAX_PIXELS) return undefined;
      svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${src.width}" height="${src.height}"><image href="data:${src.mime};base64,${bytes.toString("base64")}" width="${src.width}" height="${src.height}" preserveAspectRatio="none"/></svg>`;
    }
    const probe = new Resvg(svg, { font: { loadSystemFonts: false, fontFiles: [FONT], defaultFontFamily: "DejaVu Sans" } });
    const w0 = probe.width, h0 = probe.height;
    if (!(w0 > 0 && h0 > 0) || w0 * h0 > MAX_PIXELS * 4) return undefined;
    // Vectors are drawn at the bound; rasters are only ever scaled down.
    const scale = Math.min(VECTOR.test(filePath) ? Infinity : 1, max / Math.max(w0, h0));
    const fitTo = w0 >= h0 ? { mode: "width" as const, value: Math.max(1, Math.round(w0 * scale)) } : { mode: "height" as const, value: Math.max(1, Math.round(h0 * scale)) };
    const out = new Resvg(svg, { fitTo, font: { loadSystemFonts: false, fontFiles: [FONT], defaultFontFamily: "DejaVu Sans" } }).render();
    const { seen, ...meta } = measurePixels(out.pixels, out.width, out.height);
    if (seen === 0) return undefined; // nothing visible: an empty drawing, or a format the renderer could not decode
    if (src?.mime === "image/jpeg" && scale >= 1) return { mime: "image/jpeg", width: src.width, height: src.height, data: bytes, meta };
    return { mime: "image/png", width: out.width, height: out.height, data: out.asPng(), meta };
  } catch {
    return undefined;
  }
}
