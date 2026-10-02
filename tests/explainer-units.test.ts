/**
 * Unit tests for the explainer's pure building blocks: spoken-form normalisation, timing alignment, beats, captions,
 * grounding, the mode router, spec validation, refinement rules, WAV handling and privacy routing.
 */
import { describe, expect, it } from "vitest";
import { controlNarration, lintNarration, splitSentences, spokenText, tokenize, toSpoken } from "@/lib/explainer/speech";
import { alignByCharacters, normalizeTiming, tokenSpans } from "@/lib/explainer/timing";
import { extractBeats } from "@/lib/explainer/beats";
import { buildCues, buildTranscript, parseVtt, toSrt, toVtt } from "@/lib/explainer/captions";
import { buildCorpus, factualAtoms, isGrounded } from "@/lib/explainer/grounding";
import { routeModes } from "@/lib/explainer/router";
import { validateSpec } from "@/lib/explainer/spec";
import { refineByRules } from "@/lib/explainer/refine";
import { encodeWav, padToFrameSlot, parseWav, pcmDurationMs, silences, wavHeader } from "@/lib/explainer/audio";
import { classifyNarration, decideExternal, sanitizeNarration } from "@/lib/explainer/privacy";
import { scrubSecrets } from "@/lib/explainer/tts/types";
import { wordsFromCharacters, flattenSpeechMarks } from "@/lib/explainer/tts/cloud";
import { spreadWords } from "@/lib/explainer/tts/piper";
import { contrast, contrastPairs, PALETTES } from "@/lib/explainer/design";
import { applyStructure, oneOf } from "@/lib/explainer/compile";
import { clearText, mermaidDiagram } from "@/lib/explainer/formats";
import type { ExplanationArtifactSpec, NarrationPlan, SectionAudio, TimedWord, VideoJobParams } from "@/lib/explainer/types";
import { claim, sampleSpec } from "./helpers/explainer";

describe("speech: display text versus spoken text", () => {
  it("speaks identifiers, URLs, paths, units, versions and operators without changing what is displayed", () => {
    expect(toSpoken("nvidia.com/gpu")).toEqual(["nvidia", "dot", "com", "slash", "G", "P", "U"]);
    expect(toSpoken("https://github.com/acme/app")).toEqual(["github", "dot", "com", "slash", "acme", "slash", "app"]);
    expect(toSpoken("requestCancel()")).toEqual(["request", "Cancel"]);
    expect(toSpoken("snake_case_name")).toEqual(["snake", "case", "name"]);
    expect(toSpoken("src/lib/jobs.ts")).toEqual(["source", "slash", "lib", "slash", "jobs", "dot", "T", "S"]);
    expect(toSpoken("80GB")).toEqual(["80", "gigabytes"]);
    expect(toSpoken("12%")).toEqual(["12", "percent"]);
    expect(toSpoken("v1.2.3")).toEqual(["version", "1", "point", "2", "point", "3"]);
    expect(toSpoken("k8s")).toEqual(["Kubernetes"]);
    expect(toSpoken("=")).toEqual(["equals"]);
    expect(toSpoken("e.g.")).toEqual(["for", "example"]);
  });
  it("splits sentences without breaking decimals, domains, versions or abbreviations", () => {
    expect(splitSentences("Each pod uses 1.5 GPUs. See nvidia.com for e.g. the plugin. Version 2.1.0 ships today! Done?")).toEqual(["Each pod uses 1.5 GPUs.", "See nvidia.com for e.g. the plugin.", "Version 2.1.0 ships today!", "Done?"]);
  });
  it("keeps sentence punctuation on the last spoken word, and maps every token to its span", () => {
    const t = tokenize("It asks for nvidia.com/gpu: 1. Done.");
    const spoken = spokenText(t);
    expect(spoken).toBe("It asks for nvidia dot com slash G P U: 1. Done.");
    const spans = tokenSpans(t);
    t.forEach((tok, i) => { if (tok.spoken.length) expect(spoken.slice(spans[i].start, spans[i].end)).toBe(tok.spoken.join(" ")); });
  });
  it("lints and rewrites toward controlled technical English", () => {
    const lint = lintNarration("In this section, we basically leverage the scheduler in order to utilize GPUs; it is done by the plugin (which is configured elsewhere in the cluster).");
    expect(lint.issues.map((i) => i.kind)).toEqual(expect.arrayContaining(["heading", "filler", "complex-word", "semicolon", "parenthetical"]));
    const out = controlNarration("We leverage the scheduler in order to utilize the GPUs, and the plugin advertises each GPU as one unit so pods cannot share it at all today.", { maxWords: 14 });
    expect(out).not.toMatch(/leverage|in order to|utilize/);
    expect(splitSentences(out).length).toBeGreaterThan(1);
  });
});

