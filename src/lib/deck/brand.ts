import { inArray } from "drizzle-orm";
import { getDb, projectRows, schema } from "../db/client";
import type { ImageMeta } from "../db/schema";
import { getFileContents } from "../ingest/store";
import { pickVisuals, processImage, type VisualCandidate } from "../ingest/visuals";
import { parseColor, toHex, toOklch } from "../util/color";
import type { DeckImage } from "./scene";

/**
 * The project's own branding, found in its repository: a logo (and a variant for dark backgrounds), a social card or lead
 * screenshot, more screenshots, and the brand colours it declares. The deck stores references (image hashes and paths),
 * never the pixels; every element records the file it came from, so the deck can say where its branding came from.
 */
export interface BrandImage { hash: string; path: string; width: number; height: number; tone: ImageMeta["tone"]; opaque: boolean; caption?: string }
export interface BrandColor { color: string; source: string }
export interface DeckBrand {
  primary?: BrandColor;
  secondary?: BrandColor;
  /** The logo for light backgrounds (any tone; a light-only logo is drawn on a dark tile). */
  logo?: BrandImage;
  /** A logo made for dark backgrounds, when the project has one. */
  logoOnDark?: BrandImage;
  /** A social card or the lead screenshot, shown on the title slide. */
  hero?: BrandImage;
  screens: BrandImage[];
}

type Role = "brand" | "primary" | "theme" | "accent" | "secondary";
const ROLE_RANK: Record<Role, number> = { brand: 0, primary: 1, theme: 2, accent: 3, secondary: 4 };
interface Declared { rgb: [number, number, number]; role: Role; source: string }

const STYLE_FILE = /\.(css|scss|sass|less|styl|pcss)$/i;
const STYLE_NAME = /(global|index|app|main|theme|variables|vars|tokens|colou?rs|base|styles?|tailwind|brand|root)[^/]*$/i;
const MANIFEST = /(^|\/)(manifest\.json|site\.webmanifest|manifest\.webmanifest)$/i;
const PAGE_SHELL = /(^|\/)(index\.html?|app\.html|_document\.[jt]sx?|layout\.[jt]sx?|nuxt\.config\.[jt]s|_app\.[jt]sx?)$/i;
const TAILWIND = /(^|\/)tailwind\.config\.[cm]?[jt]s$/i;
const THEME_CODE = /(^|\/)(theme|colou?rs|tokens|palette|brand)\.(ts|js|mjs|json)$/i;
const VAR_ROLE: [RegExp, Role][] = [[/^(color-)?brand(-(color|primary|500|600|default|base|main))?$/, "brand"], [/^(color-)?primary(-(color|500|600|default|base|main))?$/, "primary"], [/^(color-)?accent(-(color|500|600|default|base|main))?$/, "accent"], [/^(color-)?secondary(-(color|500|600|default|base|main))?$/, "secondary"]];

const roleOfName = (name: string): Role | undefined => VAR_ROLE.find(([re]) => re.test(name.toLowerCase()))?.[1];

