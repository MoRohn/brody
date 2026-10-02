import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { zipDirectory } from "./zip";
import os from "node:os";
import path from "node:path";

/**
 * An answer becomes an explainer without leaving Brody: Explain ▾ → Video, progress as it happens, then a playable video
 * with captions, chapters and a transcript that seeks it; the interactive explainer, the diagram, the clear explanation,
 * the sources and the validation report all come from the same explanation. (The server runs with the synthetic test
 * voice and the HTML renderer, so the test is deterministic and needs no speech engine or Manim.)
 */
let base = "";
test.beforeAll(async ({ browser }) => {
  const zip = path.join(os.tmpdir(), `explainer-shop-${Date.now()}.zip`);
  zipDirectory(path.resolve("fixtures/sample-shop"), zip);
  const page = await browser.newPage();
  await page.goto("http://localhost:" + (process.env.E2E_PORT ?? 3211) + "/");
  await page.getByRole("tab", { name: "ZIP archive" }).click();
  await page.locator('input[aria-label="Select ZIP archive"]').setInputFiles(zip);
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await page.waitForURL(/\/p\/prj_/);
  await expect(page.getByRole("heading", { name: "Engineering review" })).toBeVisible({ timeout: 60_000 });
  base = new URL(page.url()).pathname.replace(/\/review$/, "").replace(/\/$/, "");
  await page.close();
});

test("Explain ▾ turns an answer into a validated video, an interactive explainer, a diagram and clear text", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(`${base}/ask`);
  await page.getByLabel("Question about the repository").fill("What happens after POST /api/orders?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const explain = page.getByTestId("explain-menu").last();
  await expect(explain).toBeVisible({ timeout: 60_000 });
  await explain.click();
  await expect(page.getByRole("menuitem")).toHaveCount(4);
  await page.getByTestId("explain-video").click();
  const panel = page.getByTestId("explainer-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByText(/Recommended:/)).toBeVisible();

  await panel.getByTestId("start-video").click();
  await expect(panel.getByTestId("explainer-progress")).toBeVisible();
  await expect(panel.getByText("Writing narration")).toBeVisible();
  const video = panel.getByTestId("explainer-video");
  await expect(video).toBeVisible({ timeout: 200_000 });
  await expect.poll(async () => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 30_000 }).toBeGreaterThan(0);
  expect(await video.evaluate((v: HTMLVideoElement) => v.duration)).toBeGreaterThan(5);
  expect(await video.evaluate((v: HTMLVideoElement) => Array.from(v.textTracks).map((t) => t.kind))).toEqual(["captions", "chapters"]);

  // The transcript seeks the video.
  const lines = panel.getByTestId("transcript").getByRole("button");
  await expect(lines.first()).toBeVisible();
  await lines.nth(2).click();
  await expect.poll(async () => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.5);
  await video.evaluate((v: HTMLVideoElement) => v.pause());
  await expect(panel.getByRole("button", { name: /^Regenerate / }).first()).toBeVisible();
  await expect(panel.getByTestId("dl-explainer-video")).toHaveAttribute("href", /video\.mp4\?download=1$/);
  await expect(panel.getByTestId("refine-box")).toBeVisible();

  // The same explanation as an interactive explainer, a diagram, clear text and sources.
  await panel.getByTestId("explainer-tab-interactive").click();
  await expect(panel.getByTestId("interactive-stage").locator("svg")).toBeVisible();
  await panel.getByTestId("interactive-play").click();
  await page.waitForTimeout(800);
  await panel.getByTestId("interactive-play").click();
  await panel.getByTestId("explainer-tab-text").click();
  await expect(panel.getByText(/controlled technical English/)).toBeVisible();
  await panel.getByTestId("explainer-tab-sources").click();
  await expect(panel.getByTestId("explainer-sources").getByRole("link").first()).toBeVisible();
  await panel.getByTestId("explainer-tab-artifacts").click();
  await expect(panel.getByText("Validation passed")).toBeVisible();

  await page.waitForTimeout(500); // let the tab's colour transition finish before measuring contrast
  const axe = await new AxeBuilder({ page }).include('[data-testid="explainer-panel"]').analyze();
  expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.help} ${v.nodes.map((n) => `${n.html.slice(0, 140)} ${n.failureSummary?.slice(0, 160)}`).join(" | ")}`)).toEqual([]);

  // Every explainer of the project is listed on its own page.
  await page.goto(`${base}/explainers`);
  await expect(page.getByTestId("explainer-card")).toHaveCount(1);
  await expect(page.getByTestId("explainer-card").getByText("video ready")).toBeVisible();
});
