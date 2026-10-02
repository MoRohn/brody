/**
 * End-to-end acceptance: "Explain why Kubernetes GPU scheduling can cause under-utilization when several AI services
 * share a DGX machine."
 *
 * Brody answers from the fixture repository, the answer compiles into the Explanation IR, the router recommends video,
 * narration is spoken (real audio, measured word timing), beats land on the measured timings, scenes are planned,
 * rendered, muxed and validated, captions and transcript carry sources, and "Redo just the final section and show how
 * dynamic GPU scheduling fixes this" regenerates only that section.
 *
 * The AI provider is a scripted double that answers like a model would, including two deliberately ungrounded facts that
 * the grounding guards must remove. The voice is the deterministic synthetic voice so the test runs on any machine;
 * tests/explainer-local.test.ts repeats the core path with the macOS voice and Manim where they exist.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyze, fixtureFiles, freshDb, MockProvider, setAIProvider } from "./helpers";
import { askRepository } from "@/lib/ask";
import { createExplanation, getExplanationView, getJobView, refineExplanation, requestVideo } from "@/lib/explainer";
import { validateSpec } from "@/lib/explainer/spec";
import { setRenderers, HtmlRenderer } from "@/lib/explainer/render";
import { setTtsProviders, SyntheticProvider } from "@/lib/explainer/tts";
import { probe } from "@/lib/explainer/media";
import { parseVtt } from "@/lib/explainer/captions";
import { explainerConfig } from "@/lib/explainer/config";
import type { ArtifactManifest, NarrationPlan, NarrativeBeat, VisualScenePlan } from "@/lib/explainer/types";
import { drainVideoQueue } from "@/lib/jobs/worker";
import type { AnalysisRequest } from "@/lib/ai";

const QUESTION = "Explain why Kubernetes GPU scheduling can cause under-utilization when several AI services share a DGX machine.";
const FIXTURE = "fixtures/dgx-ai-platform";

function lineOf(file: string, needle: string): number {
  const lines = fs.readFileSync(path.join(FIXTURE, file), "utf8").split("\n");
  const i = lines.findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`${needle} not in ${file}`);
  return i + 1;
}

const ANSWER = [
  "Kubernetes treats a GPU as a whole, indivisible unit.",
  "The DGX node dgx-01 advertises 8 GPUs, and each of the eight inference services requests nvidia.com/gpu: 1, so the scheduler gives every service an entire A100.",
  "The NVIDIA device plugin has sharing disabled, so one pod holds one whole GPU.",
  "Each inference service uses about 12% of its GPU, so most of every GPU sits idle while all 8 GPUs are allocated.",
  "The fine-tuning job needs 2 GPUs and stays Pending with Insufficient nvidia.com/gpu, even though most capacity is idle.",
  "ADR-0007 proposes dynamic GPU scheduling: time-slicing advertises each GPU as 4 replicas, and the GPU packer places services by measured utilisation, two services per GPU at most.",
  "The 8 inference services then fit on 4 GPUs, which frees 4 GPUs for training.",
].join(" ");

function claimIds(prompt: string): { id: string; text: string }[] {
  return [...prompt.matchAll(/^(c\d+) \[[^\]]*\] (.*)$/gm)].map((m) => ({ id: m[1], text: m[2] }));
}
const find = (cs: { id: string; text: string }[], re: RegExp) => cs.filter((c) => re.test(c.text)).map((c) => c.id);

/** A scripted model: grounded answers and structure, plus two planted ungrounded facts. */
function script(req: AnalysisRequest<unknown>): unknown {
  if (req.task === "ask") {
    return {
      answer: ANSWER, insufficientEvidence: false, confidence: "high",
      citations: [
        { path: "cluster/dgx-01-node.yaml", startLine: lineOf("cluster/dgx-01-node.yaml", 'nvidia.com/gpu: "8"'), endLine: lineOf("cluster/dgx-01-node.yaml", 'nvidia.com/gpu: "8"'), note: "the node advertises 8 GPUs" },
        { path: "deploy/inference-services.yaml", startLine: 1, endLine: 3, note: "each service requests one whole GPU" },
        { path: "deploy/nvidia-device-plugin.yaml", startLine: 1, endLine: 2, note: "sharing is disabled" },
        { path: "docs/gpu-utilization.md", startLine: lineOf("docs/gpu-utilization.md", "about 12%"), endLine: lineOf("docs/gpu-utilization.md", "about 12%") + 1, note: "about 12% utilisation" },
        { path: "docs/gpu-utilization.md", startLine: lineOf("docs/gpu-utilization.md", "Pending for 3 days"), endLine: lineOf("docs/gpu-utilization.md", "Pending for 3 days") + 2, note: "training job Pending" },
        { path: "docs/adr/0007-dynamic-gpu-scheduling.md", startLine: lineOf("docs/adr/0007-dynamic-gpu-scheduling.md", "## Decision"), endLine: lineOf("docs/adr/0007-dynamic-gpu-scheduling.md", "fit on 4 GPUs"), note: "dynamic GPU scheduling proposal" },
      ],
    };
  }
  if (req.task === "explainer-structure" || req.task === "explainer-structure:story") {
    const cs = claimIds(req.prompt);
    const whole = find(cs, /whole|indivisible|entire A100|one pod holds/i);
    const eight = find(cs, /8 GPUs/);
    const twelve = find(cs, /12%/);
    const pending = find(cs, /Pending|needs 2 GPUs/);
    const fix = find(cs, /time-slicing|packer|fit on 4|frees 4/i);
    const full = {
      title: "Why whole-GPU scheduling leaves a shared DGX idle",
      summary: "Kubernetes gives every inference service a whole GPU, so a DGX with 8 GPUs looks full while each GPU is mostly idle.",
      objectives: ["See why whole-GPU requests waste capacity", "See how sharing GPUs frees capacity for training"],
      claims: [
        { id: "a1", text: "Each inference service holds a whole GPU but uses about 12% of it.", basedOn: [...whole.slice(0, 1), ...twelve], confidence: "high" },
        { id: "a2", text: "Utilisation rises to 95% after the change.", basedOn: fix.slice(0, 1), confidence: "medium" },
      ],
      concepts: [
        { id: "k1", name: "DGX machine", definition: "The DGX node dgx-01 advertises 8 GPUs.", kind: "component", glyph: "machine", parentId: "", count: 0, claimIds: eight },
        { id: "k2", name: "GPU", definition: "", kind: "resource", glyph: "gpu", parentId: "k1", count: 8, claimIds: eight },
        { id: "k3", name: "Kubernetes scheduler", definition: "", kind: "component", glyph: "scheduler", parentId: "", count: 0, claimIds: whole },
        { id: "k4", name: "Inference service pod", definition: "", kind: "component", glyph: "pod", parentId: "", count: 8, claimIds: eight },
        { id: "k5", name: "Fine-tuning job", definition: "", kind: "component", glyph: "pod", parentId: "", count: 0, claimIds: pending },
      ],
      relationships: [
        { from: "k4", to: "k2", label: "requests 1 GPU", kind: "requests", claimIds: eight },
        { from: "k3", to: "k2", label: "allocates", kind: "allocates", claimIds: whole },
        { from: "k5", to: "k3", label: "waits on", kind: "blocks", claimIds: pending },
      ],
      processes: [],
      metrics: [{ label: "of each GPU used", value: 12, unit: "%", display: "12%", claimIds: twelve }],
      comparisons: [{ title: "Whole GPUs versus shared GPUs", beforeLabel: "Today", before: ["Each inference service holds a whole GPU"], afterLabel: "Dynamic scheduling", after: ["The 8 inference services fit on 4 GPUs"], claimIds: [...whole.slice(0, 1), ...fix] }],
      examples: [],
      uncertainties: [],
      sections: [
        { title: "The setup", objective: "Name the parts: the DGX, its GPUs, the pods and the scheduler.", claimIds: [...whole.slice(0, 1), ...eight.slice(0, 1)], conceptIds: ["k1", "k2", "k3", "k4"], visual: "architecture" },
        { title: "Where capacity goes idle", objective: "Show the idle capacity and the blocked job.", claimIds: [...twelve, ...pending], conceptIds: ["k2", "k4", "k5"], visual: "contention" },
        { title: "Sharing GPUs", objective: "Show what dynamic scheduling changes.", claimIds: fix, conceptIds: ["k2", "k4", "k5"], visual: "contention" },
      ],
      hook: "Why does a DGX with 8 GPUs look full while most of each GPU sits idle?",
      conclusion: "The 8 inference services then fit on 4 GPUs, which frees 4 GPUs for training.",
    };
    // The provider is asked for the parts first, then the story; each response holds only its own fields.
    const keys = req.task === "explainer-structure" ? ["claims", "concepts", "relationships", "metrics", "uncertainties"] : ["title", "summary", "objectives", "sections", "comparisons", "processes", "examples", "hook", "conclusion"];
    return Object.fromEntries(Object.entries(full).filter(([k]) => keys.includes(k)));
  }
  if (req.task === "explainer-narration") {
    const ids = [...req.prompt.matchAll(/^- (\w+) \((hook|body|conclusion)/gm)].map((m) => ({ id: m[1], role: m[2] }));
    const text: Record<string, string> = {
      hook: "Why does a DGX with 8 GPUs look full while most of each GPU sits idle?",
      n1: "Kubernetes treats a GPU as a whole, indivisible unit. The DGX node advertises 8 GPUs. Each inference service requests nvidia.com/gpu: 1, so the scheduler gives every service an entire A100.",
      n2: "Each inference service uses about 12% of its GPU. Most of every GPU sits idle. Each GPU costs 30,000 dollars. The fine-tuning job needs 2 GPUs and stays Pending.",
      n3: /dynamic GPU scheduling fixes this/i.test(req.prompt)
        ? "Dynamic GPU scheduling fixes this. Time-slicing advertises each GPU as 4 replicas, so several pods share one GPU. The GPU packer places services by measured utilisation. The 8 inference services fit on 4 GPUs, and 4 GPUs come free for training."
        : "ADR-0007 proposes dynamic GPU scheduling. Time-slicing lets several pods share one GPU. The 8 inference services then fit on 4 GPUs.",
      outro: "Whole GPUs leave capacity idle. Sharing them frees 4 GPUs for training.",
    };
    return { sections: ids.map((s) => ({ id: s.id, narration: text[s.id] ?? "Kubernetes treats a GPU as a whole unit.", beats: [] })) };
  }
  return undefined;
}

describe("explainer acceptance: GPU scheduling on a shared DGX", () => {
  let projectId = "";
  let questionId = "";
  const synthetic = new SyntheticProvider();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brody-explainer-acc-"));

  beforeAll(async () => {
    process.env.EXPLAINER_DIR = dir;
    freshDb();
    setTtsProviders([synthetic]);
    setRenderers([new HtmlRenderer()]);
    const r = await analyze(fixtureFiles(FIXTURE), "dgx-ai-platform");
    expect(r.job.status).toBe("succeeded");
    projectId = r.projectId;
    setAIProvider(new MockProvider(script));
  }, 180_000);

  afterAll(() => {
    setTtsProviders(undefined);
    setRenderers(undefined);
    setAIProvider(null);
    delete process.env.EXPLAINER_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("answers normally, then compiles the answer into a grounded Explanation IR and recommends video", async () => {
    const answer = await askRepository(projectId, QUESTION);
    expect(answer.mode).toBe("ai");
    expect(answer.citations.length).toBeGreaterThanOrEqual(5);
    const { getDb, schema } = await import("@/lib/db/client");
    questionId = getDb().select().from(schema.questions).all().find((q) => q.question === QUESTION)!.id;

    const { explanation, created } = await createExplanation({ projectId, source: { kind: "question", id: questionId } });
    expect(created).toBe(true);
    const spec = explanation.spec;
    expect(validateSpec(spec).ok).toBe(true);
    // The planted "95%" claim is kept for transparency but marked unsupported, so it can never be narrated or drawn.
    const planted = spec.claims.find((c) => c.text.includes("95%"));
    expect(planted?.supported).toBe(false);
    expect((explanation.compile as { dropped: string[] }).dropped.some((d) => d.includes("95%"))).toBe(true);
    // Every supported claim traces to a real source line.
    for (const c of spec.claims.filter((x) => x.supported)) for (const s of c.sourceIds) expect(spec.sources.find((x) => x.id === s)?.path).toBeTruthy();
    expect(spec.concepts.map((k) => k.glyph)).toEqual(expect.arrayContaining(["machine", "gpu", "scheduler", "pod"]));
    expect(spec.concepts.find((k) => k.glyph === "gpu")).toMatchObject({ parentId: "k1", count: 8 });
    // Diagrams and animation add material value here.
    expect(explanation.router.recommendedModes).toEqual(expect.arrayContaining(["text", "diagram", "video"]));
    expect(explanation.router.videoValueScore).toBeGreaterThanOrEqual(0.55);
    expect(explanation.router.reasons.join(" ")).toMatch(/contended|time-dependent|contained/);
    // The other formats come from the same spec.
    expect(explanation.diagram).toContain("subgraph");
    expect(explanation.clear.sections.length).toBe(3);
  });

  it("produces a validated, synchronised, source-traceable video from measured narration", async () => {
    const ex = getExplanationView((await createExplanation({ projectId, source: { kind: "question", id: questionId } })).explanation.id);
    const job = requestVideo(ex.id, { duration: "quick", ttsProvider: "synthetic", renderer: "html" });
    expect(job.status).toBe("queued");
    expect(await drainVideoQueue()).toBe(1);
    const done = getJobView(job.id);
    if (done.status !== "ready") throw new Error(`${done.status}: ${done.error}\n${done.log.join("\n")}`);
    const base = path.join(explainerConfig().dir, ex.id);
    const manifest = JSON.parse(fs.readFileSync(path.join(base, done.artifacts.manifest as string), "utf8")) as ArtifactManifest;
    expect(manifest.validation?.ok).toBe(true);
    expect(manifest.validation!.checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(manifest.ttsProvider).toBe("synthetic");
    expect(manifest.timing).toEqual({ source: "synthetic", granularity: "word" });
    for (const f of [manifest.video!, manifest.audio!, manifest.captions.vtt!, manifest.captions.srt!, manifest.captions.transcript!, manifest.scenePlan!, manifest.beats!, manifest.wordTimings!, manifest.explanationSpec, manifest.narrationScript]) expect(fs.existsSync(path.join(base, f))).toBe(true);
    // Audio and video agree to within a frame, and the video has exactly the planned frames.
    const info = await probe(path.join(base, manifest.video!));
    const plan = JSON.parse(fs.readFileSync(path.join(base, manifest.scenePlan!), "utf8")) as VisualScenePlan;
    expect(info.video?.frames).toBe(plan.frames);
    expect(Math.abs((info.audio?.durationMs ?? 0) - (plan.frames * 1000) / 30)).toBeLessThanOrEqual(40);
    // The planted "30,000 dollars" sentence was removed by the grounding guard before it could be spoken.
    const narration = JSON.parse(fs.readFileSync(path.join(base, manifest.narrationScript), "utf8")) as NarrationPlan;
    expect(narration.rejected.some((r) => r.sentence.includes("30,000"))).toBe(true);
    expect(narration.sections.map((s) => s.narration).join(" ")).not.toContain("30,000");
    // Beats sit on measured word starts.
    const words = JSON.parse(fs.readFileSync(path.join(base, manifest.wordTimings!), "utf8")) as { text: string; startMs: number }[];
    const beats = JSON.parse(fs.readFileSync(path.join(base, manifest.beats!), "utf8")) as NarrativeBeat[];
    // (A section's first beat opens with the section itself, so its scene never starts on an empty frame.)
    for (const b of beats.filter((x) => !x.sentenceAnchored)) expect(words.some((w) => Math.abs(w.startMs - b.startMs) <= 0.5) || plan.scenes.some((s) => Math.abs(s.startMs - b.startMs) <= 0.5)).toBe(true);
    expect(beats.filter((x) => !x.sentenceAnchored).length).toBeGreaterThan(5);
    // Captions cover the narration, and the transcript carries sources for every factual sentence.
    const cues = parseVtt(fs.readFileSync(path.join(base, manifest.captions.vtt!), "utf8"));
    expect(cues.length).toBeGreaterThan(4);
    const transcript = JSON.parse(fs.readFileSync(path.join(base, manifest.captions.transcript!), "utf8")) as { entries: { sectionId: string; sourceRefs: string[] }[] };
    expect(transcript.entries.filter((e) => e.sectionId !== "hook").every((e) => e.sourceRefs.length > 0)).toBe(true);
    // The visual planner drew the machine, the GPUs, the scheduler, the pods, the requests, the idle capacity and the fix.
    const objects = plan.scenes.flatMap((s) => s.objects);
    expect(objects.some((o) => o.kind === "group" && o.glyph === "machine")).toBe(true);
    expect(objects.filter((o) => o.kind === "cell" && o.id.startsWith("k:k2#")).length).toBeGreaterThanOrEqual(8);
    expect(objects.some((o) => o.glyph === "scheduler")).toBe(true);
    expect(objects.some((o) => o.lines.join(" ").includes("requests 1 GPU"))).toBe(true);
    const actions = plan.scenes.flatMap((s) => s.actions);
    expect(actions.some((a) => a.kind === "value" && Math.abs((a.value ?? 0) - 0.12) < 1e-6)).toBe(true); // 12% used, the rest idle
    expect(actions.some((a) => a.kind === "state" && a.state === "blocked")).toBe(true); // the job that cannot start
    expect(actions.some((a) => a.kind === "label" && a.text === "free")).toBe(true); // GPUs freed by sharing
    // Sources stay traceable from scene to beat to claim to source.
    expect(manifest.sourceRefs.length).toBeGreaterThanOrEqual(3);
    expect(plan.scenes.some((s) => s.citations.length > 0)).toBe(true);
    // Stage metrics exist for observability.
    expect(manifest.metrics.stages.map((m) => m.stage)).toEqual(["planning", "scripting", "tts", "aligning", "storyboarding", "rendering", "muxing", "validating"]);
    expect(manifest.metrics.tokens.input).toBeGreaterThan(0);
  }, 240_000);

  it("regenerates only the final section when asked to show how dynamic GPU scheduling fixes it", async () => {
    const ex = getExplanationView((await createExplanation({ projectId, source: { kind: "question", id: questionId } })).explanation.id);
    const before = ex.ready!;
    const base = path.join(explainerConfig().dir, ex.id);
    const m0 = JSON.parse(fs.readFileSync(path.join(base, before.artifacts.manifest as string), "utf8")) as ArtifactManifest;
    const calls0 = synthetic.calls.length;
    const { refine, job } = await refineExplanation(ex.id, "Redo just the final section and show how dynamic GPU scheduling fixes this.");
    expect(refine.sections).toEqual(["n3"]);
    expect(job.kind).toBe("section");
    await drainVideoQueue();
    const done = getJobView(job.id);
    if (done.status !== "ready") throw new Error(`${done.status}: ${done.error}\n${done.log.join("\n")}`);
    const m1 = JSON.parse(fs.readFileSync(path.join(base, done.artifacts.manifest as string), "utf8")) as ArtifactManifest;
    // Exactly one section was spoken again; the other sections' audio was reused byte for byte.
    expect(synthetic.calls.length - calls0).toBe(1);
    expect(synthetic.calls[synthetic.calls.length - 1]).toMatch(/Dynamic G P U scheduling fixes this/);
    expect(m1.sectionAudio.filter((a, i) => a !== m0.sectionAudio[i])).toHaveLength(1);
    // Only that section's scene was rendered again; every other scene video is the same file.
    const changed = m1.sceneVideos.filter((v, i) => v !== m0.sceneVideos[i]);
    expect(changed).toHaveLength(1);
    const plan1 = JSON.parse(fs.readFileSync(path.join(base, m1.narrationScript), "utf8")) as NarrationPlan;
    const plan0 = JSON.parse(fs.readFileSync(path.join(base, m0.narrationScript), "utf8")) as NarrationPlan;
    for (const s of plan1.sections.filter((x) => x.id !== "n3")) expect(s.narration).toBe(plan0.sections.find((x) => x.id === s.id)!.narration);
    expect(plan1.sections.find((s) => s.id === "n3")!.narration).toMatch(/^Dynamic GPU scheduling fixes this/);
    expect(m1.validation?.ok).toBe(true);
    expect(m1.metrics.stages.find((s) => s.stage === "rendering")?.detail ?? "").toMatch(/1 rendered|scene-n3/);
  }, 240_000);
});
