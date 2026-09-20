import { expect, test } from "@playwright/test";

/** The home page: one "Select your code" section holding two collapsible options. */
test("Select your code: Upload is open by default, Import is collapsed, and each toggles on its own", async ({ page }) => {
  await page.goto("/");
  const section = page.getByRole("region", { name: "Select your code" }).or(page.locator("section[aria-labelledby='select-h']"));
  await expect(section.getByRole("heading", { name: "Select your code" })).toBeVisible();
  // Exactly one section for both options: no separate cards.
  await expect(page.locator("section[aria-labelledby='select-h']")).toHaveCount(1);

  const upload = page.getByRole("button", { name: /Upload code/ });
  const imp = page.getByRole("button", { name: /Import repository/ });
  await expect(upload).toHaveAttribute("aria-expanded", "true");
  await expect(imp).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#upload-panel")).toBeVisible();
  await expect(page.locator("#import-panel")).toBeHidden();
  await expect(page.getByRole("tab", { name: "Files" })).toBeVisible();

  // Open Import: both can be open together.
  await imp.click();
  await expect(imp).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#import-panel")).toBeVisible();
  await expect(page.locator("#upload-panel")).toBeVisible();

  // A third option opens a Brody export; like Import it starts collapsed.
  await expect(page.getByRole("button", { name: /Open a Brody export/ })).toHaveAttribute("aria-expanded", "false");

  // Text typed into Import survives collapsing it.
  await page.getByLabel("GitHub URL").fill("https://github.com/acme/widgets");
  await imp.click();
  await expect(page.locator("#import-panel")).toBeHidden();
  await expect(imp).toContainText("acme/widgets"); // a collapsed summary of what was entered
  await imp.click();
  await expect(page.getByLabel("GitHub URL")).toHaveValue("https://github.com/acme/widgets");

  // Collapse Upload: it says how many files are ready when some were chosen.
  await page.locator('input[aria-label="Select files"]').setInputFiles([{ name: "a.ts", mimeType: "text/plain", buffer: Buffer.from("export const a = 1;\n") }]);
  await upload.click();
  await expect(page.locator("#upload-panel")).toBeHidden();
  await expect(upload).toContainText("1 file ready");
  await upload.click();
  await expect(page.getByText(/1 file selected/)).toBeVisible();
});

test("the header keeps only the AI settings pill: no ruff pill", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /^AI settings\. Current/ })).toBeVisible();
  await expect(page.locator("header")).not.toContainText(/ruff/i);
});

test("both options are reachable by keyboard", async ({ page }) => {
  await page.goto("/");
  const imp = page.getByRole("button", { name: /Import repository/ });
  await imp.focus();
  await page.keyboard.press("Enter");
  await expect(imp).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Space");
  await expect(imp).toHaveAttribute("aria-expanded", "false");
});

test("the header is text only: the Brody wordmark with its subtitle below, and no logo tile or icon", async ({ page }) => {
  await page.goto("/");
  const brand = page.getByRole("link", { name: "Brody, all projects" });
  await expect(brand).toBeVisible();
  await expect(brand.locator("svg")).toHaveCount(0);
  await expect(brand).toContainText("Repo intel and code review, bro");
  const wordmark = await brand.locator(".wordmark").boundingBox();
  const subtitle = await brand.getByText("Repo intel and code review, bro").boundingBox();
  expect(subtitle!.y).toBeGreaterThan(wordmark!.y + wordmark!.height - 2); // the subtitle sits below the wordmark
  await expect(page.locator("header a[aria-label^='Brody'] rect")).toHaveCount(0);
});
