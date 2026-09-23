/**
 * Formal verification of the most complex functions with Lean 4.
 *
 * For each chosen function the AI provider writes a pure Lean model of the code and states properties about it as
 * theorems: guarantees the code should keep, and for every open AI review claim either a counterexample (the claim is
 * right) or a proof that the claimed failure cannot happen (the claim is wrong). Lean checks them; its exact errors go back
 * to the model for a few repair rounds, more for more complex code. A theorem is accepted only when Lean proves it with the
 * standard axioms alone (see lean.ts). Because a proof about the wrong model proves nothing, a separate audit then compares
 * the model with the source and replays every counterexample on the original code before anything reaches the review.
 */
import { z } from "zod";
import { SAFETY_PREAMBLE, tryAnalyze, untrusted, type AIProvider, type UsageMeter } from "../ai";
import { config } from "../config";
import type { RelationshipRow, SymbolRow } from "../db/schema";
import { getExplain, putExplain } from "../docs/cache";
import type { LoadedFile } from "../graph/build";
import type { FindingDraft } from "../review/types";
import { mapLimit } from "../util/concurrency";
import { sha256 } from "../util/ids";
import { sliceLines } from "../util/text";
import { checkLean, findLean, leanUnavailableReason, type LeanCheck, type LeanToolchain } from "./lean";
import { selectFormalTargets, type FormalTargetPlan } from "./targets";
import type { FormalProperty, FormalReport, FormalTarget, PropertyOutcome } from "./types";

export * from "./types";
export { findLean, leanUnavailableReason, resetLean, screenLeanSource, checkLean } from "./lean";
export { selectFormalTargets } from "./targets";

/** Bump when the prompts, the policy or the outcome rules change, so cached verdicts are recomputed. */
const FORMAL_VERSION = "2"; // 2: theorems are stripped from models, repairs stop when they stall

const PropertySchema = z.object({
  theorem: z.string(),
  intent: z.enum(["holds", "violated"]),
  claim: z.string(),
  title: z.string(),
  claimIndex: z.number(),
  startLine: z.number(),
  endLine: z.number(),
  witness: z.string(),
  severity: z.enum(["Critical", "High", "Medium", "Low"]),
  category: z.enum(["Correctness", "Reliability", "Security", "Data"]),
  whyItMatters: z.string(),
  remediation: z.string(),
  lean: z.string(),
});

export const FormalPlanSchema = z.object({
  modelable: z.boolean(),
  reason: z.string(),
  assumptions: z.array(z.string()),
  leanModel: z.string(),
  properties: z.array(PropertySchema),
});
export type FormalPlan = z.infer<typeof FormalPlanSchema>;

export const FormalAuditSchema = z.object({
  modelFaithful: z.boolean(),
  divergences: z.array(z.string()),
  properties: z.array(z.object({
    theorem: z.string(),
    statementMatchesClaim: z.boolean(),
    hypothesesRealistic: z.boolean(),
    witnessOnSource: z.enum(["reproduces", "does_not_reproduce", "not_applicable"]),
    note: z.string(),
  })),
});

