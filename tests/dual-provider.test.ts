import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getModels } from "@/app/api/ai/models/route";
import { GET as getSettings, PUT as putSettings } from "@/app/api/ai/settings/route";
import { AnthropicProvider } from "@/lib/ai/anthropic";
import { checkProvider, getAIProvider, providerStatus, resetProviderCache, setAIProvider } from "@/lib/ai";
import { BUILTIN_MODELS, clearModelCache, listModels } from "@/lib/ai/models";
import { classifyOpenAIModel, OpenAICompatibleProvider } from "@/lib/ai/openai";
import { readSettings, resetSettingsCache, resolveModel, resolveProvider, updateSettings } from "@/lib/ai/settings";
import { config } from "@/lib/config";

const schema = z.object({ answer: z.string() });
const req = { task: "t", system: "s", prompt: "p", schema };
const chat = (content: string, extra: Record<string, unknown> = {}, msg: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ choices: [{ message: { content, ...msg }, ...extra }], usage: { prompt_tokens: 7, completion_tokens: 3 } }), { status: 200 });
const bad = (detail: string, status = 400) => new Response(JSON.stringify({ error: { message: detail } }), { status });

const original = { ...config.ai };
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "brody-ai-"));
  process.env.AI_SETTINGS_PATH = path.join(dir, "ai-settings.json");
  resetSettingsCache();
  setAIProvider(undefined);
  resetProviderCache();
  clearModelCache();
  Object.assign(config.ai, { provider: "auto", anthropicApiKey: undefined, openaiApiKey: undefined, openaiBaseUrl: "https://api.openai.com/v1", anthropicModel: undefined, openaiModel: undefined, legacyModel: undefined, embeddingModel: undefined });
});
afterEach(() => {
  vi.unstubAllGlobals();
  Object.assign(config.ai, original);
  delete process.env.AI_SETTINGS_PATH;
  setAIProvider(undefined);
  resetProviderCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

function stubFetch(fn: (url: string, body: Record<string, unknown> | undefined, init: RequestInit) => Response) {
  const calls: { url: string; body?: Record<string, unknown>; headers: Record<string, string> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ url, body, headers: init.headers as Record<string, string> });
    return fn(url, body, init);
  }));
  return calls;
}

