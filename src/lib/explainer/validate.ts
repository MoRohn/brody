/**
 * Automatic validation of an explainer. A renderer that exits 0 has not proved anything: the video must decode, match
 * the narration's length, cover every planned scene and beat, keep every caption inside the narration, trace every
 * scene back to sources, and every frame plan must lay out legibly. Validation runs twice: on the scene plan before
 * anything is rendered (so a bad layout never costs a render), and on the finished media.
 */
import fs from "node:fs";
import { contrast, contrastPairs, CANVAS, GRID, MAX_VISIBLE_OBJECTS, MIN_FONT_PX, MIN_SOURCE_FONT_PX, PALETTES } from "./design";
import { sceneStateAt } from "./frame";
import { textWidth } from "./measure";
import { decodeCheck, frameSpread, probe } from "./media";
import { overlaps } from "./scenes";
import { levels, readWavFile } from "./audio";
import type { Cue } from "./captions";
import type { ExplanationArtifactSpec, NarrativeBeat, SectionAudio, TimedWord, TranscriptEntry, ValidationCheck, ValidationReport, VisualObject, VisualScenePlan } from "./types";

type Check = ValidationCheck;
const pass = (id: string, label: string, detail = ""): Check => ({ id, label, status: "pass", detail });
const fail = (id: string, label: string, detail: string): Check => ({ id, label, status: "fail", detail });
const warn = (id: string, label: string, detail: string): Check => ({ id, label, status: "warn", detail });
const verdict = (id: string, label: string, problems: string[], okDetail: string, severity: "fail" | "warn" = "fail"): Check =>
  problems.length ? { id, label, status: severity, detail: `${problems.slice(0, 6).join("; ")}${problems.length > 6 ? ` (+${problems.length - 6} more)` : ""}` } : pass(id, label, okDetail);

// ---------------------------------------------------------------------------------------------------------------------
// Timeline: words, beats, captions
// ---------------------------------------------------------------------------------------------------------------------
export function validateTimeline(words: TimedWord[], beats: NarrativeBeat[], cues: Cue[], audio: SectionAudio[], narrationMs: number): Check[] {
  const checks: Check[] = [];
  const neg = words.filter((w) => w.startMs < 0 || w.endMs < 0).length + beats.filter((b) => b.startMs < 0).length + cues.filter((c) => c.startMs < 0).length;
  checks.push(neg ? fail("timestamps.nonnegative", "No negative timestamps", `${neg} negative timestamp(s)`) : pass("timestamps.nonnegative", "No negative timestamps"));
  const nonMono: string[] = [];
  for (let i = 1; i < words.length; i++) if (words[i].startMs < words[i - 1].startMs) nonMono.push(`word ${i} "${words[i].text}" starts before the previous word`);
  for (let i = 1; i < beats.length; i++) if (beats[i].startMs < beats[i - 1].startMs) nonMono.push(`beat ${beats[i].id} starts before ${beats[i - 1].id}`);
  for (let i = 1; i < cues.length; i++) if (cues[i].startMs < cues[i - 1].endMs - 1) nonMono.push(`caption ${cues[i].index} overlaps caption ${cues[i - 1].index}`);
  checks.push(verdict("timestamps.monotonic", "Timestamps increase monotonically", nonMono, `${words.length} words, ${beats.length} beats, ${cues.length} captions in order`));
  const zero = [...words.filter((w) => w.endMs <= w.startMs).map((w) => `word "${w.text}"`), ...beats.filter((b) => b.endMs <= b.startMs).map((b) => `beat ${b.id}`), ...cues.filter((c) => c.endMs <= c.startMs).map((c) => `caption ${c.index}`)];
  checks.push(verdict("timestamps.duration", "No zero-length words, beats or captions", zero, "every interval has positive length"));
  const late = [...words.filter((w) => w.endMs > narrationMs + 5).map((w) => `word "${w.text}" ends after the narration`), ...cues.filter((c) => c.endMs > narrationMs + 5).map((c) => `caption ${c.index}`)];
  checks.push(verdict("timestamps.bounds", "Timings stay inside the narration", late, `all within ${Math.round(narrationMs)} ms`));
  // Captions cover narration: every word lies inside a caption.
  const uncovered = words.filter((w) => !cues.some((c) => c.startMs <= w.startMs + 1 && c.endMs >= w.endMs - 1)).map((w) => `"${w.text}" at ${Math.round(w.startMs)} ms`);
  checks.push(verdict("captions.coverage", "Captions cover the narration", uncovered, `${cues.length} captions cover all ${words.length} words`));
  const cueText = cues.map((c) => c.lines.join(" ")).join(" ").replace(/\s+/g, " ").trim();
  const wordText = words.map((w) => w.text).join(" ").replace(/\s+/g, " ").trim();
  checks.push(cueText === wordText ? pass("captions.text", "Captions match the narration word for word") : fail("captions.text", "Captions match the narration word for word", "caption text differs from the spoken words"));
  const sectionsWithout = audio.filter((a) => !beats.some((b) => b.sectionId === a.sectionId)).map((a) => a.sectionId);
  checks.push(verdict("beats.coverage", "Every section has beats", sectionsWithout, `${beats.length} beats across ${audio.length} sections`));
  const interpolated = words.filter((w) => w.interpolated).length;
  const sentenceOnly = audio.filter((a) => a.timing.granularity === "sentence").length;
  if (sentenceOnly) checks.push(warn("timing.fidelity", "Word timing measured", `${sentenceOnly} section(s) have sentence-level timing only (${audio.find((a) => a.timing.granularity === "sentence")?.provider} reports no word timings); beats are anchored to sentence starts`));
  else checks.push(interpolated / Math.max(1, words.length) > 0.15 ? warn("timing.fidelity", "Word timing measured", `${interpolated} of ${words.length} words had to be interpolated`) : pass("timing.fidelity", "Word timing measured", `${words.length - interpolated} of ${words.length} words measured by ${[...new Set(audio.map((a) => a.timing.source))].join(", ")}`));
  return checks;
}

