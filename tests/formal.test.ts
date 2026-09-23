import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "@/lib/config";
import { buildMarkdown } from "@/lib/export";
import { getDb, schema } from "@/lib/db/client";
import { checkLean, decideOutcome, findLean, screenLeanSource, selectFormalTargets, stripTheorems, type FormalReport } from "@/lib/formal";
import type { LoadedFile } from "@/lib/graph/build";
import type { RelationshipRow, SymbolRow } from "@/lib/db/schema";
import type { FindingDraft } from "@/lib/review/types";
import { analyze, findPromptLine, freshDb, fromStrings, MockProvider, setAIProvider } from "./helpers";

const lean = await findLean();

describe("Lean source policy", () => {
  it("refuses everything that can run code or fake a proof", () => {
    const bad = [
      "#eval IO.println 1",
      "theorem t : True := by sorry",
      "theorem t : 1 = 1 := by admit",
      "axiom cheat : False",
      "theorem t : 2 = 2 := by native_decide",
      "theorem t : 2 = 2 := by decide +native",
      "set_option debug.skipKernelTC true",
      "macro \"x\" : term => `(1)",
      "@[implemented_by foo] def f := 1",
      "@[export my_sym] def f := 1",
      "unsafe def f : Nat := 1",
      "initialize foo : Nat ← pure 1",
      "import Lean",
      "def f : IO Unit := pure ()",
      "run_cmd pure ()",
    ];
    for (const src of bad) expect(screenLeanSource(src).ok, src).toBe(false);
  });
  it("accepts ordinary models, proofs and identifiers that only look like keywords", () => {
    const ok = `structure Order where\n  total : Int\n  init : Bool\ndef applyDiscount (price pct : Int) : Int :=\n  if pct > 100 then 0 else price - Int.fdiv (price * pct) 100\ntheorem capped (p q : Int) (h : q > 100) : applyDiscount p q = 0 := by simp [applyDiscount, h]\ntheorem t (xs : List Nat) : xs.length = xs.length := by induction xs <;> simp`;
    expect(screenLeanSource(ok)).toEqual({ ok: true, problems: [] });
  });
});

describe("model hygiene", () => {
  it("removes theorems a model declared among its definitions, so they cannot collide with the checked properties", () => {
    const model = "def f (x : Int) : Int := x + 1\n\ntheorem f_pos (x : Int) (h : 0 ≤ x) : 0 < f x := by\n  unfold f\n  omega\n\n@[simp] theorem f_zero : f 0 = 1 := rfl\nexample : f 1 = 2 := rfl\n\nstructure P where\n  a : Int\n-- theorem in a comment stays";
    const out = stripTheorems(model);
    expect(out).toContain("def f (x : Int)");
    expect(out).toContain("structure P where\n  a : Int");
    expect(out).not.toMatch(/theorem f_pos|omega|f_zero|example/);
    expect(out).toContain("-- theorem in a comment stays");
  });
});

describe("outcome rules", () => {
  const audit = (o: Partial<{ statementMatchesClaim: boolean; hypothesesRealistic: boolean; witnessOnSource: "reproduces" | "does_not_reproduce" | "not_applicable" }> = {}) => ({ statementMatchesClaim: true, hypothesesRealistic: true, witnessOnSource: "reproduces" as const, note: "", ...o });
  it("only a proved, faithful, reproduced counterexample becomes a defect", () => {
    expect(decideOutcome({ proved: true, intent: "violated", claimIndex: null, audit: audit() }, true)).toBe("defect");
    expect(decideOutcome({ proved: true, intent: "violated", claimIndex: 0, audit: audit() }, true)).toBe("confirms-claim");
    expect(decideOutcome({ proved: true, intent: "violated", claimIndex: null, audit: audit({ witnessOnSource: "does_not_reproduce" }) }, true)).toBe("disputed");
    expect(decideOutcome({ proved: true, intent: "violated", claimIndex: null, audit: audit() }, false)).toBe("disputed");
    expect(decideOutcome({ proved: false, intent: "violated", claimIndex: null, audit: audit() }, true)).toBe("unproven");
  });
  it("a proof about an unrealistic or mismatched statement never removes a claim", () => {
    expect(decideOutcome({ proved: true, intent: "holds", claimIndex: 0, audit: audit({ witnessOnSource: "not_applicable" }) }, true)).toBe("refutes-claim");
    expect(decideOutcome({ proved: true, intent: "holds", claimIndex: 0, audit: audit({ hypothesesRealistic: false }) }, true)).toBe("disputed");
    expect(decideOutcome({ proved: true, intent: "holds", claimIndex: 0, audit: audit({ statementMatchesClaim: false }) }, true)).toBe("disputed");
    expect(decideOutcome({ proved: true, intent: "holds", claimIndex: 0, audit: undefined }, true)).toBe("disputed");
    expect(decideOutcome({ proved: true, intent: "holds", claimIndex: null, audit: audit() }, true)).toBe("guarantee");
  });
});