describe("OpenAI compatibility", () => {
  it("defaults to an OpenAI model, never a Claude model", () => {
    Object.assign(config.ai, { legacyModel: undefined, openaiApiKey: "k" });
    expect(new OpenAICompatibleProvider({ apiKey: "k" }).model).toBe("gpt-4.1");
  });

  it("uses max_completion_tokens against api.openai.com and max_tokens against other endpoints", async () => {
    const calls = stubFetch(() => chat('{"answer":"a"}'));
    await new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", apiKey: "k", model: "gpt-5" }).analyze(req);
    await new OpenAICompatibleProvider({ baseUrl: "http://localhost:11434/v1", model: "llama3.1" }).analyze(req);
    expect(calls[0].body).toHaveProperty("max_completion_tokens");
    expect(calls[0].body).not.toHaveProperty("max_tokens");
    expect(calls[1].body).toHaveProperty("max_tokens");
    expect(calls[1].body).not.toHaveProperty("max_completion_tokens");
    expect(JSON.stringify(calls[0].body)).not.toContain("$schema");
  });

  it("adapts when the endpoint rejects the token parameter, and remembers", async () => {
    const calls = stubFetch((_u, body) => (body && "max_tokens" in body ? bad("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.") : chat('{"answer":"ok"}')));
    const p = new OpenAICompatibleProvider({ baseUrl: "https://gateway.example/v1", apiKey: "k", model: "o4-mini" });
    expect((await p.analyze(req)).data.answer).toBe("ok");
    await p.analyze(req);
    expect(calls.map((c) => Object.keys(c.body!).filter((k) => k.includes("tokens")))).toEqual([["max_tokens"], ["max_completion_tokens"], ["max_completion_tokens"]]);
  });

  it("falls back from json_schema to json_object and describes the schema in the prompt", async () => {
    const calls = stubFetch((_u, body) => ((body?.response_format as { type?: string } | undefined)?.type === "json_schema" ? bad("response_format json_schema is not supported") : chat('{"answer":"ok"}')));
    const r = await new OpenAICompatibleProvider({ baseUrl: "http://localhost:8000/v1", model: "local" }).analyze(req);
    expect(r.data.answer).toBe("ok");
    expect((calls[1].body!.response_format as { type: string }).type).toBe("json_object");
    expect(JSON.stringify(calls[1].body!.messages)).toContain("JSON Schema");
  });

  it("retries rate limits and server errors, honouring Retry-After", async () => {
    let n = 0;
    stubFetch(() => (++n === 1 ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } }) : n === 2 ? new Response("oops", { status: 503 }) : chat('{"answer":"ok"}')));
    const r = await new OpenAICompatibleProvider({ baseUrl: "http://localhost:1/v1", model: "m", retryDelayMs: 1 }).analyze(req);
    expect(r.data.answer).toBe("ok");
    expect(n).toBe(3);
  });

  it("does not retry authentication failures", async () => {
    let n = 0;
    stubFetch(() => { n++; return bad("Incorrect API key provided: sk-abc123456789", 401); });
    const err = await new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", apiKey: "sk-abc123456789", model: "m", retryDelayMs: 1 }).analyze(req).catch((e) => e);
    expect(n).toBe(1);
    expect(err.message).toContain("401");
    expect(JSON.stringify([err.message, err.detail])).not.toContain("sk-abc123456789");
  });

  it("gives a truncated reasoning-model reply more room on the retry", async () => {
    const calls = stubFetch(() => (calls.length === 1 ? chat("", { finish_reason: "length" }) : chat('{"answer":"done"}', { finish_reason: "stop" })));
    const r = await new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", apiKey: "k", model: "gpt-5" }).analyze({ ...req, maxTokens: 1000 });
    expect(r.data.answer).toBe("done");
    expect(calls[0].body!.max_completion_tokens).toBe(1000);
    expect(calls[1].body!.max_completion_tokens).toBe(2000);
  });

  it("surfaces a refusal as a response error and tolerates array content and prose around JSON", async () => {
    stubFetch(() => chat("", {}, { refusal: "I can't help with that." }));
    await expect(new OpenAICompatibleProvider({ baseUrl: "http://localhost:1/v1", model: "m" }).analyze(req)).rejects.toThrow(/declined/);
    stubFetch(() => new Response(JSON.stringify({ choices: [{ message: { content: [{ type: "text", text: 'Sure! {"answer":"parts"} Hope that helps.' }] } }] }), { status: 200 }));
    expect((await new OpenAICompatibleProvider({ baseUrl: "http://localhost:1/v1", model: "m" }).analyze(req)).data.answer).toBe("parts");
  });

  it("pings without structured output and succeeds even when a reasoning model returns no text", async () => {
    const calls = stubFetch(() => chat("", { finish_reason: "length" }));
    await new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", apiKey: "k", model: "gpt-5" }).ping();
    expect(calls[0].body).not.toHaveProperty("response_format");
  });

  it("reports a non-JSON success response as a base URL problem", async () => {
    stubFetch(() => new Response("<html>login</html>", { status: 200 }));
    await expect(new OpenAICompatibleProvider({ baseUrl: "http://localhost:1/v1", model: "m" }).analyze(req)).rejects.toThrow(/not JSON.*base URL/);
  });

  it("sends the Azure api-key header alongside Bearer", async () => {
    const calls = stubFetch(() => chat('{"answer":"a"}'));
    await new OpenAICompatibleProvider({ baseUrl: "https://res.openai.azure.com/openai/v1", apiKey: "az", model: "gpt-4.1" }).analyze(req);
    expect(calls[0].headers["api-key"]).toBe("az");
    expect(calls[0].headers.Authorization).toBe("Bearer az");
  });

  it("lists chat models newest first, excluding endpoints that cannot serve chat completions, and separates embeddings", async () => {
    stubFetch(() => new Response(JSON.stringify({ data: [
      { id: "gpt-4.1", created: 100 }, { id: "gpt-5", created: 300 }, { id: "text-embedding-3-small", created: 50 }, { id: "whisper-1", created: 1 }, { id: "dall-e-3", created: 2 },
      { id: "gpt-5-codex", created: 310 }, { id: "o1-pro", created: 200 }, { id: "gpt-3.5-turbo-instruct", created: 3 }, { id: "gpt-4o-realtime-preview", created: 4 }, { id: "o4-mini", created: 250 },
    ] }), { status: 200 }));
    const list = await new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", apiKey: "k" }).listModels();
    expect(list.filter((m) => m.kind === "chat").map((m) => m.id)).toEqual(["gpt-5", "o4-mini", "gpt-4.1"]);
    expect(list.filter((m) => m.kind === "embedding").map((m) => m.id)).toEqual(["text-embedding-3-small"]);
    expect(classifyOpenAIModel("llama3.1:8b")).toBe("chat");
  });
});

