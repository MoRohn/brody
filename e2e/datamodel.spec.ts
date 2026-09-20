import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Regression: the ER diagram used to render as empty boxes, list only some models, and show no relationships. */
const SCHEMAS = `from typing import List, Optional
from pydantic import BaseModel


class Integrity(BaseModel):
    status: str
    signals: List[str]


class ScoreBand(BaseModel):
    low: float
    high: float


class RubricInfo(BaseModel):
    id: str
    title: str


class EvaluateResponse(BaseModel):
    score: float
    rubric: RubricInfo
    bands: List[ScoreBand]
    integrity: Optional[Integrity] = None
`;

test("the data model map draws every model with its text, and shows relationships in both directions", async ({ page }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brody-er-"));
  fs.mkdirSync(path.join(dir, "app"));
  fs.writeFileSync(path.join(dir, "app", "schemas.py"), SCHEMAS);
  fs.writeFileSync(path.join(dir, "README.md"), "# scoring\n");
  const zip = path.join(os.tmpdir(), `er-${Date.now()}.zip`);
  execFileSync("zip", ["-qr", zip, "."], { cwd: dir });

  await page.goto("/");
  await page.getByRole("tab", { name: "ZIP archive" }).click();
  await page.locator('input[aria-label="Select ZIP archive"]').setInputFiles(zip);
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await page.waitForURL(/\/p\/prj_/);
  await expect(page.getByRole("heading", { name: "Engineering review" })).toBeVisible({ timeout: 60_000 });
  const base = new URL(page.url()).pathname.replace(/\/review$/, "").replace(/\/$/, "");
  await page.goto(`${base}/architecture`);

  await expect(page.getByText("4 models").first()).toBeVisible();
  await expect(page.getByText("3 relationships").first()).toBeVisible();
  const diagram = page.locator("figure").last();
  await diagram.scrollIntoViewIfNeeded();
  await expect(diagram.locator("svg")).toBeVisible({ timeout: 30_000 });

  // The bug: entity boxes with no text. Every model name and typed attribute must be in the drawing.
  const text = (await diagram.locator("svg").textContent()) ?? "";
  for (const t of ["EvaluateResponse", "RubricInfo", "ScoreBand", "Integrity", "float", "score", "rubric", "bands", "integrity", "FK", "PK"]) expect(text, t).toContain(t);
  expect(await diagram.locator("svg .row-rect-odd").count()).toBeGreaterThan(0);

  // Row colours follow the brightness level: no light rows on a dark theme (unreadable light-on-light before).
  await page.evaluate(() => localStorage.setItem("brody.theme", "darkest"));
  await page.reload();
  await page.locator("figure").last().scrollIntoViewIfNeeded();
  await expect(page.locator("figure svg").last()).toBeVisible({ timeout: 30_000 });
  const rowFill = await page.locator("figure svg .row-rect-odd path").first().evaluate((el) => getComputedStyle(el).fill);
  const m = rowFill.match(/\d+/g)!.map(Number);
  expect(m[0] + m[1] + m[2], `odd row fill ${rowFill}`).toBeLessThan(200); // dark, not near-white

  // The table: typed fields, what each model points to, and what points at it.
  const row = page.getByRole("row", { name: /EvaluateResponse/ }).filter({ hasText: "Points to" }).or(page.getByRole("row").filter({ hasText: "bands: List[ScoreBand]" }));
  await expect(row.first()).toContainText("rubric: RubricInfo");
  await expect(row.first()).toContainText("bands");
  await expect(row.first()).toContainText("[*]");
  const scoreBand = page.getByRole("row").filter({ hasText: "low: float" });
  await expect(scoreBand).toContainText("EvaluateResponse via bands");
});