const LEAN_RULES = `How to write the Lean 4 model (core Lean 4 only: no Mathlib, no imports):
- One \`def\` per source function (the target and any helper it calls), named after it in lowerCamelCase. Use \`structure\` and \`inductive\` for records and enumerations. Definitions must be total: use structural recursion over a List or an explicit \`fuel : Nat\` for loops. No \`partial\`.
- Model behaviour exactly, including the bad paths. Do not fix bugs in the model.
- Integers: use Int (Nat only where the source type guarantees non-negative values). Fixed-width integers that can overflow (Rust u32, Java int, Go int32, C) are BitVec n (then \`bv_decide\` is available). JavaScript numbers used as integers are Int; say in assumptions that values beyond 2^53 are not modelled. Money handled in floating point: model in the smallest unit (cents) as Int only if the code rounds to it; otherwise set modelable=false.
- Never use Float. Never use String manipulation beyond equality.
- Division and remainder differ by language, and this matters: Lean's Int \`/\` and \`%\` round toward negative infinity for positive divisors (Int.ediv/Int.emod). Integer \`/\` and \`%\` in C, Go, Rust and Java, and JavaScript Math.trunc(a / b) and \`%\`, truncate toward zero: use Int.tdiv / Int.tmod. Python \`//\` and \`%\` floor: use Int.fdiv / Int.fmod. JavaScript Math.floor(a / b) is Int.fdiv. Lean defines x / 0 = 0, but JavaScript gives Infinity or NaN and Python raises: model division by zero explicitly (Option or Except).
- Errors and exceptions: \`Except String α\`. null/undefined: \`Option α\`. Array access that can be out of range: \`xs[i]?\`.
- IO (database, network, clock, randomness, async calls): do not model it. Take its result as an extra parameter of the def, and list that in assumptions.
- Forbidden anywhere, including comments and strings: import, #eval/#print/#check or any #-command, sorry, admit, axiom, unsafe, native_decide, set_option, macro, syntax, notation, elab, initialize, IO, extern, implemented_by. They are rejected before Lean runs.

How to write the properties:
- Each property is one \`theorem <name> ... := by ...\` in "lean", with a unique snake_case name. Its statement must mention the model's definitions.
- intent "holds": a guarantee over all inputs the real callers can pass. Hypotheses may only state what the code, its types, its validation or its callers really ensure. Never add hypotheses that exclude the interesting inputs or that contradict each other.
- intent "violated": the code breaks an expected property on a concrete input. State it as an existential with explicit values, e.g. \`theorem discount_can_exceed_price : ∃ p q : Int, 0 ≤ p ∧ p < applyDiscount p q := ⟨100, -50, by decide⟩\`, and describe the input and the wrong result in "witness" (for example "price 100, percent -50 returns 150"). Only claim a violation for inputs the real callers can produce.
- Choose properties that matter for this code: bounds (a total is never negative, a discount never exceeds the price), conservation (amounts add up), monotonicity, idempotence, that it cannot throw for valid input, that a state machine cannot reach an invalid state, that an access check cannot be passed without the required role, agreement with the documented formula and with the project's own tests.
- Useful tactics: \`unfold f\` or \`simp [f]\`, \`split\`, \`omega\` (linear integer arithmetic only; it cannot use x*y of two variables), \`decide\` (concrete, finite facts), \`cases\`, \`induction xs with\`, \`bv_decide\` (BitVec). For products of variables, use lemmas such as Int.mul_le_mul_of_nonneg_left, Int.ediv_le_self, Int.emod_nonneg, Int.emod_lt_of_pos, Int.ediv_mul_le, or case-split to concrete values.
- claimIndex: the number of the review claim the property settles, or -1. For every review claim, write exactly one property with that claimIndex: intent "violated" with a counterexample if the claim is right, or intent "holds" proving the claimed failure cannot happen if the claim is wrong.
- startLine/endLine: the source lines the property is about. severity/category/whyItMatters/remediation describe the defect for "violated" properties (for "holds" use "Low", "Correctness" and empty strings).`;

