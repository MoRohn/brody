import path from "node:path";
import * as fontkit from "fontkit";
import type { FontKind } from "./scene";

/**
 * Text measurement for the deck layout, using the same DejaVu faces as the report's PDF so the numbers are stable on every
 * machine. DejaVu Sans Condensed is about as wide as Arial and DejaVu Serif is wider than Georgia, so text that fits here
 * fits in the browser and in PowerPoint (with a small margin added).
 */
const DIR = path.join(process.cwd(), "node_modules", "dejavu-fonts-ttf", "ttf");
const FILES: Record<string, string> = {
  "sans": "DejaVuSansCondensed.ttf",
  "sans-bold": "DejaVuSansCondensed-Bold.ttf",
  "serif": "DejaVuSerif.ttf",
  "serif-bold": "DejaVuSerif-Bold.ttf",
};
const SAFETY = 1.03;

interface Face { unitsPerEm: number; glyphForCodePoint(cp: number): { advanceWidth: number }; hasGlyphForCodePoint(cp: number): boolean }
const faces = new Map<string, Face>();
const advances = new Map<string, Map<number, number>>();

function face(key: string): Face {
  let f = faces.get(key);
  if (!f) { f = fontkit.openSync(path.join(DIR, FILES[key])) as unknown as Face; faces.set(key, f); advances.set(key, new Map()); }
  return f;
}
const keyOf = (font: FontKind, bold: boolean) => `${font}${bold ? "-bold" : ""}`;

/** Width in canvas pixels of a single line. */
export function textWidth(text: string, size: number, font: FontKind = "sans", bold = false): number {
  const key = keyOf(font, bold);
  const f = face(key);
  const cache = advances.get(key)!;
  let total = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    let a = cache.get(cp);
    if (a === undefined) { a = f.hasGlyphForCodePoint(cp) ? f.glyphForCodePoint(cp).advanceWidth / f.unitsPerEm : 0.55; cache.set(cp, a); }
    total += a;
  }
  return total * size * SAFETY;
}

export interface WrapOptions { size: number; font?: FontKind; bold?: boolean; maxLines?: number }

/** Greedy word wrap to a width. Overflowing text is cut at `maxLines` with an ellipsis. */
export function wrap(text: string, width: number, o: WrapOptions): string[] {
  const font = o.font ?? "sans";
  const bold = !!o.bold;
  const paragraphs = text.replace(/\r/g, "").split("\n");
  const lines: string[] = [];
  const w = (s: string) => textWidth(s, o.size, font, bold);
  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) { lines.push(""); continue; }
    let cur = "";
    for (const word of words) {
      const next = cur ? `${cur} ${word}` : word;
      if (w(next) <= width) { cur = next; continue; }
      if (cur) lines.push(cur);
      // A single word longer than the line is broken into pieces.
      if (w(word) > width) {
        let piece = "";
        for (const ch of word) { if (w(piece + ch) > width && piece) { lines.push(piece); piece = ch; } else piece += ch; }
        cur = piece;
      } else cur = word;
    }
    if (cur) lines.push(cur);
  }
  if (o.maxLines && lines.length > o.maxLines) {
    const kept = lines.slice(0, o.maxLines);
    let last = kept[o.maxLines - 1];
    while (last.length > 1 && w(`${last}…`) > width) last = last.slice(0, -1).replace(/\s+$/, "");
    kept[o.maxLines - 1] = `${last.replace(/[\s,;:.-]+$/, "")}…`;
    return kept;
  }
  return lines;
}
