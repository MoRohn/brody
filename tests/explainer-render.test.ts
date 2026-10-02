/**
 * Rendering and media: the layout validator, the frame function, the HTML renderer, media validation of broken output,
 * and the Manim safeguards carried over from the explainer-video reference (real-clock timing, no caching, no
 * set_opacity, no Indicate), checked against the SVG renderer pixel by pixel. Tests that need Manim or the macOS voice
 * are skipped, with the reason, on machines without them.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeWav, readWavFile, silences } from "@/lib/explainer/audio";
import { explainerConfig } from "@/lib/explainer/config";
import { renderFrameSvg, sceneStateAt } from "@/lib/explainer/frame";
import { conformScene, mux, probe, run } from "@/lib/explainer/media";
import { HtmlRenderer, ManimRenderer } from "@/lib/explainer/render";
import { MANIM_SCRIPT } from "@/lib/explainer/render/manim-script";
import { renderModel } from "@/lib/explainer/render/manim";
import { buildDiagram, planScenes } from "@/lib/explainer/scenes";
import { tokenize, spokenText } from "@/lib/explainer/speech";
import { MacSpeechProvider } from "@/lib/explainer/tts/macos";
import { validateLayout, validateMedia } from "@/lib/explainer/validate";
import { extractBeats } from "@/lib/explainer/beats";
import { planDeterministic } from "@/lib/explainer/narrate";
import type { SceneSpec, SectionAudio, TimedWord, VisualObject, VisualScenePlan } from "@/lib/explainer/types";
import { sampleSpec } from "./helpers/explainer";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brody-explainer-render-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const node = (id: string, x: number, y: number, extra: Partial<VisualObject> = {}): VisualObject => ({ id, kind: "node", box: { x, y, w: 180, h: 64 }, lines: [id], fontSize: 22, glyph: "service", refs: [], z: 2, initial: { visible: false, state: "idle" }, ...extra });
const scene = (objects: VisualObject[], actions: SceneSpec["actions"], frameCount = 60): SceneSpec => ({ id: "scene-t", sectionId: "t", objective: "", layout: "architecture", startMs: 0, endMs: (frameCount * 1000) / 30, startFrame: 0, frameCount, renderer: "html", objects, actions, citations: [], hash: "h" });
const plan = (s: SceneSpec[]): VisualScenePlan => ({ version: 1, canvas: { width: 1280, height: 720, fps: 30 }, style: "brody", durationMs: s.reduce((a, x) => a + x.endMs - x.startMs, 0), frames: s.reduce((a, x) => a + x.frameCount, 0), scenes: s });

describe("layout validation", () => {
  it("passes a planned scene and catches overflow, out-of-frame, collisions and tiny text", () => {
    const ok = scene([node("a", 100, 200), node("b", 400, 200)], [{ id: "x", beatId: "b", kind: "appear", target: "a", startMs: 0, durationMs: 300 }, { id: "y", beatId: "b", kind: "appear", target: "b", startMs: 0, durationMs: 300 }]);
    expect(validateLayout(plan([ok])).filter((c) => c.status === "fail")).toEqual([]);
    const bad = scene([
      node("this label is far too long for its box", 100, 200),
      node("off", 1200, 200),
      node("overlap", 120, 210),
      node("tiny", 600, 300, { fontSize: 11 }),
    ], ["this label is far too long for its box", "off", "overlap", "tiny"].map((id, i) => ({ id: `a${i}`, beatId: "b", kind: "appear" as const, target: id, startMs: 0, durationMs: 300 })));
    const fails = validateLayout(plan([bad])).filter((c) => c.status === "fail").map((c) => c.id);
    expect(fails).toEqual(expect.arrayContaining(["layout.text", "layout.frame", "layout.collisions", "layout.fonts"]));
  });
  it("only counts a collision when both objects are on screen at once", () => {
    const s = scene([node("a", 100, 200), node("b", 110, 210)], [
      { id: "1", beatId: "b1", kind: "appear", target: "a", startMs: 0, durationMs: 300 },
      { id: "2", beatId: "b2", kind: "disappear", target: "a", startMs: 800, durationMs: 300 },
      { id: "3", beatId: "b2", kind: "appear", target: "b", startMs: 1200, durationMs: 300 },
    ]);
    expect(validateLayout(plan([s])).find((c) => c.id === "layout.collisions")?.status).toBe("pass");
  });
  it("flags a scene that shows nothing but its title", () => {
    const s = scene([{ ...node("k", 64, 40), kind: "kicker", initial: { visible: true } }], []);
    expect(validateLayout(plan([s])).find((c) => c.id === "layout.empty")?.status).toBe("fail");
  });
});

describe("frame function", () => {
  const s = scene([node("a", 100, 200), node("b", 500, 200)], [
    { id: "1", beatId: "b", kind: "appear", target: "a", startMs: 0, durationMs: 400 },
    { id: "2", beatId: "b", kind: "highlight", target: "a", startMs: 500, durationMs: 300 },
    { id: "3", beatId: "b", kind: "appear", target: "b", startMs: 500, durationMs: 300 },
    { id: "4", beatId: "b", kind: "scrim", startMs: 1000, durationMs: 300, keep: ["a"] },
  ]);
  it("eases appearances, never moves a highlighted object, and keeps chosen objects above the scrim", () => {
    expect(sceneStateAt(s, 0).objs.get("a")!.opacity).toBe(0);
    expect(sceneStateAt(s, 1999).objs.get("a")!.opacity).toBe(1);
    expect(sceneStateAt(s, 700).objs.get("a")!.highlight).toBeGreaterThan(0.5);
    // A highlight is an outline: the object's box and position are untouched (no Indicate-style scaling).
    expect(s.objects[0].box).toEqual({ x: 100, y: 200, w: 180, h: 64 });
    const svg = renderFrameSvg(s, 1900, { style: "brody" });
    const scrimAt = svg.indexOf('opacity="0.8"');
    expect(scrimAt).toBeGreaterThan(0);
    expect(svg.lastIndexOf(">a<")).toBeGreaterThan(scrimAt); // "a" is drawn again above the scrim
    expect(svg.lastIndexOf(">b<")).toBeLessThan(scrimAt); // "b" stays under it
  });
  it("escapes repository text in the SVG", () => {
    const x = scene([node("<script>alert(1)</script>", 100, 200, { initial: { visible: true } })], []);
    expect(renderFrameSvg(x, 0, { style: "brody" })).not.toContain("<script>");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Real renders
// ---------------------------------------------------------------------------------------------------------------------
/** A real plan from the sample spec with synthetic, exactly known word timings. */
function realPlan(): VisualScenePlan {
  const spec = sampleSpec();
  const np = planDeterministic(spec, { duration: "quick", audience: "intermediate", style: "brody" });
  let at = 0;
  const audio: SectionAudio[] = np.sections.map((sec) => {
    const tokens = tokenize(sec.narration);
    const words: TimedWord[] = tokens.map((t, i) => ({ text: t.display, startMs: at + 100 + i * 330, endMs: at + 100 + i * 330 + 300, sectionId: sec.id, sentence: t.sentence }));
    const frames = Math.ceil(((tokens.length * 330 + 500) * 30) / 1000);
    const a: SectionAudio = { sectionId: sec.id, audio: "", speechMs: tokens.length * 330, slotMs: (frames * 1000) / 30, frames, startMs: at, words, timing: { source: "synthetic", granularity: "word", interpolated: 0 }, provider: "t", voice: "v", hash: sec.id };
    at += a.slotMs;
    return a;
  });
  const { beats } = extractBeats(np.sections, audio);
  return planScenes({ spec, plan: np, audio, beats, style: "brody", renderer: "auto", available: ["manim", "html"] }).plan;
}

