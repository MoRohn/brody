/**
 * Captions (WebVTT and SRT) and the transcript, generated from the measured word timings, never from guessed durations.
 * Cues keep to broadcast norms: at most two lines of 42 characters, at most 6 seconds, broken at sentence ends, never
 * spanning two sections. Browser-safe (the player builds chapter tracks with it).
 */
import type { TimedWord, TranscriptEntry } from "./types";

export interface Cue { index: number; startMs: number; endMs: number; lines: string[]; sectionId: string }

const MAX_LINE = 42;
const MAX_CUE_MS = 6000;
const MIN_CUE_MS = 700;

function wrap2(words: string[]): string[] | null {
  const text = words.join(" ");
  if (text.length <= MAX_LINE) return [text];
  // Best two-line split: balanced, both within the limit.
  let best: string[] | null = null, bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" "), b = words.slice(i).join(" ");
    if (a.length > MAX_LINE || b.length > MAX_LINE) continue;
    const diff = Math.abs(a.length - b.length);
    if (diff < bestDiff) { best = [a, b]; bestDiff = diff; }
  }
  return best;
}

export function buildCues(words: TimedWord[]): Cue[] {
  const cues: Cue[] = [];
  let cur: TimedWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    const lines = wrap2(cur.map((w) => w.text)) ?? [cur.map((w) => w.text).join(" ")];
    cues.push({ index: cues.length + 1, startMs: cur[0].startMs, endMs: cur[cur.length - 1].endMs, lines, sectionId: cur[0].sectionId });
    cur = [];
  };
  for (const w of words) {
    if (cur.length) {
      const last = cur[cur.length - 1];
      const tooLong = !wrap2([...cur, w].map((x) => x.text)) || w.endMs - cur[0].startMs > MAX_CUE_MS;
      const newSection = w.sectionId !== last.sectionId;
      const sentenceEnd = /[.!?]["')\]]?$/.test(last.text) && cur.length >= 3;
      if (tooLong || newSection || sentenceEnd) flush();
    }
    cur.push(w);
  }
  flush();
  // Short cues are held a little longer, but never into the next one.
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1]?.startMs ?? Infinity;
    if (cues[i].endMs - cues[i].startMs < MIN_CUE_MS) cues[i].endMs = Math.min(cues[i].startMs + MIN_CUE_MS, next);
    if (cues[i].endMs > next) cues[i].endMs = next;
  }
  return cues;
}

const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, "0");
function stamp(ms: number, sep: "." | ","): string {
  const t = Math.max(0, Math.round(ms));
  return `${pad(t / 3_600_000)}:${pad((t / 60_000) % 60)}:${pad((t / 1000) % 60)}${sep}${pad(t % 1000, 3)}`;
}

/** WebVTT text must not contain "-->" or start a line with "NOTE"; escape the markup characters. */
const vttText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/-->/g, "--&gt;");

export function toVtt(cues: Cue[]): string {
  return `WEBVTT\n\n${cues.map((c) => `${c.index}\n${stamp(c.startMs, ".")} --> ${stamp(c.endMs, ".")}\n${c.lines.map(vttText).join("\n")}`).join("\n\n")}\n`;
}

export function toSrt(cues: Cue[]): string {
  return `${cues.map((c) => `${c.index}\n${stamp(c.startMs, ",")} --> ${stamp(c.endMs, ",")}\n${c.lines.join("\n")}`).join("\n\n")}\n`;
}

/** Chapters as WebVTT, one cue per section, for the player's chapter track. */
export function chaptersVtt(chapters: { title: string; startMs: number; endMs: number }[]): string {
  return `WEBVTT\n\n${chapters.map((c, i) => `chapter-${i + 1}\n${stamp(c.startMs, ".")} --> ${stamp(c.endMs, ".")}\n${vttText(c.title)}`).join("\n\n")}\n`;
}

/** One transcript entry per spoken sentence, with the claims and sources its section rests on. */
export function buildTranscript(words: TimedWord[], sectionRefs: Map<string, { sourceRefs: string[]; claimIds: string[] }>): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  let cur: TimedWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    const refs = sectionRefs.get(cur[0].sectionId) ?? { sourceRefs: [], claimIds: [] };
    out.push({ id: `t${out.length + 1}`, sectionId: cur[0].sectionId, text: cur.map((w) => w.text).join(" "), startMs: Math.round(cur[0].startMs), endMs: Math.round(cur[cur.length - 1].endMs), sourceRefs: refs.sourceRefs, claimIds: refs.claimIds });
    cur = [];
  };
  for (const w of words) {
    if (cur.length && (w.sectionId !== cur[0].sectionId || w.sentence !== cur[cur.length - 1].sentence)) flush();
    cur.push(w);
  }
  flush();
  return out;
}

/** Parse WebVTT back into cues (used by validation to check what was written). */
export function parseVtt(vtt: string): { startMs: number; endMs: number; text: string }[] {
  const toMs = (s: string) => { const [h, m, rest] = s.split(":"); const [sec, ms] = rest.split("."); return ((Number(h) * 60 + Number(m)) * 60 + Number(sec)) * 1000 + Number(ms); };
  const out: { startMs: number; endMs: number; text: string }[] = [];
  for (const block of vtt.split(/\n\n+/)) {
    const lines = block.split("\n");
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split("-->").map((x) => x.trim());
    out.push({ startMs: toMs(a), endMs: toMs(b), text: lines.slice(ti + 1).join(" ") });
  }
  return out;
}