describe("timing: measured words onto display tokens", () => {
  const tokens = tokenize("The pod asks for nvidia.com/gpu: 1. Twelve percent is used.");
  const spoken = spokenText(tokens);
  it("uses character ranges when the provider reports them", () => {
    let at = 0;
    const words = spoken.split(" ").map((w) => { const s = spoken.indexOf(w, at); at = s + w.length; return { text: w, startMs: s * 10, endMs: (s + w.length) * 10, charStart: s, charEnd: s + w.length }; });
    const n = normalizeTiming(tokens, words, { sectionId: "a", offsetMs: 1000, durationMs: spoken.length * 10 + 50 });
    expect(n.words.map((w) => w.text)).toEqual(["The", "pod", "asks", "for", "nvidia.com/gpu:", "1.", "Twelve", "percent", "is", "used."]);
    expect(n.interpolated).toBe(0);
    const id = n.words.find((w) => w.text === "nvidia.com/gpu:")!;
    expect(id.startMs).toBe(1000 + spoken.indexOf("nvidia") * 10); // the whole identifier spans its spoken words
    expect(id.endMs).toBe(1000 + (spoken.indexOf("U:") + 2) * 10);
  });
  it("aligns transcribed words (merged, split, re-spelled) by characters and interpolates only what is missing", () => {
    const words = [
      { text: "The", startMs: 0, endMs: 100 }, { text: "pod", startMs: 100, endMs: 300 }, { text: "asks", startMs: 300, endMs: 500 }, { text: "for", startMs: 500, endMs: 600 },
      { text: "nvidia.com/GPU", startMs: 600, endMs: 1500 }, { text: "one.", startMs: 1500, endMs: 1700 }, { text: "12%", startMs: 1900, endMs: 2300 }, { text: "is", startMs: 2300, endMs: 2400 }, { text: "used", startMs: 2400, endMs: 2700 },
    ];
    const n = normalizeTiming(tokens, words, { sectionId: "a", offsetMs: 0, durationMs: 2800 });
    expect(n.words).toHaveLength(10);
    expect(n.words.find((w) => w.text === "nvidia.com/gpu:")).toMatchObject({ startMs: 600, endMs: 1500 });
    // "1." was transcribed as "one."; "Twelve percent" as "12%": interpolated, flagged, and still inside the right gap.
    // Words the transcription spelled differently ("1." as "one.", "Twelve percent" as "12%") may not align letter for
    // letter: those are interpolated between measured neighbours, flagged, and counted.
    expect(n.interpolated).toBeGreaterThan(0);
    expect(n.words.filter((w) => w.interpolated)).toHaveLength(n.interpolated);
    expect(n.words.find((w) => w.text === "1.")!.startMs).toBeGreaterThanOrEqual(1500);
    for (let i = 1; i < n.words.length; i++) expect(n.words[i].startMs).toBeGreaterThanOrEqual(n.words[i - 1].startMs);
    for (const w of n.words) { expect(w.endMs).toBeGreaterThan(w.startMs); expect(w.startMs).toBeGreaterThanOrEqual(0); expect(w.endMs).toBeLessThanOrEqual(2800); }
  });
  it("locates provider words in text by longest common subsequence", () => {
    const spans = alignByCharacters("the quick brown fox", [{ text: "quick", startMs: 0, endMs: 1 }, { text: "fox", startMs: 1, endMs: 2 }]);
    expect(spans).toEqual([{ start: 4, end: 9 }, { start: 16, end: 19 }]);
  });
  it("handles very short and very long narration", () => {
    const short = tokenize("Yes.");
    expect(normalizeTiming(short, [{ text: "Yes.", startMs: 10, endMs: 300, charStart: 0, charEnd: 4 }], { sectionId: "a", offsetMs: 0, durationMs: 350 }).words).toEqual([{ text: "Yes.", startMs: 10, endMs: 300, sectionId: "a", sentence: 0 }]);
    const long = tokenize(Array.from({ length: 400 }, (_, i) => `Word${i} goes here.`).join(" "));
    const sp = spokenText(long);
    let at = 0;
    const ws = sp.split(" ").map((w, i) => { const s = sp.indexOf(w, at); at = s + w.length; return { text: w, startMs: i * 100, endMs: i * 100 + 90, charStart: s, charEnd: s + w.length }; });
    const n = normalizeTiming(long, ws, { sectionId: "a", offsetMs: 0, durationMs: ws.length * 100 });
    expect(n.words).toHaveLength(1200);
    expect(n.interpolated).toBe(0);
  });
});

