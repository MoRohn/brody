/**
 * The narrative planner: ExplanationArtifactSpec + duration + audience + style → NarrationPlan.
 *
 * It writes for the ear, not the page: short sentences, active verbs, a term defined before it is used, no spoken
 * headings, one running example. About 80% controlled technical English (speech.ts) and 20% natural connective speech.
 * Every sentence is checked by the grounding guard against the spec; a sentence that adds a number, name or identifier
 * the spec does not contain is removed and recorded in `rejected`.
 *
 * Section ids are stable ("hook", the spec's section ids, "outro"), so a plan revised for one section leaves the others
 * byte-identical and their audio and scenes are reused.
 */
import { z } from "zod";
import { getAIProvider, SAFETY_PREAMBLE, tryAnalyze, untrusted, UsageMeter } from "../ai";
import { oneOf, specCorpus } from "./compile";
import { isGrounded } from "./grounding";
import { DURATION_WINDOWS } from "./router";
import { controlNarration, splitSentences, wordCount } from "./speech";
import type { AudienceLevel, BeatIntent, Claim, DurationMode, ExplanationArtifactSpec, NarrationPlan, NarrationSection, VisualAction, VisualActionKind, VisualLayout, VisualStyle } from "./types";

/** Planning estimate only (the job measures real speech): about 155 words a minute for a clear technical voice. */
export const PLANNING_WORDS_PER_SECOND = 2.6;

export interface PlanOptions {
  duration: DurationMode;
  audience: AudienceLevel;
  style: VisualStyle;
  /** Rewrite only these section ids; keep the rest of `previous` unchanged. */
  sections?: string[];
  previous?: NarrationPlan;
  /** A refinement instruction for the sections being rewritten ("focus on the GPU scheduling", "simpler"). */
  instruction?: string;
  /** Word budget multiplier from the measured duration fit (0.7 = make it 30% shorter). */
  lengthFactor?: number;
  useAI?: boolean;
}

const RELATION_VERBS = /\b(requests?|asks? for|sends?|calls?|reads?|writes?|flows?|passes?|allocates?|assigns?|binds?|schedules?|places?|routes?)\b/i;
const SHARE = /\b(shar(e|es|ed|ing)|time-?slic\w*|slic(e|es|ing)|partition\w*|pack(s|ed|ing)?|bin-?pack\w*|mig)\b/i;
const STATE_WORDS: [RegExp, NonNullable<VisualAction["state"]>][] = [[/\b(idle|unused|wasted|empty|sits?)\b/i, "idle"], [/\b(block|blocked|wait|waits|waiting|pending|stuck|starv)/i, "blocked"], [/\b(busy|runs?|running|active|computing)\b/i, "busy"], [/\b(fixed|freed|reclaimed|shared|reused)\b/i, "ok"]];

const maxWordsFor = (a: AudienceLevel) => (a === "beginner" ? 16 : a === "expert" ? 24 : 20);

