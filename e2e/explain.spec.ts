import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

/** The Explain page separates scales: whole system, groups of files, single files, symbols. */
let base = "";
test.beforeAll(async ({ browser }) => {
  const zip = path.join(os.tmpdir(), `explain-shop-${Date.now()}.zip`);
  execFileSync("zip", ["-qr", zip, ".", "-x", "*.DS_Store"], { cwd: path.resolve("fixtures/sample-shop") });
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

test("four zoom levels, each showing only its own scale", async ({ page }) => {
  await page.goto(`${base}/explain`);
  const tabs = page.getByRole("tablist", { name: "Level of detail" });
  await expect(tabs.getByRole("tab")).toHaveText([/Whole system/, /Groups of files\s*\d+/, /Single files\s*\d+/, /Symbols\s*\d+/]);

  // Whole system: the product-level story, with no per-file or per-folder explanations mixed in.
  await expect(tabs.getByRole("tab", { name: /Whole system/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Executive summary" })).toBeVisible();
  await expect(page.getByText("How the files work together", { exact: true })).toHaveCount(0);
  await expect(page.getByText("What this file does", { exact: true })).toHaveCount(0);

  // Groups of files: areas and folders, explained as units.
  await tabs.getByRole("tab", { name: /Groups of files/ }).click();
  await expect(page).toHaveURL(/scale=collections/);
  const groups = page.getByRole("navigation", { name: "Groups of files" });
  await expect(groups.getByText("Functional areas")).toBeVisible();
  await expect(groups.getByText("Folders")).toBeVisible();
  await groups.getByRole("button", { name: /services\// }).click();
  await expect(page).toHaveURL(/item=mod%3Asrc%2Fservices/);
  await expect(page.getByText("How the files work together", { exact: true })).toBeVisible();
  await expect(page.getByText(/paymentService\.ts is imported by orderService\.ts/)).toBeVisible();
  await expect(page.getByText("What this file does", { exact: true })).toHaveCount(0);
  const table = page.getByRole("table").filter({ hasText: "What this file does on its own" });
  await expect(table.getByRole("row")).toHaveCount(3); // header + two files

  // Drill down from the group to one file, and back up.
  await table.getByRole("button", { name: "src/services/orderService.ts" }).click();
  await expect(tabs.getByRole("tab", { name: /Single files/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("What this file does", { exact: true })).toBeVisible();
  await expect(page.getByText("How the files work together", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Part of the folder/)).toContainText("src/services/");
  await page.getByRole("button", { name: "src/services/", exact: true }).click();
  await expect(page.getByText("How the files work together", { exact: true })).toBeVisible();

  // Areas are groups too.
  await groups.getByRole("button", { name: /Core Services/ }).click();
  await expect(page.getByText("What this area is for")).toBeVisible();
  await expect(page.getByRole("table").filter({ hasText: "What this file does on its own" })).toBeVisible();
});

test("deep links open the right level and item, including a folder that was not pre-generated", async ({ page }) => {
  await page.goto(`${base}/explain?scale=files&item=file:src/utils/pricing.ts`);
  await expect(page.getByRole("heading", { name: "src/utils/pricing.ts" })).toBeVisible();
  await page.goto(`${base}/explain?scale=collections&item=mod:migrations`);
  await expect(page.getByText("How the files work together", { exact: true })).toBeVisible();
  await expect(page.getByText(/single file/)).toBeVisible();
  await page.goto(`${base}/explain?scale=collections&item=mod:no/such/folder`);
  await expect(page.locator("[role=alert]:not(#__next-route-announcer__)")).toContainText("No source files were found");
});

test("explain your own group of files: pick, explain together, and see AI is unavailable without a provider", async ({ page }) => {
  await page.goto(`${base}/explain?scale=collections`);
  await page.getByRole("button", { name: /Your own group/ }).click();
  await page.getByLabel("Find files").fill("services");
  await page.getByRole("button", { name: "Select all shown" }).click();
  await expect(page.getByText("Selected (2)")).toBeVisible();
  await page.getByLabel("Add a folder or file path").fill("src/utils/pricing.ts");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Selected (3)")).toBeVisible();
  await expect(page.getByRole("button", { name: "Explain with AI" })).toBeDisabled();
  await page.getByRole("button", { name: "Explain together", exact: true }).click();
  await expect(page.getByRole("heading", { name: "3 selected files" })).toBeVisible();
  await expect(page.getByText("How the files work together", { exact: true })).toBeVisible();
  await expect(page.getByRole("table").filter({ hasText: "What this file does on its own" }).getByRole("row")).toHaveCount(4);
});

test("every zoom level is free of serious accessibility violations, light and dark", async ({ browser }) => {
  for (const level of ["default", "darkest"]) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript((l) => localStorage.setItem("brody.theme", l), level);
    const page = await ctx.newPage();
    for (const q of ["", "?scale=collections&item=mod:src/services", "?scale=collections&item=custom", "?scale=files", "?scale=symbols"]) {
      await page.goto(`${base}/explain${q}`);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(400);
      const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
      expect(res.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => `${level} ${q}: ${v.id} ${v.nodes[0].target.join(" ")}`)).toEqual([]);
    }
    await ctx.close();
  }
});

test("the executive summary is a business brief, with the in-depth text kept as collapsed Summary evidence", async ({ page }) => {
  await page.goto(`${base}/explain`);
  await expect(page.getByRole("heading", { name: "Executive summary" })).toBeVisible();
  await expect(page.getByText("Order taking backend that charges customers").first()).toBeVisible(); // the headline
  await expect(page.getByRole("list", { name: "Snapshot" }).getByRole("listitem")).toHaveCount(8);
  await expect(page.getByText("Health and risk", { exact: true })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Recommended next step" })).toBeVisible();
  // The in-depth summary is there, but out of the way until asked for.
  const evidence = page.locator("details#summary-evidence");
  await expect(evidence).toBeVisible();
  await expect(evidence).not.toHaveAttribute("open", "");
  await evidence.getByText("Summary evidence").click();
  await expect(evidence.getByText(/Execution begins at/)).toBeVisible();
  await expect(evidence.getByRole("link", { name: /src\/server\.ts/ }).first()).toBeVisible();
});

test("the Overview page opens with the same brief", async ({ page }) => {
  await page.goto(base);
  await expect(page.getByRole("heading", { name: "Executive summary" })).toBeVisible();
  await expect(page.getByText("Order taking backend that charges customers").first()).toBeVisible();
  await expect(page.locator("details#summary-evidence")).toBeVisible();
});