function audioFor(id: string, text: string, startMs: number, granularity: "word" | "sentence" = "word"): SectionAudio {
  const tokens = tokenize(text);
  const words: TimedWord[] = tokens.map((t, i) => ({ text: t.display, startMs: startMs + i * 300, endMs: startMs + i * 300 + 250, sectionId: id, sentence: t.sentence }));
  return { sectionId: id, audio: "", speechMs: tokens.length * 300, slotMs: tokens.length * 300 + 400, frames: Math.ceil(((tokens.length * 300 + 400) * 30) / 1000), startMs, words, timing: { source: "provider", granularity, interpolated: 0 }, provider: "t", voice: "v", hash: id };
}

describe("beats: semantic events on measured time", () => {
  const plan = (narr: string, cues: string[]): NarrationPlan["sections"][number] => ({ id: "s1", specSectionId: "n1", role: "body", title: "T", objective: "", narration: narr, visualIntent: { layout: "architecture", focus: [], beats: cues.map((c) => ({ cue: c, action: { kind: "highlight_component", targets: [] }, claimIds: [] })) }, sourceRefs: [], claimIds: ["c1"] });
  it("matches cues in spoken order, so a repeated phrase lands on the right occurrence", () => {
    const text = "The pod waits. The pod runs. Then it stops.";
    const a = audioFor("s1", text, 1000);
    const { beats, warnings } = extractBeats([plan(text, ["The pod waits", "The pod runs", "Then it stops"])], [a]);
    expect(warnings).toEqual([]);
    expect(beats.map((b) => b.startMs)).toEqual([1000, 1000 + 3 * 300, 1000 + 6 * 300]);
    expect(beats.every((b) => b.endMs > b.startMs)).toBe(true);
    expect(beats[beats.length - 1].endMs).toBe(a.startMs + a.slotMs);
  });
  it("falls back to the best sentence when a cue is not word for word", () => {
    const text = "Kubernetes allocates whole GPUs. Pods cannot share them.";
    const { beats, warnings } = extractBeats([plan(text, ["Kubernetes allocates", "pods can not share"])], [audioFor("s1", text, 0)]);
    expect(beats.map((b) => b.startMs)).toEqual([0, 4 * 300]);
    expect(warnings.map((w) => w.detail).join(" ")).toMatch(/placed at the start of sentence 2/);
  });
  it("merges two cues that land on the same word instead of making a zero-length beat", () => {
    const text = "One two three. Four five six.";
    const { beats, warnings } = extractBeats([plan(text, ["One two", "three", "Four five"])], [audioFor("s1", text, 0, "sentence")]);
    expect(beats).toHaveLength(2);
    expect(warnings.map((w) => w.detail).join(" ")).toMatch(/same word/);
  });
  it("anchors beats to sentence starts when timing is sentence-level only", () => {
    const text = "One two three. Four five six.";
    const { beats } = extractBeats([plan(text, ["three", "five six"])], [audioFor("s1", text, 0, "sentence")]);
    expect(beats.every((b) => b.sentenceAnchored)).toBe(true);
    expect(beats.map((b) => b.startMs)).toEqual([0, 3 * 300]);
  });
  it("rounds beat times relative to the section, so a section's beats do not depend on its position", () => {
    const text = "Alpha beta. Gamma delta.";
    const at = (offset: number) => extractBeats([plan(text, ["Alpha beta", "Gamma delta"])], [audioFor("s1", text, offset)]).beats.map((b) => b.startMs - offset);
    expect(at(0)).toEqual(at(1234.333333));
  });
});