function describeTarget(t: FormalTargetPlan): string {
  const s = t.symbol;
  const src = sliceLines(t.file.text!, s.startLine, s.endLine).split("\n").map((l, i) => `${s.startLine + i}: ${l}`).join("\n");
  const helpers = t.helpers.map((h) => `Helper ${h.symbol.qualifiedName} (${h.symbol.filePath}:${h.symbol.startLine}-${h.symbol.endLine}):\n${h.text.split("\n").map((l, i) => `${h.symbol.startLine + i}: ${l}`).join("\n")}`).join("\n\n");
  const tests = t.testLines.map((x) => `Test lines in ${x.path}:\n${x.text}`).join("\n\n");
  const claims = t.candidates.map((c, i) => `Claim ${i} (${c.draft.category}, lines ${c.draft.startLine}-${c.draft.endLine}): ${c.draft.title}. ${c.draft.whatHappens}`).join("\n");
  return untrusted([
    `Target: ${s.kind} ${s.qualifiedName} in ${s.filePath}, lines ${s.startLine}-${s.endLine} (${t.file.language}; cyclomatic complexity ${t.complexity})`,
    s.signature ? `Signature: ${s.signature}` : "",
    s.documentation ? `Documentation: ${s.documentation.slice(0, 800)}` : "",
    `Source:\n${src}`,
    helpers,
    tests,
    claims ? `Open review claims about this function:\n${claims}` : "",
  ].filter(Boolean).join("\n\n"));
}

function planPrompt(t: FormalTargetPlan): string {
  return `Formally model the function below in Lean 4 and state properties about it that Lean can check.

${describeTarget(t)}

${LEAN_RULES}

Write between ${t.propertyRange[0]} and ${t.propertyRange[1]} properties in addition to one per review claim.
If the behaviour cannot be modelled faithfully (it is mostly IO, depends on floating-point rounding, or on code not shown), set modelable=false, explain why in "reason", and return no properties.`;
}

function repairPrompt(t: FormalTargetPlan, plan: FormalPlan, check: LeanCheck, round: number, rounds: number): string {
  const issues = [
    check.refused?.length ? `The source was refused before Lean ran:\n- ${check.refused.join("\n- ")}` : "",
    check.modelErrors.length ? `Errors in the model definitions:\n- ${check.modelErrors.join("\n- ")}` : "",
    ...check.theorems.filter((x) => !x.proved).map((x) => `Theorem ${x.name} was not proved:\n- ${x.errors.join("\n- ") || "no proof was accepted"}`),
  ].filter(Boolean).join("\n\n");
  const proved = check.theorems.filter((x) => x.proved).map((x) => x.name);
  return `You modelled the function below in Lean 4 and Lean checked it. Repair round ${round} of ${rounds}.

${describeTarget(t)}

Your previous model:
\`\`\`lean
${plan.leanModel}
\`\`\`

Your previous properties:
${plan.properties.map((p) => `[${p.intent}, claimIndex ${p.claimIndex}] ${p.claim}\n\`\`\`lean\n${p.lean}\n\`\`\``).join("\n\n")}

What Lean reported (these are facts from the checker):
${issues}
${proved.length ? `\nAlready proved: ${proved.join(", ")}. Keep them unchanged unless you must change the model.` : ""}

Return the complete plan again (model and every property) with the errors fixed.
- Fix proofs first. Change a statement only if it was wrong, and then say so in "claim". Never weaken a statement just to make it provable, and never add hypotheses to dodge a counterexample.
- If Lean shows a proposition is false (for example "decide proved that the proposition ... is false"), the property you expected does not hold: switch its intent and prove the opposite with a concrete witness.
- If the model itself was wrong, fix the model to match the source.

${LEAN_RULES}`;
}

function auditPrompt(t: FormalTargetPlan, plan: FormalPlan, proved: FormalPlan["properties"]): string {
  return `You are auditing a Lean 4 model of a function, written by another engineer, before its proofs are trusted. Lean has already checked the proofs, so do not re-check the logic of the proofs. Check the modelling, which Lean cannot: a proof about a model that differs from the code proves nothing about the code.

${describeTarget(t)}

The Lean model:
\`\`\`lean
${plan.leanModel}
\`\`\`
Stated simplifications: ${plan.assumptions.join("; ") || "none"}

Proved properties:
${proved.map((p) => `Theorem ${p.theorem} [${p.intent}]: ${p.claim}${p.witness ? `\nWitness: ${p.witness}` : ""}\n\`\`\`lean\n${p.lean}\n\`\`\``).join("\n\n")}

