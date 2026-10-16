import { getDb, schema } from "../db/client";
import { eq } from "drizzle-orm";
import { brandSources, loadBrandImages } from "./brand";
import { ensureDeckContent, type DeckContent } from "./content";
import { buildDeckHtml } from "./html";
import { layoutDeck } from "./layout";
import { renderDeckPdf } from "./pdf";
import { renderDeckPptx } from "./pptx";
import type { DeckSlides } from "./scene";

export type DeckFormat = "html" | "pptx" | "pdf";
export const DECK_FORMATS: DeckFormat[] = ["html", "pptx", "pdf"];
export const isDeckFormat = (v: string): v is DeckFormat => (DECK_FORMATS as string[]).includes(v);

export const DECK_CONTENT_TYPES: Record<DeckFormat, string> = {
  html: "text/html; charset=utf-8",
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export interface DeckFile { body: Buffer | string; contentType: string; filename: string }

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "project";
const cache = new Map<string, { at: number; file: DeckFile }>();
const CACHE_MAX = 9;

/** Whether a deck is drawn with the project's own branding (when its repository has any) or in Brody's style. */
export interface DeckOptions { brand?: boolean }

const layout = (content: DeckContent, o: DeckOptions) => layoutDeck(content, { brand: o.brand !== false, images: o.brand === false ? undefined : loadBrandImages(content.brand) });

/** The laid-out slides for a project: the same shapes every format draws. */
export function deckSlides(projectId: string, o: DeckOptions = {}): DeckSlides {
  return layout(ensureDeckContent(projectId), o);
}

export interface DeckOutline {
  title: string; generatedAt: number; origin: string;
  slides: { n: number; id: string; title: string; kicker: string; ref?: string }[];
  /** The branding found in the repository (whether or not this outline uses it), and the files it came from. */
  brand: { logo: boolean; colors: string[]; screens: number; sources: string[] } | null;
}

/** The slide list (titles and the report section each points to), for the app page. */
export function deckOutline(projectId: string, o: DeckOptions = {}): DeckOutline {
  const content = ensureDeckContent(projectId);
  const d = layout(content, o);
  const b = content.brand;
  return {
    title: d.title, generatedAt: d.generatedAt, origin: content.origin, slides: d.slides.map((s, i) => ({ n: i + 1, id: s.id, title: s.title, kicker: s.kicker, ref: s.ref })),
    brand: b ? { logo: !!(b.logo || b.logoOnDark), colors: [b.primary?.color, b.secondary?.color].filter((x): x is string => !!x), screens: (b.hero ? 1 : 0) + b.screens.length, sources: brandSources(b) } : null,
  };
}

/** One deck file. Content comes from the snapshot the analysis stored, so the deck matches the report it was built with. */
export async function exportDeck(projectId: string, format: DeckFormat, o: DeckOptions = {}): Promise<DeckFile> {
  const content: DeckContent = ensureDeckContent(projectId);
  const key = `${projectId}:${content.generatedAt}:${format}:${o.brand === false ? "plain" : "brand"}`;
  const hit = cache.get(key);
  if (hit) return hit.file;
  const project = getDb().select({ name: schema.projects.name }).from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  const slides = layout(content, o);
  const stem = `${safe(project?.name ?? content.project.name)}-executive-summary`;
  let file: DeckFile;
  if (format === "html") file = { body: buildDeckHtml(slides), contentType: DECK_CONTENT_TYPES.html, filename: `${stem}.html` };
  else if (format === "pdf") file = { body: await renderDeckPdf(slides), contentType: DECK_CONTENT_TYPES.pdf, filename: `${stem}.pdf` };
  else file = { body: await renderDeckPptx(slides), contentType: DECK_CONTENT_TYPES.pptx, filename: `${stem}.pptx` };
  cache.set(key, { at: Date.now(), file });
  while (cache.size > CACHE_MAX) cache.delete([...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0][0]);
  return file;
}

export { buildDeckContent, ensureDeckContent, saveDeckContent, type DeckContent } from "./content";
export { layoutDeck } from "./layout";