describe("captions and transcript", () => {
  const words: TimedWord[] = "This is a fairly long first sentence that should wrap onto two caption lines. Short one. Next section starts here.".split(" ").map((w, i) => ({ text: w, startMs: i * 400, endMs: i * 400 + 350, sectionId: i < 16 ? "a" : "b", sentence: i < 14 ? 0 : i < 16 ? 1 : 0 }));
  it("builds caption cues within broadcast limits that cover every word, never across sections", () => {
    const cues = buildCues(words);
    for (const c of cues) { expect(c.lines.length).toBeLessThanOrEqual(2); for (const l of c.lines) expect(l.length).toBeLessThanOrEqual(42); expect(c.endMs - c.startMs).toBeLessThanOrEqual(6000); }
    for (const w of words) expect(cues.some((c) => c.startMs <= w.startMs && c.endMs >= w.endMs)).toBe(true);
    expect(cues.every((c) => words.filter((w) => w.startMs >= c.startMs && w.endMs <= c.endMs).every((w) => w.sectionId === c.sectionId))).toBe(true);
    const vtt = toVtt(cues);
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(parseVtt(vtt)).toHaveLength(cues.length);
    expect(toSrt(cues)).toMatch(/^1\n00:00:00,000 --> /);
  });
  it("escapes markup in WebVTT", () => {
    const cues = buildCues([{ text: "a<b>-->c&d", startMs: 0, endMs: 900, sectionId: "a", sentence: 0 }]);
    expect(toVtt(cues)).toContain("a&lt;b&gt;--&gt;c&amp;d");
  });
  it("builds a transcript per sentence with the section's sources", () => {
    const t = buildTranscript(words, new Map([["a", { sourceRefs: ["s1"], claimIds: ["c1"] }], ["b", { sourceRefs: ["s2"], claimIds: ["c2"] }]]));
    expect(t.map((e) => e.sectionId)).toEqual(["a", "a", "b"]);
    expect(t[2].sourceRefs).toEqual(["s2"]);
  });
});

describe("grounding guard", () => {
  const corpus = buildCorpus(["The DGX has 8 GPUs and each service uses about 12% of one.", "`requestCancel` in src/jobs.ts", "Kubernetes allocates whole GPUs."]);
  it("accepts rephrasing that adds no new facts", () => {
    expect(isGrounded("Kubernetes gives each service a whole GPU, and eight GPUs fill up.", corpus).ok).toBe(true);
    expect(isGrounded("The `requestCancel` function lives in src/jobs.ts.", corpus).ok).toBe(true);
    expect(isGrounded("Twelve percent is used; one service, two services.", corpus).ok).toBe(true);
  });
  it("rejects new numbers, identifiers and names", () => {
    expect(isGrounded("Each GPU costs 30,000 dollars.", corpus).missing).toEqual(["30,000"]);
    expect(isGrounded("Use `cancelAll` instead.", corpus).ok).toBe(false);
    expect(isGrounded("Then Slurm takes over.", corpus).missing).toEqual(["Slurm"]);
    expect(factualAtoms("ninety five").map((a) => a.norm)).toEqual(["90", "5"]);
  });
  it("lets titles use Title Case without treating every word as a name", () => {
    expect(isGrounded("Why Whole GPUs Sit Idle", corpus, { properNouns: false }).ok).toBe(true);
    expect(isGrounded("Why 40 GPUs Sit Idle", corpus, { properNouns: false }).ok).toBe(false);
  });
});

