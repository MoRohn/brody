import { expect, test } from "@playwright/test";

/** The brightness control and the brand colours. No project is needed: the home page carries both. */
const rgb = (hex: string) => { const n = parseInt(hex.slice(1), 16); return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`; };
const bodyBg = (page: import("@playwright/test").Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test("uses the requested blues: deep #1B4965 fill and #006C96 accent", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Understand any codebase" })).toBeVisible();
  // Deep navy: the active tab pill. The wordmark's "o" is a white ring around a cerulean dot.
  const activeTab = await page.getByRole("tab", { name: "Files" }).evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(activeTab).toBe(rgb("#1b4965"));
  const o = page.locator(".wordmark-o").first();
  expect(await o.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe(rgb("#ffffff"));
  expect(await o.evaluate((el) => getComputedStyle(el, "::after").backgroundColor)).toBe(rgb("#006c96"));
  const primary = await page.getByRole("button", { name: "Analyze", exact: true }).evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(primary).toBe(rgb("#006c96"));
  await expect.poll(() => bodyBg(page)).toBe(rgb("#d2e0e9"));
});

test("brightness control: slider and named stops change the level, it persists, and Escape closes it", async ({ page }) => {
  await page.goto("/");
  const opener = page.getByRole("button", { name: /^Display brightness: Default/ });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Display brightness" });
  await expect(dialog).toBeVisible();

  await dialog.getByRole("slider", { name: "Brightness level" }).press("End");
  await expect(page.locator("html")).toHaveAttribute("data-level", "darkest");
  await expect.poll(() => bodyBg(page)).toBe(rgb("#09141c"));
  await dialog.getByRole("button", { name: "Bright" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-level", "bright");
  await expect.poll(() => bodyBg(page)).toBe(rgb("#eaf1f5"));
  await dialog.getByRole("button", { name: "Dark", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Dark", exact: true })).toHaveAttribute("aria-pressed", "true");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Display brightness: Dark/ })).toBeFocused();

  // Remembered, and applied before first paint on the next visit (no flash of the default level).
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-level", "dark");
  expect(await page.evaluate(() => localStorage.getItem("brody.theme"))).toBe("dark");

  await page.getByRole("button", { name: /^Display brightness: Dark/ }).click();
  await page.getByRole("button", { name: "Reset to default" }).click();
  await expect.poll(() => bodyBg(page)).toBe(rgb("#d2e0e9"));
});

test("a first visit follows the system dark preference, and a saved choice wins over it", async ({ browser }) => {
  const dark = await browser.newContext({ colorScheme: "dark" });
  const a = await dark.newPage();
  await a.goto("/");
  await expect(a.locator("html")).toHaveAttribute("data-level", "dark");
  await a.evaluate(() => localStorage.setItem("brody.theme", "bright"));
  await a.reload();
  await expect(a.locator("html")).toHaveAttribute("data-level", "bright");
  await dark.close();

  const light = await browser.newContext({ colorScheme: "light" });
  const b = await light.newPage();
  await b.goto("/");
  expect(await b.locator("html").getAttribute("data-level")).toBeNull();
  await light.close();
});

test("the brightness popover has no serious accessibility violations at any level", async ({ page }) => {
  const AxeBuilder = (await import("@axe-core/playwright")).default;
  await page.goto("/");
  await page.getByRole("button", { name: /^Display brightness/ }).click();
  for (const l of ["Bright", "Original", "Default", "Dark", "Darkest"]) {
    await page.getByRole("dialog").getByRole("button", { name: l, exact: true }).click();
    await page.waitForTimeout(500); // let the colour cross-fade finish so axe reads settled colours
    const res = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(res.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")), l).toEqual([]);
  }
});
