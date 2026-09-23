import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * The Formal Proofs page with a populated Lean report (an ordinary e2e run has no AI provider, so the real page only shows
 * its empty state). Layout, contrast and accessibility at every width and brightness level.
 */
const SHOTS = process.env.SCREENSHOT_DIR;
const VIEWPORTS = [{ name: "desktop", width: 1440, height: 900 }, { name: "tablet", width: 820, height: 1100 }, { name: "phone", width: 390, height: 844 }, { name: "small-phone", width: 360, height: 740 }];
const LEVELS = ["bright", "original", "default", "dark", "darkest"] as const;

const model = `def applyDiscount (priceCents percent : Int) : Int :=\n  if percent > 100 then 0 else priceCents - Int.fdiv (priceCents * percent) 100`;
const prop = (o: Record<string, unknown>) => ({ title: "", claimIndex: null, startLine: 6, endLine: 7, witness: "", severity: "Low", category: "Correctness", whyItMatters: "", remediation: "", proved: true, axioms: ["propext"], errors: [], ...o });
const report = {
  status: "ran", lean: "4.34.0", model: "anthropic (claude-opus-5)", generatedAt: Date.now(),
  totals: { targets: 3, checked: 2, proved: 4, defects: 1, guarantees: 1, claimsConfirmed: 1, claimsRefuted: 1, disputed: 0, unproven: 1 },
  targets: [
    {
      id: "t1", filePath: "src/billing/discount.ts", symbol: "applyDiscount", kind: "function", startLine: 2, endLine: 8, language: "TypeScript", complexity: 3,
      reasons: ["1 open review claim to settle", "decides amounts, limits, state or access"], claims: [{ title: "Negative discount raises the price", claim: "A negative percent makes the price larger.", startLine: 6, endLine: 6 }],
      status: "checked", note: "", assumptions: ["JavaScript numbers are modelled as Int; values beyond 2^53 are not modelled.", "Math.floor(a / b) is Int.fdiv."], divergences: [], modelFaithful: true,
      lean: `set_option autoImplicit false\n\n${model}\n\ntheorem negative_percent_raises_price : ∃ p q : Int, 0 ≤ p ∧ p < applyDiscount p q := ⟨100, -50, by decide⟩`, rounds: 1, ms: 5200, cached: false,
      properties: [
        prop({ theorem: "negative_percent_raises_price", intent: "violated", claimIndex: 0, title: "Negative discount raises the price", claim: "A negative percent returns more than the original price.", witness: "price 100 cents, percent -50 returns 150", severity: "High", lean: "theorem negative_percent_raises_price : ∃ p q : Int, 0 ≤ p ∧ p < applyDiscount p q := ⟨100, -50, by decide⟩", audit: { statementMatchesClaim: true, hypothesesRealistic: true, witnessOnSource: "reproduces", note: "Hand trace: percent -50 is not > 100; off = Math.floor(100 * -50 / 100) = -50; returns 100 - (-50) = 150." }, outcome: "confirms-claim", findingCode: "COR-001" }),
        prop({ theorem: "over_100_is_free", intent: "violated", title: "A discount above 100% gives the item away", claim: "Any percent above 100 makes the price zero instead of being rejected.", witness: "price 500 cents, percent 150 returns 0", severity: "Medium", lean: "theorem over_100_is_free : ∃ p q : Int, 0 < p ∧ applyDiscount p q = 0 ∧ q > 100 := ⟨500, 150, by decide⟩", audit: { statementMatchesClaim: true, hypothesesRealistic: true, witnessOnSource: "reproduces", note: "150 > 100, so the early return gives 0." }, outcome: "defect", findingCode: "COR-002" }),
        prop({ theorem: "never_exceeds_price_for_valid_percent", intent: "holds", claim: "For 0 ≤ percent ≤ 100 and a non-negative price, the result never exceeds the price.", lean: "theorem never_exceeds_price_for_valid_percent (p q : Int) (hp : 0 ≤ p) (hq : 0 ≤ q) (hq' : q ≤ 100) : applyDiscount p q ≤ p := by\n  unfold applyDiscount\n  split <;> omega", proved: false, axioms: [], errors: ["line 3: omega could not prove the goal: a possible counterexample may satisfy the constraints -99 ≤ 100*c - d ≤ 0 where c := p * q / 100"], outcome: "unproven" }),
      ],
    },
    {
      id: "t2", filePath: "src/inventory/clampQuantityWithAVeryLongFileNameThatShouldWrap.ts", symbol: "clampQuantity", kind: "function", startLine: 11, endLine: 15, language: "TypeScript", complexity: 3,
      reasons: ["1 open review claim to settle"], claims: [{ title: "clampQuantity can return a negative quantity", claim: "When q is large the function may return a negative number.", startLine: 13, endLine: 13 }],
      status: "checked", note: "", assumptions: [], divergences: [], modelFaithful: true, lean: "def clampQuantity (q max : Int) : Int := if q < 0 then 0 else if q > max then max else q", rounds: 2, ms: 3100, cached: true,
      properties: [
        prop({ theorem: "clamp_never_negative", intent: "holds", claimIndex: 0, claim: "For any non-negative stock, the result is never negative.", startLine: 12, endLine: 14, lean: "theorem clamp_never_negative (q m : Int) (hm : 0 ≤ m) : 0 ≤ clampQuantity q m := by\n  unfold clampQuantity\n  split <;> (try split) <;> omega", axioms: ["propext", "Quot.sound"], audit: { statementMatchesClaim: true, hypothesesRealistic: true, witnessOnSource: "not_applicable", note: "Stock is validated as non-negative by the caller." }, outcome: "refutes-claim" }),
        prop({ theorem: "clamp_is_idempotent", intent: "holds", claim: "Clamping twice gives the same result as clamping once.", startLine: 12, endLine: 14, lean: "theorem clamp_is_idempotent (q m : Int) (hm : 0 ≤ m) : clampQuantity (clampQuantity q m) m = clampQuantity q m := by\n  unfold clampQuantity\n  split <;> split <;> omega", axioms: ["propext"], audit: { statementMatchesClaim: true, hypothesesRealistic: true, witnessOnSource: "not_applicable", note: "" }, outcome: "guarantee" }),
      ],
    },
    { id: "t3", filePath: "src/services/paymentService.ts", symbol: "chargeCustomer", kind: "function", startLine: 5, endLine: 20, language: "TypeScript", complexity: 9, reasons: ["cyclomatic complexity 9"], claims: [], status: "not-modelable", note: "Mostly network calls to the payment provider; the logic that remains depends on floating-point amounts.", assumptions: [], divergences: [], modelFaithful: null, lean: "", rounds: 0, ms: 2100, cached: false, properties: [] },
  ],
};