describe("mode router", () => {
  it("recommends video for contended, time-dependent systems and not for trivial results", () => {
    const r = routeModes(sampleSpec());
    expect(r.recommendedModes).toEqual(expect.arrayContaining(["text", "diagram", "video"]));
    expect(r.videoValueScore).toBeGreaterThanOrEqual(0.55);
    expect(r.reasons.join(" ")).toMatch(/contended|contained/);
    const tiny: ExplanationArtifactSpec = { ...sampleSpec(), concepts: [], relationships: [], metrics: [], comparisons: [], claims: [claim("c1", "The function returns a string.")] };
    const t = routeModes(tiny);
    expect(t.recommendedModes).toEqual(["text"]);
    expect(t.videoValueScore).toBeLessThan(0.3);
  });
  it("suggests a length from the material and honours a requested depth", () => {
    expect(routeModes(sampleSpec()).suggestedDuration).toBe("standard");
    expect(routeModes({ ...sampleSpec(), concepts: sampleSpec().concepts.slice(0, 3) }).suggestedDuration).toBe("quick");
    expect(routeModes(sampleSpec(), { requestedDepth: "deep" }).suggestedDuration).toBe("deep");
  });
});

describe("spec validation", () => {
  it("accepts a consistent spec", () => expect(validateSpec(sampleSpec())).toMatchObject({ ok: true }));
  it("finds broken references and sections that rest on unsupported claims", () => {
    const s = sampleSpec();
    s.relationships.push({ id: "r9", from: "k1", to: "k99", label: "x", kind: "uses", claimIds: [] });
    s.narrative.sections[0].claimIds.push("c6");
    s.concepts[1].parentId = "k77";
    s.metrics![0].claimIds = [];
    const v = validateSpec(s);
    expect(v.ok).toBe(false);
    expect(v.issues.map((i) => i.message).join(" | ")).toMatch(/unknown concept k99.*|rests on unsupported claim c6/);
    expect(v.issues.some((i) => i.message.includes("unknown parent k77"))).toBe(true);
    expect(v.issues.some((i) => i.message.includes("must be stated by a claim"))).toBe(true);
  });
});

describe("AI structure is verified before it is used", () => {
  it("drops ungrounded claims, counts, metrics and unknown enum values", () => {
    const base = sampleSpec();
    const { spec, dropped } = applyStructure(base, {
      title: "Whole GPUs leave capacity idle", summary: "", objectives: [],
      claims: [{ id: "a1", text: "Each pod holds a whole GPU.", basedOn: ["c2"], confidence: "high" }, { id: "a2", text: "Utilisation rises to 95%.", basedOn: ["c5"], confidence: "high" }],
      concepts: [{ id: "k1", name: "DGX machine", definition: "", kind: "machine-ish", glyph: "rocket", parentId: "", count: 0, claimIds: ["c1"] }, { id: "k2", name: "GPU", definition: "", kind: "resource", glyph: "gpu", parentId: "k1", count: 64, claimIds: ["c1"] }],
      relationships: [{ from: "k2", to: "k1", label: "inside", kind: "contains", claimIds: ["c1"] }],
      processes: [], metrics: [{ label: "x", value: 77, unit: "%", display: "77%", claimIds: ["c3"] }], comparisons: [], examples: [], uncertainties: [],
      sections: [{ title: "Setup", objective: "", claimIds: ["c1", "a1"], conceptIds: ["k1", "k2"], visual: "Architecture" }],
      hook: "Why?", conclusion: "Sharing frees GPUs.",
    }, "test-model");
    expect(spec.claims.find((c) => c.id === "a1")?.supported).toBe(true);
    expect(spec.claims.find((c) => c.id === "a2")?.supported).toBe(false);
    expect(dropped.join(" ")).toMatch(/95%/);
    expect(dropped.join(" ")).toMatch(/count 64 is not stated/);
    expect(dropped.join(" ")).toMatch(/77 is not stated/);
    expect(spec.concepts[0]).toMatchObject({ kind: "component", glyph: "machine" });
    expect(spec.narrative.sections[0].visual).toBe("architecture");
    expect(oneOf("Quick", ["quick", "deep"] as const, "deep")).toBe("quick");
    expect(validateSpec(spec).ok).toBe(true);
  });
});

describe("clear text and diagram come from the same spec", () => {
  it("never shows unsupported claims and draws containment as subgraphs", () => {
    const s = sampleSpec();
    const c = clearText(s);
    expect(JSON.stringify(c)).not.toContain("9 million");
    expect(c.sections.map((x) => x.id)).toEqual(["n1", "n2", "n3"]);
    const m = mermaidDiagram(s)!;
    expect(m).toContain('subgraph k1_group["DGX machine"]');
    expect(m).toContain('k4 -->|"requests"| k2');
    expect(m).toContain("-.->");
  });
});