// ---------------------------------------------------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------------------------------------------------
export function validateProvenance(spec: ExplanationArtifactSpec, beats: NarrativeBeat[], transcript: TranscriptEntry[], plan: VisualScenePlan): Check[] {
  const claims = new Map(spec.claims.map((c) => [c.id, c]));
  const sources = new Set(spec.sources.map((s) => s.id));
  const problems: string[] = [];
  for (const b of beats) for (const id of b.claimIds) {
    const c = claims.get(id);
    if (!c) problems.push(`beat ${b.id} cites unknown claim ${id}`);
    else if (!c.supported) problems.push(`beat ${b.id} rests on unsupported claim ${id}`);
    else for (const s of c.sourceIds) if (!sources.has(s)) problems.push(`claim ${id} cites unknown source ${s}`);
  }
  for (const s of plan.scenes) for (const c of s.citations) for (const sid of c.sourceIds) if (!sources.has(sid)) problems.push(`scene ${s.id} shows unknown source ${sid}`);
  const factual = transcript.filter((t) => !t.sectionId.startsWith("hook"));
  const untraced = factual.filter((t) => t.sourceRefs.length === 0).map((t) => `"${t.text.slice(0, 50)}"`);
  return [
    verdict("provenance.claims", "Every beat's claims resolve to sources", problems, `${beats.reduce((a, b) => a + b.claimIds.length, 0)} claim references resolve`),
    verdict("provenance.transcript", "Every factual sentence is traceable", untraced, `${factual.length} sentences carry source references`, "warn"),
  ];
}

// ---------------------------------------------------------------------------------------------------------------------
// Layout (before rendering)
// ---------------------------------------------------------------------------------------------------------------------
const TEXT_PAD: Partial<Record<VisualObject["kind"], number>> = { node: 16, group: 46, cell: 9, chip: 8, list: 24, code: 68, source: 20, kicker: 62 };

function textOverflow(o: VisualObject): string | null {
  if (o.kind === "connector" || o.kind === "meter" || !o.lines.length) return null;
  const mono = !!o.mono || o.kind === "code" || o.kind === "source";
  const bold = !!o.bold || o.kind === "kicker";
  const inset = o.kind === "node" && o.glyph && !o.plain ? 48 : TEXT_PAD[o.kind] ?? 0;
  const avail = o.kind === "kicker" || o.kind === "statement" || o.kind === "metric" || o.kind === "callout" || o.plain ? Math.max(o.box.w, CANVAS.width - GRID.marginX - o.box.x) : o.box.w - inset - (o.kind === "cell" ? 9 : o.kind === "chip" ? 8 : 10);
  const widest = Math.max(...o.lines.map((l) => textWidth(l, o.fontSize, { mono, bold })));
  return widest > avail + 0.5 ? `${o.id}: text ${Math.round(widest)} px wide in ${Math.round(avail)} px` : null;
}

