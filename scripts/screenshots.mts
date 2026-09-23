/**
 * Capture the README screenshots from a running Brody.
 *   npm run screenshots -- --url http://localhost:3215 --shop <projectId> --self <projectId> [--only progress,review]
 * `--shop` is an analysis of fixtures/sample-shop with AI enabled (review, proofs, usage); `--self` is an analysis of this
 * repository (architecture and code map have more to show on a larger codebase). Images go to docs/screenshots at 2x.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "@playwright/test";

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const url = opt("url") ?? "http://brody:3003";
const shop = opt("shop");
const self = opt("self");
const only = opt("only")?.split(",");
const out = path.resolve("docs/screenshots");
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL === undefined ? "chrome" : process.env.PW_CHANNEL || undefined });

async function shot(name: string, go: (page: Page) => Promise<void>, opts: { level?: string; width?: number; height?: number } = {}) {
  if (only && !only.includes(name)) return;
  const ctx = await browser.newContext({ viewport: { width: opts.width ?? 1440, height: opts.height ?? 900 }, deviceScaleFactor: 2 });
  await ctx.addInitScript((l) => { try { localStorage.setItem("brody.theme", l); } catch { /* storage blocked */ } }, opts.level ?? "default");
  const page = await ctx.newPage();
  await go(page);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  console.log(`docs/screenshots/${name}.png`);
  await ctx.close();
}

const P = (id: string | undefined, rest = "") => { if (!id) throw new Error("missing project id"); return `${url}/p/${id}${rest}`; };

await shot("home", async (p) => { await p.goto(url); });
await shot("progress", async (p) => { await p.goto(P(shop)); await p.getByTestId("usage-inline").waitFor(); });
await shot("overview", async (p) => { await p.goto(P(shop)); await p.getByRole("heading", { name: "Engineering review" }).waitFor(); });
await shot("review", async (p) => {
  await p.goto(P(shop, "/review"));
  // Show a verified finding that carries a validated patch.
  const items = p.locator('section[aria-label="Findings list"] li button');
  await items.first().waitFor();
  const n = await items.count();
  for (let i = 0; i < n; i++) {
    await items.nth(i).click();
    if (await p.getByText("Suggested patch").count()) break;
  }
}, { height: 1000 });
await shot("proofs", async (p) => { await p.goto(P(shop, "/proofs")); await p.getByRole("heading", { name: "Formal Proofs" }).waitFor(); }, { height: 1240 });
await shot("usage", async (p) => { await p.goto(P(shop, "/review")); await p.getByTestId("usage-pill").click(); await p.getByTestId("usage-panel").waitFor(); await p.getByTestId("usage-panel").evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished))); });
await shot("explain", async (p) => { await p.goto(P(shop, "/explain")); });
await shot("files", async (p) => { await p.goto(P(shop, "/files?path=src%2Fservices%2ForderService.ts")); });
await shot("ask", async (p) => {
  await p.goto(P(shop, "/ask"));
  // A structural question, answered exactly from the graph (no AI request).
  await p.getByPlaceholder(/Ask how something works/).fill("Which components depend on createOrder?");
  await p.keyboard.press("Enter");
  await p.getByText(/createOrder/).nth(1).waitFor();
  await p.waitForTimeout(1500);
});
await shot("deck", async (p) => { await p.goto(P(shop, "/deck")); await p.waitForTimeout(1500); });
await shot("architecture", async (p) => { await p.goto(P(self, "/architecture")); });
// A shorter window lets the fitted graph fill the frame instead of floating in empty canvas.
await shot("map", async (p) => { await p.goto(P(self, "/map")); await p.waitForTimeout(1500); }, { height: 720 });
await shot("map-dark", async (p) => { await p.goto(P(self, "/map")); await p.waitForTimeout(1500); }, { level: "darkest", height: 720 });

await browser.close();