/** Deterministic beat intents for a section's narration: one visual change per sentence, chosen from what it mentions. */
export function deriveBeats(narration: string, layout: VisualLayout, spec: ExplanationArtifactSpec, introduced: Set<string>, role: NarrationSection["role"], claimIds: string[]): BeatIntent[] {
  const beats: BeatIntent[] = [];
  const sentences = splitSentences(narration);
  sentences.forEach((s, i) => {
    const lower = s.toLowerCase();
    const cue = s.split(/\s+/).slice(0, 5).join(" ");
    const mentioned = spec.concepts.filter((k) => mentions(lower, k.name));
    const fresh = mentioned.filter((k) => !introduced.has(k.id));
    const metric = (spec.metrics ?? []).find((m) => lower.includes(m.display.toLowerCase()) || new RegExp(`\\b${m.value}\\s?(%|percent)`).test(lower));
    const cls = claimIdsFor(s, spec, claimIds);
    let action: VisualAction;
    if (role === "hook") action = { kind: "show_statement", targets: [] };
    else if (role === "conclusion" && i === sentences.length - 1) action = { kind: "reveal_result", targets: mentioned.map((k) => k.id) };
    else if (layout === "code") action = { kind: "show_code", targets: [(spec.codeReferences ?? [])[0]?.id ?? ""].filter(Boolean) };
    else if (layout === "comparison" && i > 0) action = { kind: "compare_states", targets: [(spec.comparisons ?? [])[0]?.id ?? ""].filter(Boolean) };
    else if (metric) action = { kind: "emphasize_metric", targets: [metric.id] };
    else if (role === "body" && (layout === "contention" || layout === "architecture") && SHARE.test(s) && sharedResources(spec).length) {
      action = { kind: "transform_object", targets: sharedResources(spec).map((k) => k.id) };
    } else if (fresh.length) {
      const state = STATE_WORDS.find(([re]) => re.test(s));
      action = { kind: "introduce_component", targets: fresh.map((k) => k.id), ...(state ? { state: state[1] } : {}) };
    } else {
      const rel = spec.relationships.find((r) => mentioned.some((k) => k.id === r.from) && mentioned.some((k) => k.id === r.to));
      const state = STATE_WORDS.find(([re]) => re.test(s));
      if (rel && RELATION_VERBS.test(s)) action = { kind: /flow|send|pass/i.test(s) ? "show_data_flow" : "connect_components", targets: [rel.id] };
      else if (state && mentioned.length) action = { kind: "set_state", targets: mentioned.map((k) => k.id), state: state[1] };
      else if (mentioned.length) action = { kind: "highlight_component", targets: mentioned.map((k) => k.id) };
      else if (layout === "process") action = { kind: "advance_timeline", targets: [] };
      else action = { kind: "hold", targets: [] };
    }
    for (const k of mentioned) introduced.add(k.id);
    beats.push({ cue, action, claimIds: cls });
  });
  return beats;
}

/** Resources drawn as several identical instances (GPUs): what a "share" sentence re-packs. */
const sharedResources = (spec: ExplanationArtifactSpec) => spec.concepts.filter((k) => (k.count ?? 0) > 1 && (k.kind === "resource" || k.glyph === "gpu"));

function mentions(lower: string, name: string): boolean {
  const n = name.toLowerCase();
  if (lower.includes(n)) return true;
  const singular = n.replace(/s$/, "");
  return singular.length > 2 && new RegExp(`\\b${singular.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?\\b`).test(lower);
}

function claimIdsFor(sentence: string, spec: ExplanationArtifactSpec, fallback: string[]): string[] {
  const words = new Set(sentence.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
  const scored = spec.claims.filter((c) => c.supported && fallback.includes(c.id)).map((c) => ({ c, n: c.text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => words.has(w)).length })).filter((x) => x.n >= 2).sort((a, b) => b.n - a.n);
  return scored.length ? scored.slice(0, 2).map((x) => x.c.id) : fallback.slice(0, 2);
}

function hookFor(spec: ExplanationArtifactSpec): string {
  const h = spec.narrative.hook?.trim() ?? spec.title;
  // A question title is a fine hook. A statement title is turned into one plain sentence.
  return controlNarration(/[?.!]$/.test(h) ? h : `${h}.`);
}

function sectionNarration(claims: Claim[], spec: ExplanationArtifactSpec, audience: AudienceLevel, budget: number, defined: Set<string>): string {
  const out: string[] = [];
  let words = 0;
  for (const c of claims) {
    // Define a term before it carries weight, for viewers who may not know it.
    if (audience === "beginner") {
      for (const k of spec.concepts) {
        if (defined.has(k.id) || !k.definition || !mentions(c.text.toLowerCase(), k.name) || k.definition === c.text) continue;
        const d = controlNarration(k.definition, { maxWords: 16 });
        if (wordCount(d) + words > budget) continue;
        out.push(d);
        words += wordCount(d);
        defined.add(k.id);
      }
    }
    const t = controlNarration(c.text.replace(/^(Failure mode|Input|Output|Inputs|Outputs|Fix):\s*/i, ""), { maxWords: maxWordsFor(audience) });
    if (words > 0 && words + wordCount(t) > budget) break;
    out.push(t);
    words += wordCount(t);
  }
  return out.join(" ");
}

