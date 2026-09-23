import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

/** Web performance budgets against the production build (generous; they catch regressions, not micro-differences). */
const ROUTES = ["", "review", "explain", "architecture", "map", "files?path=src%2Fservices%2ForderService.ts", "ask", "reports", "proofs"];
const BUDGET = { domContentLoadedMs: 2500, lcpMs: 3500, jsKB: 700, apiMs: 800 };
let base = "";

test.beforeAll(async ({ browser }) => {
  const zip = path.join(os.tmpdir(), `perf-shop-${Date.now()}.zip`);
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

test("page load timing, largest contentful paint and JavaScript weight stay within budget", async ({ browser }) => {
  const rows: string[] = [];
  const failures: string[] = [];
  for (const r of ["/", ...ROUTES.map((x) => `${base.replace(/^https?:\/\/[^/]+/, "")}/${x}`)]) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.addInitScript(() => { (window as unknown as { __lcp: number }).__lcp = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) (window as unknown as { __lcp: number }).__lcp = e.startTime; }).observe({ type: "largest-contentful-paint", buffered: true }); });
    await page.goto(r);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);
    const m = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
      const res = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
      const js = res.filter((x) => /\.js(\?|$)/.test(x.name));
      return { dcl: nav.domContentLoadedEventEnd, load: nav.loadEventEnd, lcp: (window as unknown as { __lcp: number }).__lcp, jsKB: js.reduce((a, x) => a + x.transferSize, 0) / 1024, jsRawKB: js.reduce((a, x) => a + x.decodedBodySize, 0) / 1024, reqs: res.length };
    });
    const label = r.replace(/\/p\/prj_[a-z0-9]+/, "") || "/";
    rows.push(`${label.padEnd(44)} dcl ${String(Math.round(m.dcl)).padStart(5)}ms  lcp ${String(Math.round(m.lcp)).padStart(5)}ms  js ${m.jsKB.toFixed(0).padStart(4)} KB transferred / ${m.jsRawKB.toFixed(0).padStart(5)} KB raw  requests ${m.reqs}`);
    if (m.dcl > BUDGET.domContentLoadedMs) failures.push(`${label}: DOMContentLoaded ${Math.round(m.dcl)}ms`);
    if (m.lcp > BUDGET.lcpMs) failures.push(`${label}: LCP ${Math.round(m.lcp)}ms`);
    if (m.jsKB > BUDGET.jsKB) failures.push(`${label}: ${m.jsKB.toFixed(0)} KB JS transferred`);
    await ctx.close();
  }
  console.log("\n" + rows.join("\n"));
  expect(failures).toEqual([]);
});

test("API endpoints answer quickly on a warm server", async ({ request }) => {
  const pid = base.match(/prj_[a-z0-9]+/)![0];
  const paths = ["/api/status", "/api/projects", `/api/projects/${pid}/overview`, `/api/projects/${pid}/findings`, `/api/projects/${pid}/architecture`, `/api/projects/${pid}/files`, `/api/projects/${pid}/graph?type=area`, `/api/projects/${pid}/search?q=order`, `/api/projects/${pid}/report`];
  const rows: string[] = [];
  const slow: string[] = [];
  for (const p of paths) {
    await request.get(p); // warm
    const t: number[] = [];
    for (let i = 0; i < 5; i++) { const s = performance.now(); const res = await request.get(p); expect(res.ok(), p).toBe(true); await res.body(); t.push(performance.now() - s); }
    t.sort((a, b) => a - b);
    rows.push(`${p.replace(pid, ":id").padEnd(44)} median ${t[2].toFixed(0).padStart(4)}ms  max ${t[4].toFixed(0).padStart(4)}ms`);
    if (t[2] > BUDGET.apiMs) slow.push(p);
  }
  console.log("\n" + rows.join("\n"));
  expect(slow).toEqual([]);
});
