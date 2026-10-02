/**
 * The Explanation IR and every artifact derived from it.
 *
 *   Brody result (answer, documentation, finding) ──► ExplanationArtifactSpec (the canonical IR)
 *        ──► NarrationPlan ──► TTS (audio + MEASURED word timings) ──► NarrativeBeat[] ──► VisualScenePlan ──► renderers
 *
 * Every renderer (clear prose, diagram, interactive player, video) reads the SAME spec, so formats cannot drift apart
 * semantically. Nothing downstream may add a fact that is not a claim in the spec, and every claim carries the source
 * ids it rests on, so a scene can always be traced back to lines of code.
 *
 * This module is imported by the browser (the interactive player and the result panel), so it must stay free of Node APIs.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Explanation IR
// ---------------------------------------------------------------------------------------------------------------------

export type AudienceLevel = "beginner" | "intermediate" | "expert";
export type DurationMode = "quick" | "standard" | "deep";
export type ExplainMode = "text" | "diagram" | "interactive" | "video";
export type Confidence = "high" | "medium" | "low";

/** Where a fact came from. Code sources resolve to real file lines in the analysed project. */
export interface SourceReference {
  id: string;
  kind: "code" | "doc" | "finding" | "graph" | "answer";
  label: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  snippet?: string;
  note?: string;
}

/** A piece of evidence: a source, optionally narrowed to a quote. */
export interface Evidence {
  id: string;
  sourceId: string;
  quote?: string;
  note?: string;
}

export interface Claim {
  id: string;
  text: string;
  evidenceIds: string[];
  sourceIds: string[];
  confidence: Confidence;
  /** grounded-result: stated by the Brody result itself; deterministic: computed from the repository graph; ai-restructured: a model restated grounded material. */
  origin: "grounded-result" | "deterministic" | "ai-restructured";
  /** False when no source resolves. Unsupported claims are kept for transparency but never narrated or drawn. */
  supported: boolean;
}

export type ConceptGlyph = "machine" | "gpu" | "pod" | "service" | "scheduler" | "database" | "queue" | "user" | "file" | "function" | "external" | "config" | "generic";

export interface Concept {
  id: string;
  name: string;
  definition: string;
  kind: "component" | "resource" | "actor" | "data" | "idea" | "metric";
  glyph: ConceptGlyph;
  /** Containment: a GPU inside a machine, a file inside a module. */
  parentId?: string;
  /** How many identical instances to draw (eight GPUs). Drawn as one row of cells inside the concept. */
  count?: number;
  claimIds: string[];
}

export type RelationshipKind = "calls" | "uses" | "requests" | "contains" | "allocates" | "blocks" | "produces" | "depends_on" | "flows_to" | "contends_with" | "reads" | "writes";

export interface Relationship {
  id: string;
  from: string;
  to: string;
  label: string;
  kind: RelationshipKind;
  claimIds: string[];
}

export interface ProcessStep { id: string; label: string; detail?: string; actor?: string; claimIds: string[] }
export interface Process { id: string; name: string; steps: ProcessStep[]; claimIds: string[] }
export interface TimelineEvent { id: string; label: string; at?: string; claimIds: string[] }
export interface Timeline { id: string; name: string; events: TimelineEvent[] }
export interface Equation { id: string; expression: string; meaning: string; claimIds: string[] }

export interface CodeReference {
  id: string;
  sourceId: string;
  path: string;
  startLine: number;
  endLine: number;
  language?: string;
  code: string;
  /** Lines to emphasise, inclusive, in file line numbers. */
  highlight?: [number, number];
  caption: string;
  claimIds: string[];
}

export interface Example { id: string; title: string; description: string; claimIds: string[] }
export interface Uncertainty { id: string; text: string; claimIds: string[] }

/** A number worth showing: utilisation, a count, a latency. Values always come from claims, never from a model's guess. */
export interface MetricFact { id: string; label: string; value: number; unit?: string; display: string; claimIds: string[] }

/** Two states of the same system: the problem and the fix, before and after. */
export interface Comparison {
  id: string;
  title: string;
  before: { label: string; points: string[] };
  after: { label: string; points: string[] };
  claimIds: string[];
}

export type VisualLayout = "architecture" | "process" | "comparison" | "metric" | "code" | "timeline" | "equation" | "statement" | "contention";

