import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/** AI cost transparency: tokens, model and estimated cost, updating live while an analysis runs. */
const SHOTS = process.env.USAGE_SHOTS_DIR;

function usage(calls: number) {
  const input = calls * 18_000, output = calls * 1_900;
  const cost = (input * 5 + output * 25) / 1e6;
  return {
    calls, inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: cost, costPartial: false, pricesAsOf: "2026-09-23", updatedAt: Date.now(),
    models: [{ provider: "anthropic", model: "claude-opus-5", calls, inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: cost, rate: { input: 5, output: 25, cachedInput: 0.5, cacheWrite: 6.25 }, priceSource: "list", priceBasis: "Anthropic API list price as of 2026-09-23" }],
    stages: [
      { key: "review", label: "AI review", calls: Math.ceil(calls * 0.7), inputTokens: Math.round(input * 0.7), outputTokens: Math.round(output * 0.7), cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: cost * 0.7 },
      { key: "formal", label: "Formal verification (Lean)", calls: Math.floor(calls * 0.3), inputTokens: Math.round(input * 0.3), outputTokens: Math.round(output * 0.3), cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: cost * 0.3 },
    ],
  };
}

async function fakeRun(page: Page) {
  const started = Date.now() - 90_000;
  const labels = ["Importing repository", "Parsing source", "Reviewing code", "Formally verifying complex code (Lean 4)", "Verifying findings"];
  let polls = 0;
  await page.route("**/api/projects/prj_usage*", (route) => {
    polls++;
    const stages = labels.map((label, i) => ({ key: `s${i}`, label, status: i < 2 ? "done" : i === 2 ? "running" : "pending", startedAt: i <= 2 ? started : null, finishedAt: i < 2 ? started + 1000 : null }));
    const project = {
      id: "prj_usage", name: "shop", sourceType: "zip", sourceUrl: null, owner: null, branch: null, commit: null, fileCount: 10, sourceFileCount: 5, totalBytes: 1000, lineCount: 100, languages: {}, status: "analyzing",
      incremental: null, previousProjectId: null, createdAt: started, updatedAt: Date.now(),
      // Each poll the run has made more requests, as a real one would.
      job: { id: "job_u", status: "running", currentStage: "s2", stages, error: null, createdAt: started, startedAt: started, finishedAt: null, log: [], summary: { live: true, model: { provider: "anthropic", model: "claude-opus-5" }, aiUsage: usage(4 + polls * 3) } },
    };
    return route.fulfill({ json: { project } });
  });
}

test("the header shows live tokens and estimated cost, with model, breakdown and pricing basis on demand", async ({ page }) => {
  await fakeRun(page);
  await page.goto("/p/prj_usage");
  const pill = page.getByTestId("usage-pill");
  await expect(pill).toBeVisible();
  await expect(pill).toContainText(/k/);
  await expect(pill).toContainText(/~\$\d/);
  await expect(pill.locator(".live-dot")).toBeVisible();

  // It updates in real time as the run spends tokens.
  const first = await pill.innerText();
  await expect.poll(() => pill.innerText(), { timeout: 8000 }).not.toBe(first);

  // The progress screen shows the same numbers inline.
  const inline = page.getByTestId("usage-inline");
  await expect(inline).toContainText("claude-opus-5");
  await expect(inline).toContainText("Formal verification (Lean)");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/progress.png`, fullPage: true });

  await pill.click();
  const panel = page.getByTestId("usage-panel");
  await expect(panel).toBeVisible();
  await panel.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  await expect(panel).toContainText("claude-opus-5");
  await expect(panel).toContainText("Est. cost");
  await expect(panel).toContainText("Anthropic API list price as of 2026-09-23");
  await expect(panel).toContainText("$5 in · $25 out per 1M");
  if (SHOTS) await panel.screenshot({ path: `${SHOTS}/popover.png` });

  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);

  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(pill).toBeFocused();
});

test("the usage popover fits a phone screen", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await fakeRun(page);
  await page.goto("/p/prj_usage");
  await page.getByTestId("usage-pill").click();
  const panel = page.getByTestId("usage-panel");
  await panel.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  const box = (await panel.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/phone.png` });
  await ctx.close();
});
