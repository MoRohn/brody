import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";

const SHOTS = process.env.SCREENSHOT_DIR;

test("the executive deck: a pipeline step, a page with a live preview, and three downloads", async ({ page }) => {
  const zip = path.join(os.tmpdir(), `deck-shop-${Date.now()}.zip`);
  execFileSync("zip", ["-qr", zip, ".", "-x", "*.DS_Store"], { cwd: path.resolve("fixtures/sample-shop") });
  await page.goto("/");
  await page.getByRole("tab", { name: "ZIP archive" }).click();
  await page.locator('input[aria-label="Select ZIP archive"]').setInputFiles(zip);
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await page.waitForURL(/\/p\/prj_/);
  await expect(page.getByRole("heading", { name: "Engineering review" })).toBeVisible({ timeout: 90_000 });
  const base = page.url().replace(/\/$/, "");

  // The analysis includes the deck stage, and it finished.
  const id = base.split("/p/")[1];
  const res = await page.request.get(`/api/projects/${id}`);
  const stages = (await res.json()).project.job.stages as { key: string; status: string; detail?: string }[];
  const deck = stages.find((s) => s.key === "deck")!;
  expect(deck.status).toBe("done");
  expect(deck.detail).toMatch(/13 slides/);

  // The Executive Deck page previews the real deck and offers three downloads.
  await page.getByRole("link", { name: "Executive Deck" }).click();
  await expect(page.getByRole("heading", { name: "Executive summary deck" })).toBeVisible();
  const frame = page.frameLocator('iframe[title="Executive summary deck preview"]');
  await expect(frame.locator(".slide.on svg text").first()).toBeVisible({ timeout: 20_000 });
  await expect(frame.locator("#count")).toHaveText("1 / 13");
  await frame.locator(".slide.on svg").click(); // focus the preview so it receives the keys
  await page.keyboard.press("ArrowRight");
  await expect(frame.locator("#count")).toHaveText("2 / 13");
  await expect(frame.locator(".slide.on")).toContainText("The system in brief");
  await page.keyboard.press("o");
  await expect(frame.locator(".slide").first()).toBeVisible();
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, "deck-page.png") }); }

  const download = async (format: string, testId: string) => {
    const [d] = await Promise.all([page.waitForEvent("download"), page.getByTestId(testId).click()]);
    const file = path.join(os.tmpdir(), `deck-${Date.now()}-${d.suggestedFilename()}`);
    await d.saveAs(file);
    expect(d.suggestedFilename()).toMatch(new RegExp(`-executive-summary\\.${format}$`));
    return fs.readFileSync(file);
  };
  const pptx = await download("pptx", "dl-deck-pptx");
  const parts = Object.keys(unzipSync(new Uint8Array(pptx)));
  expect(parts.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))).toHaveLength(13);
  const pdf = await download("pdf", "dl-deck-pdf");
  expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  const html = await download("html", "dl-deck-html");
  expect(html.toString()).toContain("Executive summary");

  // The Reports page offers the same three, and the report itself has not changed.
  await page.getByRole("link", { name: "Reports", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Executive Summary Deck" })).toBeVisible();
  await expect(page.getByTestId("dl-deck-pptx")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Repository Intelligence Report" })).toBeVisible();
  const md = await (await page.request.get(`/api/projects/${id}/export?format=md&scope=full`)).text();
  expect(md).toContain("## 1. Executive Summary");
  expect(md.toLowerCase()).not.toContain("executive deck");
});