export interface VisualizationHint {
  id: string;
  kind: VisualLayout;
  subjectIds: string[];
  note?: string;
  sectionId?: string;
}

export interface NarrativeSection {
  id: string;
  title: string;
  objective: string;
  claimIds: string[];
  conceptIds: string[];
  visual: VisualLayout;
}

export interface ProvenanceRecord {
  id: string;
  stage: string;
  at: number;
  /** Who produced this step: "deterministic", or the model id. Never a credential. */
  by: string;
  inputHash: string;
  note?: string;
}

export interface ExplanationArtifactSpec {
  id: string;
  /** The Brody result this explains: "question:<id>", "file:<path>", "area:<id>", "system", "finding:<code>". */
  sourceRunId: string;
  projectId: string;
  version: number;

  title: string;
  summary: string;

  audience: { level: AudienceLevel; domainKnowledge?: string[] };
  objectives: string[];

  concepts: Concept[];
  claims: Claim[];
  evidence: Evidence[];
  relationships: Relationship[];
  processes: Process[];
  timelines?: Timeline[];
  equations?: Equation[];
  codeReferences?: CodeReference[];
  metrics?: MetricFact[];
  comparisons?: Comparison[];

  examples: Example[];
  counterExamples?: Example[];

  uncertainties?: Uncertainty[];
  caveats?: string[];

  sources: SourceReference[];

  narrative: {
    hook?: string;
    sections: NarrativeSection[];
    conclusion: string;
  };

  visualizationHints: VisualizationHint[];
  provenance: ProvenanceRecord[];

  /** 0..1, from the grounding of the result: share of supported claims weighted by their confidence. */
  confidence: number;
}

// ---------------------------------------------------------------------------------------------------------------------
// Mode router
// ---------------------------------------------------------------------------------------------------------------------

export interface ModeRecommendation {
  recommendedModes: ExplainMode[];
  videoValueScore: number;
  diagramValueScore: number;
  interactiveValueScore: number;
  reasons: string[];
  /** The features the scores were computed from, so a decision can be explained and tested. */
  features: Record<string, number>;
  suggestedDuration: DurationMode;
  estimate: { videoSeconds: number; renderSeconds: number; costUsd: number | null };
}

// ---------------------------------------------------------------------------------------------------------------------
// Narration
// ---------------------------------------------------------------------------------------------------------------------

export type VisualActionKind =
  | "introduce_component" | "highlight_component" | "connect_components" | "show_data_flow" | "zoom_to_subsystem"
  | "transform_object" | "compare_states" | "advance_timeline" | "show_equation" | "show_code" | "emphasize_metric"
  | "reveal_result" | "set_state" | "dim_context" | "show_statement" | "hold";

export interface VisualAction {
  kind: VisualActionKind;
  /** Concept, relationship, metric, code or comparison ids from the spec. */
  targets: string[];
  /** For set_state: idle | busy | blocked | waiting | ok. For emphasize_metric: the metric id is in targets. */
  state?: "idle" | "busy" | "blocked" | "waiting" | "ok";
  label?: string;
}

/** A planned visual change, anchored to the opening words of a sentence in the narration. */
export interface BeatIntent {
  cue: string;
  action: VisualAction;
  claimIds: string[];
}

export interface NarrationSection {
  id: string;
  specSectionId: string;
  role: "hook" | "body" | "conclusion";
  title: string;
  objective: string;
  narration: string;
  visualIntent: { layout: VisualLayout; focus: string[]; beats: BeatIntent[] };
  sourceRefs: string[];
  claimIds: string[];
  /** Extra silence after this section, so its picture stays on screen longer. */
  holdMs?: number;
  /** The narration was written by the user, not planned. */
  userEdited?: boolean;
}

export interface NarrationPlan {
  id: string;
  specId: string;
  title: string;
  hook: string;
  sections: NarrationSection[];
  conclusion: string;
  /** Before speech exists this is a planning estimate only; the job replaces it with the measured duration. */
  estimatedDurationMs: number;
  target: { mode: DurationMode; minMs: number; maxMs: number };
  audience: AudienceLevel;
  style: VisualStyle;
  origin: "deterministic" | "ai";
  /** Sentences removed because they stated something the spec does not support. */
  rejected: { sectionId: string; sentence: string; reason: string }[];
}