Answer:
- modelFaithful: does the model compute exactly what the source computes, for every input the callers can pass (including number types, rounding, division, null handling, error paths and branch order)? A stated simplification is acceptable only if it cannot change the properties. List every divergence that matters in "divergences".
- For each theorem: statementMatchesClaim (the Lean statement says what the plain-words claim says, and is not trivial or weaker), hypothesesRealistic (its hypotheses hold for real callers, are not contradictory and do not exclude the relevant inputs), and witnessOnSource: for "violated" properties, execute the ORIGINAL SOURCE by hand on the witness input, step by step, and say "reproduces" only if the source really gives the wrong result; for "holds" properties use "not_applicable". Put the hand trace or the reason in "note".
Be sceptical. When unsure, answer false or "does_not_reproduce".`;
}

export interface FormalRunResult {
  report: FormalReport;
  /** New findings for defects proved by counterexample. Each carries formalRef = "<target id>/<theorem>". */
  drafts: (FindingDraft & { formalRef: string })[];
  /** Verdicts on review claims, keyed by the index of the draft handed in. */
  verdicts: Map<number, { verdict: "confirmed" | "refuted"; note: string; formalRef: string }>;
}

const emptyTotals = (): FormalReport["totals"] => ({ targets: 0, checked: 0, proved: 0, defects: 0, guarantees: 0, claimsConfirmed: 0, claimsRefuted: 0, disputed: 0, unproven: 0 });

/** Is formal verification possible right now, and if not, why not. */
export async function formalAvailability(provider: AIProvider | null): Promise<{ lean: LeanToolchain | null; reason?: string }> {
  if (!config.formal.enabled) return { lean: null, reason: "Disabled by FORMAL_VERIFICATION=off." };
  if (!provider) return { lean: null, reason: "Formal verification needs an AI provider to write the Lean models." };
  const lean = await findLean();
  return lean ? { lean } : { lean: null, reason: leanUnavailableReason() };
}

export async function runFormalVerification(opts: {
  provider: AIProvider;
  meter: UsageMeter;
  lean: LeanToolchain;
  files: Map<string, LoadedFile>;
  symbols: SymbolRow[];
  rels: RelationshipRow[];
  /** AI review candidates that survived deterministic verification. */
  candidates: FindingDraft[];
  onProgress?: (msg: string) => void;
  isCancelled?: () => boolean;
}): Promise<FormalRunResult> {
  const { provider, meter, lean } = opts;
  const plans = selectFormalTargets({ files: opts.files, symbols: opts.symbols, rels: opts.rels, candidates: opts.candidates });
  opts.onProgress?.(`Formal verification: modelling ${plans.length} function(s) in Lean ${lean.version}`);
  const targets = await mapLimit(plans, config.formal.concurrency, async (plan, i) => {
    if (opts.isCancelled?.()) return null;
    const t = await verifyTarget({ plan, id: `t${i + 1}`, provider, meter, lean, isCancelled: opts.isCancelled });
    const got = t.properties.filter((p) => p.proved).length;
    opts.onProgress?.(`Lean: ${t.symbol} (${t.filePath}) ${t.status === "checked" ? `${got}/${t.properties.length} properties proved${t.cached ? " (cached)" : ""}` : t.note}`);
    return { t, plan };
  });

  const drafts: FormalRunResult["drafts"] = [];
  const verdicts: FormalRunResult["verdicts"] = new Map();
  const totals = emptyTotals();
  const done = targets.filter((x): x is { t: FormalTarget; plan: FormalTargetPlan } => !!x);
  for (const { t, plan } of done) {
    totals.targets++;
    if (t.status === "checked") totals.checked++;
    for (const p of t.properties) {
      if (p.proved) totals.proved++;
      const ref = `${t.id}/${p.theorem}`;
      const cand = p.claimIndex !== null ? plan.candidates[p.claimIndex] : undefined;
      const proof = `Machine-checked by Lean ${lean.version}: theorem ${p.theorem} proved (axioms: ${p.axioms.join(", ") || "none"})`;
      if (p.outcome === "defect") {
        totals.defects++;
        const text = plan.file.text!;
        const evidence = sliceLines(text, p.startLine, p.endLine).split("\n").map((l, k) => `${p.startLine + k}: ${l.slice(0, 220)}`).join("\n");
        drafts.push({
          title: p.title.slice(0, 160) || p.claim.slice(0, 160), category: p.category, severity: p.severity, confidence: "High", origin: "formal", analyzer: "lean4",
          filePath: t.filePath, startLine: p.startLine, endLine: p.endLine, evidence,
          whatHappens: `${p.claim} Counterexample: ${p.witness}.`, whyItMatters: p.whyItMatters || "The function returns a wrong result for an input its callers can pass.",
          remediation: `${p.remediation ? `${p.remediation} ` : ""}Add a regression test with the counterexample input (${p.witness}).`,
          relatedComponents: [t.symbol], verification: "verified",
          verificationNote: `${proof}. The audit replayed the counterexample on the source: ${p.audit?.note.slice(0, 300) ?? ""}`, formalRef: ref,
        });
      } else if (p.outcome === "confirms-claim" && cand) {
        totals.claimsConfirmed++;
        verdicts.set(cand.index, { verdict: "confirmed", formalRef: ref, note: `Confirmed by formal proof. ${proof}: counterexample ${p.witness}. ${p.audit?.note.slice(0, 200) ?? ""}` });
      } else if (p.outcome === "refutes-claim" && cand) {
        totals.claimsRefuted++;
        verdicts.set(cand.index, { verdict: "refuted", formalRef: ref, note: `Refuted by formal proof. ${proof}: ${p.claim}` });
      } else if (p.outcome === "guarantee") totals.guarantees++;
      else if (p.outcome === "disputed") totals.disputed++;
      else if (p.outcome === "unproven" || p.outcome === "refused") totals.unproven++;
    }
  }
  return {
    report: { status: "ran", lean: lean.version, model: `${provider.name} (${provider.model})`, generatedAt: Date.now(), targets: done.map((x) => x.t), totals },
    drafts,
    verdicts,
  };
}

function cacheKey(plan: FormalTargetPlan, lean: LeanToolchain, model: string): string {
  const parts = [
    sliceLines(plan.file.text!, plan.symbol.startLine, plan.symbol.endLine),
    ...plan.helpers.map((h) => h.text),
    ...plan.testLines.map((x) => x.text),
    ...plan.candidates.map((c) => `${c.draft.title}|${c.draft.whatHappens}`),
    plan.file.language,
    String(plan.rounds),
  ];
  return `formal:${FORMAL_VERSION}:${lean.version}:${model}:${sha256(parts.join("\u0000")).slice(0, 32)}`;
}

async function verifyTarget(opts: { plan: FormalTargetPlan; id: string; provider: AIProvider; meter: UsageMeter; lean: LeanToolchain; isCancelled?: () => boolean }): Promise<FormalTarget> {
  const { plan, provider, meter, lean } = opts;
  const started = Date.now();
  const s = plan.symbol;
  const base: FormalTarget = {
    id: opts.id, filePath: s.filePath, symbol: s.qualifiedName, kind: s.kind, startLine: s.startLine, endLine: s.endLine, language: plan.file.language,
    complexity: plan.complexity, reasons: plan.reasons, claims: plan.candidates.map((c) => ({ title: c.draft.title, claim: c.draft.whatHappens, startLine: c.draft.startLine ?? s.startLine, endLine: c.draft.endLine ?? s.endLine })),
    status: "failed", note: "", assumptions: [], divergences: [], modelFaithful: null, lean: "", rounds: 0, ms: 0, cached: false, properties: [],
  };
  // Positions are relative to the function in the cache, so a function that only moved within its file is not re-verified.
  const key = cacheKey(plan, lean, provider.model);
  const hit = getExplain<{ target: FormalTarget }>(key)?.target;
  if (hit) {
    const shift = s.startLine - hit.startLine;
    return { ...hit, ...pick(base), cached: true, ms: Date.now() - started, properties: hit.properties.map((p) => ({ ...p, startLine: p.startLine + shift, endLine: p.endLine + shift, findingCode: undefined })) };
  }

  const system = `${SAFETY_PREAMBLE}\n\nYou are also an expert in Lean 4 and formal verification of software.`;
  const plan0 = await tryAnalyze(provider, meter, { task: "formal:model", system, prompt: planPrompt(plan), schema: FormalPlanSchema, maxTokens: 12000 });
  if (!plan0) return { ...base, note: "The AI provider did not return a model.", ms: Date.now() - started };
  if (!plan0.modelable || !plan0.properties.length) {
    const t = { ...base, status: "not-modelable" as const, note: plan0.reason.slice(0, 400) || "The model judged this function unsuitable for a faithful Lean model.", assumptions: plan0.assumptions, ms: Date.now() - started };
    putExplain(key, "formal", { target: t });
    return t;
  }

  // Check, then repair with Lean's own errors. The round with the most proved theorems is kept as one consistent whole,
  // because a later round may change the model and so invalidate earlier proofs.
  let best: { plan: FormalPlan; check: LeanCheck } | null = null;
  let current: FormalPlan = sanitize(plan0, plan);
  let rounds = 0;
  for (;;) {
    const check = await checkLean(lean, current.leanModel, current.properties.map((p) => ({ name: p.theorem, text: p.lean })));
    rounds++;
    const provedCount = check.theorems.filter((x) => x.proved).length;
    const bestCount = best ? best.check.theorems.filter((x) => x.proved).length : -1;
    if (provedCount >= bestCount) best = { plan: current, check };
    // A repair round that proved nothing new is unlikely to be followed by one that does: stop paying for more.
    const stalled = rounds > 1 && provedCount <= bestCount;
    if (provedCount === check.theorems.length || rounds > plan.rounds || stalled || opts.isCancelled?.()) break;
    const next = await tryAnalyze(provider, meter, { task: "formal:repair", system, prompt: repairPrompt(plan, current, check, rounds, plan.rounds), schema: FormalPlanSchema, maxTokens: 12000 });
    if (!next || !next.properties.length) break;
    current = sanitize(next, plan);
  }

  const { plan: final, check } = best!;
  const outcomeOf = new Map(check.theorems.map((x) => [x.name, x]));
  const properties: FormalProperty[] = final.properties.map((p) => {
    const o = outcomeOf.get(p.theorem);
    return {
      theorem: p.theorem, intent: p.intent, claim: p.claim, title: p.title, claimIndex: p.claimIndex >= 0 && p.claimIndex < plan.candidates.length ? p.claimIndex : null,
      startLine: p.startLine, endLine: p.endLine, witness: p.witness, severity: p.severity, category: p.category, whyItMatters: p.whyItMatters, remediation: p.remediation,
      lean: p.lean, proved: !!o?.proved, axioms: o?.axioms ?? [], errors: [...(o?.errors ?? []), ...(check.refused ?? [])].slice(0, 6),
      outcome: check.refused?.length ? "refused" : "unproven",
    };
  });

  // Audit what Lean proved. Without a passing audit nothing reaches the review as a fact.
  const proved = final.properties.filter((p) => outcomeOf.get(p.theorem)?.proved);
  let audit: z.infer<typeof FormalAuditSchema> | undefined;
  if (proved.length && !opts.isCancelled?.()) audit = await tryAnalyze(provider, meter, { task: "formal:audit", system: SAFETY_PREAMBLE, prompt: auditPrompt(plan, final, proved), schema: FormalAuditSchema, maxTokens: 6000 });
  for (const p of properties) {
    if (!p.proved) continue;
    const a = audit?.properties.find((x) => x.theorem === p.theorem);
    if (a) p.audit = { statementMatchesClaim: a.statementMatchesClaim, hypothesesRealistic: a.hypothesesRealistic, witnessOnSource: a.witnessOnSource, note: a.note };
    p.outcome = decideOutcome(p, audit?.modelFaithful ?? false);
  }

  const target: FormalTarget = {
    ...base, status: "checked", note: check.refused?.length ? `Lean source refused: ${check.refused.join("; ")}` : check.modelErrors.length ? `The model did not compile: ${check.modelErrors[0].slice(0, 300)}` : audit ? "" : proved.length ? "The fidelity audit could not be run, so no proof was used in the review." : "",
    assumptions: final.assumptions, divergences: audit?.divergences ?? [], modelFaithful: audit ? audit.modelFaithful : null, lean: check.source, rounds, ms: Date.now() - started, properties,
  };
  // Only complete results are cached: an audit lost to a provider failure should be retried next time.
  if (!proved.length || audit) putExplain(key, "formal", { target: { ...target, cached: false } });
  return target;
}

/** The cached result belongs to the same function text; its identity and position come from the current analysis. */
function pick(b: FormalTarget): Partial<FormalTarget> {
  return { id: b.id, filePath: b.filePath, symbol: b.symbol, startLine: b.startLine, endLine: b.endLine, reasons: b.reasons, claims: b.claims, complexity: b.complexity };
}

/**
 * Theorems belong in the properties, where each is checked and reported on its own. A model that also declares them in its
 * definitions makes Lean reject the duplicates ("has already been declared"), which wastes every repair round, so any
 * theorem, lemma or example in the model text is removed (a declaration runs until the next top-level line).
 */
export function stripTheorems(model: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of model.split("\n")) {
    const topLevel = /^\S/.test(line) && !/^(--|\/-)/.test(line);
    if (topLevel) skipping = /^(@\[[^\]]*\]\s*)?(private\s+|protected\s+)?(theorem|lemma|example)\b/.test(line);
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Keep line numbers inside the function and names usable, whatever the model returned. */
function sanitize(p: FormalPlan, t: FormalTargetPlan): FormalPlan {
  const lo = t.symbol.startLine, hi = t.symbol.endLine;
  const seen = new Set<string>();
  const properties = p.properties.slice(0, t.propertyRange[1] + t.candidates.length + 2).map((x, i) => {
    let name = /^[A-Za-z_][A-Za-z0-9_]*$/.test(x.theorem) ? x.theorem : `p${i + 1}`;
    if (seen.has(name)) name = `${name}_${i + 1}`;
    seen.add(name);
    const start = Math.min(hi, Math.max(lo, Math.floor(x.startLine) || lo));
    return { ...x, theorem: name, startLine: start, endLine: Math.min(hi, Math.max(start, Math.floor(x.endLine) || start)), lean: name === x.theorem ? x.lean : x.lean.replace(new RegExp(`\\btheorem\\s+${x.theorem.replace(/[^A-Za-z0-9_]/g, "")}\\b`), `theorem ${name}`) };
  });
  return { ...p, leanModel: stripTheorems(p.leanModel), properties };
}

/** The rules that turn a proved theorem plus its audit into a review outcome. Everything not listed stays out of the review. */
export function decideOutcome(p: Pick<FormalProperty, "proved" | "intent" | "claimIndex" | "audit">, modelFaithful: boolean): PropertyOutcome {
  if (!p.proved) return "unproven";
  const a = p.audit;
  const sound = modelFaithful && !!a?.statementMatchesClaim && !!a?.hypothesesRealistic;
  if (!sound) return "disputed";
  if (p.intent === "violated") {
    if (a!.witnessOnSource !== "reproduces") return "disputed";
    return p.claimIndex !== null ? "confirms-claim" : "defect";
  }
  return p.claimIndex !== null ? "refutes-claim" : "guarantee";
}
