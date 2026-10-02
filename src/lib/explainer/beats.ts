/**
 * Narrative beats: semantic visual events pinned to MEASURED narration time.
 *
 * A beat's cue is the opening words of the sentence where the visual change belongs. Cues are matched against the timed
 * words in spoken order, each search starting after the previous match, so a phrase spoken twice lands on the right
 * occurrence (the method of beats.py in the explainer-video reference, MIT, Paul Lemaistre). Unlike that script, a cue
 * that cannot be found does not abort: it falls back to the start of the sentence whose words it shares most, and the
 * beat records the fallback. When timing is sentence-level only, beats snap to sentence starts and say so.
 */
import { normWord, splitSentences } from "./speech";
import type { NarrationSection, NarrativeBeat, SectionAudio, TimedWord } from "./types";

export interface BeatWarning { sectionId: string; cue: string; detail: string }

function findCue(words: TimedWord[], cue: string, from: number): number {
  const p = cue.split(/\s+/).map(normWord).filter(Boolean).slice(0, 6);
  if (!p.length) return -1;
  const flat = words.map((w) => normWord(w.text));
  for (let i = from; i <= flat.length - p.length; i++) {
    let ok = true;
    for (let k = 0; k < p.length && ok; k++) ok = flat[i + k] === p[k];
    if (ok) return i;
  }
  // A shorter prefix (voices sometimes merge a leading "A" or "The"), still in order.
  if (p.length > 2) return findCue(words, p.slice(1).join(" "), from);
  return -1;
}

/** First word of the sentence that shares the most words with the cue, at or after `from`. */
function bestSentenceStart(words: TimedWord[], cue: string, from: number): number {
  const want = new Set(cue.split(/\s+/).map(normWord).filter(Boolean));
  let best = -1, bestScore = 0;
  for (let i = from; i < words.length; i++) {
    if (i > 0 && words[i].sentence === words[i - 1].sentence) continue;
    let score = 0;
    for (let k = i; k < words.length && words[k].sentence === words[i].sentence; k++) if (want.has(normWord(words[k].text))) score++;
    if (score > bestScore) { best = i; bestScore = score; }
  }
  return best;
}

export function extractBeats(sections: NarrationSection[], audio: SectionAudio[]): { beats: NarrativeBeat[]; warnings: BeatWarning[] } {
  const beats: NarrativeBeat[] = [];
  const warnings: BeatWarning[] = [];
  for (const sec of sections) {
    const a = audio.find((x) => x.sectionId === sec.id);
    if (!a || a.words.length === 0) { warnings.push({ sectionId: sec.id, cue: "", detail: "no timed words for this section" }); continue; }
    const words = a.words;
    const sentenceOnly = a.timing.granularity === "sentence";
    const local: NarrativeBeat[] = [];
    let cursor = 0;
    const intents = sec.visualIntent.beats.length ? sec.visualIntent.beats : splitSentences(sec.narration).map((s) => ({ cue: s, action: { kind: "hold" as const, targets: [] }, claimIds: sec.claimIds }));
    for (const intent of intents) {
      let idx = findCue(words, intent.cue, cursor);
      let anchored = false;
      if (idx < 0) {
        idx = bestSentenceStart(words, intent.cue, cursor);
        if (idx < 0) { warnings.push({ sectionId: sec.id, cue: intent.cue, detail: "cue not found in the spoken words; beat dropped" }); continue; }
        anchored = true;
        warnings.push({ sectionId: sec.id, cue: intent.cue, detail: `cue not found word for word; placed at the start of sentence ${words[idx].sentence + 1}` });
      }
      if (sentenceOnly) {
        // Without word timing, only sentence starts are measured: move the beat to its sentence's first word.
        while (idx > 0 && words[idx - 1].sentence === words[idx].sentence) idx--;
        anchored = true;
      }
      // Two cues on the same word would make a zero-length beat: keep the first and merge the action into it.
      const prev = local[local.length - 1];
      if (prev && words[idx].startMs <= prev.startMs) {
        warnings.push({ sectionId: sec.id, cue: intent.cue, detail: "cue landed on the same word as the previous beat; merged" });
        continue;
      }
      cursor = idx + 1;
      local.push({
        id: `${sec.id}.b${local.length + 1}`,
        sectionId: sec.id,
        cueText: intent.cue,
        // Rounded RELATIVE to the section, so a section's beats (and its scene's hash) do not depend on where the section
        // falls in the video: an earlier section that gets longer must not change this section's render.
        startMs: a.startMs + Math.round(Math.round((words[idx].startMs - a.startMs) * 1000) / 1000),
        endMs: 0,
        visualAction: intent.action,
        claimIds: intent.claimIds.length ? intent.claimIds : sec.claimIds,
        sourceRefs: [],
        sentenceAnchored: anchored,
      });
    }
    // The section's first beat opens with the section, so the scene never starts on a blank frame.
    if (local.length && local[0].startMs > a.startMs) local[0].startMs = a.startMs;
    if (!local.length) local.push({ id: `${sec.id}.b1`, sectionId: sec.id, cueText: words[0].text, startMs: a.startMs, endMs: 0, visualAction: { kind: "hold", targets: [] }, claimIds: sec.claimIds, sourceRefs: [], sentenceAnchored: true });
    const sectionEnd = a.startMs + a.slotMs;
    local.forEach((b, i) => { b.endMs = i + 1 < local.length ? local[i + 1].startMs : sectionEnd; });
    beats.push(...local);
  }
  return { beats, warnings };
}
