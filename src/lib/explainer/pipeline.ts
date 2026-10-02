/**
 * Durable explainer video jobs.
 *
 *   QUEUED → PLANNING → SCRIPTING → TTS → ALIGNING → STORYBOARDING → RENDERING → MUXING → VALIDATING → READY
 *                                                                                         ↘ FAILED / CANCELLED
 *
 * Every stage persists its outputs and the hash of its inputs. Section audio and scene videos are content addressed
 * (store.ts), so a retried, resumed or section-level job re-does only what changed: a narration edit to one section
 * re-synthesises that section and re-renders that scene, and everything else is reused. Results stream as they appear:
 * the plan, then the transcript and audio, then the storyboard and the interactive player, then the video.
 *
 * A video failure never touches the Brody result it explains: the answer, its explanation, diagram, transcript and
 * sources stay available, and the job says exactly which stage failed and why.
 */
import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray, lt } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import type { JobStage, VideoJobRow } from "../db/schema";
import { UsageLedger, withUsageLedger } from "../ai";
import { scrubToken } from "../ingest/credentials";
import { AppError } from "../util/errors";
import { newId, sha256 } from "../util/ids";
import { mapLimit } from "../util/concurrency";
import { encodeWav, padToFrameSlot, readWavFile } from "./audio";
import { extractBeats } from "./beats";
import { buildCues, buildTranscript, chaptersVtt, toSrt, toVtt } from "./captions";
import { effectiveRouting, explainerConfig } from "./config";
import { CANVAS } from "./design";
import { concatScenes, concatWavs, conformScene, extractFrame, lastLines, mux, probe } from "./media";
import { fitPlanLength, planNarration } from "./narrate";
import { classifyNarration, decideExternal, sanitizeNarration } from "./privacy";
import { allRenderers, getRenderer, HtmlRenderer, ManimRenderer } from "./render";
import { routeModes } from "./router";
import { planScenes, SCENE_PLANNER_VERSION } from "./scenes";
import { validateSpec } from "./spec";
import { spokenText, tokenize } from "./speech";
import { dirBytes, requireExplanation, runDir, specHash, specOf, stageDir } from "./store";
import { normalizeTiming } from "./timing";
import { routeTts, scrubSecrets, type TTSProvider } from "./tts";
import { report, validateLayout, validateMedia, validateProvenance, validateTimeline } from "./validate";
import { MANIM_SCRIPT_VERSION } from "./render/manim-script";
import type { ArtifactManifest, ExplanationArtifactSpec, NarrationPlan, NarrativeBeat, RendererId, SceneSpec, SectionAudio, StageMetric, TimedWord, ValidationCheck, VideoJobParams, VisualScenePlan } from "./types";

export const PIPELINE_VERSION = 3;
const TTS_CACHE_VERSION = 2;
const HEARTBEAT_STALE_MS = 90_000;

export const VIDEO_STAGES: { key: string; label: string }[] = [
  { key: "planning", label: "Planning explanation" },
  { key: "scripting", label: "Writing narration" },
  { key: "tts", label: "Generating voice" },
  { key: "aligning", label: "Aligning narration" },
  { key: "storyboarding", label: "Designing scenes" },
  { key: "rendering", label: "Rendering" },
  { key: "muxing", label: "Finalizing" },
  { key: "validating", label: "Validating" },
];
const initialStages = (): JobStage[] => VIDEO_STAGES.map((s) => ({ key: s.key, label: s.label, status: "pending" }));

export const DEFAULT_PARAMS: VideoJobParams = { duration: "standard", audience: "intermediate", style: "brody", renderer: "auto", execution: "local" };

// ---------------------------------------------------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------------------------------------------------
export function enqueueVideoJob(explanationId: string, params: Partial<VideoJobParams>, opts: { kind?: "video" | "section" | "narration"; parentJobId?: string } = {}): VideoJobRow {
  const ex = requireExplanation(explanationId);
  const db = getDb();
  const active = db.select().from(schema.videoJobs).where(and(eq(schema.videoJobs.explanationId, explanationId), inArray(schema.videoJobs.status, ["queued", "running"]))).get();
  if (active) throw new AppError("job_active", "A video for this explanation is already being made.", 409, `Wait for job ${active.id} to finish, or cancel it first.`);
  const routing = effectiveRouting();
  const full: VideoJobParams = { ...DEFAULT_PARAMS, execution: routing.execution, renderer: routing.renderer, audience: ex.audience as VideoJobParams["audience"], ...stripUndefined(params) };
  const job: typeof schema.videoJobs.$inferInsert = { id: newId("vj"), explanationId, projectId: ex.projectId, kind: opts.kind ?? "video", status: "queued", params: full as unknown as Record<string, unknown>, stages: initialStages(), parentJobId: opts.parentJobId ?? null, createdAt: Date.now() };
  db.insert(schema.videoJobs).values(job).run();
  return getVideoJob(job.id)!;
}

const stripUndefined = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

export function getVideoJob(id: string): VideoJobRow | undefined {
  return getDb().select().from(schema.videoJobs).where(eq(schema.videoJobs.id, id)).get();
}

export function requireVideoJob(id: string): VideoJobRow {
  const j = /^[A-Za-z0-9_-]{4,64}$/.test(id) ? getVideoJob(id) : undefined;
  if (!j) throw new AppError("not_found", "That video job does not exist.", 404);
  return j;
}

/** Cancel: a queued job stops at once; a running job is asked to stop and aborts its subprocesses at the next check. */
export function cancelVideoJob(id: string): VideoJobRow {
  const db = getDb();
  requireVideoJob(id);
  db.transaction((tx) => {
    const n = tx.update(schema.videoJobs).set({ status: "cancelled", finishedAt: Date.now(), error: "Cancelled before it started." }).where(and(eq(schema.videoJobs.id, id), eq(schema.videoJobs.status, "queued"))).run().changes;
    if (!n) tx.update(schema.videoJobs).set({ cancelRequested: true }).where(and(eq(schema.videoJobs.id, id), eq(schema.videoJobs.status, "running"))).run();
  });
  return getVideoJob(id)!;
}