/** Deterministic plan straight from the spec's sections and claims. */
export function planDeterministic(spec: ExplanationArtifactSpec, o: PlanOptions): NarrationPlan {
  const win = DURATION_WINDOWS[o.duration];
  const budgetWords = Math.round(((win.targetMs / 1000) * PLANNING_WORDS_PER_SECOND) * (o.lengthFactor ?? 1));
  const claimById = new Map(spec.claims.map((c) => [c.id, c]));
  const specSections = spec.narrative.sections.filter((s) => s.claimIds.some((id) => claimById.get(id)?.supported)).slice(0, win.sections[1]);
  const perSection = Math.max(18, Math.floor((budgetWords - 30) / Math.max(1, specSections.length)));
  const introduced = new Set<string>();
  const defined = new Set<string>();
  const sections: NarrationSection[] = [];
  const hook = hookFor(spec);
  sections.push(makeSection("hook", "hook", "hook", "Opening", "State the question.", hook, "statement", [], [], spec, introduced));
  for (const s of specSections) {
    const claims = s.claimIds.map((id) => claimById.get(id)).filter((c): c is Claim => !!c && c.supported);
    const text = sectionNarration(claims, spec, o.audience, perSection, defined);
    if (!text) continue;
    sections.push(makeSection(s.id, s.id, "body", s.title, s.objective, text, s.visual, s.conceptIds, claims.map((c) => c.id), spec, introduced));
  }
  const conclusion = controlNarration(spec.narrative.conclusion, { maxWords: maxWordsFor(o.audience) });
  const outroClaims = spec.claims.filter((c) => c.supported && conclusion.toLowerCase().includes(c.text.slice(0, 30).toLowerCase())).map((c) => c.id);
  sections.push(makeSection("outro", "outro", "conclusion", "Takeaway", "Land the idea.", conclusion, "statement", [], outroClaims.length ? outroClaims : sections.flatMap((s) => s.claimIds).slice(-2), spec, introduced));
  return finishPlan(spec, o, sections, "deterministic", []);
}

function makeSection(id: string, specSectionId: string, role: NarrationSection["role"], title: string, objective: string, narration: string, layout: VisualLayout, focus: string[], claimIds: string[], spec: ExplanationArtifactSpec, introduced: Set<string>): NarrationSection {
  const sources = [...new Set(claimIds.flatMap((id) => spec.claims.find((c) => c.id === id)?.sourceIds ?? []))];
  return { id, specSectionId, role, title, objective, narration, visualIntent: { layout, focus, beats: deriveBeats(narration, layout, spec, introduced, role, claimIds) }, sourceRefs: sources, claimIds };
}