/** Brand colours a project declares: CSS custom properties and Sass variables, Tailwind and theme config, web manifests, theme-color tags. */
export function declaredColors(files: { path: string; text: string }[]): Declared[] {
  const out: Declared[] = [];
  const add = (value: string, role: Role | undefined, source: string) => {
    const rgb = role && parseColor(value.replace(/\/\*.*?\*\//g, ""));
    if (rgb) out.push({ rgb, role: role!, source });
  };
  for (const { path, text } of files) {
    if (STYLE_FILE.test(path)) {
      // The first definition of each name: the default (light) theme comes before dark-mode overrides.
      const seen = new Set<string>();
      for (const m of text.matchAll(/(?:--|\$)([\w-]+)\s*:\s*([^;{}]+)[;}]/g)) {
        const role = roleOfName(m[1]);
        if (!role || seen.has(m[1])) continue;
        seen.add(m[1]);
        add(m[2], role, path);
      }
    } else if (MANIFEST.test(path)) {
      try { const j = JSON.parse(text) as { theme_color?: string }; if (j.theme_color) add(j.theme_color, "theme", path); } catch { /* not JSON */ }
    } else if (PAGE_SHELL.test(path)) {
      const meta = text.match(/<meta[^>]*name=["']theme-color["'][^>]*>/i)?.[0].match(/content=["']([^"']+)["']/i)?.[1] ?? text.match(/themeColor\s*:\s*["']([^"']+)["']/)?.[1];
      if (meta) add(meta, "theme", path);
    } else if (TAILWIND.test(path) || THEME_CODE.test(path)) {
      for (const m of text.matchAll(/\b(brand|primary|accent|secondary)(?:Color)?\s*:\s*(?:\{[^{}]*?["']?\b(?:DEFAULT|main|500|600)["']?\s*:\s*)?["'`]([^"'`]+)["'`]/gi)) add(m[2], m[1].toLowerCase() as Role, path);
    }
  }
  return out.sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.source.split("/").length - b.source.split("/").length);
}

const colorful = (rgb: [number, number, number]) => toOklch(rgb).c >= 0.05;
const caption = (v: VisualCandidate) => v.alt?.trim() || (v.path.split("/").pop() ?? "").replace(/\.[a-z]+$/i, "").replace(/[-_.]+/g, " ").replace(/\b(screenshot|screen|img|image|\d+x\d+|@\dx)\b/gi, "").replace(/\s+/g, " ").trim().replace(/^./, (c) => c.toUpperCase()) || undefined;

/** Find the project's branding. Images analysed before images were stored are recovered where possible (SVG is kept as text). */
export function detectBrand(projectId: string): DeckBrand | undefined {
  const db = getDb();
  const rows = projectRows(schema.files, projectId).filter((f) => !f.isExcluded);
  const byPath = new Map(rows.map((f) => [f.path, f]));
  const textOf = (paths: string[]) => {
    const want = paths.map((p) => byPath.get(p)).filter((f): f is NonNullable<typeof f> => !!f && f.hasContent && !f.isBinary);
    const contents = getFileContents(want.map((f) => f.hash));
    return want.map((f) => ({ path: f.path, text: contents.get(f.hash) ?? "" })).filter((f) => f.text);
  };

  const readmes = textOf(rows.filter((f) => /^([^/]+\/)?readme(\.(md|markdown|mdx|rst|txt))?$/i.test(f.path)).map((f) => f.path));
  const candidates = pickVisuals(rows.map((f) => ({ path: f.path, size: f.size })), readmes);
  const hashes = [...new Set(candidates.map((c) => byPath.get(c.path)!.hash))];
  const stored = new Map(hashes.length ? db.select({ hash: schema.images.hash, width: schema.images.width, height: schema.images.height, meta: schema.images.meta }).from(schema.images).where(inArray(schema.images.hash, hashes)).all().map((r) => [r.hash, r]) : []);
  // An SVG logo is kept as text, so a project analysed before images were stored can still have it drawn now.
  for (const c of candidates) {
    const f = byPath.get(c.path)!;
    if (stored.has(f.hash) || !/\.svg$/i.test(c.path) || !f.hasContent) continue;
    const svg = getFileContents([f.hash]).get(f.hash);
    if (svg && /61DAFB/i.test(svg) && /(^|\/)src\/logo\.svg$/.test(c.path)) continue; // the Create React App starter logo
    const img = svg ? processImage(c.path, Buffer.from(svg, "utf8"), c.kind) : undefined;
    if (!img) continue;
    db.insert(schema.images).values({ hash: f.hash, mime: img.mime, width: img.width, height: img.height, data: img.data, meta: img.meta }).onConflictDoNothing().run();
    stored.set(f.hash, { hash: f.hash, width: img.width, height: img.height, meta: img.meta });
  }

  const found = candidates.flatMap((v) => {
    const s = stored.get(byPath.get(v.path)!.hash);
    if (!s) return [];
    const aspect = s.width / s.height;
    // A README's first image is a banner when it is wide, and most likely the logo otherwise.
    const kind = v.kind === "hero" && aspect < 1.5 && !/og|social|banner|hero|cover|splash/i.test(v.path) ? "logo" : v.kind;
    return [{ v: { ...v, kind }, img: { hash: s.hash, path: v.path, width: s.width, height: s.height, tone: s.meta.tone, opaque: s.meta.opaque, caption: caption(v) } as BrandImage, meta: s.meta, aspect }];
  });
  const logos = found.filter((x) => (x.v.kind === "logo" && Math.min(x.img.width, x.img.height) >= 24) || (x.v.kind === "icon" && x.img.width >= 128 && x.aspect > 0.8 && x.aspect < 1.25));
  logos.sort((a, b) => (a.v.kind === b.v.kind ? 0 : a.v.kind === "logo" ? -1 : 1));
  // The main logo is for light backgrounds: never a variant named for dark ones while there is another.
  const logo = logos.find((x) => !x.v.forDark && (x.img.tone !== "light" || x.img.opaque)) ?? logos.find((x) => !x.v.forDark) ?? logos[0];
  const logoOnDark = logos.find((x) => x !== logo && (x.v.forDark || x.img.tone === "light"));
  const wide = (x: (typeof found)[number]) => x.img.width >= 480 && x.aspect >= 0.45 && x.aspect <= 3.4;
  const heroes = found.filter((x) => x.v.kind === "hero" && x.img.width >= 600 && x.aspect >= 1.2 && x.aspect <= 3.4);
  const shots = found.filter((x) => x.v.kind === "screenshot" && wide(x));
  const hero = heroes[0] ?? shots[0];
  const screens = (shots.length > 1 ? shots.filter((x) => x !== hero) : shots).slice(0, 3);

  const styleFiles = rows.filter((f) => f.hasContent && !f.isBinary && f.size < 400_000 && ((STYLE_FILE.test(f.path) && (STYLE_NAME.test(f.path) || f.path.split("/").length <= 3)) || MANIFEST.test(f.path) || PAGE_SHELL.test(f.path) || TAILWIND.test(f.path) || THEME_CODE.test(f.path)));
  const declared = declaredColors(textOf(styleFiles.slice(0, 60).map((f) => f.path)));
  const logoColors = [logo, logoOnDark].flatMap((x) => (x ? x.meta.colors.map((c) => ({ color: c, source: x.img.path })) : []));
  const firstColorful = declared.find((d) => d.role !== "secondary" && colorful(d.rgb));
  let primary: BrandColor | undefined = firstColorful ? { color: toHex(firstColorful.rgb), source: firstColorful.source } : logoColors[0];
  // A deliberately monochrome brand: a logo and a declared grey or black primary, but no colour anywhere.
  if (!primary && logo) { const grey = declared.find((d) => d.role === "brand" || d.role === "primary"); if (grey) primary = { color: toHex(grey.rgb), source: grey.source }; }
  const second = declared.find((d) => (d.role === "secondary" || d.role === "accent") && colorful(d.rgb) && toHex(d.rgb) !== primary?.color);
  const secondary: BrandColor | undefined = second ? { color: toHex(second.rgb), source: second.source } : logoColors.find((c) => c.color !== primary?.color);

  if (!primary && !logo && !hero && !screens.length) return undefined;
  return { primary, secondary, logo: logo?.img, logoOnDark: logoOnDark?.img, hero: hero?.img, screens: screens.map((x) => x.img) };
}

/** Where the deck's branding came from, for the coverage slide and the app: "public/logo.svg; app/globals.css". */
export function brandSources(b: DeckBrand): string[] {
  return [...new Set([b.logo?.path, b.logoOnDark?.path, b.primary?.source, b.hero?.path, ...b.screens.map((s) => s.path)].filter((p): p is string => !!p))];
}

/** The stored renderings of a brand's images, by hash. Missing ones are simply left out (a deck imported without them). */
export function loadBrandImages(b: DeckBrand | undefined): Map<string, DeckImage> {
  const hashes = b ? [...new Set([b.logo, b.logoOnDark, b.hero, ...b.screens].filter((x): x is BrandImage => !!x).map((x) => x.hash))] : [];
  if (!hashes.length) return new Map();
  const rows = getDb().select({ hash: schema.images.hash, mime: schema.images.mime, width: schema.images.width, height: schema.images.height, data: schema.images.data }).from(schema.images).where(inArray(schema.images.hash, hashes)).all();
  return new Map(rows.map((r) => [r.hash, { mime: r.mime, width: r.width, height: r.height, data: r.data }]));
}
