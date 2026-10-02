import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { zipDirectory } from "./zip";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Code Review → AI fix prompt: every issue condensed with its fix, copied or downloaded as Markdown. */
let base = "";
test.beforeAll(async ({ browser }) => {
  const zip = path.join(os.tmpdir(), `fixprompt-shop-${Date.now()}.zip`);
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

test("the AI fix prompt lists every issue with its fix and can be copied or downloaded", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`${base}/review`);
  await page.getByTestId("fix-prompt-open").click();
  const dialog = page.getByRole("dialog", { name: "AI fix prompt" });
  await expect(dialog).toBeVisible();
  const issues = dialog.getByTestId("fix-prompt-issues").getByRole("listitem");
  await expect(issues.first()).toBeVisible();
  await expect(issues.first()).toContainText("Fix:");
  await expect(dialog.getByTestId("fix-prompt-stats")).toContainText(/condensed into \d+ issue/);

  // Options change the prompt.
  await dialog.getByLabel("Suggested patches").uncheck();
  await dialog.getByTestId("fix-prompt-tab-prompt").click();
  const md = dialog.getByTestId("fix-prompt-markdown");
  await expect(md).toContainText("# Fix the issues Brody found in");
  await expect(md).not.toContainText("Suggested patch (");

  await dialog.getByTestId("fix-prompt-copy").click();
  await expect(dialog.getByText("Copied to the clipboard.")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^# Fix the issues Brody found in/);

  const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByTestId("fix-prompt-download").click()]);
  expect(download.suggestedFilename()).toMatch(/-fix-prompt\.md$/);
  const text = fs.readFileSync((await download.path())!, "utf8");
  expect(text).toContain("## Ground rules");
  expect(text).not.toContain("Suggested patch (");

  await page.waitForTimeout(400);
  const axe = await new AxeBuilder({ page }).include('[data-testid="fix-prompt-dialog"]').analyze();
  expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 100)).join(" | ")}`)).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