export function validateLayout(plan: VisualScenePlan): Check[] {
  const overflow: string[] = [], outside: string[] = [], small: string[] = [], collide: string[] = [], dense: string[] = [], empty: string[] = [];
  const isHud = (o: VisualObject) => o.kind === "kicker" || o.kind === "source";
  for (const s of plan.scenes) {
    for (const o of s.objects) {
      const t = textOverflow(o);
      if (t) overflow.push(`${s.id} ${t}`);
      const pts = o.points ?? [];
      const box = o.kind === "connector" ? { x: Math.min(...pts.map((p) => p.x)), y: Math.min(...pts.map((p) => p.y)), w: Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x)), h: Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y)) } : o.box;
      if (box.x < 0 || box.y < 0 || box.x + box.w > CANVAS.width || box.y + box.h > CANVAS.height) outside.push(`${s.id} ${o.id} leaves the frame`);
      else if (!isHud(o) && (box.y + box.h > GRID.captionSafeTop + 2) && o.kind !== "connector") outside.push(`${s.id} ${o.id} enters the caption-safe band`);
      if (o.lines.length && o.fontSize && o.fontSize < (o.kind === "source" ? MIN_SOURCE_FONT_PX : MIN_FONT_PX)) small.push(`${s.id} ${o.id} at ${o.fontSize} px`);
    }
    // Density, emptiness and collisions, sampled whenever something finishes changing and in the scene's middle.
    // Two things collide only if they are on screen at the same moment.
    const solids = new Set(s.objects.filter((o) => ["node", "group", "chip", "list", "statement", "metric", "callout", "code"].includes(o.kind) && !o.parent).map((o) => o.id));
    const dur = s.endMs - s.startMs;
    const times = [...new Set([...s.actions.map((a) => a.startMs + a.durationMs + 1), dur / 2, dur - 1].map((t) => Math.round(Math.min(dur - 1, t))))];
    let maxVisible = 0;
    const seen = new Set<string>();
    for (const t of times) {
      const st = sceneStateAt(s, t);
      const visible = s.objects.filter((o) => !isHud(o) && o.kind !== "connector" && (st.objs.get(o.id)?.opacity ?? 0) > 0.5);
      maxVisible = Math.max(maxVisible, visible.length);
      const vs = visible.filter((o) => solids.has(o.id));
      for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) {
        const key = `${vs[i].id}|${vs[j].id}`;
        if (!seen.has(key) && overlaps(vs[i].box, vs[j].box, -1)) { seen.add(key); collide.push(`${s.id}: ${vs[i].id} overlaps ${vs[j].id} at ${(t / 1000).toFixed(1)} s`); }
      }
    }
    const mid = sceneStateAt(s, dur / 2);
    if (!s.objects.some((o) => !isHud(o) && (mid.objs.get(o.id)?.opacity ?? 0) > 0.5)) empty.push(`${s.id} shows nothing but its title at its midpoint`);
    if (maxVisible > MAX_VISIBLE_OBJECTS) dense.push(`${s.id} shows ${maxVisible} objects at once`);
  }
  const pal = PALETTES[plan.style] ?? PALETTES.brody;
  const lowContrast = contrastPairs(pal).filter((p) => contrast(p.fg, p.bg) < p.min).map((p) => `${p.name} ${contrast(p.fg, p.bg).toFixed(2)}:1 < ${p.min}:1`);
  return [
    verdict("layout.text", "Text fits its boxes", overflow, "every label measured inside its box"),
    verdict("layout.frame", "Objects stay inside the frame and out of the caption band", outside, "all objects inside the safe area"),
    verdict("layout.fonts", "Text is large enough to read", small, `all text at ${MIN_FONT_PX} px or larger (source markers ${MIN_SOURCE_FONT_PX} px)`),
    verdict("layout.collisions", "No overlapping labels or boxes", collide, "no collisions"),
    verdict("layout.density", "Scenes are not overcrowded", dense, `at most ${MAX_VISIBLE_OBJECTS} objects at once`, "warn"),
    verdict("layout.empty", "No empty scenes", empty, "every scene shows its subject"),
    verdict("layout.contrast", "Text contrast", lowContrast, `all text pairs meet their contrast floor (${plan.style})`),
  ];
}

// ---------------------------------------------------------------------------------------------------------------------
// Media (after rendering)
// ---------------------------------------------------------------------------------------------------------------------
export interface MediaInputs { video: string; audio: string; plan: VisualScenePlan; narrationMs: number; vtt: string; toleranceMs?: number; signal?: AbortSignal }

