/**
 * User-controlled refinement. A request in plain words ("make this shorter", "explain it for a beginner", "redo just the
 * final section and show how dynamic GPU scheduling fixes this") becomes a structured modification of the
 * ExplanationSpec, the NarrationPlan or the scene plan, applied by a new job that reuses everything the edit does not
 * touch. Nothing is rebuilt from the original prompt.
 *
 * Deterministic rules cover the common requests and always win; when none matches and a model is configured, the model
 * maps the request onto the same closed set of operations, constrained to the plan's real section ids.
 */
import { z } from "zod";
import { getAIProvider, SAFETY_PREAMBLE, tryAnalyze, untrusted, UsageMeter } from "../ai";
import { oneOf } from "./compile";
import type { DurationMode, ExplanationArtifactSpec, NarrationPlan, PlanEdits, VideoJobParams } from "./types";

export interface RefinePlan {
  /** What Brody understood, in one line per operation, shown to the user before the job starts. */
  understood: string[];
  kind: "video" | "section";
  params: Partial<VideoJobParams>;
  /** Narration sections that are re-planned. Empty: the plan is reused (re-render or settings change only). */
  sections: string[];
  /** The whole narration is re-planned (duration or audience changes). */
  replanAll: boolean;
  origin: "rules" | "ai" | "fallback";
}

const WORD_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8 };
const STEP_DOWN: Record<DurationMode, DurationMode> = { deep: "standard", standard: "quick", quick: "quick" };
const STEP_UP: Record<DurationMode, DurationMode> = { quick: "standard", standard: "deep", deep: "deep" };
const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "it", "this", "that", "more", "make", "show", "how", "just", "section", "part", "scene", "please", "with", "about", "focus", "clearer", "redo", "explain", "fixes", "fix", "works", "work", "use"]);

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));

/** The section a phrase refers to, by its words against each section's title, claims and concepts. */
export function matchSection(phrase: string, plan: NarrationPlan, spec: ExplanationArtifactSpec): string | null {
  const q = new Set(words(phrase));
  if (!q.size) return null;
  let best: string | null = null, bestScore = 0;
  for (const s of plan.sections) {
    const text = [s.title, s.narration, ...s.claimIds.map((id) => spec.claims.find((c) => c.id === id)?.text ?? ""), ...s.visualIntent.focus.map((id) => spec.concepts.find((k) => k.id === id)?.name ?? "")].join(" ");
    const w = words(text);
    const score = w.filter((x) => q.has(x)).length / Math.sqrt(w.length + 1) + (words(s.title).some((x) => q.has(x)) ? 1 : 0);
    if (score > bestScore) { best = s.id; bestScore = score; }
  }
  return bestScore > 0 ? best : null;
}

/** Supported claims not yet in a section that match the phrase: what "show how X fixes this" can draw on. */
function claimsAbout(phrase: string, spec: ExplanationArtifactSpec, exclude: string[]): string[] {
  const q = new Set(words(phrase));
  return spec.claims.filter((c) => c.supported && !exclude.includes(c.id)).map((c) => ({ c, n: words(c.text).filter((w) => q.has(w)).length })).filter((x) => x.n >= 1).sort((a, b) => b.n - a.n).slice(0, 4).map((x) => x.c.id);
}

