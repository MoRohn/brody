import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import http from "node:http";

/**
 * Drives the AI settings panel against a mock OpenAI-compatible endpoint, so no real key or billable call is needed.
 * The server under test is started with OPENAI_BASE_URL pointing at this mock (see playwright.config.ts).
 */
const MOCK_PORT = Number(process.env.E2E_MOCK_AI_PORT ?? 4599);
let server: http.Server;
let extraModel = false;
const chatBodies: { model?: string; response_format?: unknown }[] = [];

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && req.url === "/v1/models") {
      const data = [{ id: "gpt-5", created: 300 }, { id: "gpt-4.1", created: 200 }, { id: "text-embedding-3-small", created: 100 }, { id: "whisper-1", created: 1 }];
      if (extraModel) data.unshift({ id: "gpt-5.5-preview", created: 400 });
      return send(200, { data });
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        chatBodies.push(JSON.parse(raw));
        send(200, { choices: [{ message: { content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } });
      });
      return;
    }
    send(404, { error: { message: "not found" } });
  });
  await new Promise<void>((r) => server.listen(MOCK_PORT, "127.0.0.1", r));
});
test.afterAll(async () => { await new Promise((r) => server.close(r)); });

test("choose a provider, refresh and select models for both APIs, save, test and persist", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /AI settings\. Current: not configured/ })).toBeVisible();
  const opener = page.getByRole("button", { name: /^AI settings\. Current/ });
  await expect(opener.locator("svg")).toBeVisible(); // gear icon
  await expect(opener).toContainText("AI settings");
  await opener.click();
  const panel = page.locator("#ai-settings");
  await expect(panel.getByRole("heading", { name: "AI settings" })).toBeVisible();
  const note = panel.getByTestId("api-key-note");
  await expect(note).toContainText("Where to enter your API key");
  await expect(note).toContainText(".env");
  await expect(note).toContainText("brody restart");
  await expect(panel.getByText(/No key yet: add ANTHROPIC_API_KEY/)).toBeVisible();

  // Anthropic has no key here: built-in suggestions and a clear hint, still selectable.
  const anthropic = panel.getByLabel("Anthropic (Claude) model", { exact: true });
  await expect(anthropic).toBeEnabled();
  await expect(anthropic.locator("option", { hasText: "claude-opus-5" })).toHaveCount(1);
  await expect(panel.getByText(/No Anthropic API key is configured/).first()).toBeVisible();
  await anthropic.selectOption("claude-sonnet-5");

  // OpenAI lists the endpoint's chat models only, then picks up a new model after Refresh.
  const openai = panel.getByLabel("OpenAI (or compatible) model", { exact: true });
  await expect(openai.locator("option")).toHaveText([/gpt-5/, /gpt-4\.1/, /Other model ID/]);
  await expect(panel.getByText(/2 models loaded from the provider/)).toBeVisible();
  extraModel = true;
  await panel.getByRole("button", { name: "Refresh OpenAI (or compatible) models" }).click();
  await expect(openai.locator("option", { hasText: "gpt-5.5-preview" })).toHaveCount(1);

  await panel.getByRole("radio", { name: /OpenAI or compatible/ }).check();
  await openai.selectOption("gpt-4.1");
  const axe = await new AxeBuilder({ page }).include("#ai-settings").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);

  await panel.getByRole("button", { name: "Save and test" }).click();
  await expect(panel.getByRole("status").filter({ hasText: "Working" })).toContainText("gpt-4.1");
  expect(chatBodies.at(-1)?.model).toBe("gpt-4.1");
  await expect(page.getByRole("button", { name: /AI settings\. Current: gpt-4\.1/ })).toBeVisible();

  // Persisted across a reload, for both providers.
  await page.reload();
  await page.getByRole("button", { name: /^AI settings\. Current/ }).click();
  await expect(page.getByRole("radio", { name: /OpenAI or compatible/ })).toBeChecked();
  await expect(page.getByLabel("OpenAI (or compatible) model", { exact: true })).toHaveValue("gpt-4.1");
  await expect(page.getByLabel("Anthropic (Claude) model", { exact: true })).toHaveValue("claude-sonnet-5");

  // A model outside the list can be entered by hand.
  await page.getByLabel("OpenAI (or compatible) model", { exact: true }).selectOption({ label: "Other model ID…" });
  await page.getByLabel("Model ID").fill("my-finetune:v2");
  await page.getByRole("button", { name: "Save and test" }).click();
  await expect(page.locator("#ai-settings").getByRole("status").filter({ hasText: "Working" })).toContainText("my-finetune:v2");

  // Reset returns to the environment (AI off in this run).
  await page.getByRole("button", { name: "Reset to defaults" }).click();
  await expect(page.getByRole("button", { name: /AI settings\. Current: not configured/ })).toBeVisible();
});

test("a failing provider is reported with an actionable hint instead of silently saved as working", async ({ page }) => {
  await page.route("**/api/ai/settings?test=1", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, health: { checked: true, ok: false, provider: "openai-compatible", model: "gpt-4.1", problem: { summary: "The AI provider rejected the API key.", hint: "Check OPENAI_API_KEY for typos." } } } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /^AI settings\. Current/ }).click();
  await page.locator("#ai-settings").getByRole("radio", { name: /OpenAI or compatible/ }).check();
  await page.getByRole("button", { name: "Save and test" }).click();
  await expect(page.locator("#ai-settings").getByRole("alert").filter({ hasText: "the test failed" })).toContainText("Check OPENAI_API_KEY");
  await page.getByRole("button", { name: "Reset to defaults" }).click();
});