/** Retry a failed or cancelled job in place. Finished stages are reused from their content-addressed outputs. */
export function retryVideoJob(id: string): VideoJobRow {
  const j = requireVideoJob(id);
  if (j.status !== "failed" && j.status !== "cancelled") throw new AppError("not_retryable", `Only a failed or cancelled job can be retried (this one is ${j.status}).`, 409);
  const active = getDb().select().from(schema.videoJobs).where(and(eq(schema.videoJobs.explanationId, j.explanationId), inArray(schema.videoJobs.status, ["queued", "running"]))).get();
  if (active) throw new AppError("job_active", "Another video for this explanation is in progress.", 409);
  const stages = (j.stages.length ? j.stages : initialStages()).map((s) => (s.status === "done" || s.status === "warning" ? s : { ...s, status: "pending" as const, detail: undefined, startedAt: undefined, finishedAt: undefined }));
  getDb().update(schema.videoJobs).set({ status: "queued", error: null, cancelRequested: false, finishedAt: null, stages, attempts: j.attempts + 1, log: [...j.log, `${new Date().toISOString().slice(11, 19)} Retry requested; finished stages will be reused.`] }).where(eq(schema.videoJobs.id, id)).run();
  return getVideoJob(id)!;
}

export function claimNextVideoJob(): VideoJobRow | undefined {
  const db = getDb();
  return db.transaction((tx) => {
    const next = tx.select().from(schema.videoJobs).where(eq(schema.videoJobs.status, "queued")).orderBy(schema.videoJobs.createdAt).limit(1).get();
    if (!next) return undefined;
    const n = tx.update(schema.videoJobs).set({ status: "running", startedAt: Date.now(), heartbeatAt: Date.now() }).where(and(eq(schema.videoJobs.id, next.id), eq(schema.videoJobs.status, "queued"))).run().changes;
    return n ? { ...next, status: "running" } : undefined;
  });
}

/** Jobs whose worker died are re-queued; their finished stages are reused when they run again. */
export function recoverStaleVideoJobs(now = Date.now()): number {
  const db = getDb();
  const stale = db.select().from(schema.videoJobs).where(and(eq(schema.videoJobs.status, "running"), lt(schema.videoJobs.heartbeatAt, now - HEARTBEAT_STALE_MS))).all();
  for (const j of stale) {
    const stages = j.stages.map((s) => (s.status === "running" ? { ...s, status: "pending" as const } : s));
    db.update(schema.videoJobs).set({ status: "queued", stages, currentStage: null, log: [...j.log, "Worker stopped unexpectedly; the job was requeued and will resume from its finished stages."] }).where(eq(schema.videoJobs.id, j.id)).run();
  }
  return stale.length;
}

// ---------------------------------------------------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------------------------------------------------
class Cancelled extends Error { constructor(readonly why: "cancelled" | "timeout") { super(why === "timeout" ? "The job took longer than its time limit." : "Cancelled."); } }

class Tracker {
  stages: JobStage[];
  log: string[];
  artifacts: Record<string, unknown>;
  stageHashes: Record<string, string>;
  metrics: StageMetric[] = [];
  readonly abort = new AbortController();
  private lastCheck = 0;
  private stageStart = 0;
  private cpuStart = process.cpuUsage();
  constructor(readonly job: VideoJobRow, readonly deadline: number) {
    this.stages = job.stages.length ? job.stages : initialStages();
    this.log = job.log ?? [];
    this.artifacts = { ...(job.artifacts ?? {}) };
    this.stageHashes = { ...(job.stageHashes ?? {}) };
  }
  flush(extra: Partial<typeof schema.videoJobs.$inferInsert> = {}) {
    getDb().update(schema.videoJobs).set({ stages: this.stages, log: this.log.slice(-400), artifacts: this.artifacts, stageHashes: this.stageHashes, heartbeatAt: Date.now(), ...extra }).where(eq(schema.videoJobs.id, this.job.id)).run();
  }
  check() {
    const now = Date.now();
    if (now > this.deadline) { this.abort.abort(); throw new Cancelled("timeout"); }
    if (now - this.lastCheck > 300) {
      this.lastCheck = now;
      if (getDb().select({ c: schema.videoJobs.cancelRequested }).from(schema.videoJobs).where(eq(schema.videoJobs.id, this.job.id)).get()?.c) { this.abort.abort(); throw new Cancelled("cancelled"); }
    }
  }
  start(key: string, detail?: string) {
    this.check();
    const s = this.stages.find((x) => x.key === key)!;
    s.status = "running"; s.startedAt = Date.now(); s.finishedAt = undefined; s.detail = detail;
    this.stageStart = Date.now();
    this.cpuStart = process.cpuUsage();
    this.flush({ currentStage: key, progress: { stage: key, fraction: 0, message: detail ?? VIDEO_STAGES.find((x) => x.key === key)?.label } });
  }
  progress(key: string, fraction: number, message: string) {
    this.flush({ progress: { stage: key, fraction: Math.max(0, Math.min(1, fraction)), message } });
  }
  done(key: string, detail: string, reused = false, extra: Partial<StageMetric> = {}) {
    const s = this.stages.find((x) => x.key === key)!;
    s.status = "done"; s.finishedAt = Date.now(); s.detail = detail;
    const cpu = process.cpuUsage(this.cpuStart);
    this.metrics.push({ stage: key, ms: Date.now() - this.stageStart, reused, detail, cpuMs: Math.round((cpu.user + cpu.system) / 1000), ...extra });
    this.flush();
  }
  warn(key: string, detail: string) {
    const s = this.stages.find((x) => x.key === key)!;
    s.status = "warning"; s.finishedAt = Date.now(); s.detail = detail;
    this.flush();
  }
  fail(key: string | null, detail: string) {
    const s = this.stages.find((x) => x.key === key);
    if (s) { s.status = "failed"; s.finishedAt = Date.now(); s.detail = detail; }
    this.flush();
  }
  note(msg: string) {
    this.log.push(`${new Date().toISOString().slice(11, 19)} ${scrubToken(scrubSecrets(msg, [explainerConfig().openaiKey, explainerConfig().elevenlabsKey, explainerConfig().speechifyKey]))}`);
    this.flush();
  }
  artifact(key: string, value: unknown) { this.artifacts[key] = value; this.flush(); }
}