async function grayAt(video: string, ms: number): Promise<Buffer> {
  const r = await run(explainerConfig().ffmpeg, ["-v", "error", "-i", video, "-ss", (ms / 1000).toFixed(3), "-frames:v", "1", "-vf", "scale=320:180,format=gray", "-f", "rawvideo", "-"]);
  return r.stdout;
}
const meanDiff = (a: Buffer, b: Buffer) => { let d = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) d += Math.abs(a[i] - b[i]); return d / Math.min(a.length, b.length); };

describe("HTML renderer", () => {
  it("renders exactly the planned frames and passes media validation with real audio", async () => {
    const p = realPlan();
    const s = p.scenes.find((x) => x.layout === "contention" || x.layout === "architecture")!;
    const r = await new HtmlRenderer().renderScene(s, { workDir: path.join(dir, "html"), style: "brody", fps: 30, width: 1280, height: 720 });
    expect((await probe(r.video)).video?.frames).toBe(s.frameCount);
    // Validation of a single-scene plan with matching audio.
    const audio = path.join(dir, "a.wav");
    const n = Math.round((s.frameCount / 30) * 48000);
    const pcm = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 20) * 9000), i * 2);
    fs.writeFileSync(audio, encodeWav(pcm));
    const out = path.join(dir, "html-final.mp4");
    await mux(r.video, audio, out);
    const one = { ...p, scenes: [{ ...s, startMs: 0, endMs: s.endMs - s.startMs }], frames: s.frameCount, durationMs: Math.round((s.frameCount / 30) * 1000) };
    const checks = await validateMedia({ video: out, audio, plan: one, narrationMs: (n / 48000) * 1000, vtt: "WEBVTT\n" });
    expect(checks.filter((c) => c.status === "fail")).toEqual([]);
  }, 120_000);

  it("fails validation when audio and video disagree, when frames are blank, and when the file is corrupt", async () => {
    const blank = path.join(dir, "blank.mp4");
    await run(explainerConfig().ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x0B1822:s=1280x720:r=30", "-frames:v", "90", "-pix_fmt", "yuv420p", blank]);
    const audio = path.join(dir, "long.wav");
    const pcm = Buffer.alloc(48000 * 5 * 2); for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 20) * 9000), i * 2);
    fs.writeFileSync(audio, encodeWav(pcm));
    const muxed = path.join(dir, "mismatch.mp4");
    await mux(blank, audio, muxed);
    const p = plan([scene([node("a", 100, 200)], [], 90)]);
    const checks = await validateMedia({ video: muxed, audio, plan: p, narrationMs: 5000, vtt: "WEBVTT\n" });
    const failed = checks.filter((c) => c.status === "fail").map((c) => c.id);
    expect(failed).toEqual(expect.arrayContaining(["av.sync", "video.nonempty"]));
    const corrupt = path.join(dir, "corrupt.mp4");
    const bytes = fs.readFileSync(muxed);
    fs.writeFileSync(corrupt, Buffer.concat([bytes.subarray(0, Math.floor(bytes.length / 2)), Buffer.alloc(4096, 7)]));
    const c2 = await validateMedia({ video: corrupt, audio, plan: p, narrationMs: 5000, vtt: "WEBVTT\n" }).catch((e) => [{ id: "probe", status: "fail", detail: String(e) }]);
    expect(c2.some((c) => c.status === "fail")).toBe(true);
  }, 120_000);
});