export type VisualStyle = "brody" | "brody-light" | "calm";

// ---------------------------------------------------------------------------------------------------------------------
// Speech and timing
// ---------------------------------------------------------------------------------------------------------------------

/** How a word's time was obtained. Only "provider" and "aligned" are word-accurate measurements. */
export type TimingSource = "provider" | "aligned" | "segment-measured" | "synthetic";

export interface TimedWord {
  /** The word as displayed in captions and the transcript. */
  text: string;
  startMs: number;
  endMs: number;
  sectionId: string;
  /** Index of the sentence inside its section. */
  sentence: number;
  /** True when the time was interpolated between measured neighbours rather than measured itself. */
  interpolated?: boolean;
}

export interface SectionAudio {
  sectionId: string;
  /** Path relative to the explanation's artifact directory. */
  audio: string;
  /** Measured speech length (from the sample count, never from a header). */
  speechMs: number;
  /** Slot length on the timeline: speech plus the pause, rounded up to whole video frames. */
  slotMs: number;
  frames: number;
  startMs: number;
  words: TimedWord[];
  timing: { source: TimingSource; granularity: "word" | "sentence"; interpolated: number };
  provider: string;
  voice: string;
  hash: string;
}

export interface NarrativeBeat {
  id: string;
  sectionId: string;
  cueText: string;
  /** Absolute narration time. */
  startMs: number;
  endMs: number;
  visualAction: VisualAction;
  sourceRefs: string[];
  claimIds: string[];
  /** True when the cue had to be placed at a sentence boundary because word timing was not measured. */
  sentenceAnchored: boolean;
}

// ---------------------------------------------------------------------------------------------------------------------
// Visual scene plan: a deterministic, fully laid out description that renderers only draw
// ---------------------------------------------------------------------------------------------------------------------

export interface Box { x: number; y: number; w: number; h: number }

export type ObjectKind = "title" | "kicker" | "statement" | "node" | "group" | "cell" | "connector" | "chip" | "meter" | "metric" | "code" | "equation" | "timeline" | "callout" | "list" | "source";
export type ObjectState = "idle" | "busy" | "blocked" | "waiting" | "ok";

export interface VisualObject {
  id: string;
  kind: ObjectKind;
  box: Box;
  /** Pre-wrapped lines; renderers never wrap or measure text themselves. */
  lines: string[];
  /** Secondary text (a node's sub-label, a meter's caption). */
  sub?: string[];
  fontSize: number;
  mono?: boolean;
  bold?: boolean;
  align?: "left" | "center" | "right";
  glyph?: ConceptGlyph;
  /** Spec ids this object depicts. */
  refs: string[];
  parent?: string;
  /** Connector geometry: polyline points, arrow at the end. */
  points?: { x: number; y: number }[];
  dashed?: boolean;
  /** Meter: value 0..1 at the start of the scene. */
  value?: number;
  /** Code: the first file line shown, to map highlights. */
  firstLine?: number;
  /** Drawn without its own frame (a caption plus cells nested in a group). Still highlightable as a region. */
  plain?: boolean;
  /** Visual emphasis tier: "primary" text in ink, "secondary" in the secondary ink. */
  tone?: "primary" | "secondary" | "accent";
  z: number;
  initial: { visible: boolean; state?: ObjectState; highlight?: boolean };
}

export type PrimitiveKind = "appear" | "disappear" | "highlight" | "unhighlight" | "draw" | "flow" | "state" | "value" | "label" | "scrim" | "unscrim" | "camera" | "lines" | "emphasis";

/** One animation primitive, in scene-local milliseconds. */
export interface TimedAction {
  id: string;
  beatId: string;
  kind: PrimitiveKind;
  target?: string;
  startMs: number;
  durationMs: number;
  state?: ObjectState;
  value?: number;
  /** For "lines": inclusive file line range to emphasise. For "camera": the view box. */
  range?: [number, number];
  view?: Box;
  /** Objects kept above the scrim. */
  keep?: string[];
  /** For "label": the new secondary text of a cell. */
  text?: string;
}

export interface SourceOverlay { claimId: string; sourceIds: string[]; label: string; startMs: number; endMs: number }