// ---------------------------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------------------------
export async function processVideoJob(jobId: string): Promise<void> {
  const ledger = new UsageLedger();
  return withUsageLedger(ledger, () => runVideoJob(jobId, ledger));
}

interface RunState {
  spec: ExplanationArtifactSpec;
  params: VideoJobParams;
  plan?: NarrationPlan;
  audio?: SectionAudio[];
  provider?: TTSProvider;
  words?: TimedWord[];
  beats?: NarrativeBeat[];
  scenePlan?: VisualScenePlan;
  sceneVideos: string[];
  renderersUsed: Record<string, number>;
  checks: ValidationCheck[];
  ttsChars: number;
  ttsCostUsd: number;
}

async function runVideoJob(jobId: string, ledger: UsageLedger): Promise<void> {
  const db = getDb();
  const job = getVideoJob(jobId);
  if (!job) return;
  const started = db.update(schema.videoJobs).set({ status: "running", startedAt: job.startedAt ?? Date.now(), heartbeatAt: Date.now() }).where(and(eq(schema.videoJobs.id, jobId), inArray(schema.videoJobs.status, ["queued", "running"]))).run().changes;
  if (!started) return;
  const cfg = explainerConfig();
  const t = new Tracker(job, Date.now() + cfg.jobTimeoutMs);
  const beat = setInterval(() => { try { t.flush(); } catch { /* the database may be closing */ } }, 10_000);
  const t0 = Date.now();
  let stage: string | null = null;
  const ex = requireExplanation(job.explanationId);
  const out = runDir(ex.id, job.id);
  fs.mkdirSync(out, { recursive: true });
  const rel = (p: string) => path.relative(path.join(cfg.dir, ex.id), p).split(path.sep).join("/");
  const st: RunState = { spec: specOf(ex), params: job.params as unknown as VideoJobParams, sceneVideos: [], renderersUsed: {}, checks: [], ttsChars: 0, ttsCostUsd: 0 };
  try {
    // 1. Planning: the canonical spec, validated, adjusted to the requested audience. -----------------------------------
    stage = "planning"; t.start(stage);
    const spec = applySpecEdits({ ...st.spec, audience: { ...st.spec.audience, level: st.params.audience } }, st.params);
    const sv = validateSpec(spec);
    if (!sv.ok) throw new AppError("invalid_spec", `The explanation spec is inconsistent: ${sv.issues.filter((i) => i.severity === "error").slice(0, 3).map((i) => `${i.path} ${i.message}`).join("; ")}`, 422);
    st.spec = spec;
    fs.writeFileSync(path.join(out, "spec.json"), JSON.stringify(spec, null, 1));
    t.stageHashes.planning = specHash(spec);
    const router = routeModes(spec, { requestedDepth: st.params.duration });
    t.artifact("spec", rel(path.join(out, "spec.json")));
    t.done(stage, `${spec.claims.filter((c) => c.supported).length} grounded claims, ${spec.concepts.length} concepts, ${spec.sources.length} sources; video value ${router.videoValueScore}`);

    // 2. Scripting: the narration plan. ---------------------------------------------------------------------------------
    stage = "scripting"; t.start(stage);
    const parent = job.parentJobId ? getVideoJob(job.parentJobId) : undefined;
    const previous = parent ? readJson<NarrationPlan>(path.join(runDir(ex.id, parent.id), "plan.json")) : undefined;
    const planKey = sha256(JSON.stringify({ v: PIPELINE_VERSION, spec: t.stageHashes.planning, p: { ...st.params, forceScenes: undefined }, parent: parent?.id ?? null })).slice(0, 20);
    const planFile = path.join(out, "plan.json");
    let reusedPlan = false;
    if (t.stageHashes.scripting === planKey && fs.existsSync(planFile)) { st.plan = readJson<NarrationPlan>(planFile)!; reusedPlan = true; }
    else {
      const sections = st.params.sections?.length ? st.params.sections : undefined;
      if (previous && job.kind !== "video" && !sections) {
        // A settings, narration-edit or re-render job: the parent's narration stands, with the edits applied.
        st.plan = applyPlanEdits({ ...previous, rejected: previous.rejected ?? [] }, st.params);
        t.note(`Narration reused from ${parent!.id}${st.params.edits ? " with your edits" : ""}.`);
      } else {
        const res = await planNarration(spec, { duration: st.params.duration, audience: st.params.audience, style: st.params.style, previous: previous && sections ? previous : undefined, sections: previous && sections ? sections : undefined, instruction: st.params.instruction, lengthFactor: st.params.lengthFactor });
        st.plan = applyPlanEdits(res.plan, st.params);
        if (res.ai.error) t.note(`Narration model unavailable (${res.ai.error.slice(0, 160)}); used the deterministic plan.`);
      }
      for (const r of st.plan.rejected) t.note(`Grounding guard removed a sentence from ${r.sectionId}: "${r.sentence.slice(0, 80)}" (${r.reason})`);
      for (const s of st.plan.sections) s.narration = sanitizeNarration(s.narration);
      fs.writeFileSync(planFile, JSON.stringify(st.plan, null, 1));
      t.stageHashes.scripting = planKey;
    }
    t.artifact("plan", rel(planFile));
    t.done(stage, `${st.plan.sections.length} sections, about ${Math.round(st.plan.estimatedDurationMs / 1000)} s planned (${st.plan.origin}${reusedPlan ? ", reused" : ""})`, reusedPlan);

    // 3. TTS, section by section. ---------------------------------------------------------------------------------------
    stage = "tts"; t.start(stage);
    const project = db.select().from(schema.projects).where(eq(schema.projects.id, ex.projectId)).get() ?? null;
    const privateToken = !!db.select().from(schema.credentials).where(eq(schema.credentials.projectId, ex.projectId)).get();
    const cls = classifyNarration(st.plan.sections.map((s) => s.narration).join(" "), project);
    const privacy = decideExternal(cls.sensitivity, effectiveRouting().privacy, st.params.allowExternal, privateToken);
    const route = await routeTts({ execution: st.params.execution, requested: st.params.ttsProvider, privacy });
    for (const sk of route.skipped) t.note(`Voice ${sk.id} not used: ${sk.why.replace(/\.+$/, "")}.`);
    if (!route.candidates.length) throw new AppError("no_tts", `No voice can narrate this explanation (${route.execution} execution). ${route.skipped.map((s) => `${s.id}: ${s.why}`).join("; ")}`, 503, "Install a local voice (macOS speech is built in on a Mac; set PIPER_MODEL for Piper), or allow a configured cloud voice in the explainer settings.");
    const tts = await synthesizeAll(t, st, ex.id, route.candidates, st.params.voice);
    st.audio = tts.audio; st.provider = tts.provider;
    t.done(stage, `${st.audio.length} sections spoken by ${tts.provider.label}${tts.reused ? ` (${tts.reused} reused)` : ""}; ${(st.audio.reduce((a, x) => a + x.speechMs, 0) / 1000).toFixed(1)} s of speech measured`, tts.reused === st.audio.length, { costUsd: st.ttsCostUsd, detail: `${st.ttsChars} characters` });

    // 4. Aligning: measured duration fit, timings, beats, captions and transcript. -------------------------------------
    stage = "aligning"; t.start(stage);
    for (let pass = 0; pass < 2; pass++) {
      const measured = st.audio.reduce((a, x) => a + x.slotMs, 0);
      const fit = fitPlanLength(st.plan, st.spec, measured);
      if (!fit.changed.length) break;
      t.note(`Measured narration is ${(measured / 1000).toFixed(1)} s, outside the ${st.params.duration} window (${st.plan.target.minMs / 1000}–${st.plan.target.maxMs / 1000} s); revising ${fit.changed.join(", ")}.`);
      st.plan = fit.plan;
      fs.writeFileSync(planFile, JSON.stringify(st.plan, null, 1));
      const again = await synthesizeAll(t, st, ex.id, [tts.provider], st.params.voice);
      st.audio = again.audio;
    }
    finalizeTimeline(st);
    const narrationWav = path.join(out, "narration.wav");
    const narrationMs = concatWavs(st.audio.map((a) => path.join(cfg.dir, ex.id, a.audio)), narrationWav);
    const { beats, warnings } = extractBeats(st.plan.sections, st.audio);
    st.beats = beats;
    for (const w of warnings) t.note(`Beat ${w.sectionId}: ${w.detail}${w.cue ? ` ("${w.cue.slice(0, 40)}")` : ""}`);
    const words = st.audio.flatMap((a) => a.words);
    st.words = words;
    const sectionRefs = new Map(st.plan.sections.map((s) => [s.id, { sourceRefs: s.sourceRefs, claimIds: s.claimIds }]));
    const cues = buildCues(words);
    const transcript = buildTranscript(words, sectionRefs);
    const vtt = toVtt(cues);
    write(out, "captions.vtt", vtt);
    write(out, "captions.srt", toSrt(cues));
    write(out, "chapters.vtt", chaptersVtt(st.plan.sections.map((s) => { const a = st.audio!.find((x) => x.sectionId === s.id)!; return { title: s.role === "hook" ? "Opening" : s.title, startMs: a.startMs, endMs: a.startMs + a.slotMs }; })));
    write(out, "transcript.json", JSON.stringify({ entries: transcript, sections: st.plan.sections.map((s) => ({ id: s.id, title: s.title, role: s.role })) }, null, 1));
    write(out, "word-timings.json", JSON.stringify(words));
    write(out, "beats.json", JSON.stringify(beats, null, 1));
    write(out, "sections.json", JSON.stringify(st.audio, null, 1));
    for (const [k, f] of Object.entries({ audio: "narration.wav", captionsVtt: "captions.vtt", captionsSrt: "captions.srt", chapters: "chapters.vtt", transcript: "transcript.json", wordTimings: "word-timings.json", beats: "beats.json" })) t.artifacts[k] = rel(path.join(out, f));
    t.artifact("durationMs", Math.round(narrationMs));
    t.stageHashes.aligning = sha256(JSON.stringify(st.audio.map((a) => a.hash))).slice(0, 20);
    st.checks.push(...validateTimeline(words, beats, cues, st.audio, narrationMs));
    t.done(stage, `${(narrationMs / 1000).toFixed(1)} s narration; ${words.length} words timed (${st.audio[0]?.timing.source}, ${st.audio.some((a) => a.timing.granularity === "sentence") ? "sentence" : "word"} level), ${beats.length} beats, ${cues.length} captions`);

    // 5. Storyboarding: the visual scene plan, validated before anything is rendered. ---------------------------------
    stage = "storyboarding"; t.start(stage);
    const renderers = (await Promise.all(allRenderers().map(async (r) => ((await r.unavailableReason()) ? null : r.id)))).filter((x): x is RendererId => !!x);
    if (!renderers.length) throw new AppError("no_renderer", "No renderer is available.", 503, "Install @resvg/resvg-js (npm install) or Manim (scripts/setup-explainer.sh).");
    if (st.params.renderer === "manim" && !renderers.includes("manim")) t.note(`Manim was requested but is unavailable (${await getRenderer("manim")?.unavailableReason()}); scenes use the HTML renderer.`);
    let sp = planScenes({ spec: st.spec, plan: st.plan, audio: st.audio, beats, style: st.params.style, renderer: st.params.renderer, available: renderers });
    if (st.params.motion === "reduced") sp = { ...sp, plan: reduceMotion(sp.plan) };
    for (const w of sp.warnings) t.note(w);
    let layout = validateLayout(sp.plan);
    if (layout.some((c) => c.status === "fail")) {
      // Repair: fall back to the plain statement layout for the scenes that failed, then check again.
      const bad = new Set(layout.filter((c) => c.status === "fail").flatMap((c) => c.detail.match(/scene-[\w.-]+/g) ?? []));
      t.note(`Layout check failed (${layout.filter((c) => c.status === "fail").map((c) => `${c.label}: ${c.detail}`).join(" | ").slice(0, 300)}); simplifying ${[...bad].join(", ") || "the plan"}.`);
      const plan2: NarrationPlan = { ...st.plan, sections: st.plan.sections.map((s) => (bad.has(`scene-${s.id}`) ? { ...s, visualIntent: { ...s.visualIntent, layout: "statement" } } : s)) };
      sp = planScenes({ spec: st.spec, plan: plan2, audio: st.audio, beats, style: st.params.style, renderer: st.params.renderer, available: renderers });
      if (st.params.motion === "reduced") sp = { ...sp, plan: reduceMotion(sp.plan) };
      layout = validateLayout(sp.plan);
    }
    st.checks.push(...layout);
    st.scenePlan = sp.plan;
    write(out, "scene-plan.json", JSON.stringify(sp.plan));
    // Storyboard: one still per scene, drawn by the same frame function the player and the HTML renderer use.
    const html = new HtmlRenderer();
    const boards: string[] = [];
    fs.mkdirSync(path.join(out, "storyboard"), { recursive: true });
    for (const s of sp.plan.scenes) {
      t.check();
      const local = Math.min(s.endMs - s.startMs - 1, Math.max(0, (s.actions.filter((a) => a.kind === "appear").pop()?.startMs ?? 0) + 900));
      const f = path.join(out, "storyboard", `${s.id}.png`);
      fs.writeFileSync(f, (await html.rasterize(s, local, { style: st.params.style, width: 640, height: 360 })).png());
      boards.push(rel(f));
    }
    t.artifacts.storyboard = boards;
    t.artifact("scenePlan", rel(path.join(out, "scene-plan.json")));
    t.stageHashes.storyboarding = sha256(JSON.stringify(sp.plan.scenes.map((s) => s.hash))).slice(0, 20);
    const layoutFail = layout.filter((c) => c.status === "fail");
    if (layoutFail.length) throw new AppError("layout_invalid", `The scene layout is not legible: ${layoutFail.map((c) => `${c.label} (${c.detail})`).join("; ").slice(0, 400)}`, 422);
    t.done(stage, `${sp.plan.scenes.length} scenes (${Object.entries(countBy(sp.plan.scenes.map((s) => s.renderer))).map(([k, v]) => `${v} ${k}`).join(", ")}), ${sp.plan.frames} frames; layout checks passed`);

    // 6. Rendering, scene by scene, reusing any scene whose exact content and timing were rendered before. ------------
    stage = "rendering"; t.start(stage);
    const render = await renderScenes(t, st, ex.id, sp.plan, st.params.forceScenes ?? []);
    t.done(stage, `${sp.plan.scenes.length} scenes: ${render.rendered} rendered, ${render.reused} reused${render.fallbacks ? `, ${render.fallbacks} fell back to HTML` : ""}`, render.rendered === 0, { detail: render.detail });

    // 7. Muxing. ----------------------------------------------------------------------------------------------------------
    stage = "muxing"; t.start(stage);
    const video = await assemble(t, st, out, narrationWav);
    t.artifacts.video = rel(video.file);
    t.artifacts.thumbnail = rel(video.thumbnail);
    t.done(stage, `MP4 ${(fs.statSync(/*turbopackIgnore: true*/ video.file).size / 1048576).toFixed(1)} MB, ${(sp.plan.durationMs / 1000).toFixed(1)} s`, false, { detail: `ffmpeg ${video.ms} ms` });

    // 8. Validating, with one automatic repair of scenes that came out empty. ------------------------------------------
    stage = "validating"; t.start(stage);
    let media = await validateMedia({ video: video.file, audio: narrationWav, plan: sp.plan, narrationMs, vtt, signal: t.abort.signal });
    const empty = media.find((c) => c.id === "video.nonempty" && c.status === "fail");
    if (empty) {
      const ids = sp.plan.scenes.filter((s) => empty.detail.includes(s.id)).map((s) => s.id);
      t.note(`Validation found empty frames in ${ids.join(", ")}; re-rendering them with the HTML renderer.`);
      await renderScenes(t, st, ex.id, { ...sp.plan, scenes: sp.plan.scenes.map((s) => (ids.includes(s.id) ? { ...s, renderer: "html" as const } : s)) }, ids);
      const again = await assemble(t, st, out, narrationWav);
      media = await validateMedia({ video: again.file, audio: narrationWav, plan: sp.plan, narrationMs, vtt, signal: t.abort.signal });
    }
    st.checks.push(...media, ...validateProvenance(st.spec, beats, transcript, sp.plan));
    const rep = report(st.checks);
    const failed = rep.checks.filter((c) => c.status === "fail");
    if (rep.ok) t.done(stage, `${rep.checks.filter((c) => c.status === "pass").length} checks passed${rep.checks.some((c) => c.status === "warn") ? `, ${rep.checks.filter((c) => c.status === "warn").length} warnings` : ""}`);
    else t.fail(stage, failed.map((c) => `${c.label}: ${c.detail}`).join("; ").slice(0, 400));
    const manifest = buildManifest(t, st, ex.id, job, out, rel, Date.now() - t0, ledger, rep);
    write(out, "manifest.json", JSON.stringify(manifest, null, 1));
    t.artifact("manifest", rel(path.join(out, "manifest.json")));
    if (!rep.ok) {
      db.update(schema.videoJobs).set({ status: "failed", error: `The video did not pass validation: ${failed.map((c) => c.label).join(", ")}. The transcript, audio and interactive explainer are still available.`, finishedAt: Date.now(), currentStage: null, validation: rep as unknown as Record<string, unknown>, manifest: manifest as unknown as Record<string, unknown>, summary: summaryOf(t, ledger, st) }).where(eq(schema.videoJobs.id, jobId)).run();
      return;
    }
    db.update(schema.videoJobs).set({ status: "ready", finishedAt: Date.now(), currentStage: null, progress: null, validation: rep as unknown as Record<string, unknown>, manifest: manifest as unknown as Record<string, unknown>, summary: summaryOf(t, ledger, st) }).where(eq(schema.videoJobs.id, jobId)).run();
  } catch (e) {
    const cancelled = e instanceof Cancelled;
    const message = cancelled ? e.message : e instanceof AppError ? `${e.message}${e.hint ? ` ${e.hint}` : ""}` : `Unexpected error while ${VIDEO_STAGES.find((s) => s.key === stage)?.label.toLowerCase() ?? "starting"}: ${(e as Error)?.message ?? String(e)}`;
    const clean = scrubToken(scrubSecrets(message, [cfg.openaiKey, cfg.elevenlabsKey, cfg.speechifyKey]));
    t.fail(stage, clean.slice(0, 400));
    t.abort.abort();
    const partial = Object.keys(t.artifacts).length > 0;
    db.update(schema.videoJobs).set({ status: cancelled && (e as Cancelled).why === "cancelled" ? "cancelled" : "failed", error: `${clean}${partial && !cancelled ? " Everything produced before this stage is still available." : ""}`, finishedAt: Date.now(), currentStage: null, progress: null, summary: summaryOf(t, ledger, st) }).where(eq(schema.videoJobs.id, jobId)).run();
    if (!cancelled && !(e instanceof AppError)) console.error(`[brody] explainer job ${jobId} failed:`, clean);
  } finally {
    clearInterval(beat);
  }
}

