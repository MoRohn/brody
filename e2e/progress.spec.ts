import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** In-progress feedback: nothing that takes time may look idle or frozen. */
const LABELS = ["Importing repository", "Enumerating files", "Parsing source", "Building symbol and dependency graph", "Indexing for retrieval", "Detecting architecture", "Running static analysis", "Reviewing code", "Verifying findings", "Generating documentation", "Building code map", "Finalizing report"];

async function fakeRunningProject(page: Page, runningIndex = 7) {
  const started = Date.now() - 65_000;
  const stages = LABELS.map((label, i) => ({
    key: `s${i}`, label,
    status: i < runningIndex ? "done" : i === runningIndex ? "running" : "pending",
    detail: i < runningIndex ? "ok" : i === runningIndex ? null : null,
    startedAt: i <= runningIndex ? started + i * 2000 : null,
    finishedAt: i < runningIndex ? started + i * 2000 + 1500 : null,
  }));
  const project = {
    id: "prj_fakerunning", name: "demo", sourceType: "zip", sourceUrl: null, owner: null, branch: null, commit: null, fileCount: 10, sourceFileCount: 5, totalBytes: 1000, lineCount: 100, languages: {}, status: "analyzing",
    incremental: null, previousProjectId: null, createdAt: started, updatedAt: Date.now(),
    job: { id: "job_fake", status: "running", currentStage: `s${runningIndex}`, stages, error: null, createdAt: started, startedAt: started, finishedAt: null, log: ["started"], summary: null },
  };
  await page.route("**/api/projects/prj_fakerunning*", (route) => route.fulfill({ json: { project } }));
}

test("a running analysis shows a spinner, a moving bar, the current step and live timers", async ({ page }) => {
  await fakeRunningProject(page);
  await page.goto("/p/prj_fakerunning");
  await expect(page.getByRole("heading", { name: /Analysing/ })).toBeVisible();

  // Header spinner and the running row's spinner are actually turning.
  const spinners = page.locator(".spinner");
  await expect(spinners.first()).toBeVisible();
  expect(await spinners.first().evaluate((el) => getComputedStyle(el).animationName)).toBe("spin");
  const row = page.getByRole("listitem").filter({ hasText: "Reviewing code" });
  await expect(row).toHaveAttribute("aria-current", "step");
  await expect(row.locator(".spinner")).toBeVisible();

  // The bar has a moving highlight and is never empty: 7 done + half of the running step out of 12.
  const bar = page.getByRole("progressbar", { name: "Analysis progress" });
  await expect(bar).toHaveClass(/running/);
  const width = await bar.locator(".bar").evaluate((el) => (el as HTMLElement).style.width);
  expect(parseFloat(width)).toBeCloseTo(((7 + 0.5) / 12) * 100, 0);
  expect(await bar.locator(".bar").evaluate((el) => getComputedStyle(el, "::after").animationName)).toBe("shimmer");

  // Plain-language status for screen readers and everyone else, and the tab title says work is happening.
  await expect(page.getByRole("status").filter({ hasText: "Step 8 of 12: Reviewing code" })).toBeVisible();
  await expect(page).toHaveTitle(/Analysing demo/);

  // Timers tick without any server update.
  const before = await row.locator("span.tabular-nums").last().innerText();
  await expect.poll(async () => row.locator("span.tabular-nums").last().innerText(), { timeout: 5000 }).not.toBe(before);

  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);
});

test("with reduced motion the rings still turn, only slower, and the bar stays visible", async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await fakeRunningProject(page);
  await page.goto("/p/prj_fakerunning");
  const spinner = page.locator(".spinner").first();
  await expect(spinner).toBeVisible();
  // Poll: the locator re-resolves each time, so it is robust to the page swapping its loading spinner for the real one.
  await expect.poll(() => spinner.evaluate((el) => { const s = getComputedStyle(el); return { name: s.animationName, duration: s.animationDuration }; }), { timeout: 10_000 }).toEqual({ name: "spin", duration: "2.4s" });
  await expect(page.getByRole("progressbar", { name: "Analysis progress" })).toBeVisible();
  await ctx.close();
});

