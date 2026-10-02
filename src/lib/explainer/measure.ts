/**
 * Text measurement for explainer layouts, with the exact faces both renderers draw with (DejaVu Sans Condensed and
 * DejaVu Sans Mono, shipped in node_modules/dejavu-fonts-ttf and loaded by resvg and registered with Manim). Because
 * layout, the SVG renderer and the Manim renderer share one set of font files, a label measured to fit here fits on
 * screen, and the layout validator can prove it.
 */
import path from "node:path";
import * as fontkit from "fontkit";
import { FONT } from "./design";

export const FONT_DIR = path.join(process.cwd(), "node_modules", "dejavu-fonts-ttf", "ttf");
export const fontFiles = () => Object.values(FONT.files).map((f) => path.join(FONT_DIR, f));

interface Face { unitsPerEm: number; ascent: number; descent: number; glyphForCodePoint(cp: number): { advanceWidth: number }; hasGlyphForCodePoint(cp: number): boolean }
const faces = new Map<string, Face>();
const cache = new Map<string, Map<number, number>>();

function face(file: string): Face {
  let f = faces.get(file);
  if (!f) { f = fontkit.openSync(path.join(FONT_DIR, file)) as unknown as Face; faces.set(file, f); cache.set(file, new Map()); }
  return f;
}
const fileFor = (mono: boolean, bold: boolean) => (mono ? (bold ? FONT.files.monoBold : FONT.files.mono) : bold ? FONT.files.sansBold : FONT.files.sans);

export function textWidth(text: string, size: number, o: { mono?: boolean; bold?: boolean } = {}): number {
  const file = fileFor(!!o.mono, !!o.bold);
  const f = face(file);
  const c = cache.get(file)!;
  let total = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    let a = c.get(cp);
    if (a === undefined) { a = f.hasGlyphForCodePoint(cp) ? f.glyphForCodePoint(cp).advanceWidth / f.unitsPerEm : 0.6; c.set(cp, a); }
    total += a;
  }
  return total * size;
}

/** Ascent above the baseline, in px, for vertical placement. */
export function ascent(size: number, mono = false): number {
  const f = face(fileFor(mono, false));
  return (f.ascent / f.unitsPerEm) * size;
}

/**
 * Greedy wrap to `width`. Words wider than the line (long identifiers, URLs) are broken at separators or hard-split, so
 * no line can ever exceed the width. Returns at most `maxLines`, the last one ellipsised when text was cut.
 */
export function wrapText(text: string, width: number, size: number, o: { mono?: boolean; bold?: boolean; maxLines?: number } = {}): { lines: string[]; truncated: boolean } {
  const w = (s: string) => textWidth(s, size, o);
  const words: string[] = [];
  for (const word of text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean)) {
    if (w(word) <= width) { words.push(word); continue; }
    // Break long tokens after separators, then by characters.
    let cur = "";
    for (const part of word.split(/(?<=[/._:-])/)) {
      if (w(cur + part) <= width) { cur += part; continue; }
      if (cur) words.push(cur);
      cur = "";
      for (const ch of part) { if (w(cur + ch) > width && cur) { words.push(cur); cur = ""; } cur += ch; }
    }
    if (cur) words.push(cur);
  }
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    const next = cur ? `${cur} ${word}` : word;
    if (w(next) <= width || !cur) cur = next;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  const max = o.maxLines ?? Infinity;
  if (lines.length <= max) return { lines, truncated: false };
  const kept = lines.slice(0, max);
  let last = kept[max - 1];
  while (last.length > 1 && w(`${last}…`) > width) last = last.slice(0, -1).trimEnd();
  kept[max - 1] = `${last}…`;
  return { lines: kept, truncated: true };
}