const write = (dir: string, name: string, content: string) => fs.writeFileSync(path.join(dir, name), content);
function readJson<T>(file: string): T | undefined { try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return undefined; } }
const countBy = (xs: string[]) => xs.reduce<Record<string, number>>((a, x) => ({ ...a, [x]: (a[x] ?? 0) + 1 }), {});

// ---------------------------------------------------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------------------------------------------------
function applySpecEdits(spec: ExplanationArtifactSpec, params: VideoJobParams): ExplanationArtifactSpec {
  const add = params.edits?.addClaims;
  const layouts = params.edits?.layouts;
  if (!add && !layouts) return spec;
  const supported = new Set(spec.claims.filter((c) => c.supported).map((c) => c.id));
  return {
    ...spec,
    narrative: {
      ...spec.narrative,
      sections: spec.narrative.sections.map((s) => ({
        ...s,
        claimIds: [...new Set([...s.claimIds, ...(add?.[s.id] ?? []).filter((id) => supported.has(id))])],
        visual: layouts?.[s.id] ?? s.visual,
      })),
    },
  };
}

function applyPlanEdits(plan: NarrationPlan, params: VideoJobParams): NarrationPlan {
  const e = params.edits;
  if (!e) return plan;
  let sections = plan.sections.filter((s) => !(e.drop ?? []).includes(s.id));
  sections = sections.map((s) => ({
    ...s,
    ...(e.narration?.[s.id] !== undefined ? { narration: e.narration[s.id], userEdited: true } : {}),
    ...(e.holdMs?.[s.id] !== undefined ? { holdMs: Math.max(0, Math.min(10_000, e.holdMs[s.id])) } : {}),
    ...(e.layouts?.[s.specSectionId] ? { visualIntent: { ...s.visualIntent, layout: e.layouts[s.specSectionId] } } : {}),
  }));
  return { ...plan, sections, hook: sections.find((s) => s.role === "hook")?.narration ?? "" };
}