function finishPlan(spec: ExplanationArtifactSpec, o: PlanOptions, sections: NarrationSection[], origin: NarrationPlan["origin"], rejected: NarrationPlan["rejected"]): NarrationPlan {
  const win = DURATION_WINDOWS[o.duration];
  const words = sections.reduce((a, s) => a + wordCount(s.narration), 0);
  return {
    id: `plan-${spec.id}`,
    specId: spec.id,
    title: spec.title,
    hook: sections.find((s) => s.role === "hook")?.narration ?? "",
    sections,
    conclusion: sections.find((s) => s.role === "conclusion")?.narration ?? "",
    estimatedDurationMs: Math.round((words / PLANNING_WORDS_PER_SECOND) * 1000),
    target: { mode: o.duration, minMs: win.minMs, maxMs: win.maxMs },
    audience: o.audience,
    style: o.style,
    origin,
    rejected,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// AI planner
// ---------------------------------------------------------------------------------------------------------------------
const ACTIONS = ["introduce_component", "highlight_component", "connect_components", "show_data_flow", "zoom_to_subsystem", "transform_object", "compare_states", "advance_timeline", "show_equation", "show_code", "emphasize_metric", "reveal_result", "set_state", "dim_context", "show_statement", "hold"] as const;

export const NarrationSchema = z.object({
  sections: z.array(z.object({
    id: z.string(),
    narration: z.string(),
    beats: z.array(z.object({ cue: z.string(), action: z.string(), targets: z.array(z.string()), state: z.string(), claimIds: z.array(z.string()) })),
  })),
});

function narrationPrompt(spec: ExplanationArtifactSpec, o: PlanOptions, slots: { id: string; role: string; title: string; objective: string; layout: VisualLayout; claimIds: string[]; conceptIds: string[]; words: number; current?: string }[]): string {
  const claims = spec.claims.filter((c) => c.supported).map((c) => `${c.id}: ${c.text}`).join("\n");
  const concepts = spec.concepts.map((k) => `${k.id} (${k.glyph}${k.parentId ? `, inside ${k.parentId}` : ""}${k.count ? `, x${k.count}` : ""}): ${k.name}${k.definition ? ` - ${k.definition}` : ""}`).join("\n");
  const other = [...spec.relationships.map((r) => `${r.id}: ${r.from} ${r.label} ${r.to}`), ...(spec.metrics ?? []).map((m) => `${m.id}: ${m.label} = ${m.display}`), ...(spec.comparisons ?? []).map((c) => `${c.id}: ${c.title}`), ...(spec.codeReferences ?? []).map((c) => `${c.id}: ${c.path}:${c.startLine}-${c.endLine}`)].join("\n");
  const plan = slots.map((s) => `- ${s.id} (${s.role}, layout ${s.layout}, about ${s.words} words): ${s.title}. Goal: ${s.objective}. Claims: ${s.claimIds.join(", ") || "any"}. Concepts on screen: ${s.conceptIds.join(", ") || "none"}.${s.current ? `\n  Current narration: ${s.current}` : ""}`).join("\n");
  return `Write the spoken narration for an animated technical explainer, section by section. The audience is ${o.audience}. It is heard once at normal speed while a diagram animates.

Style: short sentences (under ${maxWordsFor(o.audience)} words), present tense, active voice, concrete verbs, one idea per sentence. Name a thing before it does work, and define a term before using it${o.audience === "beginner" ? " (always, in plain words)" : o.audience === "expert" ? " (only if unusual)" : ""}. No parentheses, no headings read aloud, no "In this video", no filler (basically, essentially, robust, seamless, leverage, delve). Clear spoken transitions between sections. Keep one running example. Mostly controlled technical English, with some natural conversational connection.

Facts: use ONLY the claims below. Do not add numbers, product names, identifiers or causes that the claims do not state. If a section has little to say, keep it short.
${o.instruction ? `\nRevision request from the user for these sections: ${o.instruction}\n` : ""}
Claims:
${untrusted(claims)}

Concepts that the animation can show:
${untrusted(concepts)}

Other things it can show:
${untrusted(other || "none")}

Sections to write:
${plan}

For each section, also give beats: one per sentence where the picture should change. cue = the first 3 to 6 words of that sentence, copied exactly. action from the list; targets = the concept, relationship, metric, comparison or code ids it acts on; state for set_state, otherwise "none"; claimIds = the claims that sentence states.`;
}

export interface PlanOutcome { plan: NarrationPlan; ai: { used: boolean; model?: string; error?: string; usage?: { inputTokens: number; outputTokens: number } } }

export async function planNarration(spec: ExplanationArtifactSpec, o: PlanOptions): Promise<PlanOutcome> {
  const det = planDeterministic(spec, o);
  // Revising some sections: start from the previous plan so untouched sections stay exactly as they were.
  const base = o.previous && o.sections?.length ? o.previous : det;
  const targetIds = o.sections?.length ? o.sections : base.sections.map((s) => s.id);
  const provider = o.useAI === false ? null : getAIProvider();
  if (!provider) {
    if (!o.previous || !o.sections?.length) return { plan: det, ai: { used: false } };
    // Without a model, a revised section is rebuilt deterministically from the (possibly edited) spec.
    const sections = base.sections.map((s) => (targetIds.includes(s.id) ? det.sections.find((d) => d.id === s.id) ?? s : s));
    return { plan: finishPlan(spec, o, sections, base.origin, base.rejected), ai: { used: false } };
  }
  const win = DURATION_WINDOWS[o.duration];
  const totalWords = Math.round((win.targetMs / 1000) * PLANNING_WORDS_PER_SECOND * (o.lengthFactor ?? 1));
  const bodyCount = Math.max(1, base.sections.filter((s) => s.role === "body").length);
  const specClaims = (s: NarrationSection) => spec.narrative.sections.find((x) => x.id === s.specSectionId)?.claimIds ?? [];
  const slots = base.sections.filter((s) => targetIds.includes(s.id)).map((s) => ({ id: s.id, role: s.role, title: s.title, objective: s.objective, layout: spec.narrative.sections.find((x) => x.id === s.specSectionId)?.visual ?? s.visualIntent.layout, claimIds: [...new Set([...s.claimIds, ...specClaims(s)])], conceptIds: s.visualIntent.focus, words: s.role === "body" ? Math.round((totalWords - 40) / bodyCount) : 20, current: o.previous ? s.narration : undefined }));
  const meter = new UsageMeter();
  const res = await tryAnalyze(provider, meter, { task: "explainer-narration", system: SAFETY_PREAMBLE, prompt: narrationPrompt(spec, o, slots), schema: NarrationSchema, maxTokens: 8000 });
  if (!res) return { plan: o.previous && o.sections?.length ? base : det, ai: { used: false, error: meter.failures[0]?.error } };

  const corpus = specCorpus(spec);
  const rejected: NarrationPlan["rejected"] = [...(o.previous ? base.rejected.filter((r) => !targetIds.includes(r.sectionId)) : [])];
  const ids = new Set([...spec.concepts.map((k) => k.id), ...spec.relationships.map((r) => r.id), ...(spec.metrics ?? []).map((m) => m.id), ...(spec.comparisons ?? []).map((c) => c.id), ...(spec.codeReferences ?? []).map((c) => c.id)]);
  const supported = new Set(spec.claims.filter((c) => c.supported).map((c) => c.id));
  const introduced = new Set<string>();
  const sections = base.sections.map((s) => {
    const got = res.sections.find((x) => x.id === s.id);
    if (!targetIds.includes(s.id) || !got) {
      for (const b of s.visualIntent.beats) for (const t of b.action.targets) introduced.add(t);
      return s;
    }
    // Grounding guard, sentence by sentence, then the mechanical style rules.
    const kept: string[] = [];
    for (const sentence of splitSentences(got.narration)) {
      const g = isGrounded(sentence, corpus);
      if (g.ok) kept.push(sentence);
      else rejected.push({ sectionId: s.id, sentence, reason: `introduces ${g.missing.join(", ")}, which the explanation's sources do not state` });
    }
    const narration = controlNarration(kept.join(" "), { maxWords: maxWordsFor(o.audience) + 4 });
    if (!narration) return det.sections.find((d) => d.id === s.id) ?? s;
    const claimIds = [...new Set(got.beats.flatMap((b) => b.claimIds).filter((id) => supported.has(id)))];
    const sentences = splitSentences(narration);
    const aiBeats: BeatIntent[] = got.beats
      .filter((b) => sentences.some((x) => x.toLowerCase().startsWith(b.cue.toLowerCase().replace(/[.,]$/, "").split(" ").slice(0, 3).join(" "))))
      .map((b) => { const st = oneOf(b.state, ["none", "idle", "busy", "blocked", "waiting", "ok"] as const, "none"); return { cue: b.cue, action: { kind: oneOf(b.action, ACTIONS, "hold") as VisualActionKind, targets: b.targets.filter((t) => ids.has(t)), ...(st !== "none" ? { state: st } : {}) }, claimIds: b.claimIds.filter((id) => supported.has(id)) }; });
    const derived = deriveBeats(narration, s.visualIntent.layout, spec, introduced, s.role, claimIds.length ? claimIds : s.claimIds);
    // Prefer the model's beats where they matched a sentence, the derived ones elsewhere.
    const beats = derived.map((d) => aiBeats.find((a) => a.cue.toLowerCase().split(" ").slice(0, 3).join(" ") === d.cue.toLowerCase().split(" ").slice(0, 3).join(" ")) ?? d);
    const finalClaims = claimIds.length ? claimIds : s.claimIds;
    return { ...s, narration, claimIds: finalClaims, sourceRefs: [...new Set(finalClaims.flatMap((id) => spec.claims.find((c) => c.id === id)?.sourceIds ?? []))], visualIntent: { ...s.visualIntent, beats } };
  });
  return { plan: finishPlan(spec, o, sections, "ai", rejected), ai: { used: true, model: provider.model, usage: { inputTokens: meter.usage.inputTokens, outputTokens: meter.usage.outputTokens } } };
}

/** Deterministic length adjustment after measuring speech: drop or restore sentences in the longest sections. */
export function fitPlanLength(plan: NarrationPlan, spec: ExplanationArtifactSpec, measuredMs: number): { plan: NarrationPlan; changed: string[] } {
  const { minMs, maxMs } = plan.target;
  if (measuredMs >= minMs && measuredMs <= maxMs) return { plan, changed: [] };
  const changed: string[] = [];
  const sections = plan.sections.map((s) => ({ ...s }));
  if (measuredMs > maxMs) {
    let over = measuredMs - maxMs * 0.95;
    const msPerWord = measuredMs / Math.max(1, sections.reduce((a, s) => a + wordCount(s.narration), 0));
    for (const s of [...sections].filter((x) => x.role === "body").sort((a, b) => wordCount(b.narration) - wordCount(a.narration))) {
      if (over <= 0) break;
      const sent = splitSentences(s.narration);
      while (sent.length > 1 && over > 0) { const cut = sent.pop()!; over -= wordCount(cut) * msPerWord; }
      if (sent.join(" ") !== s.narration) { s.narration = sent.join(" "); changed.push(s.id); }
    }
  } else {
    // Too short: add the claims each section has not said yet.
    let under = minMs * 1.05 - measuredMs;
    const msPerWord = measuredMs / Math.max(1, sections.reduce((a, s) => a + wordCount(s.narration), 0));
    for (const s of sections.filter((x) => x.role === "body")) {
      if (under <= 0) break;
      const spoken = s.narration.toLowerCase();
      const extra = s.claimIds.map((id) => spec.claims.find((c) => c.id === id)).filter((c): c is Claim => !!c && c.supported && !spoken.includes(c.text.slice(0, 24).toLowerCase()));
      for (const c of extra) { if (under <= 0) break; const t = controlNarration(c.text); s.narration = `${s.narration} ${t}`; under -= wordCount(t) * msPerWord; if (!changed.includes(s.id)) changed.push(s.id); }
    }
  }
  if (!changed.length) return { plan, changed };
  const introduced = new Set<string>();
  for (const s of sections) {
    if (changed.includes(s.id)) s.visualIntent = { ...s.visualIntent, beats: deriveBeats(s.narration, s.visualIntent.layout, spec, introduced, s.role, s.claimIds) };
    else for (const b of s.visualIntent.beats) for (const t of b.action.targets) introduced.add(t);
  }
  return { plan: { ...plan, sections }, changed };
}
