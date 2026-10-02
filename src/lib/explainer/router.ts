/**
 * ExplanationModeRouter: which forms of an explanation are worth producing for this result.
 *
 * Scores are computed from the spec, not from the prose: how many components interact, how many steps a process has,
 * whether time or order matters, whether there is contention between things, a before/after contrast, numbers worth
 * showing, code worth walking through. Video is recommended only when animation adds understanding a diagram cannot
 * (change over time, contention, a before/after), and when the estimated cost and latency are reasonable. Video remains
 * available on request for every result. Browser-safe.
 */
import type { DurationMode, ExplainMode, ExplanationArtifactSpec, ModeRecommendation } from "./types";

const clamp = (x: number) => Math.max(0, Math.min(1, x));
const TEMPORAL = /\b(then|after|before|while|until|when|wait|waits|waiting|queue|queued|over time|eventually|meanwhile|first|finally|sequence|order|timeline|later|stays|remains|holds)\b/i;
const SPATIAL = /\b(inside|within|contains|on the same|share|shared|sharing|across|between|attached|node|machine|cluster|layer)\b/i;
const CONTENTION = /\b(contention|compete|competing|share|shared|block|blocks|starv|idle|unused|wasted|under-?utili[sz]|over-?subscri|fragment|bottleneck|hold|holds|reserved?)\b/i;

export interface RouterInput { intent?: string; requestedDepth?: DurationMode; costPerMinuteUsd?: number | null; localRender?: boolean }

export function routeModes(spec: ExplanationArtifactSpec, input: RouterInput = {}): ModeRecommendation {
  const supported = spec.claims.filter((c) => c.supported);
  const text = supported.map((c) => c.text).join(" ");
  const sentences = Math.max(1, supported.length);
  const components = spec.concepts.filter((c) => c.kind !== "idea").length;
  const relationships = spec.relationships.length;
  const steps = spec.processes.reduce((a, p) => a + p.steps.length, 0);
  const temporal = supported.filter((c) => TEMPORAL.test(c.text)).length / sentences;
  const spatial = supported.filter((c) => SPATIAL.test(c.text)).length / sentences;
  const contention = supported.filter((c) => CONTENTION.test(c.text)).length / sentences;
  const containment = spec.concepts.filter((c) => c.parentId || (c.count ?? 0) > 1).length;
  const comparisons = (spec.comparisons ?? []).length;
  const metrics = (spec.metrics ?? []).length;
  const code = (spec.codeReferences ?? []).length;
  const words = text.split(/\s+/).filter(Boolean).length;
  const density = clamp(words / 260);
  const intent = (input.intent ?? "").toLowerCase();
  const wantsVisual = /\b(visual|video|animate|animation|show me|teach|walk me through|how does .* work|explain visually)\b/.test(intent);

  const features = { components, relationships, steps, temporal: +temporal.toFixed(2), spatial: +spatial.toFixed(2), contention: +contention.toFixed(2), containment, comparisons, metrics, code, words, density: +density.toFixed(2), claims: supported.length };

  const diagramValue = clamp(0.12 * Math.min(components, 6) + 0.06 * Math.min(relationships, 6) + 0.15 * Math.min(containment, 2) + (steps >= 3 ? 0.15 : 0) + 0.2 * spatial);
  const animationValue = clamp(0.45 * temporal + 0.5 * contention + (comparisons ? 0.2 : 0) + (steps >= 3 ? 0.15 : 0) + (containment ? 0.1 : 0) + (metrics ? 0.06 : 0));
  const proseDifficulty = clamp((components >= 4 ? 0.3 : 0.1) + (relationships >= 4 ? 0.25 : 0.05) + 0.3 * density + (steps >= 4 ? 0.15 : 0));
  // Cost and latency pull the score down a little; local rendering is free, so only latency counts there.
  const costPenalty = input.costPerMinuteUsd ? clamp(input.costPerMinuteUsd / 2) * 0.15 : 0;
  const trivial = supported.length < 3 || components < 2;
  let videoValue = clamp(0.5 * animationValue + 0.3 * diagramValue + 0.2 * proseDifficulty - costPenalty - (trivial ? 0.35 : 0) + (wantsVisual ? 0.15 : 0));
  if (supported.length === 0) videoValue = 0;
  const interactiveValue = clamp(0.6 * diagramValue + 0.3 * animationValue + (code ? 0.1 : 0));

  const reasons: string[] = [];
  if (steps >= 3) reasons.push(`multi-stage process (${steps} steps)`);
  if (temporal >= 0.25) reasons.push("time-dependent behavior");
  if (contention >= 0.2) reasons.push("resources contended for or left idle");
  if (containment) reasons.push("components contained in other components");
  if (components >= 4) reasons.push(`${components} interacting components`);
  if (comparisons) reasons.push("a before/after contrast");
  if (metrics) reasons.push("numbers worth showing");
  if (code) reasons.push("source lines worth walking through");
  if (diagramValue >= 0.5) reasons.push("visual relationships improve comprehension");
  if (trivial) reasons.push("short result: prose is enough on its own");
  if (supported.length === 0) reasons.push("no claim resolves to a source, so nothing can be narrated");

  const modes: ExplainMode[] = ["text"];
  if (diagramValue >= 0.35 && components >= 2) modes.push("diagram");
  if (interactiveValue >= 0.45 && !trivial) modes.push("interactive");
  if (videoValue >= 0.55) modes.push("video");

  const suggestedDuration: DurationMode = input.requestedDepth ?? (supported.length > 18 || steps > 8 ? "deep" : supported.length > 6 || components > 4 ? "standard" : "quick");
  const videoSeconds = suggestedDuration === "quick" ? 50 : suggestedDuration === "standard" ? 120 : 300;
  return {
    recommendedModes: modes,
    videoValueScore: +videoValue.toFixed(2),
    diagramValueScore: +diagramValue.toFixed(2),
    interactiveValueScore: +interactiveValue.toFixed(2),
    reasons,
    features,
    suggestedDuration,
    estimate: { videoSeconds, renderSeconds: Math.round(videoSeconds * (input.localRender === false ? 1.5 : 0.8) + 20), costUsd: input.costPerMinuteUsd ? +((videoSeconds / 60) * input.costPerMinuteUsd).toFixed(3) : input.costPerMinuteUsd === null ? null : 0 },
  };
}

/** Duration windows for the three video modes. Enforced on MEASURED speech, not on word counts. */
export const DURATION_WINDOWS: Record<DurationMode, { minMs: number; maxMs: number; targetMs: number; sections: [number, number] }> = {
  quick: { minMs: 25_000, maxMs: 70_000, targetMs: 48_000, sections: [2, 4] },
  standard: { minMs: 60_000, maxMs: 190_000, targetMs: 120_000, sections: [3, 6] },
  deep: { minMs: 170_000, maxMs: 660_000, targetMs: 330_000, sections: [5, 10] },
};