function reduceMotion(plan: VisualScenePlan): VisualScenePlan {
  return { ...plan, scenes: plan.scenes.map((s) => ({ ...s, actions: s.actions.filter((a) => a.kind !== "flow" && a.kind !== "camera") })) };
}

// ---------------------------------------------------------------------------------------------------------------------
// TTS
// ---------------------------------------------------------------------------------------------------------------------
interface CachedSection { speechMs: number; slotMs: number; frames: number; words: TimedWord[]; timing: SectionAudio["timing"]; provider: string; voice: string }

async function synthesizeAll(t: Tracker, st: RunState, explanationId: string, candidates: TTSProvider[], voice?: string): Promise<{ audio: SectionAudio[]; provider: TTSProvider; reused: number }> {
  const cfg = explainerConfig();
  let lastError = "";
  for (const provider of candidates) {
    try {
      const audio: SectionAudio[] = [];
      let reused = 0;
      for (const [i, sec] of st.plan!.sections.entries()) {
        t.check();
        const tokens = tokenize(sec.narration);
        const spoken = spokenText(tokens);
        const v = voice || provider.defaultVoice;
        const pause = sec.holdMs !== undefined ? cfg.sectionPauseMs + sec.holdMs : cfg.sectionPauseMs;
        const key = sha256(JSON.stringify({ v: TTS_CACHE_VERSION, spoken, display: tokens.map((x) => x.display), provider: provider.id, voice: v, pause, fps: CANVAS.fps })).slice(0, 32);
        const dir = stageDir(explanationId, "tts", key);
        const metaFile = path.join(dir, "section.json");
        let meta = readJson<CachedSection>(metaFile);
        if (meta && fs.existsSync(path.join(dir, "slot.wav"))) reused++;
        else {
          t.progress("tts", i / st.plan!.sections.length, `Speaking section ${i + 1} of ${st.plan!.sections.length}`);
          fs.mkdirSync(dir, { recursive: true });
          let res;
          for (let attempt = 1; ; attempt++) {
            try { res = await provider.synthesize({ text: spoken, voice: v, workDir: dir, signal: t.abort.signal }); break; }
            catch (e) {
              const retryable = (e as { retryable?: boolean }).retryable;
              if (attempt >= 2 || !retryable) throw e;
              t.note(`${provider.label} failed on section ${sec.id} (${(e as Error).message.slice(0, 120)}); retrying.`);
            }
          }
          const pcm = readWavFile(res.audioPath);
          const slot = padToFrameSlot(pcm, pause, CANVAS.fps);
          fs.writeFileSync(path.join(dir, "slot.wav"), encodeWav(slot.data));
          const norm = normalizeTiming(tokens, res.words, { sectionId: sec.id, offsetMs: 0, durationMs: slot.speechMs });
          meta = { speechMs: slot.speechMs, slotMs: slot.slotMs, frames: slot.frames, words: norm.words, timing: { ...res.timing, interpolated: norm.interpolated }, provider: provider.id, voice: v };
          fs.writeFileSync(metaFile, JSON.stringify(meta));
          if (res.audioPath !== path.join(dir, "slot.wav")) fs.rmSync(res.audioPath, { force: true });
          st.ttsChars += spoken.length;
          st.ttsCostUsd += ((provider.usdPerMillionChars ?? 0) * spoken.length) / 1e6;
        }
        audio.push({ sectionId: sec.id, audio: path.relative(path.join(cfg.dir, explanationId), path.join(dir, "slot.wav")).split(path.sep).join("/"), speechMs: meta.speechMs, slotMs: meta.slotMs, frames: meta.frames, startMs: 0, words: meta.words.map((w) => ({ ...w, sectionId: sec.id })), timing: meta.timing, provider: meta.provider, voice: meta.voice, hash: key });
      }
      if (provider !== candidates[0]) t.note(`Used ${provider.label} after the preferred voice failed.`);
      return { audio, provider, reused };
    } catch (e) {
      if (e instanceof Cancelled) throw e;
      lastError = scrubSecrets((e as Error).message ?? String(e));
      t.note(`${provider.label} could not narrate: ${lastError.slice(0, 200)}`);
    }
  }
  throw new AppError("tts_failed", `Every available voice failed. Last error: ${lastError.slice(0, 300)}`, 502, "Check the voice settings, or switch to a local voice.");
}

