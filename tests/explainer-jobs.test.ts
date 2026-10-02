/**
 * Explainer jobs: lifecycle, cancellation, retry and resume with stage reuse, provider fallback, timeouts, renderer and
 * FFmpeg failures, local-only routing, voices without word timing, stale-worker recovery, and the HTTP API.
 *
 * The explanation is compiled deterministically (no AI provider), which also exercises the no-model path. A stub
 * renderer draws FFmpeg's test pattern with the exact frame count, so lifecycle tests run in seconds; the real renderers
 * are covered by tests/explainer-acceptance.test.ts and tests/explainer-render.test.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { analyze, fixtureFiles, freshDb, setAIProvider } from "./helpers";
import { askRepository } from "@/lib/ask";
import { getDb, schema } from "@/lib/db/client";
import { cancelJob, createExplanation, getExplanationView, getJobView, regenerateSection, requestVideo, retryJob } from "@/lib/explainer";
import { explainerConfig, updateExplainerSettings } from "@/lib/explainer/config";
import { recoverStaleVideoJobs } from "@/lib/explainer/pipeline";
import { HtmlRenderer, setRenderers, type ExplainerRenderer, type RenderContext, type SceneRender } from "@/lib/explainer/render";
import { setTtsProviders, SyntheticProvider, TTSError, type TTSProvider, type TTSRequest, type TTSResult } from "@/lib/explainer/tts";
import { run } from "@/lib/explainer/media";
import { invokeTool, TOOLS } from "@/lib/explainer/tool";
import type { ArtifactManifest, SceneSpec, ValidationReport } from "@/lib/explainer/types";
import { drainVideoQueue } from "@/lib/jobs/worker";
import { POST as createRoute } from "@/app/api/explanations/route";
import { GET as fileRoute } from "@/app/api/explanations/[id]/files/[...path]/route";
import { POST as toolRoute } from "@/app/api/explainer/tool/route";

/** Draws FFmpeg's moving test pattern: fast, never empty, exactly the planned frames. */
class StubRenderer implements ExplainerRenderer {
  readonly label = "stub";
  calls: string[] = [];
  failFor = new Set<string>();
  constructor(readonly id: "html" | "manim" = "html") {}
  async unavailableReason() { return null; }
  async renderScene(scene: SceneSpec, ctx: RenderContext): Promise<SceneRender> {
    this.calls.push(scene.id);
    if (this.failFor.has(scene.id) || this.failFor.has("*")) throw new Error(`${this.id} crashed on ${scene.id}`);
    fs.mkdirSync(ctx.workDir, { recursive: true });
    const video = path.join(ctx.workDir, "stub.mp4");
    const r = await run(explainerConfig().ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=${ctx.width}x${ctx.height}:rate=${ctx.fps}`, "-frames:v", String(scene.frameCount), "-pix_fmt", "yuv420p", video], { signal: ctx.signal });
    if (r.code !== 0) throw new Error(r.stderr);
    return { video, sources: [], renderer: this.id, ms: 0, cpuMs: 0 };
  }
}

/** A voice that reports sentence timing only (like Piper), built on the synthetic voice's audio. */
class SentenceVoice implements TTSProvider {
  readonly id = "sentencevoice";
  readonly label = "Sentence-timed voice";
  readonly defaultVoice = "v";
  readonly capabilities = { supportsWordTimings: false, supportsSentenceTimings: true, supportsStreaming: false, supportsLocalInference: true, supportsVoiceClone: false, charLimit: 10_000 };
  private inner = new SyntheticProvider();
  async unavailableReason() { return null; }
  async synthesize(req: TTSRequest): Promise<TTSResult> { const r = await this.inner.synthesize(req); return { ...r, timing: { source: "segment-measured", granularity: "sentence" } }; }
}

/** A cloud voice double: the synthetic engine, presented as a remote provider. */
function cloudVoice(): TTSProvider {
  const v = new SyntheticProvider();
  Object.defineProperties(v, { id: { value: "cloudvoice" }, label: { value: "Cloud voice double" }, capabilities: { value: { ...v.capabilities, supportsLocalInference: false } } });
  return v;
}

describe("explainer jobs", () => {
  let projectId = "";
  let explanationId = "";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brody-explainer-jobs-"));
  const synthetic = new SyntheticProvider();
  const stub = new StubRenderer();

  beforeAll(async () => {
    process.env.EXPLAINER_DIR = dir;
    process.env.EXPLAINER_TTS_PROVIDER = "synthetic";
    freshDb();
    setTtsProviders([synthetic]);
    setRenderers([stub]);
    const r = await analyze(fixtureFiles("fixtures/dgx-ai-platform"), "dgx");
    projectId = r.projectId;
    // No AI provider: the graph and retrieval answer, and the explanation compiles deterministically.
    setAIProvider(null);
    const answer = await askRepository(projectId, "Explain why GPU scheduling leaves the DGX GPUs idle and blocks the training job.");
    expect(answer.citations.length).toBeGreaterThan(0);
    const { explanation } = await createExplanation({ projectId, source: { kind: "question", id: answer.id! } });
    explanationId = explanation.id;
  }, 180_000);

  afterEach(() => {
    setTtsProviders([synthetic]);
    setRenderers([stub]);
    stub.failFor.clear();
    synthetic.failNext = 0;
    delete process.env.FFMPEG_PATH;
    updateExplainerSettings({ execution: null, privacy: null, ttsProvider: null });
    process.env.EXPLAINER_TTS_PROVIDER = "synthetic";
  });

  afterAll(() => {
    setTtsProviders(undefined);
    setRenderers(undefined);
    delete process.env.EXPLAINER_DIR;
    delete process.env.EXPLAINER_TTS_PROVIDER;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const manifestOf = (jobId: string) => JSON.parse(fs.readFileSync(path.join(dir, explanationId, getJobView(jobId).artifacts.manifest as string), "utf8")) as ArtifactManifest;

  it("compiles a deterministic explanation without any AI provider", () => {
    const e = getExplanationView(explanationId);
    expect(e.compile).toMatchObject({ ai: false });
    expect(e.spec.claims.some((c) => c.supported)).toBe(true);
    expect(e.spec.sources.length).toBeGreaterThan(0);
  });

  it("runs a job to READY with every stage recorded, and refuses a second job while one is active", async () => {
    const job = requestVideo(explanationId, { duration: "quick" });
    expect(() => requestVideo(explanationId, {})).toThrow(/already being made/);
    await drainVideoQueue();
    const done = getJobView(job.id);
    expect(done.status, done.error ?? "").toBe("ready");
    expect(done.stages.map((s) => s.status)).toEqual(Array(8).fill("done"));
    expect((done.validation as ValidationReport).ok).toBe(true);
    const m = manifestOf(job.id);
    expect(m.video && fs.existsSync(path.join(dir, explanationId, m.video))).toBe(true);
    expect(m.metrics.stages.every((s) => s.ms >= 0)).toBe(true);
    expect(m.stageHashes).toHaveProperty("planning");
  }, 120_000);

  it("cancels a queued job at once and a running job at its next check", async () => {
    const q = requestVideo(explanationId, { duration: "quick" });
    expect(cancelJob(q.id).status).toBe("cancelled");
    // Running: the voice requests cancellation from inside synthesis, as a user clicking Cancel would.
    const slow = new SyntheticProvider();
    Object.defineProperty(slow, "id", { value: "slowvoice" });
    const orig = slow.synthesize.bind(slow);
    let jobId = "";
    slow.synthesize = async (req) => { getDb().update(schema.videoJobs).set({ cancelRequested: true }).where(eq(schema.videoJobs.id, jobId)).run(); await new Promise((r) => setTimeout(r, 400)); return orig({ ...req, text: `${req.text} ` }); };
    setTtsProviders([slow]);
    process.env.EXPLAINER_TTS_PROVIDER = "";
    jobId = requestVideo(explanationId, { duration: "quick", ttsProvider: "slowvoice" }).id;
    await drainVideoQueue();
    const j = getJobView(jobId);
    expect(j.status).toBe("cancelled");
    expect(j.stages.find((s) => s.status === "failed")?.key).toBe("tts");
  }, 120_000);

  it("keeps everything produced before a failure, and a retry resumes without redoing finished stages", async () => {
    stub.failFor.add("*");
    setRenderers([stub]);
    const job = requestVideo(explanationId, { duration: "quick", forceScenes: ["*"] });
    await drainVideoQueue();
    const failed = getJobView(job.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/could not be rendered.*Everything produced before this stage is still available/s);
    expect(failed.artifacts).toHaveProperty("transcript");
    expect(failed.artifacts).toHaveProperty("audio");
    expect(failed.artifacts).toHaveProperty("storyboard");
    // The explanation itself is untouched by the failure.
    expect(getExplanationView(explanationId).clear.sections.length).toBeGreaterThan(0);
    stub.failFor.clear();
    const calls = synthetic.calls.length;
    expect(retryJob(job.id).status).toBe("queued");
    await drainVideoQueue();
    const ok = getJobView(job.id);
    expect(ok.status, ok.error ?? "").toBe("ready");
    expect(ok.attempts).toBe(1);
    expect(synthetic.calls.length).toBe(calls); // every section's audio came from the stage cache
    expect(() => retryJob(job.id)).toThrow(/Only a failed or cancelled job/);
  }, 120_000);

  it("falls back to the next voice when one fails, and retries a voice once on a timeout", async () => {
    const broken = new SyntheticProvider();
    broken.failNext = 100;
    Object.defineProperty(broken, "id", { value: "brokenvoice" });
    const flaky = new SyntheticProvider();
    Object.defineProperty(flaky, "id", { value: "flakyvoice" });
    const orig = flaky.synthesize.bind(flaky);
    let first = true;
    flaky.synthesize = async (req) => { if (first) { first = false; throw new TTSError("network timeout", "synthetic", true); } return orig({ ...req, text: `${req.text}  ` }); };
    setTtsProviders([broken, flaky]);
    process.env.EXPLAINER_TTS_PROVIDER = "";
    const job = requestVideo(explanationId, { duration: "quick", ttsProvider: "brokenvoice" });
    await drainVideoQueue();
    const j = getJobView(job.id);
    expect(j.status, j.error ?? "").toBe("ready");
    expect(j.log.join("\n")).toMatch(/could not narrate/);
    expect(j.log.join("\n")).toMatch(/retrying/);
    expect(j.log.join("\n")).toMatch(/after the preferred voice failed/);
  }, 120_000);

  it("falls back from a crashing Manim renderer to the HTML renderer, scene by scene", async () => {
    const manim = new StubRenderer("manim");
    manim.failFor.add("*");
    setRenderers([manim, new StubRenderer("html")]);
    const job = requestVideo(explanationId, { duration: "quick", renderer: "manim", forceScenes: ["*"] });
    await drainVideoQueue();
    const j = getJobView(job.id);
    expect(j.status, j.error ?? "").toBe("ready");
    expect(j.log.join("\n")).toMatch(/manim failed .*rendered with html instead/);
    expect(manifestOf(job.id).renderers).toEqual({ html: expect.any(Number) });
  }, 120_000);

  it("fails clearly, without touching the explanation, when FFmpeg is missing", async () => {
    process.env.FFMPEG_PATH = "/nonexistent/ffmpeg";
    setRenderers([new HtmlRenderer()]);
    const job = requestVideo(explanationId, { duration: "quick", forceScenes: ["*"] });
    await drainVideoQueue();
    const j = getJobView(job.id);
    expect(j.status).toBe("failed");
    expect(j.error).toMatch(/ffmpeg|FFmpeg|Could not/);
    expect(getExplanationView(explanationId).diagram).not.toBeUndefined();
  }, 120_000);

  it("keeps narration on the machine in local-only mode, and asks before using a cloud voice", async () => {
    setTtsProviders([cloudVoice()]);
    process.env.EXPLAINER_TTS_PROVIDER = "";
    const local = requestVideo(explanationId, { duration: "quick", execution: "local" });
    await drainVideoQueue();
    expect(getJobView(local.id).error).toMatch(/No voice can narrate.*execution is local-only/);
    const cloud = requestVideo(explanationId, { duration: "quick", execution: "cloud" });
    await drainVideoQueue();
    expect(getJobView(cloud.id).error).toMatch(/explicit permission/);
    const allowed = requestVideo(explanationId, { duration: "quick", execution: "cloud", allowExternal: true });
    await drainVideoQueue();
    expect(getJobView(allowed.id).status).toBe("ready");
    updateExplainerSettings({ privacy: "local-only" });
    const blocked = requestVideo(explanationId, { duration: "quick", execution: "cloud", allowExternal: true });
    await drainVideoQueue();
    expect(getJobView(blocked.id).error).toMatch(/local-only/);
  }, 180_000);

  it("uses a voice without word timing in an explicit sentence-level mode, never pretending to be word-accurate", async () => {
    setTtsProviders([new SentenceVoice()]);
    process.env.EXPLAINER_TTS_PROVIDER = "";
    const job = requestVideo(explanationId, { duration: "quick" });
    await drainVideoQueue();
    const j = getJobView(job.id);
    expect(j.status, j.error ?? "").toBe("ready");
    const m = manifestOf(job.id);
    expect(m.timing).toEqual({ source: "segment-measured", granularity: "sentence" });
    expect((j.validation as ValidationReport).checks.find((c) => c.id === "timing.fidelity")).toMatchObject({ status: "warn" });
    const beats = JSON.parse(fs.readFileSync(path.join(dir, explanationId, m.beats!), "utf8")) as { sentenceAnchored: boolean }[];
    expect(beats.every((b) => b.sentenceAnchored)).toBe(true);
  }, 120_000);

  it("requeues a job whose worker died and finishes it from its finished stages", async () => {
    const job = requestVideo(explanationId, { duration: "quick" });
    getDb().update(schema.videoJobs).set({ status: "running", heartbeatAt: Date.now() - 10 * 60_000 }).where(eq(schema.videoJobs.id, job.id)).run();
    expect(recoverStaleVideoJobs()).toBe(1);
    expect(getJobView(job.id).status).toBe("queued");
    await drainVideoQueue();
    expect(getJobView(job.id).status).toBe("ready");
  }, 120_000);

  it("re-renders one scene on request and reuses the rest", async () => {
    const ready = getExplanationView(explanationId).ready!;
    const m0 = manifestOf(ready.id);
    const scene = (JSON.parse(fs.readFileSync(path.join(dir, explanationId, m0.scenePlan!), "utf8")) as { scenes: SceneSpec[] }).scenes[1];
    const before = stub.calls.length;
    const job = regenerateSection(ready.id, { sectionId: scene.sectionId });
    expect(job.kind).toBe("section");
    await drainVideoQueue();
    expect(getJobView(job.id).status).toBe("ready");
    expect(stub.calls.slice(before)).toEqual([scene.id]);
    expect(() => regenerateSection(ready.id, { sectionId: "nope" })).toThrow(/Unknown section/);
  }, 120_000);

  it("serves artifacts with HTTP range requests and refuses paths outside the explanation", async () => {
    const ready = getExplanationView(explanationId).ready!;
    const rel = (ready.artifacts.video as string).split("/");
    const ctx = { params: Promise.resolve({ id: explanationId, path: rel }) };
    const full = await fileRoute(new Request("http://x/"), ctx);
    expect(full.status).toBe(200);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    const part = await fileRoute(new Request("http://x/", { headers: { range: "bytes=0-99" } }), { params: Promise.resolve({ id: explanationId, path: rel }) });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toMatch(/^bytes 0-99\//);
    expect((await part.arrayBuffer()).byteLength).toBe(100);
    const evil = await fileRoute(new Request("http://x/"), { params: Promise.resolve({ id: explanationId, path: ["..", "..", "brody.db"] }) });
    expect(evil.status).toBe(404);
    const dl = await fileRoute(new Request("http://x/?download=1"), { params: Promise.resolve({ id: explanationId, path: rel }) });
    expect(dl.headers.get("content-disposition")).toMatch(/attachment; filename=".*\.mp4"/);
  });

  it("exposes the same capability over HTTP and as an agent tool, on stored Brody state only", async () => {
    const notJson = await createRoute(new Request("http://x/api/explanations", { method: "POST", body: "projectId=x", headers: { "content-type": "application/x-www-form-urlencoded" } }));
    expect(notJson.status).toBe(415);
    const qid = getExplanationView(explanationId).sourceRunId;
    const res = await createRoute(new Request("http://x/api/explanations", { method: "POST", body: JSON.stringify({ projectId, source: { kind: "question", id: qid.split(":")[1] } }), headers: { "content-type": "application/json" } }));
    expect(res.status).toBe(200);
    expect(TOOLS.map((t) => t.name)).toEqual(["create_explainer", "get_video_job", "refine_explainer", "regenerate_section"]);
    const text = await invokeTool("create_explainer", { projectId, sourceRunId: qid, mode: "text" });
    expect(text).toMatchObject({ explanationId, mode: "text" });
    const http = await toolRoute(new Request("http://x/", { method: "POST", body: JSON.stringify({ name: "create_explainer", arguments: { projectId, sourceRunId: "question:nope" } }), headers: { "content-type": "application/json" } }));
    expect(http.status).toBe(404);
    await expect(invokeTool("create_explainer", { projectId, sourceRunId: "bogus:x" })).rejects.toThrow(/Unknown result/);
  });
});