describe("Anthropic compatibility", () => {
  it("lists models from the SDK with capabilities and flags models without structured output", async () => {
    const rows = [
      { id: "claude-opus-5", display_name: "Claude Opus 5", created_at: "2026-05-01T00:00:00Z", max_input_tokens: 1000000, max_tokens: 128000, capabilities: { structured_outputs: { supported: true } } },
      { id: "claude-3-haiku-20240307", display_name: "Claude Haiku 3", created_at: "2024-03-07T00:00:00Z", max_input_tokens: 200000, max_tokens: 4096, capabilities: { structured_outputs: { supported: false } } },
    ];
    const client = { models: { list: () => ({ async *[Symbol.asyncIterator]() { for (const r of rows) yield r; } }) } } as unknown as Anthropic;
    const list = await new AnthropicProvider({ client, model: "claude-opus-5" }).listModels();
    expect(list.map((m) => [m.id, m.compatible])).toEqual([["claude-opus-5", true], ["claude-3-haiku-20240307", false]]);
    expect(list[0]).toMatchObject({ name: "Claude Opus 5", contextWindow: 1000000, maxOutputTokens: 128000 });
  });
});

describe("provider and model selection", () => {
  it("prefers Anthropic in auto mode when both keys are set, and falls back to OpenAI when only that key exists", () => {
    Object.assign(config.ai, { anthropicApiKey: "a", openaiApiKey: "o" });
    expect(resolveProvider()).toBe("anthropic");
    expect(getAIProvider()).toMatchObject({ name: "anthropic", model: "claude-opus-5" });
    Object.assign(config.ai, { anthropicApiKey: undefined });
    expect(getAIProvider()).toMatchObject({ name: "openai-compatible", model: "gpt-4.1" });
  });

  it("lets a saved provider choice override the environment, and clears back to it", () => {
    Object.assign(config.ai, { anthropicApiKey: "a", openaiApiKey: "o" });
    updateSettings({ provider: "openai-compatible", models: { "openai-compatible": "gpt-5-mini" } });
    expect(getAIProvider()).toMatchObject({ name: "openai-compatible", model: "gpt-5-mini" });
    updateSettings({ provider: null, models: { "openai-compatible": null } });
    expect(getAIProvider()).toMatchObject({ name: "anthropic" });
    expect(readSettings()).toEqual({});
  });

  it("keeps a separate model per provider so a Claude ID is never sent to OpenAI", () => {
    Object.assign(config.ai, { anthropicApiKey: "a", openaiApiKey: "o", legacyModel: "claude-sonnet-5" });
    expect(resolveModel("anthropic")).toBe("claude-sonnet-5");
    expect(resolveModel("openai-compatible")).toBe("gpt-4.1");
    updateSettings({ models: { anthropic: "claude-haiku-4-5", "openai-compatible": "gpt-4o" } });
    expect(resolveModel("anthropic")).toBe("claude-haiku-4-5");
    expect(resolveModel("openai-compatible")).toBe("gpt-4o");
  });

  it("ignores a stale Claude AI_MODEL when the automatic choice lands on OpenAI, but trusts it when the provider is explicit", () => {
    Object.assign(config.ai, { openaiApiKey: "o", legacyModel: "claude-opus-5" });
    expect(resolveModel("openai-compatible")).toBe("gpt-4.1");
    Object.assign(config.ai, { provider: "openai-compatible", legacyModel: "claude-via-gateway" });
    expect(resolveModel("openai-compatible")).toBe("claude-via-gateway");
  });

  it("explains why AI is unavailable for each choice, and honours an explicit off switch", () => {
    expect(providerStatus().reason).toMatch(/ANTHROPIC_API_KEY, or OPENAI_API_KEY/);
    updateSettings({ provider: "openai-compatible" });
    expect(providerStatus()).toMatchObject({ available: false, provider: "openai-compatible", model: "gpt-4.1" });
    expect(providerStatus().reason).toMatch(/OPENAI_API_KEY is not set/);
    Object.assign(config.ai, { anthropicApiKey: "a" });
    updateSettings({ provider: "none" });
    expect(getAIProvider()).toBeNull();
  });

  it("treats a local OpenAI-compatible endpoint as usable without a key", () => {
    Object.assign(config.ai, { openaiBaseUrl: "http://localhost:11434/v1" });
    expect(resolveProvider()).toBe("openai-compatible");
  });

  it("reuses provider instances until settings change", () => {
    Object.assign(config.ai, { anthropicApiKey: "a" });
    const first = getAIProvider();
    expect(getAIProvider()).toBe(first);
    updateSettings({ models: { anthropic: "claude-sonnet-5" } });
    expect(getAIProvider()).not.toBe(first);
    expect(getAIProvider()!.model).toBe("claude-sonnet-5");
  });

  it("persists settings with owner-only permissions and ignores a corrupt file", () => {
    updateSettings({ provider: "anthropic" });
    expect(fs.statSync(process.env.AI_SETTINGS_PATH!).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(process.env.AI_SETTINGS_PATH!, "utf8")).not.toMatch(/key/i);
    fs.writeFileSync(process.env.AI_SETTINGS_PATH!, "{not json");
    expect(readSettings()).toEqual({});
  });

  it("health-checks the selected provider with its own ping, using the model that is selected", async () => {
    Object.assign(config.ai, { openaiApiKey: "o" });
    updateSettings({ provider: "openai-compatible", models: { "openai-compatible": "gpt-4o" } });
    const calls = stubFetch(() => chat("OK"));
    const h = await checkProvider(true);
    expect(h).toMatchObject({ ok: true, provider: "openai-compatible", model: "gpt-4o" });
    expect(calls[0].body!.model).toBe("gpt-4o");
    calls.length = 0;
    stubFetch(() => bad("The model `nope` does not exist", 404));
    const failed = await checkProvider(true);
    expect(failed.ok).toBe(false);
    expect(failed.problem?.summary).toMatch(/model was not found/);
  });
});