/** Lay the sections end to end: absolute start times for sections and words. */
function finalizeTimeline(st: RunState) {
  let at = 0;
  for (const a of st.audio!) {
    const offset = at;
    a.startMs = offset;
    // Section words are stored relative to the section; shift them once onto the video's timeline.
    a.words = a.words.map((w) => ({ ...w, startMs: w.startMs + offset, endMs: w.endMs + offset }));
    at += a.slotMs;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------------------------------
function rendererVersion(id: RendererId): string {
  if (id === "manim") return `manim-${MANIM_SCRIPT_VERSION}-${(getRenderer("manim") as ManimRenderer | undefined)?.version?.() ?? "?"}`;
  return `html-${SCENE_PLANNER_VERSION}`;
}

async function renderScenes(t: Tracker, st: RunState, explanationId: string, plan: VisualScenePlan, force: string[]): Promise<{ rendered: number; reused: number; fallbacks: number; detail: string }> {
  const cfg = explainerConfig();
  const size = { width: plan.canvas.width, height: plan.canvas.height };
  let rendered = 0, reused = 0, fallbacks = 0, done = 0;
  const times: string[] = [];
  const results = await mapLimit(plan.scenes, cfg.renderConcurrency, async (s: SceneSpec) => {
    t.check();
    const key = sha256(JSON.stringify({ h: s.hash, r: s.renderer, rv: rendererVersion(s.renderer), size, nonce: force.includes(s.id) || force.includes("*") ? Date.now() : 0 })).slice(0, 32);
    const dir = stageDir(explanationId, "render", key);
    const final = path.join(dir, "scene.mp4");
    // Reuse only an exact match: same objects, same actions, same frame count, same renderer. Timing is in the hash,
    // so a cached render can never drift against new narration.
    if (fs.existsSync(final) && (await probe(final).catch(() => null))?.video?.frames === s.frameCount) {
      reused++;
      st.renderersUsed[s.renderer] = (st.renderersUsed[s.renderer] ?? 0) + 1;
      t.progress("rendering", ++done / plan.scenes.length, `Scene ${done} of ${plan.scenes.length} reused`);
      return final;
    }
    fs.mkdirSync(dir, { recursive: true });
    const order: RendererId[] = s.renderer === "manim" ? ["manim", "html"] : ["html"];
    let lastErr = "";
    for (const id of order) {
      const r = getRenderer(id);
      if (!r || (await r.unavailableReason())) continue;
      try {
        const res = await r.renderScene({ ...s, renderer: id }, { workDir: path.join(dir, id), style: st.params.style, fps: plan.canvas.fps, ...size, signal: t.abort.signal });
        await conformScene(res.video, final, s.frameCount, plan.canvas.fps, size, { signal: t.abort.signal });
        if (res.log) t.note(`${s.id}: ${res.log}`);
        rendered++;
        if (id !== s.renderer) { fallbacks++; t.note(`${s.id}: ${s.renderer} failed (${lastErr.slice(0, 160)}); rendered with ${id} instead.`); }
        st.renderersUsed[id] = (st.renderersUsed[id] ?? 0) + 1;
        times.push(`${s.id} ${id} ${res.ms} ms`);
        t.progress("rendering", ++done / plan.scenes.length, `Rendered scene ${done} of ${plan.scenes.length}`);
        return final;
      } catch (e) {
        if (t.abort.signal.aborted) throw new Cancelled("cancelled");
        lastErr = (e as Error).message;
      }
    }
    throw new AppError("render_failed", `Scene ${s.id} could not be rendered: ${lastErr.slice(0, 300)}`, 500);
  });
  st.sceneVideos = results;
  return { rendered, reused, fallbacks, detail: times.join(", ") };
}

async function assemble(t: Tracker, st: RunState, out: string, narrationWav: string): Promise<{ file: string; thumbnail: string; ms: number }> {
  const t0 = Date.now();
  t.check();
  const silent = path.join(out, "video-silent.mp4");
  await concatScenes(st.sceneVideos, silent, { signal: t.abort.signal });
  const file = path.join(out, "video.mp4");
  await mux(silent, narrationWav, file, { signal: t.abort.signal });
  fs.rmSync(silent, { force: true });
  const plan = st.scenePlan!;
  const pick = plan.scenes.find((s) => s.layout === "architecture" || s.layout === "contention") ?? plan.scenes[Math.min(1, plan.scenes.length - 1)];
  const thumbnail = path.join(out, "thumbnail.png");
  await extractFrame(file, Math.round(pick.endMs - 300), thumbnail, 640, { signal: t.abort.signal }).catch((e) => t.note(`Thumbnail failed: ${lastLines(String(e))}`));
  return { file, thumbnail, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------------------------------------------------------------
// Manifest and metrics
// ---------------------------------------------------------------------------------------------------------------------
function summaryOf(t: Tracker, ledger: UsageLedger, st: RunState): Record<string, unknown> {
  const usage = ledger.snapshot();
  return { metrics: t.metrics, aiUsage: usage, tts: { chars: st.ttsChars, costUsd: +st.ttsCostUsd.toFixed(4) }, renderers: st.renderersUsed };
}

function buildManifest(t: Tracker, st: RunState, explanationId: string, job: VideoJobRow, out: string, rel: (p: string) => string, totalMs: number, ledger: UsageLedger, validation: ReturnType<typeof report>): ArtifactManifest {
  const usage = ledger.snapshot();
  const plan = st.scenePlan!;
  const sources = [...new Set(st.beats!.flatMap((b) => b.sourceRefs))];
  const timingSources = [...new Set(st.audio!.map((a) => a.timing.source))];
  const aiCost = usage.costUsd;
  return {
    runId: job.id,
    explanationId,
    projectId: job.projectId,
    sourceRunId: st.spec.sourceRunId,
    createdAt: Date.now(),
    explanationSpec: rel(path.join(out, "spec.json")),
    narrationScript: rel(path.join(out, "plan.json")),
    audio: rel(path.join(out, "narration.wav")),
    sectionAudio: st.audio!.map((a) => a.audio),
    wordTimings: rel(path.join(out, "word-timings.json")),
    beats: rel(path.join(out, "beats.json")),
    scenePlan: rel(path.join(out, "scene-plan.json")),
    rendererSources: st.sceneVideos.flatMap((v) => { const d = path.dirname(v); return ["manim/brody_scene.py", "manim/scene-model.json", "html/scene.json"].map((f) => path.join(/*turbopackIgnore: true*/ d, f)).filter((f) => fs.existsSync(/*turbopackIgnore: true*/ f)).map(rel); }),
    sceneVideos: st.sceneVideos.map(rel),
    captions: { vtt: rel(path.join(out, "captions.vtt")), srt: rel(path.join(out, "captions.srt")), transcript: rel(path.join(out, "transcript.json")) },
    video: rel(path.join(out, "video.mp4")),
    thumbnail: fs.existsSync(path.join(out, "thumbnail.png")) ? rel(path.join(out, "thumbnail.png")) : null,
    storyboard: (t.artifacts.storyboard as string[]) ?? [],
    durationMs: plan.durationMs,
    renderer: Object.keys(st.renderersUsed).length > 1 ? "mixed" : Object.keys(st.renderersUsed)[0] ?? "none",
    renderers: st.renderersUsed,
    ttsProvider: st.provider?.id ?? "none",
    voice: st.audio![0]?.voice ?? "",
    timing: { source: timingSources.length > 1 ? "mixed" : timingSources[0], granularity: st.audio!.some((a) => a.timing.granularity === "sentence") ? "sentence" : "word" },
    modelVersions: Object.fromEntries([...usage.models.map((m) => [`ai:${m.provider}`, m.model]), ["pipeline", String(PIPELINE_VERSION)], ["scenePlanner", String(SCENE_PLANNER_VERSION)], ["manimScript", String(MANIM_SCRIPT_VERSION)], ...((getRenderer("manim") as ManimRenderer | undefined)?.version?.() ? [["manim", (getRenderer("manim") as ManimRenderer).version()!]] : [])]),
    sourceRefs: sources,
    stageHashes: t.stageHashes,
    validation,
    metrics: {
      stages: t.metrics,
      totalMs,
      artifactBytes: dirBytes(out),
      retries: job.attempts,
      costUsd: aiCost === null && st.ttsCostUsd === 0 ? (usage.calls ? null : 0) : +((aiCost ?? 0) + st.ttsCostUsd).toFixed(4),
      cpuMs: t.metrics.reduce((a, m) => a + (m.cpuMs ?? 0), 0),
      tokens: { input: usage.inputTokens, output: usage.outputTokens },
    },
  };
}
