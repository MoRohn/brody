import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SHOTS = process.env.SCREENSHOT_DIR;
const VIEWPORTS = [{ name: "desktop", width: 1440, height: 900 }, { name: "laptop", width: 1100, height: 760 }, { name: "tablet", width: 820, height: 1100 }, { name: "phone", width: 390, height: 844 }];
const LEVELS = ["bright", "original", "default", "dark", "darkest"] as const;
/** Layout does not depend on colour, so two contrasting levels cover it; contrast is checked on all five below. */
const LAYOUT_LEVELS = ["default", "darkest"] as const;
const TABS = ["", "review", "explain", "explain?scale=collections&item=mod%3Asrc%2Fservices", "explain?scale=files", "architecture", "map", "files?path=src%2Fservices%2ForderService.ts", "ask", "deck", "reports", "proofs"];

let base = "";

test.beforeAll(async ({ browser }) => {
  const zip = path.join(os.tmpdir(), `style-shop-${Date.now()}.zip`);
  execFileSync("zip", ["-qr", zip, ".", "-x", "*.DS_Store"], { cwd: path.resolve("fixtures/sample-shop") });
  const page = await browser.newPage();
  await page.goto("http://localhost:" + (process.env.E2E_PORT ?? 3211) + "/");
  await page.getByRole("tab", { name: "ZIP archive" }).click();
  await page.locator('input[aria-label="Select ZIP archive"]').setInputFiles(zip);
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await page.waitForURL(/\/p\/prj_/);
  await expect(page.getByRole("heading", { name: "Engineering review" })).toBeVisible({ timeout: 60_000 });
  base = page.url().replace(/\/$/, "");
  await page.close();
});

const noHorizontalOverflow = async (page: Page, label: string) => {
  const over = await page.evaluate(() => {
    const el = document.scrollingElement!;
    const offenders: string[] = [];
    // The app shell scrolls inside panes, so check the panes and the document, not just <html>.
    for (const node of document.querySelectorAll<HTMLElement>("main, body")) if (node.scrollWidth > node.clientWidth + 2 && getComputedStyle(node).overflowX === "visible") offenders.push(node.tagName);
    return { doc: el.scrollWidth - el.clientWidth, offenders };
  });
  expect(over.doc, `${label}: document scrolls horizontally`).toBeLessThanOrEqual(2);
  expect(over.offenders, `${label}: overflowing containers`).toEqual([]);
};

for (const vp of VIEWPORTS) {
  test(`layout is clean at ${vp.name} (${vp.width}px), default and darkest levels`, async ({ browser }) => {
    for (const scheme of LAYOUT_LEVELS) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      await ctx.addInitScript((l) => { try { localStorage.setItem("brody.theme", l); } catch { /* storage blocked */ } }, scheme);
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
      page.on("pageerror", (e) => errors.push(String(e)));
      const routes = ["/", ...TABS.map((t) => `${base.replace(/^https?:\/\/[^/]+/, "")}/${t}`)];
      for (const r of routes) {
        await page.goto(r);
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(250);
        const label = `${vp.name}/${scheme}${r.replace(/\/p\/prj_[a-z0-9]+/, "")}`;
        await expect(page.locator("body")).not.toContainText("Application error");
        await noHorizontalOverflow(page, label);
        if (SHOTS && (scheme === "darkest" || vp.name === "phone" || vp.name === "tablet")) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${vp.name}-${scheme}-${(r.replace(/\/p\/prj_[a-z0-9]+\/?/, "") || "home").replace(/[^a-z0-9]+/gi, "_")}.png`) }); }
      }
      expect(errors.filter((e) => !/favicon|Failed to load resource: the server responded with a status of 4(04|21)/.test(e)), `${vp.name}/${scheme} console errors`).toEqual([]);
      await ctx.close();
    }
  });
}

test("accessibility: no serious or critical axe violations on any view at any brightness level", async ({ browser }) => {
  test.setTimeout(300_000);
  for (const scheme of LEVELS) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript((l) => { try { localStorage.setItem("brody.theme", l); } catch { /* storage blocked */ } }, scheme);
    const page = await ctx.newPage();
    const problems: string[] = [];
    for (const r of ["/", ...TABS.map((t) => `${base.replace(/^https?:\/\/[^/]+/, "")}/${t}`)]) {
      await page.goto(r);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(400);
      const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
      for (const v of res.violations.filter((x) => x.impact === "serious" || x.impact === "critical")) problems.push(`${scheme} ${r.replace(/\/p\/prj_[a-z0-9]+/, "")}: ${v.id} (${v.impact}) ${v.nodes.length} node(s): ${v.nodes[0].target.join(" ")}`);
    }
    expect(problems).toEqual([]);
    await ctx.close();
  }
});

test("keyboard: search opens with the shortcut, menus close with Escape and are operable", async ({ page }) => {
  await page.goto(base);
  await expect(page.getByLabel("Search repository")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.keyboard.press("Control+k");
  await expect(page.getByLabel("Search repository")).toBeFocused();
  await page.keyboard.press("Escape");
  await page.getByTestId("download-menu-full").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
});