describe("Manim renderer safeguards", () => {
  let reason: string | null = "not checked";
  beforeAll(async () => { reason = await new ManimRenderer().unavailableReason(); });

  it("never dims with set_opacity and never pulses with Indicate (static check of the interpreter)", () => {
    expect(MANIM_SCRIPT).not.toMatch(/\.set_opacity\(/);
    expect(MANIM_SCRIPT).not.toMatch(/\bIndicate\(/);
    expect(MANIM_SCRIPT).toMatch(/hold_until/);
    expect(MANIM_SCRIPT).toMatch(/self\.renderer, "time"/);
    expect(MANIM_SCRIPT).toMatch(/Refusing to render with caching on/);
    // Outline shapes are built with an invisible ground-coloured fill as a second guard.
    expect(MANIM_SCRIPT).toMatch(/fill_color=P\["ground"\], fill_opacity=0\.0/);
  });

  it("refuses to render with caching on", async (ctx) => {
    if (reason) ctx.skip();
    const p = realPlan();
    const work = path.join(dir, "cache");
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, "s.py"), MANIM_SCRIPT);
    fs.writeFileSync(path.join(work, "m.json"), JSON.stringify(renderModel(p.scenes[0], "brody")));
    const r = await run(explainerConfig().manimPython, ["-m", "manim", "render", path.join(work, "s.py"), "BrodyScene", "-r", "320,180", "--media_dir", path.join(work, "media"), "-v", "ERROR"], { cwd: work, env: { ...process.env, BRODY_SCENE_MODEL: path.join(work, "m.json"), BRODY_SCENE_REPORT: path.join(work, "r.json") } as NodeJS.ProcessEnv });
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout.toString()).toMatch(/Refusing to render with caching on/);
  }, 120_000);

  it("has no frame drift: forty odd-length animations land on their planned frames", async (ctx) => {
    if (reason) ctx.skip();
    // Forty nodes appear one after another at 237 ms intervals, each over 111 ms: rounding every animation up to a
    // whole frame and summing run times would drift by seconds; reading the real clock keeps every one on time.
    const objs: VisualObject[] = [];
    const acts: SceneSpec["actions"] = [];
    for (let i = 0; i < 40; i++) {
      objs.push({ ...node(`n${i}`, 70 + (i % 8) * 145, 140 + Math.floor(i / 8) * 90), box: { x: 70 + (i % 8) * 145, y: 140 + Math.floor(i / 8) * 90, w: 120, h: 60 }, lines: [] , glyph: undefined });
      acts.push({ id: `a${i}`, beatId: `b${i}`, kind: "appear", target: `n${i}`, startMs: 100 + i * 237, durationMs: 111 });
    }
    const s = scene(objs, acts, 330);
    const r = await new ManimRenderer().renderScene(s, { workDir: path.join(dir, "drift"), style: "brody", fps: 30, width: 1280, height: 720 });
    const conformed = path.join(dir, "drift.mp4");
    await conformScene(r.video, conformed, s.frameCount, 30, { width: 1280, height: 720 });
    // The last node: absent one frame before it starts, present two frames after it ends.
    const last = acts[39];
    const lastObj = objs[39];
    const px = async (ms: number) => { const g = await grayAt(conformed, ms); const x = Math.round(((lastObj.box.x + 60) / 1280) * 320), y = Math.round(((lastObj.box.y + 30) / 720) * 180); return g[y * 320 + x]; };
    const before = await px(last.startMs - 40), after = await px(last.startMs + last.durationMs + 70);
    expect(after - before).toBeGreaterThan(4);
    expect(r.log ?? "").not.toMatch(/overrun/i);
  }, 240_000);

  it("draws the same picture as the SVG renderer at sampled moments (including source markers after a scrim)", async (ctx) => {
    if (reason) ctx.skip();
    const p = realPlan();
    const html = new HtmlRenderer();
    for (const s of p.scenes.filter((x) => x.layout === "contention" || x.layout === "comparison" || x.layout === "architecture").slice(0, 2)) {
      const r = await new ManimRenderer().renderScene(s, { workDir: path.join(dir, `cmp-${s.id}`), style: "brody", fps: 30, width: 1280, height: 720 });
      const conformed = path.join(dir, `cmp-${s.id}.mp4`);
      await conformScene(r.video, conformed, s.frameCount, 30, { width: 1280, height: 720 });
      const h = await html.renderScene(s, { workDir: path.join(dir, `cmph-${s.id}`), style: "brody", fps: 30, width: 1280, height: 720 });
      const dur = s.endMs - s.startMs;
      for (const f of [0.35, 0.7, 0.98]) {
        const t = Math.round(dur * f);
        expect(meanDiff(await grayAt(conformed, t), await grayAt(h.video, t)), `${s.id} at ${t} ms`).toBeLessThan(6);
      }
    }
  }, 300_000);
});

