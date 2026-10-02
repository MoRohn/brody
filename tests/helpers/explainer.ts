/** A small, consistent Explanation IR shared by the explainer tests. */
import type { ExplanationArtifactSpec } from "@/lib/explainer/types";

export const claim = (id: string, text: string, sourceIds = ["s1"], supported = true) => ({ id, text, sourceIds, evidenceIds: [], confidence: "high" as const, origin: "grounded-result" as const, supported });
export function sampleSpec(): ExplanationArtifactSpec {
  return {
    id: "ex_test", sourceRunId: "question:q1", projectId: "p", version: 1, title: "Why GPUs sit idle", summary: "Whole-GPU requests leave capacity idle.",
    audience: { level: "intermediate" }, objectives: [],
    concepts: [
      { id: "k1", name: "DGX machine", definition: "", kind: "component", glyph: "machine", claimIds: ["c1"] },
      { id: "k2", name: "GPU", definition: "", kind: "resource", glyph: "gpu", parentId: "k1", count: 8, claimIds: ["c1"] },
      { id: "k3", name: "Kubernetes scheduler", definition: "", kind: "component", glyph: "scheduler", claimIds: ["c2"] },
      { id: "k4", name: "Inference pod", definition: "", kind: "component", glyph: "pod", count: 8, claimIds: ["c2"] },
      { id: "k5", name: "Training job", definition: "", kind: "component", glyph: "pod", claimIds: ["c4"] },
    ],
    claims: [
      claim("c1", "The DGX machine has 8 GPUs."),
      claim("c2", "Each inference pod requests nvidia.com/gpu: 1, and the Kubernetes scheduler gives it a whole GPU."),
      claim("c3", "Each inference pod uses about 12% of its GPU, so most capacity sits idle."),
      claim("c4", "The training job waits because every GPU is allocated."),
      claim("c5", "Time-slicing lets several pods share one GPU, which frees GPUs for the training job."),
      claim("c6", "This costs 9 million dollars.", [], false),
    ],
    evidence: [], sources: [{ id: "s1", kind: "code", label: "deploy/a.yaml:1-4", path: "deploy/a.yaml", startLine: 1, endLine: 4, snippet: "nvidia.com/gpu: 1" }],
    relationships: [{ id: "r1", from: "k4", to: "k2", label: "requests", kind: "requests", claimIds: ["c2"] }, { id: "r2", from: "k5", to: "k3", label: "waits on", kind: "blocks", claimIds: ["c4"] }],
    processes: [], metrics: [{ id: "m1", label: "used", value: 12, unit: "%", display: "12%", claimIds: ["c3"] }],
    comparisons: [{ id: "cmp1", title: "Before and after", before: { label: "Today", points: ["Whole GPUs"] }, after: { label: "Shared", points: ["Several pods per GPU"] }, claimIds: ["c3", "c5"] }],
    examples: [],
    narrative: { hook: "Why do GPUs sit idle?", conclusion: "Sharing frees GPUs.", sections: [
      { id: "n1", title: "Setup", objective: "", claimIds: ["c1", "c2"], conceptIds: ["k1", "k2", "k3", "k4"], visual: "architecture" },
      { id: "n2", title: "Idle", objective: "", claimIds: ["c3", "c4"], conceptIds: ["k2", "k4", "k5"], visual: "contention" },
      { id: "n3", title: "Fix", objective: "", claimIds: ["c5"], conceptIds: ["k2", "k4", "k5"], visual: "contention" },
    ] },
    visualizationHints: [], provenance: [], confidence: 0.9,
  };
}