test("buttons that start work show a ring and a busy label while they wait", async ({ page }) => {
  await page.goto("/");
  // AI settings: refreshing the model list.
  await page.route("**/api/ai/models?provider=openai-compatible&refresh=1", async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue(); });
  await page.getByRole("button", { name: /^AI settings\. Current/ }).click();
  const refresh = page.getByRole("button", { name: "Refresh OpenAI (or compatible) models" });
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect(refresh).toHaveAttribute("aria-busy", "true");
  await expect(refresh).toHaveText(/Refreshing/);
  expect(await refresh.evaluate((el) => getComputedStyle(el, "::before").animationName)).toBe("spin");
  await expect(refresh).not.toHaveAttribute("aria-busy", "true", { timeout: 10_000 });

  // Upload: the button, a progress bar and a status line all show activity while the server works.
  await page.route("**/api/projects/upload", async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.fulfill({ status: 400, json: { error: { code: "invalid_upload", message: "Stopped by the test." } } }); });
  await page.getByRole("button", { name: "Close" }).click();
  await page.locator('input[aria-label="Select files"]').setInputFiles({ name: "a.ts", mimeType: "text/plain", buffer: Buffer.from("export const a = 1;\n") });
  const analyze = page.getByRole("button", { name: /Analyze|Uploading/ });
  await analyze.click();
  await expect(analyze).toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("progressbar", { name: "Upload progress" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: /Uploading|Upload received/ })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "Stopped by the test." })).toBeVisible();
  await expect(analyze).not.toHaveAttribute("aria-busy", "true");
});

test("a project list row shows a spinner while its analysis is running", async ({ page }) => {
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({ json: { projects: [{ id: "prj_x", name: "busy-one", sourceType: "zip", sourceUrl: null, branch: null, commit: null, fileCount: 3, status: "analyzing", updatedAt: Date.now(), languages: {} }] } });
  });
  await page.goto("/");
  const chip = page.getByRole("row", { name: /busy-one/ }).locator(".chip");
  await expect(chip).toContainText("analysing");
  await expect(chip.locator(".spinner")).toBeVisible();
});

test("regression: a folder larger than 10 MB uploads and analyses instead of failing as a broken multipart form", async ({ page }) => {
  test.setTimeout(240_000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brody-bigfolder-"));
  fs.mkdirSync(path.join(dir, "src"));
  let total = 0;
  // Large in bytes but light to analyse: mostly comments, a handful of functions per file.
  const filler = `// ${"lorem ipsum dolor sit amet consectetur ".repeat(6)}`;
  for (let i = 0; i < 200; i++) {
    const lines = Array.from({ length: 300 }, (_, j) => (j % 30 === 0 ? `export function fn${i}_${j}(a: number, b: number) { return a * ${j} + b - ${(i * 7919 + j * 104729) % 99991}; }` : `${filler}${i}.${j}`));
    const body = lines.join("\n");
    fs.writeFileSync(path.join(dir, "src", `mod${i}.ts`), body);
    total += body.length;
  }
  expect(total).toBeGreaterThan(11 * 1024 * 1024); // beyond Next's default 10 MB proxy body buffer
  await page.goto("/");
  await page.getByRole("tab", { name: "Folder" }).click();
  await page.locator('input[aria-label="Select folder"]').setInputFiles(dir);
  await expect(page.getByText(/200 files selected/)).toBeVisible();
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  // Reaching the project page proves the whole body arrived intact and parsed as a multipart form.
  await page.waitForURL(/\/p\/prj_/, { timeout: 150_000 });
  const projectId = new URL(page.url()).pathname.split("/")[2];
  const info = await (await page.request.get(`/api/projects/${projectId}`)).json();
  expect(info.project.fileCount).toBe(200);
  // Do not leave the analysis running in the background of the other tests.
  if (info.project.job?.id) await page.request.post(`/api/jobs/${info.project.job.id}/cancel`);
  await page.request.delete(`/api/projects/${projectId}`);
  fs.rmSync(dir, { recursive: true, force: true });
});