export function refineByRules(request: string, plan: NarrationPlan, spec: ExplanationArtifactSpec, current: VideoJobParams): RefinePlan | null {
  const r = request.toLowerCase().trim();
  const understood: string[] = [];
  const params: Partial<VideoJobParams> = {};
  const edits: PlanEdits = {};
  let sections: string[] = [];
  let replanAll = false;
  const bodies = plan.sections.filter((s) => s.role === "body");

  // Duration.
  const secs = r.match(/(\d+)\s*-?\s*(second|sec|s)\b/);
  const mins = r.match(/(\d+|one|two|three|five|ten)\s*-?\s*minutes?/);
  if (secs || mins) {
    const n = secs ? Number(secs[1]) : (Number(mins![1]) || WORD_NUM[mins![1]] || 1) * 60;
    params.duration = n <= 70 ? "quick" : n <= 190 ? "standard" : "deep";
    understood.push(`Target length about ${n} s (${params.duration} explainer).`);
    replanAll = true;
  } else if (/\b(shorter|more concise|tighter|trim|less long|condense)\b/.test(r)) {
    if (current.duration === "quick") { params.lengthFactor = 0.75; understood.push("A quarter shorter."); }
    else { params.duration = STEP_DOWN[current.duration]; understood.push(`Shorter: ${params.duration} explainer.`); }
    replanAll = true;
  } else if (/\b(longer|more detail|in more depth|deeper|expand)\b/.test(r) && !/\bsection\b|\bfocus\b/.test(r)) {
    params.duration = STEP_UP[current.duration];
    understood.push(`Longer: ${params.duration} explainer.`);
    replanAll = true;
  }
  // Audience.
  if (/\b(beginner|newcomer|non-?technical|novice|someone new|a child|layperson|simple terms)\b/.test(r)) { params.audience = "beginner"; understood.push("Audience: beginner (terms defined before use)."); replanAll = true; }
  else if (/\b(expert|advanced|senior engineer|specialist)\b/.test(r)) { params.audience = "expert"; understood.push("Audience: expert."); replanAll = true; }
  if (/\b(simplif(y|ied)|plainer|simpler)\b.*\bnarration\b|\bnarration\b.*\b(simpler|plainer)\b|keep the technical depth/.test(r)) {
    params.instruction = "Use simpler, shorter sentences and plainer words. Keep every technical point.";
    understood.push("Simpler narration, same technical depth.");
    replanAll = true;
  }
  // Voice and execution.
  if (/\blocal voice\b|\b(on-?device|offline) voice\b|\bkeep it local\b/.test(r)) { params.execution = "local"; params.ttsProvider = undefined; understood.push("Narrate with a local voice."); }
  const named = request.match(/\b(?:use|switch to|try) (?:the )?([A-Z][\w-]+) voice\b/);
  if (named) { params.voice = named[1]; understood.push(`Voice: ${named[1]}.`); }
  else if (/\b(change|different|another|new|switch)\b.*\bvoice\b/.test(r)) { params.voice = "__next__"; understood.push("A different voice."); }
  // Motion.
  if (/\bless animated\b|\bfewer animations\b|\bless motion\b|\bcalmer\b|\bstiller\b|\bless movement\b/.test(r)) { params.motion = "reduced"; understood.push("Fewer moving parts: no travelling dots or camera moves."); }
  // Structure.
  if (/\b(remove|drop|skip|cut|no)\b.*\b(intro|introduction|opening|hook)\b/.test(r)) { edits.drop = [...(edits.drop ?? []), "hook"]; understood.push("Remove the opening."); }
  if (/\b(remove|drop|skip|cut|no)\b.*\b(outro|conclusion|takeaway|ending)\b/.test(r)) { edits.drop = [...(edits.drop ?? []), "outro"]; understood.push("Remove the takeaway."); }
  // Hold a picture longer.
  const hold = r.match(/\b(?:make |keep )?(?:the )?(.+?)\s+(?:stay|stays|remain|remains)\s+on screen longer/);
  if (hold) {
    const targets = /diagram|architecture|picture/.test(hold[1]) ? plan.sections.filter((s) => ["architecture", "contention"].includes(s.visualIntent.layout)).map((s) => s.id) : [matchSection(hold[1], plan, spec)].filter((x): x is string => !!x);
    if (targets.length) { edits.holdMs = Object.fromEntries(targets.map((id) => [id, 2500])); understood.push(`Hold ${targets.join(", ")} on screen 2.5 s longer.`); sections = [...sections, ...targets]; }
  }
  // Code.
  if (/\bmore code\b|\bshow (?:the )?code\b/.test(r) && (spec.codeReferences ?? []).length) {
    const codeSources = new Set((spec.codeReferences ?? []).map((c) => c.sourceId));
    const target = bodies.find((s) => s.sourceRefs.some((x) => codeSources.has(x))) ?? bodies[0];
    if (target) { edits.layouts = { ...(edits.layouts ?? {}), [target.specSectionId]: "code" }; sections.push(target.id); understood.push(`Show the cited code in "${target.title}".`); }
  }
  // Regenerate one scene, or redo one section.
  const scene = r.match(/\b(?:regenerate|redo|re-?render|rebuild)\s+(?:just\s+)?(?:the\s+)?(?:scene|section)\s+(\d+|one|two|three|four|five|six|seven|eight)\b/) ?? r.match(/\b(?:regenerate|redo|re-?render)\s+(?:just\s+)?(?:the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth)\s+(?:scene|section)\b/);
  if (scene) {
    const idx = (Number(scene[1]) || WORD_NUM[scene[1]]) - 1;
    const s = plan.sections[idx];
    if (s) { params.forceScenes = [`scene-${s.id}`]; understood.push(`Re-render scene ${idx + 1} (${s.title}).`); }
  }
  const last = r.match(/\b(?:redo|regenerate|rewrite|rework)\s+(?:just\s+)?(?:the\s+)?(?:final|last)\s+(?:section|part|scene)\b(?:\s+and\s+(.*))?/);
  if (last) {
    // "The final section" is the last section that explains something, not the one-line takeaway.
    const target = bodies[bodies.length - 1] ?? plan.sections[plan.sections.length - 1];
    if (target) {
      sections.push(target.id);
      // The instruction keeps the user's own words and casing.
      const rest = request.match(/\b(?:final|last)\s+(?:section|part|scene)\b\s+and\s+(.*)$/i)?.[1]?.trim() ?? last[1]?.trim();
      if (rest) {
        params.instruction = `Rewrite this section to ${rest.replace(/\.$/, "")}. Use only the listed claims.`;
        const add = claimsAbout(rest, spec, target.claimIds);
        if (add.length) edits.addClaims = { ...(edits.addClaims ?? {}), [target.specSectionId]: add };
        understood.push(`Redo "${target.title}" only: ${rest}${add.length ? ` (drawing on ${add.length} more grounded claim${add.length > 1 ? "s" : ""})` : ""}.`);
      } else understood.push(`Redo "${target.title}" only.`);
    }
  }
  const focus = r.match(/\bfocus (?:more )?on (?:the )?(.+?)(?: section| part)?$/) ?? r.match(/\bmake (?:the )?(.+?) (?:section|part) (clearer|simpler|shorter|longer)/);
  if (focus) {
    const target = matchSection(focus[1], plan, spec);
    if (target) {
      const s = plan.sections.find((x) => x.id === target)!;
      sections.push(target);
      const add = claimsAbout(focus[1], spec, s.claimIds);
      if (add.length) edits.addClaims = { ...(edits.addClaims ?? {}), [s.specSectionId]: add };
      params.instruction = focus[2] ? `Make this section ${focus[2]}: one idea per sentence, define terms before using them.` : `Spend more time on ${focus[1]}: explain it step by step with the listed claims.`;
      understood.push(`${focus[2] ? `Make "${s.title}" ${focus[2]}` : `Focus more on ${focus[1]} in "${s.title}"`}.`);
    }
  }
  if (!understood.length) return null;
  if (Object.keys(edits).length) params.edits = edits;
  const uniq = [...new Set(sections)];
  // Whole-video changes re-plan every section; section edits re-plan only theirs; render-only edits re-plan nothing.
  return { understood, kind: replanAll ? "video" : "section", params, sections: replanAll ? [] : uniq.filter((id) => !(edits.drop ?? []).includes(id)), replanAll, origin: "rules" };
}

