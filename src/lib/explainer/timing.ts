/**
 * Measured word timing, normalised onto the words a viewer reads.
 *
 * The voice spoke the SPOKEN form of each sentence (speech.ts). Providers report timed words in their own segmentation:
 * with character ranges into the text we sent (macOS, ElevenLabs, Speechify, synthetic), or as transcribed words (OpenAI
 * alignment) that may split, merge or spell things differently. Both are mapped onto character spans of the spoken text,
 * then onto display tokens. A token no measured word covers is interpolated between its measured neighbours and flagged,
 * and the count is reported, so measured and estimated time are never confused.
 *
 * Output guarantees (checked by validate.ts): times are non-negative, start before end, never decrease, and stay within
 * the audio.
 */
import { normWord, spokenText, type SpeechToken } from "./speech";
import type { TimedWord } from "./types";
import type { TTSWord } from "./tts/types";

interface Span { start: number; end: number }

/** Character span of every display token inside the spoken text. */
export function tokenSpans(tokens: SpeechToken[]): Span[] {
  const spans: Span[] = [];
  let at = 0;
  let first = true;
  for (const t of tokens) {
    if (t.spoken.length === 0) { spans.push({ start: at, end: at }); continue; }
    if (!first) at += 1; // the joining space
    first = false;
    const len = t.spoken.join(" ").length;
    spans.push({ start: at, end: at + len });
    at += len;
  }
  return spans;
}

/** Locate provider words in the text by character alignment (longest common subsequence over letters and digits). */
export function alignByCharacters(text: string, words: TTSWord[]): (Span | null)[] {
  const a: { ch: string; pos: number }[] = [];
  for (let i = 0; i < text.length; i++) { const c = text[i].toLowerCase(); if (/[a-z0-9]/.test(c)) a.push({ ch: c, pos: i }); }
  const b: { ch: string; word: number }[] = [];
  words.forEach((w, wi) => { for (const c of normWord(w.text)) b.push({ ch: c, word: wi }); });
  const n = a.length, m = b.length;
  if (!n || !m) return words.map(() => null);
  // DP with a direction table; rows are short (one section), so n * m stays in the low millions.
  const dir = new Uint8Array((n + 1) * (m + 1));
  let prev = new Uint16Array(m + 1), cur = new Uint16Array(m + 1);
  for (let i = 1; i <= n; i++) {
    cur[0] = 0;
    for (let j = 1; j <= m; j++) {
      if (a[i - 1].ch === b[j - 1].ch) { cur[j] = prev[j - 1] + 1; dir[i * (m + 1) + j] = 1; }
      else if (prev[j] >= cur[j - 1]) { cur[j] = prev[j]; dir[i * (m + 1) + j] = 2; }
      else { cur[j] = cur[j - 1]; dir[i * (m + 1) + j] = 3; }
    }
    [prev, cur] = [cur, prev];
  }
  const spans: (Span | null)[] = words.map(() => null);
  let i = n, j = m;
  while (i > 0 && j > 0) {
    const d = dir[i * (m + 1) + j];
    if (d === 1) {
      const w = b[j - 1].word, pos = a[i - 1].pos;
      const s = spans[w];
      spans[w] = s ? { start: Math.min(s.start, pos), end: Math.max(s.end, pos + 1) } : { start: pos, end: pos + 1 };
      i--; j--;
    } else if (d === 2) i--;
    else j--;
  }
  return spans;
}

export interface NormalizedTiming { words: TimedWord[]; interpolated: number; measured: number }

/**
 * Display-token timings for one section, offset to absolute narration time.
 * `durationMs` is the measured length of the section's speech.
 */
export function normalizeTiming(tokens: SpeechToken[], provider: TTSWord[], o: { sectionId: string; offsetMs: number; durationMs: number }): NormalizedTiming {
  const text = spokenText(tokens);
  const spans = tokenSpans(tokens);
  const located: (Span | null)[] = provider.every((w) => w.charStart !== undefined && w.charEnd !== undefined) ? provider.map((w) => ({ start: w.charStart!, end: w.charEnd! })) : alignByCharacters(text, provider);
  const times: ({ s: number; e: number } | null)[] = spans.map((sp) => {
    if (sp.end <= sp.start) return null;
    let s = Infinity, e = -Infinity;
    provider.forEach((w, wi) => {
      const l = located[wi];
      if (!l || l.end <= sp.start || l.start >= sp.end) return;
      s = Math.min(s, w.startMs);
      e = Math.max(e, w.endMs);
    });
    return Number.isFinite(s) && Number.isFinite(e) ? { s, e } : null;
  });

  // Interpolate gaps between measured neighbours, weighted by spoken length.
  let interpolated = 0;
  const filled = times.map((t) => (t ? { ...t } : null));
  for (let i = 0; i < filled.length; i++) {
    if (filled[i] || spans[i].end <= spans[i].start) continue;
    let k = i;
    while (k < filled.length && !filled[k]) k++;
    const left = i > 0 ? (filled[i - 1]?.e ?? 0) : 0;
    const right = k < filled.length ? filled[k]!.s : o.durationMs;
    const run = spans.slice(i, k).map((sp) => Math.max(1, sp.end - sp.start) + 1);
    const total = run.reduce((x, y) => x + y, 0);
    let t = left;
    for (let q = i; q < k; q++) {
      const d = ((right - left) * run[q - i]) / total;
      filled[q] = { s: t, e: t + d };
      t += d;
      if (spans[q].end > spans[q].start) interpolated++;
    }
    i = k - 1;
  }

  const words: TimedWord[] = [];
  let last = 0;
  tokens.forEach((tok, i) => {
    const t = filled[i];
    // Punctuation-only tokens (a dash) join the previous word rather than becoming a zero-length word.
    if (!t || spans[i].end <= spans[i].start) {
      if (words.length) words[words.length - 1].text += ` ${tok.display}`;
      return;
    }
    let s = Math.max(0, Math.min(t.s, o.durationMs), last);
    let e = Math.min(Math.max(t.e, s + 1), o.durationMs);
    if (e <= s) { s = Math.max(0, Math.min(s, o.durationMs - 1)); e = s + 1; }
    last = s;
    words.push({ text: tok.display, startMs: s + o.offsetMs, endMs: e + o.offsetMs, sectionId: o.sectionId, sentence: tok.sentence, ...(times[i] ? {} : { interpolated: true }) });
  });
  // Ends never overlap the next word's start.
  for (let i = 0; i < words.length - 1; i++) if (words[i].endMs > words[i + 1].startMs) words[i].endMs = Math.max(words[i].startMs + 1, words[i + 1].startMs);
  return { words, interpolated, measured: words.length - interpolated };
}