describe("model catalogue", () => {
  it("returns built-in suggestions with a setup hint when no key is configured", async () => {
    const r = await listModels("anthropic");
    expect(r).toMatchObject({ source: "builtin", configured: false, selected: "claude-opus-5" });
    expect(r.models.map((m) => m.id)).toEqual(BUILTIN_MODELS.anthropic.chat.map((m) => m.id));
    expect(r.error?.hint).toContain("ANTHROPIC_API_KEY");
  });

  it("fetches once, serves the cache, and bypasses it on refresh", async () => {
    Object.assign(config.ai, { openaiApiKey: "o" });
    let n = 0;
    stubFetch(() => { n++; return new Response(JSON.stringify({ data: [{ id: n === 1 ? "gpt-5" : "gpt-5.1", created: n }, { id: "text-embedding-3-large", created: 1 }] }), { status: 200 }); });
    const a = await listModels("openai-compatible");
    const b = await listModels("openai-compatible");
    const c = await listModels("openai-compatible", { refresh: true });
    expect([a.source, b.source, c.source]).toEqual(["api", "cache", "api"]);
    expect([a.models[0].id, b.models[0].id, c.models[0].id]).toEqual(["gpt-5", "gpt-5", "gpt-5.1"]);
    expect(a.embeddingModels.map((m) => m.id)).toEqual(["text-embedding-3-large"]);
    expect(n).toBe(2);
  });

  it("keeps the last good list when a refresh fails, and explains why", async () => {
    Object.assign(config.ai, { openaiApiKey: "o" });
    stubFetch(() => new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }), { status: 200 }));
    await listModels("openai-compatible");
    stubFetch(() => bad("Incorrect API key", 401));
    const r = await listModels("openai-compatible", { refresh: true });
    expect(r.source).toBe("cache");
    expect(r.models.map((m) => m.id)).toEqual(["gpt-5"]);
    expect(r.error?.summary).toMatch(/rejected the API key/);
  });

  it("falls back to suggestions if the first fetch fails", async () => {
    Object.assign(config.ai, { openaiApiKey: "o" });
    stubFetch(() => bad("nope", 404));
    const r = await listModels("openai-compatible");
    expect(r.source).toBe("builtin");
    expect(r.models.length).toBeGreaterThan(0);
    expect(r.error).toBeDefined();
  });
});