export async function validateMedia(m: MediaInputs): Promise<Check[]> {
  const checks: Check[] = [];
  const fps = m.plan.canvas.fps;
  const tol = m.toleranceMs ?? Math.max(50, 1000 / fps + 10);
  checks.push(fs.existsSync(m.audio) && fs.statSync(m.audio).size > 44 ? pass("audio.exists", "Narration audio exists") : fail("audio.exists", "Narration audio exists", "no narration audio"));
  if (!fs.existsSync(m.video) || fs.statSync(m.video).size === 0) { checks.push(fail("video.exists", "Video exists", "no video file")); return checks; }
  checks.push(pass("video.exists", "Video exists", `${Math.round(fs.statSync(m.video).size / 1024)} KB`));
  try {
    const lv = levels(readWavFile(m.audio));
    checks.push(lv.peak > 0.02 ? pass("audio.audible", "Narration is audible", `peak ${lv.peak.toFixed(2)}, RMS ${lv.rms.toFixed(3)}`) : fail("audio.audible", "Narration is audible", `peak ${lv.peak.toFixed(3)}: the narration is silent`));
  } catch (e) { checks.push(fail("audio.audible", "Narration is audible", `cannot read the narration: ${(e as Error).message}`)); }
  const info = await probe(m.video, { signal: m.signal });
  const v = info.video, a = info.audio;
  checks.push(v && a ? pass("video.streams", "Video has picture and sound", `${v.codec} ${v.width}x${v.height} ${v.fps.toFixed(2)} fps, ${a.codec} ${a.sampleRate} Hz`) : fail("video.streams", "Video has picture and sound", `${v ? "" : "no video stream "}${a ? "" : "no audio stream"}`.trim()));
  if (v) checks.push(v.width === m.plan.canvas.width && v.height === m.plan.canvas.height && Math.abs(v.fps - fps) < 0.01 ? pass("video.format", "Resolution and frame rate", `${v.width}x${v.height} @ ${fps}`) : fail("video.format", "Resolution and frame rate", `${v.width}x${v.height} @ ${v.fps}, expected ${m.plan.canvas.width}x${m.plan.canvas.height} @ ${fps}`));
  const dec = await decodeCheck(m.video, { signal: m.signal });
  checks.push(dec.ok ? pass("video.decodes", "Video decodes end to end") : fail("video.decodes", "Video decodes end to end", dec.errors || "decoder reported errors"));
  const vMs = v?.frames ? (v.frames * 1000) / fps : v?.durationMs ?? info.durationMs;
  const aMs = a?.durationMs ?? info.durationMs;
  checks.push(Math.abs(vMs - m.plan.durationMs) <= 1000 / fps + 1 && (v?.frames ?? m.plan.frames) === m.plan.frames ? pass("video.frames", "Every planned frame is present", `${v?.frames ?? "?"} frames = ${m.plan.scenes.length} scenes`) : fail("video.frames", "Every planned frame is present", `${v?.frames ?? "?"} frames, planned ${m.plan.frames}: missing or extra scenes`));
  checks.push(Math.abs(vMs - aMs) <= tol ? pass("av.sync", "Audio and video lengths agree", `video ${Math.round(vMs)} ms, audio ${Math.round(aMs)} ms (Δ ${Math.round(Math.abs(vMs - aMs))} ms ≤ ${Math.round(tol)} ms)`) : fail("av.sync", "Audio and video lengths agree", `video ${Math.round(vMs)} ms vs audio ${Math.round(aMs)} ms (Δ ${Math.round(Math.abs(vMs - aMs))} ms > ${Math.round(tol)} ms)`));
  checks.push(Math.abs(aMs - m.narrationMs) <= tol ? pass("duration.narration", "Duration matches the measured narration", `${(m.narrationMs / 1000).toFixed(2)} s`) : fail("duration.narration", "Duration matches the measured narration", `audio track ${Math.round(aMs)} ms, narration ${Math.round(m.narrationMs)} ms`));
  // Empty frames: one sample in the middle of each scene must show structure, not a flat ground.
  const mids = m.plan.scenes.map((s) => (s.startMs + s.endMs) / 2);
  const spreads = await frameSpread(m.video, mids, { signal: m.signal });
  const flat = spreads.map((sd, i) => (sd < 4 ? `${m.plan.scenes[i].id} (σ ${sd.toFixed(1)})` : null)).filter((x): x is string => !!x);
  checks.push(verdict("video.nonempty", "No empty frames", flat, `scene midpoints all show content (σ ${Math.min(...spreads).toFixed(1)}–${Math.max(...spreads).toFixed(1)})`));
  checks.push(m.vtt.startsWith("WEBVTT") ? pass("captions.vtt", "Captions are valid WebVTT") : fail("captions.vtt", "Captions are valid WebVTT", "missing WEBVTT header"));
  return checks;
}

export function report(checks: Check[]): ValidationReport {
  return { ok: !checks.some((c) => c.status === "fail"), checks, at: Date.now() };
}