const AiRefineSchema = z.object({
  understood: z.array(z.string()),
  duration: z.string(),
  audience: z.string(),
  sections: z.array(z.string()),
  instruction: z.string(),
  dropSections: z.array(z.string()),
  holdSections: z.array(z.string()),
  reduceMotion: z.boolean(),
});

export async function resolveRefinement(request: string, plan: NarrationPlan, spec: ExplanationArtifactSpec, current: VideoJobParams): Promise<RefinePlan> {
  const rules = refineByRules(request, plan, spec, current);
  if (rules) return rules;
  const provider = getAIProvider();
  const ids = new Set(plan.sections.map((s) => s.id));
  if (provider) {
    const meter = new UsageMeter();
    const res = await tryAnalyze(provider, meter, {
      task: "explainer-refine",
      system: SAFETY_PREAMBLE,
      prompt: `A user is refining a narrated technical explainer video. Map their request onto these operations only (duration: unchanged, quick, standard or deep; audience: unchanged, beginner, intermediate or expert): change the duration (quick 30-60 s, standard 1-3 min, deep 3-10 min), change the audience, rewrite specific sections with an instruction, drop sections, hold sections on screen longer, or reduce motion. Prefer the smallest change that satisfies the request: rewrite only the sections the request is about.

Current duration: ${current.duration}. Current audience: ${current.audience}.
Sections (id: title - narration):
${untrusted(plan.sections.map((s) => `${s.id}: ${s.title} - ${s.narration.slice(0, 160)}`).join("\n"))}

The user's request: ${untrusted(request)}`,
      schema: AiRefineSchema,
      maxTokens: 1500,
    });
    if (res) {
      const sections = res.sections.filter((id) => ids.has(id));
      const params: Partial<VideoJobParams> = {};
      const duration = oneOf(res.duration, ["unchanged", "quick", "standard", "deep"] as const, "unchanged");
      const audience = oneOf(res.audience, ["unchanged", "beginner", "intermediate", "expert"] as const, "unchanged");
      if (duration !== "unchanged" && duration !== current.duration) params.duration = duration;
      if (audience !== "unchanged" && audience !== current.audience) params.audience = audience;
      if (res.instruction) params.instruction = res.instruction;
      if (res.reduceMotion) params.motion = "reduced";
      const edits: PlanEdits = {};
      const drop = res.dropSections.filter((id) => ids.has(id));
      if (drop.length) edits.drop = drop;
      const hold = res.holdSections.filter((id) => ids.has(id));
      if (hold.length) edits.holdMs = Object.fromEntries(hold.map((id) => [id, 2500]));
      if (Object.keys(edits).length) params.edits = edits;
      const replanAll = !!params.duration || !!params.audience || (!!params.instruction && sections.length === 0);
      return { understood: res.understood.slice(0, 5).length ? res.understood.slice(0, 5) : ["Revise the video as asked."], kind: replanAll ? "video" : "section", params, sections: replanAll ? [] : sections, replanAll, origin: "ai" };
    }
  }
  // No rule matched and no model: apply the request as an instruction to every section.
  return { understood: [`Revise the whole narration: "${request.slice(0, 120)}".`], kind: "video", params: { instruction: request.slice(0, 400) }, sections: [], replanAll: true, origin: "fallback" };
}