describe("AI settings API", () => {
  const put = (body: unknown, headers: Record<string, string> = { "content-type": "application/json" }, qs = "") => putSettings(new Request(`http://brody/api/ai/settings${qs}`, { method: "PUT", headers, body: JSON.stringify(body) }));

  it("reports selections and key presence without ever returning a key", async () => {
    Object.assign(config.ai, { anthropicApiKey: "sk-ant-SECRET", openaiApiKey: "sk-openai-SECRET" });
    const res = await getSettings();
    const text = await res.text();
    expect(text).not.toContain("SECRET");
    const body = JSON.parse(text);
    expect(body.providers.anthropic).toMatchObject({ configured: true, model: "claude-opus-5" });
    expect(body.providers["openai-compatible"]).toMatchObject({ configured: true, model: "gpt-4.1", endpoint: "https://api.openai.com/v1" });
  });

  it("saves a provider and model, applies them immediately, and clears with null", async () => {
    Object.assign(config.ai, { anthropicApiKey: "a", openaiApiKey: "o" });
    const res = await put({ provider: "openai-compatible", models: { "openai-compatible": "gpt-5" } });
    const body = await res.json();
    expect(body.provider).toBe("openai-compatible");
    expect(body.effective).toMatchObject({ available: true, provider: "openai-compatible", model: "gpt-5" });
    expect(getAIProvider()!.model).toBe("gpt-5");
    const cleared = await (await put({ provider: null, models: { "openai-compatible": null } })).json();
    expect(cleared.effective.provider).toBe("anthropic");
  });

  it("rejects malformed model IDs, unknown providers and non-JSON content types", async () => {
    expect((await put({ models: { anthropic: "bad model; drop table" } })).status).toBe(400);
    expect((await put({ provider: "gemini" })).status).toBe(400);
    expect((await put({ provider: "anthropic" }, { "content-type": "text/plain" })).status).toBe(415);
    expect(readSettings()).toEqual({});
  });

  it("can test the new selection in the same call", async () => {
    Object.assign(config.ai, { openaiApiKey: "o" });
    stubFetch(() => chat("OK"));
    const body = await (await put({ provider: "openai-compatible", models: { "openai-compatible": "gpt-4o" } }, undefined, "?test=1")).json();
    expect(body.health).toMatchObject({ checked: true, ok: true, model: "gpt-4o" });
  });

  it("serves the model list and validates the provider parameter", async () => {
    Object.assign(config.ai, { openaiApiKey: "o" });
    stubFetch(() => new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }), { status: 200 }));
    const ok = await (await getModels(new Request("http://brody/api/ai/models?provider=openai-compatible&refresh=1"))).json();
    expect(ok).toMatchObject({ provider: "openai-compatible", source: "api" });
    expect((await getModels(new Request("http://brody/api/ai/models?provider=nope"))).status).toBe(400);
  });
});