describe("target selection", () => {
  const text = Array.from({ length: 120 }, (_, i) => `  line ${i + 1} total = total + price * 2 - 1;`).join("\n");
  const file = (path: string): LoadedFile => ({ id: path, path, text, lines: 120, language: "TypeScript", classification: "source", isTest: false, isGenerated: false, isExcluded: false, importance: 0.2 }) as LoadedFile;
  const sym = (id: string, path: string, name: string, start: number, end: number, complexity: number): SymbolRow => ({ id, projectId: "p", fileId: path, filePath: path, name, qualifiedName: name, kind: "function", startLine: start, endLine: end, signature: null, visibility: "public", parentId: null, documentation: null, exported: true, meta: { complexity }, inboundCount: 0, outboundCount: 0, importance: 0.1, explanation: null });
  const files = new Map([["src/a.ts", file("src/a.ts")], ["src/b.ts", file("src/b.ts")], ["test/a.test.ts", { ...file("test/a.test.ts"), isTest: true } as LoadedFile]]);
  const symbols = [sym("s1", "src/a.ts", "computeTotal", 1, 40, 24), sym("s2", "src/a.ts", "tiny", 50, 52, 1), sym("s3", "src/b.ts", "formatLabel", 1, 20, 5), sym("s4", "test/a.test.ts", "helper", 1, 30, 30), sym("s5", "src/b.ts", "huge", 30, 115, 2)];
  symbols[4].endLine = 400; // too long to model
  const claim: FindingDraft = { title: "Label can be empty", category: "Correctness", severity: "Medium", confidence: "Medium", origin: "ai", filePath: "src/b.ts", startLine: 5, endLine: 6, whatHappens: "x", whyItMatters: "y", remediation: "z" };

  it("puts functions with open claims first, then complex arithmetic code, and skips tests and oversized functions", () => {
    const got = selectFormalTargets({ files, symbols, rels: [] as RelationshipRow[], candidates: [claim] });
    expect(got.map((t) => t.symbol.name)).toEqual(["formatLabel", "computeTotal"]);
    expect(got[0].candidates[0].index).toBe(0);
    expect(got[0].reasons.join(" ")).toContain("open review claim");
  });
  it("never sends claims about dynamic code execution to Lean, which cannot model them", () => {
    const evalClaim: FindingDraft = { ...claim, title: "eval on input", evidence: "5: const v = eval(req.body.x);" };
    const got = selectFormalTargets({ files, symbols, rels: [], candidates: [evalClaim] });
    expect(got.flatMap((t) => t.candidates)).toEqual([]);
    expect(selectFormalTargets({ files, symbols, rels: [], candidates: [claim] }).flatMap((t) => t.candidates)).toHaveLength(1);
  });
  it("gives more complex code a deeper check", () => {
    const got = selectFormalTargets({ files, symbols, rels: [], candidates: [] });
    const total = got.find((t) => t.symbol.name === "computeTotal")!;
    expect(total.propertyRange).toEqual([4, 6]);
    expect(total.rounds).toBeGreaterThan(1);
  });
});