describe("refinement rules", () => {
  const plan = { sections: [
    { id: "hook", specSectionId: "hook", role: "hook", title: "Opening", objective: "", narration: "Why?", visualIntent: { layout: "statement", focus: [], beats: [] }, sourceRefs: [], claimIds: [] },
    { id: "n1", specSectionId: "n1", role: "body", title: "The setup", objective: "", narration: "The DGX has GPUs.", visualIntent: { layout: "architecture", focus: ["k1"], beats: [] }, sourceRefs: ["s1"], claimIds: ["c1"] },
    { id: "n2", specSectionId: "n2", role: "body", title: "Database writes", objective: "", narration: "Rows are written.", visualIntent: { layout: "process", focus: [], beats: [] }, sourceRefs: [], claimIds: ["c3"] },
    { id: "n3", specSectionId: "n3", role: "body", title: "The fix", objective: "", narration: "Share GPUs.", visualIntent: { layout: "contention", focus: [], beats: [] }, sourceRefs: [], claimIds: ["c5"] },
    { id: "outro", specSectionId: "outro", role: "conclusion", title: "Takeaway", objective: "", narration: "Done.", visualIntent: { layout: "statement", focus: [], beats: [] }, sourceRefs: [], claimIds: [] },
  ] } as unknown as NarrationPlan;
  const cur = { duration: "standard", audience: "intermediate", style: "brody", renderer: "auto", execution: "local" } as VideoJobParams;
  const r = (q: string) => refineByRules(q, plan, sampleSpec(), cur)!;
  it("maps the documented requests onto structured edits", () => {
    expect(r("Make this shorter.").params.duration).toBe("quick");
    expect(r("Turn this into a 60-second version.").params.duration).toBe("quick");
    expect(r("Explain it for a beginner.").params.audience).toBe("beginner");
    expect(r("Keep the technical depth but simplify the narration.").params.instruction).toMatch(/simpler/);
    expect(r("Remove the intro.").params.edits?.drop).toEqual(["hook"]);
    expect(r("Use a local voice.").params.execution).toBe("local");
    expect(r("Change the voice.").params.voice).toBe("__next__");
    expect(r("Make the visuals less animated.").params.motion).toBe("reduced");
    expect(r("Regenerate scene three.").params.forceScenes).toEqual(["scene-n2"]);
    expect(r("Make the architecture diagram stay on screen longer.").params.edits?.holdMs).toEqual({ n1: 2500, n3: 2500 });
    const focus = r("Focus more on the database writes section.");
    expect(focus.sections).toEqual(["n2"]);
    expect(focus.kind).toBe("section");
    const last = r("Redo just the final section and show how dynamic GPU scheduling fixes this.");
    expect(last.sections).toEqual(["n3"]);
    expect(last.params.instruction).toMatch(/dynamic GPU scheduling/);
    expect(refineByRules("hmm", plan, sampleSpec(), cur)).toBeNull();
  });
});

describe("WAV handling", () => {
  it("measures duration from the audio bytes, not the header (streaming headers declare 0xFFFFFFFF)", () => {
    const data = Buffer.alloc(48_000 * 2); // one second
    const wav = encodeWav(data);
    wav.writeUInt32LE(0xffffffff, 40);
    wav.writeUInt32LE(0xffffffff, 4);
    const p = parseWav(wav);
    expect(Math.round(pcmDurationMs(p))).toBe(1000);
  });
  it("skips extra chunks and rejects non-WAV input", () => {
    const data = Buffer.alloc(4800 * 2);
    const h = wavHeader(data.length);
    const list = Buffer.concat([Buffer.from("LIST"), Buffer.from([4, 0, 0, 0]), Buffer.from("INFO")]);
    const wav = Buffer.concat([h.subarray(0, 36), list, h.subarray(36), data]);
    expect(Math.round(pcmDurationMs(parseWav(wav)))).toBe(100);
    expect(() => parseWav(Buffer.from("not a wav file at all"))).toThrow(/RIFF/);
  });
  it("pads each section to whole video frames so sections never shift each other's frame grid", () => {
    const p = parseWav(encodeWav(Buffer.alloc(12_345 * 2)));
    const slot = padToFrameSlot(p, 420, 30);
    expect(slot.data.length % (1600 * 2)).toBe(0);
    expect(slot.frames).toBe(Math.ceil((12_345 + 20_160) / 1600));
    expect(slot.slotMs).toBeCloseTo((slot.frames * 1000) / 30, 6);
  });
  it("finds silences", () => {
    const loud = Buffer.alloc(4800 * 2, 0); for (let i = 0; i < 4800; i++) loud.writeInt16LE(8000, i * 2);
    const quiet = Buffer.alloc(4800 * 2);
    const s = silences(parseWav(encodeWav(Buffer.concat([loud, quiet, loud]))), 50);
    expect(s).toHaveLength(1);
    expect(Math.round(s[0].startMs)).toBe(100);
    expect(Math.round(s[0].endMs)).toBe(200);
  });
});

