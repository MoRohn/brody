import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SHOTS = process.env.SCREENSHOT_DIR;
const shot = async (page: import("@playwright/test").Page, name: string) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); } };

test("import → analyze → review → explain → map → explore → ask → export", async ({ page }) => {
  // Build a real ZIP of the fixture repository.
  const zip = path.join(os.tmpdir(), `sample-shop-${Date.now()}.zip`);
  execFileSync("zip", ["-qr", zip, ".", "-x", "*.DS_Store"], { cwd: path.resolve("fixtures/sample-shop") });

  // Intake
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Understand any codebase" })).toBeVisible();
  await expect(page.getByText("AI is not configured")).toBeVisible();
  await shot(page, "01-intake");
  await page.getByRole("tab", { name: "ZIP archive" }).click();
  await page.locator('input[aria-label="Select ZIP archive"]').setInputFiles(zip);
  await expect(page.getByText(/1 file selected/)).toBeVisible();
  await page.getByRole("button", { name: "Analyze", exact: true }).click();

  // Progress: real stages, persisted; survives reload
  await page.waitForURL(/\/p\/prj_/);
  await page.reload();
  await expect(page.getByRole("heading", { name: /Overview|Analysing|Analysis/ }).or(page.getByText("Engineering review"))).toBeVisible({ timeout: 60_000 });

  // Overview
  await expect(page.getByRole("heading", { name: "Engineering review" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Order taking backend that charges customers through Stripe").first()).toBeVisible();
  await shot(page, "02-overview");
  const base = page.url().replace(/\/$/, "");

  // Code review: filters, details with evidence
  await page.getByRole("link", { name: /Code Review/ }).click();
  await expect(page.getByText(/finding/).first()).toBeVisible();
  await page.getByLabel("Filter findings by text").fill("eval");
  await expect(page.getByRole("heading", { name: "Dynamic code evaluation with eval()" })).toBeVisible();
  await expect(page.getByText("Static analyzer").first()).toBeVisible();
  await shot(page, "03-review");
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.getByRole("checkbox", { name: /Critical/ }).click();
  await expect(page.getByRole("checkbox", { name: /Critical/ })).toBeChecked();
  await expect(page.getByText("Likely secret committed in src/config.ts").first()).toBeVisible();

  // System explanation
  await page.getByRole("link", { name: /System Explanation/ }).click();
  await expect(page.getByRole("heading", { name: "Executive summary" })).toBeVisible();
  // Areas and folders are explained as groups on their own level; single files on another.
  await page.getByRole("tab", { name: /Groups of files/ }).click();
  await expect(page.getByText("What this area is for")).toBeVisible();
  await page.getByRole("tab", { name: /Whole system/ }).click();
  await shot(page, "04-explain");

  // Architecture
  await page.getByRole("link", { name: "Architecture", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Architecture", exact: true })).toBeVisible();
  await expect(page.getByText("POST").first()).toBeVisible();
  await expect(page.getByText("Legend").first()).toBeVisible();
  await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 20_000 }); // functional-area graph
  await page.locator("figure").first().scrollIntoViewIfNeeded(); // the ER diagram loads Mermaid only when it scrolls into view
  await expect(page.locator("figure svg").first()).toBeVisible({ timeout: 30_000 });
  await shot(page, "05-architecture");

  // Code map (interactive graph) and change impact
  await page.getByRole("link", { name: /Code Map/ }).click();
  await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await page.locator(".react-flow__node", { hasText: "pricing.ts" }).first().click();
  await expect(page.getByText(/Changing src\/utils\/pricing.ts can affect/)).toBeVisible({ timeout: 15_000 });
  await shot(page, "06-map-impact");

  // Files: code explorer with intelligence panel
  await page.goto(`${base}/files?path=${encodeURIComponent("src/services/orderService.ts")}`);
  await expect(page.getByLabel("Source code").getByText("createOrder").first()).toBeVisible();
  await page.getByRole("button", { name: /createOrder/ }).first().click();
  await expect(page.getByText("Called by (")).toBeVisible();
  await shot(page, "07-files");

  // Ask
  await page.getByRole("link", { name: /Ask Repository/ }).click();
  await page.getByLabel("Question about the repository").fill("Which components depend on createOrder?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByText("POST /api/orders (endpoint)")).toBeVisible();
  await expect(page.getByText("From code graph")).toBeVisible();
  await shot(page, "08-ask");

  // Global search
  await page.getByLabel("Search repository").fill("chargeCustomer");
  await expect(page.getByRole("button", { name: /chargeCustomer/ }).first()).toBeVisible();
  await shot(page, "09-search");
  await page.keyboard.press("Escape");

  // Exports
  const pid = base.match(/\/p\/(prj_[a-z0-9]+)/)![1];
  for (const [fmt, needle] of [["md", "# Repository Intelligence Report"], ["html", "<h2"], ["json", '"documentation"']] as const) {
    const res = await page.request.get(`/api/projects/${pid}/export?format=${fmt}`);
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain(needle);
  }
  const md = await (await page.request.get(`/api/projects/${pid}/export?format=md`)).text();
  expect(md.indexOf("## 1. Executive Summary")).toBeLessThan(md.indexOf("## 18. Detailed Code Map"));
  expect(md).toContain("## 19. Legend");

  // Downloads: PDF, Word and Markdown from the header menu, the overview banner and the Reports page
  await page.goto(base);
  await expect(page.getByTestId("report-ready")).toBeVisible();
  const grab = async (testId: string) => { const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId(testId).first().click()]); const file = path.join(os.tmpdir(), `dl-${Date.now()}-${dl.suggestedFilename()}`); await dl.saveAs(file); return { name: dl.suggestedFilename(), bytes: fs.readFileSync(file) }; };
  const pdf = await grab("dl-pdf-full");
  expect(pdf.name).toMatch(/report\.pdf$/);
  expect(pdf.bytes.subarray(0, 5).toString()).toBe("%PDF-");
  const docx = await grab("dl-docx-full");
  expect(docx.name).toMatch(/report\.docx$/);
  expect(docx.bytes.subarray(0, 2).toString()).toBe("PK");
  const mdFile = await grab("dl-md-full");
  expect(mdFile.name).toBe("CODEBASE_REPORT.md");
  expect(mdFile.bytes.toString()).toContain("## 18. Detailed Code Map");
  await page.getByTestId("download-menu-full").click();
  await expect(page.getByRole("menu", { name: /Repository Intelligence Report downloads/ })).toBeVisible();
  const [popup] = await Promise.all([page.waitForEvent("popup"), page.getByTestId("view-pdf-full").last().click()]);
  await popup.waitForLoadState();
  expect(popup.url()).toContain("format=pdf");
  await popup.close();
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: /^Reports$/ }).click();
  await expect(page.getByRole("heading", { name: "Reports and downloads" })).toBeVisible();
  const review = await grab("dl-pdf-review");
  expect(review.name).toMatch(/code-review\.pdf$/);
  await shot(page, "10-reports");
  // Each result view offers its own download
  await page.goto(`${base}/review`);
  await page.getByTestId("download-menu-review").click();
  await expect(page.getByTestId("dl-docx-review")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.goto(`${base}/ask`);
  await page.getByTestId("download-menu-ask").click();
  await expect(page.getByTestId("dl-md-ask")).toBeVisible();

  // Refresh keeps state
  await page.goto(`${base}/review`);
  await expect(page.getByText(/finding/).first()).toBeVisible();
});

test("invalid inputs give actionable errors", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Import repository/ }).click(); // the import option starts collapsed
  await page.getByLabel("GitHub URL").fill("not a url at all");
  await page.getByRole("button", { name: "Validate" }).click();
  await expect(page.locator("[role=alert]:not(#__next-route-announcer__)")).toContainText("not a recognizable GitHub repository URL");
  const bad = path.join(os.tmpdir(), "broken.zip");
  fs.writeFileSync(bad, "this is not a zip");
  await page.getByRole("tab", { name: "ZIP archive" }).click();
  await page.locator('input[aria-label="Select ZIP archive"]').setInputFiles(bad);
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await expect(page.locator('#upload-panel [role=alert]')).toContainText("not a valid ZIP archive");
  await page.goto("/p/prj_doesnotexist");
  await expect(page.getByText(/does not exist/)).toBeVisible();
});
