import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { config } from "../config";
import { resolveModel } from "./settings";
import { AIResponseError, type AIProvider, type AnalysisRequest, type AnalysisResult, type ModelOption } from "./types";

interface ParsedMessage<T> {
  parsed_output?: T | null;
  stop_reason?: string | null;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
  usage?: { input_tokens?: number; output_tokens?: number };
  model?: string;
}

/**
 * Anthropic provider using structured outputs. The response is parsed against the request's
 * Zod schema by the SDK; a failed parse or truncated response is retried once, never more.
 *
 * On Fable/Opus 5 tier models the server-side refusal fallback is requested by default. If the
 * API rejects those beta parameters, the provider disables them and uses the stable endpoint.
 */
export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic";
  readonly model: string;
  private client: Anthropic;
  private fallbacks: boolean;

  constructor(opts: { apiKey?: string; model?: string; client?: Anthropic } = {}) {
    this.model = opts.model ?? resolveModel("anthropic");
    const workspace = config.ai.anthropicWorkspaceId?.trim();
    this.client = opts.client ?? new Anthropic({ ...(opts.apiKey ? { apiKey: opts.apiKey } : {}), maxRetries: 2, timeout: config.ai.requestTimeoutMs, ...(workspace ? { defaultHeaders: { "anthropic-workspace-id": workspace } } : {}) });
    this.fallbacks = process.env.AI_REFUSAL_FALLBACKS !== "off" && /^claude-(fable|mythos|opus-5)/.test(this.model);
  }

  /** Cheap credential check used by the status endpoint; a few tokens only. */
  async ping(): Promise<void> {
    await this.client.messages.create({ model: this.model, max_tokens: 32, messages: [{ role: "user", content: "Reply with OK." }] }, { timeout: config.ai.healthTimeoutMs, maxRetries: 0 });
  }

  /** Models available to this key, newest first. Paginates through the whole catalogue. */
  async listModels(): Promise<ModelOption[]> {
    const out: ModelOption[] = [];
    for await (const m of this.client.models.list({ limit: 1000 })) {
      const created = Date.parse(m.created_at);
      out.push({
        id: m.id,
        name: m.display_name || m.id,
        kind: "chat",
        ...(Number.isFinite(created) && created > 0 ? { created: Math.floor(created / 1000) } : {}),
        ...(m.max_input_tokens ? { contextWindow: m.max_input_tokens } : {}),
        ...(m.max_tokens ? { maxOutputTokens: m.max_tokens } : {}),
        ...(m.capabilities ? { compatible: m.capabilities.structured_outputs?.supported !== false } : {}),
      });
      if (out.length >= 500) break;
    }
    return out.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  }

  private async call<T>(request: AnalysisRequest<T>, prompt: string): Promise<ParsedMessage<T>> {
    const base = {
      model: this.model,
      max_tokens: request.maxTokens ?? 16000,
      system: request.system,
      messages: [{ role: "user" as const, content: prompt }],
      output_config: { format: zodOutputFormat(request.schema as never) },
    };
    if (this.fallbacks) {
      try {
        return (await this.client.beta.messages.parse({ ...base, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } as never)) as unknown as ParsedMessage<T>;
      } catch (e) {
        if (e instanceof Anthropic.BadRequestError && /fallback|beta|server-side/i.test(e.message)) this.fallbacks = false;
        else throw e;
      }
    }
    return (await this.client.messages.parse(base as never)) as unknown as ParsedMessage<T>;
  }

  async analyze<T>(request: AnalysisRequest<T>): Promise<AnalysisResult<T>> {
    let prompt = request.prompt;
    let lastError = "";
    const usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
    for (let attempt = 0; attempt < 2; attempt++) {
      const msg = await this.call(request, prompt);
      usage.calls++;
      usage.inputTokens += msg.usage?.input_tokens ?? 0;
      usage.outputTokens += msg.usage?.output_tokens ?? 0;
      if (msg.stop_reason === "refusal") {
        throw new AIResponseError(`The model declined this request${msg.stop_details?.category ? ` (${msg.stop_details.category})` : ""}.`, msg.stop_details?.explanation ?? undefined);
      }
      if (msg.stop_reason === "max_tokens") {
        lastError = "the response was truncated at the output token limit";
        prompt = request.prompt + "\n\nYour previous answer was truncated. Return a shorter, complete answer that fits the schema.";
        continue;
      }
      if (msg.parsed_output) return { data: msg.parsed_output, model: msg.model ?? this.model, provider: this.name, usage };
      lastError = "the response did not match the required schema";
      prompt = `${request.prompt}\n\nYour previous answer was not valid for the required schema. Return only data that matches the schema exactly.`;
    }
    throw new AIResponseError(`Structured response could not be produced for task "${request.task}": ${lastError}.`);
  }
}