describe("provider adapters", () => {
  it("folds ElevenLabs character timings into words of the text we sent", () => {
    const text = "Hi you";
    const chars = text.split("");
    const w = wordsFromCharacters(text, chars, chars.map((_, i) => i * 0.1), chars.map((_, i) => i * 0.1 + 0.08));
    expect(w.map((x) => [x.text, Math.round(x.startMs), Math.round(x.endMs), x.charStart, x.charEnd])).toEqual([["Hi", 0, 180, 0, 2], ["you", 300, 580, 3, 6]]);
  });
  it("flattens Speechify's nested speech marks", () => {
    const marks = flattenSpeechMarks({ type: "sentence", chunks: [{ type: "word", value: "a", start_time: 0, end_time: 100 }, { type: "sentence", chunks: [{ type: "word", value: "b", start_time: 100, end_time: 200 }] }] });
    expect(marks.map((m) => m.value)).toEqual(["a", "b"]);
  });
  it("spreads sentence-timed words inside the measured sentence span (Piper mode)", () => {
    const w = spreadWords("Short and longer words.", 10, 1000, 2000);
    expect(w[0].startMs).toBe(1000);
    expect(w[w.length - 1].endMs).toBeCloseTo(2000, 6);
    expect(w.map((x) => x.charStart)).toEqual([10, 16, 20, 27]);
  });
});

describe("privacy and secrets", () => {
  it("classifies narration and applies the policy", () => {
    expect(classifyNarration("token sk-ant-abcdefghijklmnopqrstuvwx", { sourceType: "github", sourceUrl: "https://github.com/a/b" }).sensitivity).toBe("secret");
    expect(classifyNarration("pods share GPUs", { sourceType: "folder", sourceUrl: null }).sensitivity).toBe("confidential");
    expect(classifyNarration("pods share GPUs", { sourceType: "github", sourceUrl: "https://github.com/a/b" }).sensitivity).toBe("public");
    expect(decideExternal("confidential", "ask", undefined, false).externalAllowed).toBe(false);
    expect(decideExternal("confidential", "ask", true, false).externalAllowed).toBe(true);
    expect(decideExternal("public", "local-only", true, false).externalAllowed).toBe(false);
    expect(decideExternal("secret", "allow", true, false).externalAllowed).toBe(false);
    expect(decideExternal("public", "ask", false, true).blockedBecause).toMatch(/private access token/);
  });
  it("removes secrets from narration and from every provider error", () => {
    expect(sanitizeNarration("the key ghp_abcdefghijklmnopqrstuvwxyz0123456789AB is set")).toBe("the key a redacted value is set");
    expect(scrubSecrets("HTTP 401 Bearer abc.def xi-api-key: sk_live_1234567890abcdef", ["sk_live_1234567890abcdef"])).not.toMatch(/abc\.def|1234567890/);
    expect(scrubSecrets("OPENAI_API_KEY is not set.")).toBe("OPENAI_API_KEY is not set.");
  });
});

describe("design system", () => {
  it("every text colour clears its contrast floor in every style", () => {
    for (const [style, p] of Object.entries(PALETTES)) for (const pair of contrastPairs(p)) expect(contrast(pair.fg, pair.bg), `${style}: ${pair.name}`).toBeGreaterThanOrEqual(pair.min);
  });
});
