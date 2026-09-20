import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "@/lib/ai/anthropic";
import { explainAIError } from "@/lib/ai/errors";
import { OpenAICompatibleProvider } from "@/lib/ai/openai";
import { AIResponseError } from "@/lib/ai";

const schema = z.object({ answer: z.string() });
const req = { task: "t", system: "s", prompt: "p", schema };
const ok = (parsed: unknown, extra: Record<string, unknown> = {}) => ({ parsed_output: parsed, stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 }, model: "claude-opus-5", ...extra });

function fakeClient(handlers: { beta?: (p: Record<string, unknown>) => unknown; stable?: (p: Record<string, unknown>) => unknown }) {
  const calls = { beta: [] as Record<string, unknown>[], stable: [] as Record<string, unknown>[] };
  const client = {
    beta: { messages: { parse: vi.fn(async (p: Record<string, unknown>) => { calls.beta.push(p); return handlers.beta?.(p); }) } },
    messages: { parse: vi.fn(async (p: Record<string, unknown>) => { calls.stable.push(p); return handlers.stable?.(p); }), create: vi.fn(async () => ({})) },
  } as unknown as Anthropic;
  return { client, calls };
}
const badRequest = (msg: string) => new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: msg } } as never, msg, new Headers());

describe("AnthropicProvider", () => {
  it("requests structured output with server-side refusal fallback on Opus 5 and returns validated data + usage", async () => {
    const { client, calls } = fakeClient({ beta: () => ok({ answer: "hi" }) });
    const p = new AnthropicProvider({ client, model: "claude-opus-5" });
    const r = await p.analyze(req);
    expect(r.data).toEqual({ answer: "hi" });
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5, calls: 1 });
    expect(calls.beta[0]).toMatchObject({ model: "claude-opus-5", fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] });
    expect(calls.beta[0].output_config).toBeDefined();
    expect(calls.beta[0]).not.toHaveProperty("temperature");
    expect(calls.beta[0]).not.toHaveProperty("thinking");
    expect(calls.stable).toHaveLength(0);
  });

  it("degrades to the stable endpoint if the beta fallback parameters are rejected, and remembers that", async () => {
    const { client, calls } = fakeClient({ beta: () => { throw badRequest("fallbacks: unknown beta feature"); }, stable: () => ok({ answer: "stable" }) });
    const p = new AnthropicProvider({ client, model: "claude-opus-5" });
    expect((await p.analyze(req)).data.answer).toBe("stable");
    expect((await p.analyze(req)).data.answer).toBe("stable");
    expect(calls.beta).toHaveLength(1);
    expect(calls.stable).toHaveLength(2);
    expect(calls.stable[0]).not.toHaveProperty("fallbacks");
  });

  it("does not use beta parameters for other models", async () => {
    const { client, calls } = fakeClient({ stable: () => ok({ answer: "x" }) });
    await new AnthropicProvider({ client, model: "claude-sonnet-5" }).analyze(req);
    expect(calls.beta).toHaveLength(0);
    expect(calls.stable).toHaveLength(1);
  });

  it("surfaces refusals, retries truncation once and schema failures once, then gives up", async () => {
    const refusal = fakeClient({ stable: () => ok(null, { stop_reason: "refusal", stop_details: { category: "cyber", explanation: "policy" } }) });
    await expect(new AnthropicProvider({ client: refusal.client, model: "claude-sonnet-5" }).analyze(req)).rejects.toThrow(/declined.*cyber/);

    let n = 0;
    const trunc = fakeClient({ stable: () => (++n === 1 ? ok(null, { stop_reason: "max_tokens" }) : ok({ answer: "shorter" })) });
    const r = await new AnthropicProvider({ client: trunc.client, model: "claude-sonnet-5" }).analyze(req);
    expect(r.data.answer).toBe("shorter");
    expect(r.usage.calls).toBe(2);
    expect(String((trunc.calls.stable[1].messages as { content: string }[])[0].content)).toContain("truncated");

    const bad = fakeClient({ stable: () => ok(null) });
    const err = await new AnthropicProvider({ client: bad.client, model: "claude-sonnet-5" }).analyze(req).catch((e) => e);
    expect(err).toBeInstanceOf(AIResponseError);
    expect(bad.calls.stable).toHaveLength(2);
  });

  it("propagates authentication and other API errors unchanged", async () => {
    const { client } = fakeClient({ stable: () => { throw new Error("401 invalid x-api-key"); } });
    await expect(new AnthropicProvider({ client, model: "claude-sonnet-5" }).analyze(req)).rejects.toThrow("401");
  });
});

describe("OpenAI-compatible provider", () => {
  const chat = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }), { status: 200 });
  it("sends a JSON-schema response format, validates the reply and repairs invalid JSON once", async () => {
    const bodies: Record<string, unknown>[] = [];
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return chat(++n === 1 ? "not json" : '```json\n{"answer":"fixed"}\n```'); }));
    try {
      const p = new OpenAICompatibleProvider({ baseUrl: "http://localhost:1/v1", apiKey: "k", model: "m" });
      const r = await p.analyze(req);
      expect(r.data.answer).toBe("fixed");
      expect(r.usage).toEqual({ inputTokens: 14, outputTokens: 6, calls: 2 });
      expect((bodies[0].response_format as { type: string }).type).toBe("json_schema");
      expect(JSON.stringify(bodies[0])).toContain("answer");
    } finally { vi.unstubAllGlobals(); }
  });
  it("reports HTTP failures without echoing the API key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad key sk-secret-value", { status: 401 })));
    try {
      const err = await new OpenAICompatibleProvider({ baseUrl: "http://localhost:1/v1", apiKey: "sk-secret-value", model: "m" }).analyze(req).catch((e) => e);
      expect(err.message).toContain("401");
      expect(JSON.stringify([err.message, err.detail])).not.toContain("sk-secret-value");
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("AI error explanations", () => {
  it("maps provider failures to actionable hints", () => {
    expect(explainAIError('400 {"message":"This API key is not scoped to a workspace"}').hint).toContain("ANTHROPIC_WORKSPACE_ID");
    expect(explainAIError("401 invalid x-api-key").summary).toContain("rejected");
    expect(explainAIError("429 rate_limit_error").hint).toContain("AI_CONCURRENCY");
    expect(explainAIError("529 overloaded_error").summary).toContain("unavailable");
    expect(explainAIError("fetch failed ECONNREFUSED").summary).toContain("could not be reached");
    expect(explainAIError("something odd").summary).toBe("AI requests failed.");
  });
});