export type RendererId = "manim" | "html";

export interface SceneSpec {
  id: string;
  sectionId: string;
  objective: string;
  layout: VisualLayout;
  /** Absolute narration time and frame range. Scenes are frame aligned so they can be rendered and replaced alone. */
  startMs: number;
  endMs: number;
  startFrame: number;
  frameCount: number;
  renderer: RendererId;
  objects: VisualObject[];
  actions: TimedAction[];
  camera?: { atMs: number; view: Box }[];
  labels?: { id: string; text: string; box: Box }[];
  citations: SourceOverlay[];
  /** Hash of everything that decides the scene's pixels, including its timing. A cached render is reused only on an exact match. */
  hash: string;
}

export interface VisualScenePlan {
  version: number;
  canvas: { width: number; height: number; fps: number };
  style: VisualStyle;
  durationMs: number;
  frames: number;
  scenes: SceneSpec[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Jobs, validation and the manifest
// ---------------------------------------------------------------------------------------------------------------------

export type VideoJobStatus = "queued" | "running" | "ready" | "failed" | "cancelled";
export type VideoStageKey = "planning" | "scripting" | "tts" | "aligning" | "storyboarding" | "rendering" | "muxing" | "validating";

export interface VideoJobParams {
  duration: DurationMode;
  audience: AudienceLevel;
  style: VisualStyle;
  renderer: RendererId | "auto";
  execution: "local" | "cloud" | "hybrid";
  ttsProvider?: string;
  voice?: string;
  /** Section-level work: only these narration sections are re-scripted or re-rendered. */
  sections?: string[];
  instruction?: string;
  /** Allow narration that contains repository-derived content to be sent to a cloud TTS provider. */
  allowExternal?: boolean;
  /** Fewer moving parts: no travelling dots, no camera moves, no staggered entrances. */
  motion?: "full" | "reduced";
  /** Overall length multiplier for the narration plan (0.75 = a quarter shorter). */
  lengthFactor?: number;
  /** Structured edits resolved from a refinement request or made by hand. */
  edits?: PlanEdits;
  /** Scenes to render again even though their hash is unchanged ("regenerate scene three"); "*" re-renders every scene. */
  forceScenes?: string[];
}

export interface PlanEdits {
  /** Narration text written by the user, by section id. */
  narration?: Record<string, string>;
  holdMs?: Record<string, number>;
  /** Sections to leave out (for example the hook: "remove the intro"). */
  drop?: string[];
  layouts?: Record<string, VisualLayout>;
  /** Claims to add to a spec section before planning (focus requests). */
  addClaims?: Record<string, string[]>;
}

export interface ValidationCheck { id: string; label: string; status: "pass" | "warn" | "fail"; detail: string }
export interface ValidationReport { ok: boolean; checks: ValidationCheck[]; at: number }

export interface StageMetric { stage: string; ms: number; reused: boolean; detail?: string; costUsd?: number; cpuMs?: number; tokens?: { input: number; output: number } }

export interface ArtifactManifest {
  runId: string;
  explanationId: string;
  projectId: string;
  sourceRunId: string;
  createdAt: number;
  explanationSpec: string;
  narrationScript: string;
  audio: string | null;
  sectionAudio: string[];
  wordTimings: string | null;
  beats: string | null;
  scenePlan: string | null;
  rendererSources: string[];
  sceneVideos: string[];
  captions: { vtt: string | null; srt: string | null; transcript: string | null };
  video: string | null;
  thumbnail: string | null;
  storyboard: string[];
  durationMs: number;
  renderer: string;
  renderers: Record<string, number>;
  ttsProvider: string;
  voice: string;
  timing: { source: TimingSource | "mixed"; granularity: "word" | "sentence" };
  modelVersions: Record<string, string>;
  sourceRefs: string[];
  stageHashes: Record<string, string>;
  validation: ValidationReport | null;
  metrics: { stages: StageMetric[]; totalMs: number; artifactBytes: number; retries: number; costUsd: number | null; cpuMs: number; tokens: { input: number; output: number } };
}

/** Transcript entry, one per sentence, with the sources it rests on. */
export interface TranscriptEntry { id: string; sectionId: string; text: string; startMs: number; endMs: number; sourceRefs: string[]; claimIds: string[] }
