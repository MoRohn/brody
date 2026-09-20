import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Export a project as a Brody bundle and open it again: the whole journey, through the real interface. */
let projectPath = "";
let bundlePath = "";

test.beforeAll(async ({ browser }) => {
  const zip = path.join(os.tmpdir(), `bundle-shop-${Date.now()}.zip`);
  execFileSync("zip", ["-qr", zip, ".", "-x", "*.DS_Store"], { cwd: path.resolve("fixtures/sample-shop") });
  const page = await browser.newPage();
  await page.goto("http://localhost:" + (process.env.E2E_PORT ?? 3211) + "/");
  await page.getByRole("tab", { name: "ZIP archive" }).click();
  await page.locator('input[aria-label="Select ZIP archive"]').setInputFiles(zip);
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await page.waitForURL(/\/p\/prj_/);
  await expect(page.getByRole("heading", { name: "Engineering review" })).toBeVisible({ timeout: 60_000 });
  projectPath = new URL(page.url()).pathname.replace(/\/review$/, "").replace(/\/$/, "");
  await page.close();
  // A bundle on disk for the tests that open one, made up front so they do not depend on each other.
  const id = projectPath.split("/")[2];
  const res = await fetch(`http://localhost:${process.env.E2E_PORT ?? 3211}/api/projects/${id}/export?format=bundle`);
  bundlePath = path.join(os.tmpdir(), `api-${Date.now()}-brody-bundle.zip`);
  fs.writeFileSync(bundlePath, Buffer.from(await res.arrayBuffer()));
});

test("Export > Brody bundle downloads a zip that Brody can open again", async ({ page }) => {
  await page.goto(projectPath);
  await page.getByTestId("download-menu-full").click();
  const row = page.getByRole("menu").getByText("Brody bundle");
  await expect(row).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("dl-bundle-full").click()]);
  expect(download.suggestedFilename()).toMatch(/-brody-bundle\.zip$/);
  bundlePath = path.join(os.tmpdir(), `saved-${Date.now()}-${download.suggestedFilename()}`);
  await download.saveAs(bundlePath);
  expect(fs.statSync(bundlePath).size).toBeGreaterThan(50_000);
  // The Reports page offers it too.
  await page.goto(`${projectPath}/reports`);
  await expect(page.getByTestId("dl-bundle-full")).toBeVisible();
});

test("Open a Brody export: the imported project has the full interface, marked as imported", async ({ page }) => {
  await page.goto("/");
  const toggle = page.getByRole("button", { name: /Open a Brody export/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(page.getByRole("button", { name: "Open export" })).toBeDisabled();
  await page.locator('input[aria-label="Select Brody export"]').setInputFiles(bundlePath);
  await expect(page.locator("#bundle-panel")).toContainText("-brody-bundle.zip");
  await page.getByRole("button", { name: "Open export" }).click();
  await page.waitForURL(/\/p\/prj_/);
  const importedPath = new URL(page.url()).pathname.replace(/\/$/, "");
  expect(importedPath).not.toBe(projectPath); // a new project, not the original

  // Marked as imported, and nothing was re-analysed: it opens straight onto results.
  await expect(page.locator("header").getByText("imported", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Executive summary" })).toBeVisible();
  await expect(page.getByText("Order taking backend").first()).toBeVisible();

  // Every view works on the imported project.
  await page.getByRole("complementary", { name: "Sections" }).getByRole("link", { name: "Code Review" }).click();
  await expect(page.getByText("Likely secret committed in src/config.ts").first()).toBeVisible();
  await page.goto(`${importedPath}/files?path=src%2Fservices%2ForderService.ts`);
  await expect(page.getByLabel("Source code").first()).toContainText("export async function createOrder");
  await page.goto(`${importedPath}/explain`);
  await page.getByRole("tab", { name: /Groups of files/ }).click();
  await expect(page.getByText("What this area is for")).toBeVisible();
  await page.goto(`${importedPath}/architecture`);
  await expect(page.getByRole("heading", { name: "Architecture", exact: true })).toBeVisible();

  // The imported source has the credential redacted.
  const p = new URL(page.url()).pathname.split("/")[2];
  const cfg = await (await page.request.get(`/api/projects/${p}/files/content?path=src/config.ts`)).json();
  expect(JSON.stringify(cfg)).not.toContain("AKIAJ4Q7ZK3M2WXN5PTB");
});

test("dropping an export on the ordinary ZIP upload opens it instead of analysing it as code", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "ZIP archive" }).click();
  await page.locator('input[aria-label="Select ZIP archive"]').setInputFiles(bundlePath);
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await page.waitForURL(/\/p\/prj_/);
  await expect(page.locator("header").getByText("imported", { exact: true })).toBeVisible();
});

test("a file that is not a Brody export is refused with a clear message", async ({ page }) => {
  const bad = path.join(os.tmpdir(), "not-a-bundle.zip");
  fs.writeFileSync(bad, "this is not a zip");
  await page.goto("/");
  await page.getByRole("button", { name: /Open a Brody export/ }).click();
  await page.locator('input[aria-label="Select Brody export"]').setInputFiles(bad);
  await page.getByRole("button", { name: "Open export" }).click();
  await expect(page.locator("#bundle-panel [role=alert]")).toContainText("not a valid ZIP");
});