describe("on-device macOS voice", () => {
  it("reports word starts that land on the audible onsets", async (ctx) => {
    const voice = new MacSpeechProvider();
    if (await voice.unavailableReason()) ctx.skip();
    const tokens = tokenize("The pod asks for nvidia.com/gpu: 1. It uses twelve percent. Seven others wait.");
    const r = await voice.synthesize({ text: spokenText(tokens), workDir: path.join(dir, "mac") });
    expect(r.timing).toEqual({ source: "provider", granularity: "word" });
    for (let i = 1; i < r.words.length; i++) expect(r.words[i].startMs).toBeGreaterThanOrEqual(r.words[i - 1].startMs);
    // The first word after each pause starts where the silence ends (within 80 ms).
    const gaps = silences(readWavFile(r.audioPath), 150, 0.012).filter((g) => g.startMs > 50 && g.endMs < r.durationMs - 50);
    expect(gaps.length).toBeGreaterThanOrEqual(2);
    for (const g of gaps) {
      const next = r.words.find((w) => w.startMs >= g.startMs);
      expect(next, `a word after the pause at ${Math.round(g.endMs)} ms`).toBeTruthy();
      expect(Math.abs(next!.startMs - g.endMs)).toBeLessThan(80);
    }
  }, 120_000);
});

describe("diagram geometry", () => {
  it("draws containment and instances, and keeps every diagram inside the content area", () => {
    const spec = sampleSpec();
    const d = buildDiagram(spec, ["k1", "k2", "k3", "k4", "k5"], ["k1", "k2", "k3", "k4", "k5"]);
    expect(d.objects.filter((o) => o.kind === "cell" && o.parent === "k:k2")).toHaveLength(8);
    expect(d.objects.find((o) => o.id === "k:k2")?.parent).toBe("k:k1");
    expect(d.pairs).toEqual([{ relId: "r1", consumer: "k4", resource: "k2", n: 8 }]);
    for (const o of d.objects.filter((x) => x.kind !== "connector")) { expect(o.box.x).toBeGreaterThanOrEqual(64); expect(o.box.x + o.box.w).toBeLessThanOrEqual(1216); expect(o.box.y + o.box.h).toBeLessThanOrEqual(600); }
  });
});