async function mock(page: Page) {
  const project = { id: "prj_proofs", name: "shop", sourceType: "zip", sourceUrl: null, owner: null, branch: null, commit: null, fileCount: 20, sourceFileCount: 10, totalBytes: 1000, lineCount: 400, languages: {}, status: "ready", incremental: null, previousProjectId: null, createdAt: Date.now(), updatedAt: Date.now(), job: null };
  await page.route("**/api/projects/prj_proofs/**", (route) => {
    const u = route.request().url();
    if (u.includes("/formal")) return route.fulfill({ json: { formal: report } });
    if (u.includes("/overview")) return route.fulfill({ json: { review: { total: 2, bySeverity: { High: 1, Medium: 1 } } } });
    return route.fulfill({ json: {} });
  });
  await page.route(/\/api\/projects\/prj_proofs(\?.*)?$/, (route) => route.fulfill({ json: { project } }));
}

test("the Formal Proofs page reads cleanly and passes accessibility at every width and brightness level", async ({ browser }) => {
  test.setTimeout(240_000);
  const problems: string[] = [];
  for (const vp of VIEWPORTS) for (const level of LEVELS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    await ctx.addInitScript((l) => { try { localStorage.setItem("brody.theme", l); } catch { /* storage blocked */ } }, level);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await mock(page);
    await page.goto("/p/prj_proofs/proofs");
    await expect(page.getByRole("heading", { name: "Formal Proofs" })).toBeVisible();
    await expect(page.getByText("Claim confirmed").first()).toBeVisible();
    await expect(page.getByText("Defect proven")).toBeVisible();
    await expect(page.getByText("Claim refuted")).toBeVisible();
    await expect(page.getByText("Guarantee proven")).toBeVisible();
    await expect(page.getByText("Counterexample:").first()).toBeVisible();
    // Open the Lean source so its layout is checked too.
    await page.getByText("Complete Lean file checked").first().click();
    const over = await page.evaluate(() => { const el = document.scrollingElement!; const main = document.querySelector("main")!; return { doc: el.scrollWidth - el.clientWidth, main: main.scrollWidth - main.clientWidth }; });
    if (over.doc > 2 || over.main > 2) {
      // Name the elements that stick out, so a failure says what to fix.
      const wide = await page.evaluate(() => { const edge = document.querySelector("main")!.getBoundingClientRect().right; return [...document.querySelectorAll("main *")].filter((e) => e.getBoundingClientRect().right > edge + 1 && !e.closest("pre")).slice(0, 4).map((e) => `${e.tagName.toLowerCase()}.${(e as HTMLElement).className.toString().split(" ").slice(0, 2).join(".")} "${(e.textContent ?? "").slice(0, 40)}"`); });
      problems.push(`${vp.name}/${level}: horizontal overflow ${JSON.stringify(over)} from ${wide.join(", ")}`);
    }
    if (vp.name === "desktop" || level === "default" || level === "darkest") {
      const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
      for (const v of res.violations.filter((x) => x.impact === "serious" || x.impact === "critical")) problems.push(`${vp.name}/${level}: ${v.id} (${v.impact}) ${v.nodes[0].target.join(" ")}`);
    }
    if (errors.length) problems.push(`${vp.name}/${level}: ${errors.join("; ")}`);
    if (SHOTS && (level === "default" || level === "darkest")) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `proofs-${vp.name}-${level}.png`), fullPage: vp.name !== "desktop" ? false : true }); }
    await ctx.close();
  }
  expect(problems).toEqual([]);
});