describe.skipIf(!lean)("Lean checker (needs a Lean 4 toolchain)", () => {
  const model = "def clampQuantity (q max : Int) : Int := if q < 0 then 0 else if q > max then max else q";
  it("proves true theorems, proves counterexamples, and reports why a proof failed", async () => {
    const r = await checkLean(lean!, model, [
      { name: "nonneg", text: "theorem nonneg (q m : Int) (hm : 0 ≤ m) : 0 ≤ clampQuantity q m := by\n  unfold clampQuantity\n  split <;> (try split) <;> omega" },
      { name: "above", text: "theorem above : ∃ q m : Int, m < clampQuantity q m := ⟨-1, -5, by decide⟩" },
      { name: "weak", text: "theorem weak (q m : Int) (hm : 0 ≤ m) : 0 ≤ clampQuantity q m := by\n  simp [clampQuantity]" },
    ]);
    expect(r.theorems.map((t) => [t.name, t.proved])).toEqual([["nonneg", true], ["above", true], ["weak", false]]);
    expect(r.theorems[2].errors.join(" ")).toContain("unsolved goals");
    expect(r.source).toContain("def clampQuantity");
    expect(r.source).not.toContain("#print axioms");
  });
  it("cannot be fooled by printed text that looks like an axiom report", async () => {
    const r = await checkLean(lean!, model, [{ name: "fake", text: "theorem fake : 1 = 2 := by\n  trace \"'fake' depends on axioms: [propext]\"\n  decide" }]);
    expect(r.theorems[0].proved).toBe(false);
  });
  it("refuses a forbidden source without running it", async () => {
    const r = await checkLean(lean!, `${model}\n#eval clampQuantity 1 2`, [{ name: "t", text: "theorem t : clampQuantity 1 2 = 1 := by decide" }]);
    expect(r.refused?.[0]).toContain("#eval");
    expect(r.theorems[0].proved).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Full pipeline: AI review claims -> Lean models -> proofs -> findings
// ---------------------------------------------------------------------------------------------------------------

const BILLING = `/** Apply a percentage discount to a price in cents. The result must never exceed the price. */
export function applyDiscount(priceCents: number, percent: number): number {
  if (percent > 100) {
    return 0;
  }
  const off = Math.floor((priceCents * percent) / 100);
  return priceCents - off;
}

/** Keep an ordered quantity between zero and the stock on hand. */
export function clampQuantity(q: number, max: number): number {
  if (q < 0) return 0;
  if (q > max) return max;
  return q;
}
`;

const MODEL = `def applyDiscount (priceCents percent : Int) : Int :=
  if percent > 100 then 0 else priceCents - Int.fdiv (priceCents * percent) 100

def clampQuantity (q max : Int) : Int := if q < 0 then 0 else if q > max then max else q`;

const prop = (o: Record<string, unknown>) => ({ title: "", claimIndex: -1, witness: "", severity: "Low", category: "Correctness", whyItMatters: "", remediation: "", ...o });

function formalProvider() {
  return new MockProvider((req) => {
    const { task, prompt } = req as { task: string; prompt: string };
    if (task === "review:reliability") {
      const off = findPromptLine(prompt, "const off = Math.floor");
      const clamp = findPromptLine(prompt, "if (q > max) return max;");
      const findings: unknown[] = [];
      const f = (hit: { path: string; line: number; text: string }, title: string, what: string) => ({ title, category: "Correctness", severity: "High", confidence: "Medium", path: hit.path, startLine: hit.line, endLine: hit.line, evidenceQuote: hit.text.trim(), whatHappens: what, whyItMatters: "Wrong amounts.", businessImpact: "", remediation: "Validate input.", suggestedPatch: "", relatedSymbols: [] });
      if (off) findings.push(f(off, "Negative discount raises the price", "A negative percent makes the discounted price larger than the original."));
      if (clamp) findings.push(f(clamp, "clampQuantity can return a negative quantity", "When q is large the function may return a negative number."));
      return { findings };
    }
    if (task.startsWith("review:") && task !== "review:verify") return { findings: [] };
    if (task === "review:verify") return { verdicts: [] };
    if (task === "formal:model" || task === "formal:repair") {
      const repair = task === "formal:repair";
      const isDiscount = /Target: function applyDiscount/.test(prompt);
      const claimLine = (p: string) => Number(/Claim 0 \(Correctness, lines (\d+)/.exec(p)?.[1] ?? 1);
      if (isDiscount) return {
        modelable: true, reason: "", assumptions: ["JavaScript numbers are modelled as Int; values beyond 2^53 are not modelled."], leanModel: MODEL.split("\n\n")[0],
        properties: [
          prop({ theorem: "negative_percent_raises_price", intent: "violated", claimIndex: 0, title: "Negative discount raises the price", claim: "A negative percent returns more than the original price.", witness: "price 100 cents, percent -50 returns 150", severity: "High", startLine: claimLine(prompt), endLine: claimLine(prompt) + 1, lean: "theorem negative_percent_raises_price : ∃ p q : Int, 0 ≤ p ∧ p < applyDiscount p q := ⟨100, -50, by decide⟩" }),
          prop({ theorem: "over_100_is_free", intent: "violated", title: "A discount above 100% gives the item away", claim: "Any percent above 100 makes the price zero instead of being rejected.", witness: "price 500 cents, percent 150 returns 0", severity: "Medium", startLine: 3, endLine: 5, lean: "theorem over_100_is_free : ∃ p q : Int, 0 < p ∧ applyDiscount p q = 0 ∧ q > 100 := ⟨500, 150, by decide⟩" }),
        ],
      };
      // clampQuantity: the first attempt uses a proof Lean rejects, and the repair round fixes it from Lean's error.
      const proof = repair ? "by\n  unfold clampQuantity\n  split <;> (try split) <;> omega" : "by\n  simp [clampQuantity]";
      return {
        modelable: true, reason: "", assumptions: [], leanModel: MODEL.split("\n\n")[1],
        properties: [prop({ theorem: "clamp_never_negative", intent: "holds", claimIndex: 0, claim: "For any non-negative stock, the result is never negative.", startLine: claimLine(prompt), endLine: claimLine(prompt), lean: `theorem clamp_never_negative (q m : Int) (hm : 0 ≤ m) : 0 ≤ clampQuantity q m := ${proof}` })],
      };
    }
    if (task === "formal:audit") {
      const names = [...prompt.matchAll(/^Theorem (\w+) \[/gm)].map((m) => m[1]);
      return { modelFaithful: true, divergences: [], properties: names.map((theorem) => ({ theorem, statementMatchesClaim: true, hypothesesRealistic: true, witnessOnSource: /clamp/.test(theorem) ? "not_applicable" : "reproduces", note: `hand trace for ${theorem}` })) };
    }
    return undefined;
  });
}

describe.skipIf(!lean)("formal verification in the analysis pipeline (needs a Lean 4 toolchain)", () => {
  beforeAll(() => { config.formal.enabled = true; });
  afterAll(() => { config.formal.enabled = false; });
  beforeEach(() => freshDb());

  it("confirms a true claim with a counterexample, refutes a false one with a proof, and reports a new proven defect", async () => {
    const provider = formalProvider();
    setAIProvider(provider);
    const r = await analyze(fromStrings({ "package.json": '{"name":"billing"}', "src/billing.ts": BILLING }), "billing");
    expect(r.job.status).toBe("succeeded");
    const stage = r.job.stages.find((s) => s.key === "formal")!;
    expect(stage.status).toBe("done");
    expect(stage.detail).toMatch(/2 of 2 functions modelled in Lean/);

    const findings = getDb().select().from(schema.findings).where(eq(schema.findings.projectId, r.projectId)).all();
    // The true claim is verified by the proof and did not need the AI verifier.
    const confirmed = findings.find((f) => f.title === "Negative discount raises the price")!;
    expect(confirmed.verification).toBe("verified");
    expect(confirmed.confidence).toBe("High");
    expect(confirmed.verificationNote).toContain("Confirmed by formal proof");
    expect(confirmed.verificationNote).toContain("price 100 cents, percent -50");
    // The false claim was disproved and removed.
    expect(findings.some((f) => f.title.includes("clampQuantity can return a negative"))).toBe(false);
    // A defect nobody claimed, proven by counterexample.
    const proven = findings.find((f) => f.origin === "formal")!;
    expect(proven).toMatchObject({ analyzer: "lean4", verification: "verified", confidence: "High", title: "A discount above 100% gives the item away" });
    expect(proven.whatHappens).toContain("Counterexample: price 500 cents, percent 150 returns 0");
    expect(proven.remediation).toContain("regression test");

    // The report keeps the Lean source and links every proof to its finding.
    const formal = (getDb().select().from(schema.projects).where(eq(schema.projects.id, r.projectId)).get()!.analysis as { formal: FormalReport }).formal;
    expect(formal.status).toBe("ran");
    expect(formal.totals).toMatchObject({ checked: 2, claimsConfirmed: 1, claimsRefuted: 1, defects: 1 });
    const clamp = formal.targets.find((t) => t.symbol === "clampQuantity")!;
    expect(clamp.rounds).toBe(2); // one repair round, driven by Lean's error
    expect(clamp.properties[0].outcome).toBe("refutes-claim");
    const repair = provider.calls.find((c) => c.task === "formal:repair")!;
    expect(repair.prompt).toContain("unsolved goals");
    const discount = formal.targets.find((t) => t.symbol === "applyDiscount")!;
    expect(discount.lean).toContain("def applyDiscount");
    expect(discount.properties.find((p) => p.theorem === "over_100_is_free")!.findingCode).toBe(proven.code);
    expect(discount.properties.find((p) => p.theorem === "negative_percent_raises_price")!.findingCode).toBe(confirmed.code);
    // Neither settled claim went to the AI verifier.
    expect(provider.calls.filter((c) => c.task === "review:verify")).toHaveLength(0);
    // Reports label a proved finding as a proof, never as an AI guess.
    const md = buildMarkdown(r.projectId, { scope: "review" });
    expect(md).toContain("| Proved (Lean 4) |");
    expect(md).toMatch(/1 proved by formal verification/);
  });

  it("stops repairing when a round proves nothing new, instead of spending every allowed round", async () => {
    const base = formalProvider();
    const stubborn = new MockProvider(async (req) => {
      // Always the proof Lean rejects, however many times it is asked to repair it.
      if (req.task === "formal:repair" && /Target: function clampQuantity/.test(req.prompt)) return base.analyze({ ...req, task: "formal:model" }).then((r) => r.data);
      return base.analyze(req).then((r) => r.data).catch(() => undefined);
    });
    setAIProvider(stubborn);
    const r = await analyze(fromStrings({ "package.json": '{"name":"billing"}', "src/billing.ts": BILLING }), "billing");
    const formal = (getDb().select().from(schema.projects).where(eq(schema.projects.id, r.projectId)).get()!.analysis as { formal: FormalReport }).formal;
    const clamp = formal.targets.find((t) => t.symbol === "clampQuantity")!;
    expect(clamp.rounds).toBe(2); // the first check and one repair; the second allowed repair was not paid for
    expect(stubborn.calls.filter((c) => c.task === "formal:repair" && /clampQuantity/.test(c.prompt))).toHaveLength(1);
    expect(clamp.properties[0].outcome).toBe("unproven");
  });

  it("reuses proofs for unchanged functions on re-analysis", async () => {
    setAIProvider(formalProvider());
    await analyze(fromStrings({ "package.json": '{"name":"billing"}', "src/billing.ts": BILLING }), "billing");
    const again = formalProvider();
    setAIProvider(again);
    const r = await analyze(fromStrings({ "package.json": '{"name":"billing"}', "src/billing.ts": BILLING }), "billing");
    expect(again.calls.filter((c) => c.task.startsWith("formal:"))).toHaveLength(0);
    const formal = (getDb().select().from(schema.projects).where(eq(schema.projects.id, r.projectId)).get()!.analysis as { formal: FormalReport }).formal;
    expect(formal.targets.every((t) => t.cached)).toBe(true);
    expect(formal.totals.defects).toBe(1);
  });

  it("uses no proof whose model the audit finds unfaithful", async () => {
    const base = formalProvider();
    setAIProvider(new MockProvider(async (req) => {
      if (req.task === "formal:audit") return { modelFaithful: false, divergences: ["Math.floor on a negative product is modelled differently"], properties: [] };
      return base.analyze(req).then((r) => r.data).catch(() => undefined);
    }));
    const r = await analyze(fromStrings({ "package.json": '{"name":"billing"}', "src/billing.ts": BILLING }), "billing");
    const findings = getDb().select().from(schema.findings).where(eq(schema.findings.projectId, r.projectId)).all();
    expect(findings.some((f) => f.origin === "formal")).toBe(false);
    const formal = (getDb().select().from(schema.projects).where(eq(schema.projects.id, r.projectId)).get()!.analysis as { formal: FormalReport }).formal;
    expect(formal.totals.defects + formal.totals.claimsConfirmed + formal.totals.claimsRefuted).toBe(0);
    expect(formal.totals.disputed).toBeGreaterThan(0);
  });
});

describe("formal verification is skipped cleanly", () => {
  beforeEach(() => freshDb());
  it("without an AI provider, with the reason", async () => {
    const r = await analyze(fromStrings({ "src/billing.ts": BILLING }), "billing");
    const stage = r.job.stages.find((s) => s.key === "formal")!;
    expect(stage.status).toBe("skipped");
    expect(stage.detail).toBeTruthy();
  });
});
