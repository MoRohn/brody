/**
 * Local voices on each OS: the shared word-mark logic (macOS and Windows), eSpeak NG on Linux, and the Windows speech
 * engine. Engine tests run where the engine exists (macOS here, Windows and Linux in CI) and are skipped elsewhere.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { encodeWav, parseWav } from "@/lib/explainer/audio";
import { EspeakProvider } from "@/lib/explainer/tts/espeak";
import { wordsFromMarks } from "@/lib/explainer/tts/macos";
import { SAPI_SCRIPT, WindowsSpeechProvider } from "@/lib/explainer/tts/windows";
import { routeTts, setTtsProviders, allTtsProviders } from "@/lib/explainer/tts";
import { spokenText, tokenize } from "@/lib/explainer/speech";
import { normalizeTiming } from "@/lib/explainer/timing";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brody-voices-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("word marks from a speech engine", () => {
  it("merges a word split into several ranges and ends words at the silence inside their slot", () => {
    // 1 s of tone, 0.3 s of silence, 0.5 s of tone at 48 kHz.
    const tone = (ms: number) => { const n = Math.round(ms * 48); const b = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 8) * 9000), i * 2); return b; };
    const pcm = parseWav(encodeWav(Buffer.concat([tone(1000), Buffer.alloc(300 * 48 * 2), tone(500)])));
    const text = "Use GPUs. Now";
    const words = wordsFromMarks(text, [{ startMs: 0, loc: 0, end: 3 }, { startMs: 400, loc: 4, end: 5 }, { startMs: 500, loc: 5, end: 6 }, { startMs: 600, loc: 6, end: 9 }, { startMs: 1300, loc: 10, end: 13 }], pcm, 1800);
    expect(words.map((w) => w.text)).toEqual(["Use", "GPUs.", "Now"]);
    expect(words[1]).toMatchObject({ startMs: 400, charStart: 4, charEnd: 9 });
    expect(Math.abs(words[1].endMs - 1000)).toBeLessThan(15); // the pause, not the next word's start
    expect(words[2].endMs).toBe(1800);
  });
});

describe("routing prefers word-timed local voices, then sentence-timed ones", () => {
  it("orders macOS and Windows before Piper before eSpeak NG", () => {
    expect(allTtsProviders().map((p) => p.id).slice(0, 4)).toEqual(["macos", "windows", "piper", "espeak"]);
  });
  it("routes to eSpeak NG when it is the only local voice", async () => {
    const espeak = new EspeakProvider();
    Object.defineProperty(espeak, "unavailableReason", { value: async () => null });
    setTtsProviders([espeak]);
    try {
      const r = await routeTts({ execution: "local", privacy: { sensitivity: "confidential", reasons: [], externalAllowed: false } });
      expect(r.candidates.map((p) => p.id)).toEqual(["espeak"]);
    } finally { setTtsProviders(undefined); }
  });
});

describe("eSpeak NG (Linux)", () => {
  it("speaks sentence by sentence with measured sentence boundaries", async (ctx) => {
    const v = new EspeakProvider();
    if (await v.unavailableReason()) ctx.skip();
    const tokens = tokenize("The pod asks for one GPU. It uses twelve percent. Seven others wait.");
    const r = await v.synthesize({ text: spokenText(tokens), workDir: path.join(dir, "espeak") });
    expect(r.timing).toEqual({ source: "segment-measured", granularity: "sentence" });
    expect(r.durationMs).toBeGreaterThan(1500);
    const n = normalizeTiming(tokens, r.words, { sectionId: "s", offsetMs: 0, durationMs: r.durationMs });
    expect(n.words).toHaveLength(tokens.length);
    for (let i = 1; i < n.words.length; i++) expect(n.words[i].startMs).toBeGreaterThanOrEqual(n.words[i - 1].startMs);
  }, 60_000);
});

describe("Windows speech engine", () => {
  it("passes text through a file, never the command line", () => {
    expect(SAPI_SCRIPT).toContain("ReadAllText($In");
    expect(SAPI_SCRIPT).toContain("add_SpeakProgress");
    expect(SAPI_SCRIPT).toContain("AudioPosition");
  });
  it.runIf(process.platform === "win32")("speaks with measured word timings", async (ctx) => {
    const v = new WindowsSpeechProvider();
    const reason = await v.unavailableReason();
    if (reason) { console.warn(reason); ctx.skip(); }
    const tokens = tokenize("The pod asks for nvidia.com/gpu: 1. It uses twelve percent.");
    const r = await v.synthesize({ text: spokenText(tokens), workDir: path.join(dir, "sapi") });
    expect(r.timing).toEqual({ source: "provider", granularity: "word" });
    expect(r.words.length).toBeGreaterThan(8);
    for (let i = 1; i < r.words.length; i++) expect(r.words[i].startMs).toBeGreaterThanOrEqual(r.words[i - 1].startMs);
    const n = normalizeTiming(tokens, r.words, { sectionId: "s", offsetMs: 0, durationMs: r.durationMs });
    expect(n.interpolated).toBe(0);
  }, 60_000);
});
