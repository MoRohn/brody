import { z } from "zod";
import { config } from "../config";
import { resolveEmbeddingModel, resolveModel } from "./settings";
import { AIResponseError, type AIProvider, type AnalysisRequest, type AnalysisResult, type ModelOption } from "./types";

const REQUEST_TIMEOUT_MS = 180_000;
const MAX_RETRIES = 3;

type FormatMode = "json_schema" | "json_object" | "none";

/**
 * Provider for any OpenAI-compatible chat completions endpoint (OpenAI, Azure OpenAI v1, vLLM, Ollama, gateways).
 *
 * Endpoints differ in what they accept, so the provider adapts once and remembers:
 *  - Newer OpenAI models require `max_completion_tokens`; most compatible servers only know `max_tokens`.
 *  - Structured output falls back from `json_schema` to `json_object` to prompt-only JSON.
 *  - Transient failures (429, 5xx, dropped connections) are retried with backoff.
 *  - Reasoning models spend output tokens on hidden reasoning; a truncated reply is retried with more room.
 */
export class OpenAICompatibleProvider implements AIProvider {
  readonly name = "openai-compatible";
  readonly model: string;
  private baseUrl: string;
  private apiKey?: string;
  private retryDelayMs: number;
  private tokenParam: "max_completion_tokens" | "max_tokens";
  private format: FormatMode = "json_schema";

  constructor(opts: { baseUrl?: string; apiKey?: string; model?: string; retryDelayMs?: number } = {}) {
    this.baseUrl = (opts.baseUrl ?? config.ai.openaiBaseUrl).replace(/\/$/, "");
    this.apiKey = opts.apiKey ?? config.ai.openaiApiKey;
    this.model = opts.model ?? resolveModel("openai-compatible");
    this.retryDelayMs = opts.retryDelayMs ?? 1000;
    this.tokenParam = this.host() === "api.openai.com" ? "max_completion_tokens" : "max_tokens";
  }

  private host(): string {
    try {
      return new URL(this.baseUrl).hostname.toLowerCase();
    } catch {
      return "";
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) {
      h.Authorization = `Bearer ${this.apiKey}`;
      if (this.host().endsWith(".openai.azure.com")) h["api-key"] = this.apiKey;
    }
    return h;
  }

  private scrub(text: string): string {
    // Very short "keys" (placeholders for local servers) would mangle ordinary words, so only real-length keys are scrubbed.
    return this.apiKey && this.apiKey.length >= 8 ? text.split(this.apiKey).join("[key]") : text;
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      let res: Response | undefined;
      let networkError = "";
      try {
        res = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: this.headers(),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (e) {
        const name = e instanceof Error ? e.name : "";
        networkError = name === "TimeoutError" || name === "AbortError" ? `The AI endpoint timed out after ${REQUEST_TIMEOUT_MS / 1000}s.` : `Could not connect to the AI endpoint (fetch failed): ${this.scrub(e instanceof Error ? e.message : String(e))}`;
      }
      if (res?.ok) {
        try {
          return (await res.json()) as Record<string, unknown>;
        } catch {
          throw new AIResponseError("The AI endpoint returned something that is not JSON. Check that the base URL points at the API root (for OpenAI: https://api.openai.com/v1).");
        }
      }
      const transient = !res || res.status === 429 || res.status >= 500;
      if (transient && attempt < MAX_RETRIES) {
        const retryAfter = Number(res?.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 20_000) : this.retryDelayMs * 2 ** attempt;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!res) throw new AIResponseError(networkError);
      const text = this.scrub(await res.text().catch(() => "")).slice(0, 400);
      throw new AIResponseError(`AI endpoint returned ${res.status}`, text);
    }
  }

  /**
   * POST a chat completion, adapting to what this endpoint rejects. `structured` carries the schema for
   * structured output; without it no response_format is sent. The messages are rebuilt after a format
   * downgrade so the schema is then described in the prompt instead.
   */
  private async chat(model: string, messages: (format: FormatMode) => { role: string; content: string }[], maxTokens: number, structured?: { schema: object; task: string }): Promise<Record<string, unknown>> {
    let flippedTokenParam = false;
    for (let adapt = 0; adapt < 4; adapt++) {
      const format: FormatMode = structured ? this.format : "none";
      const payload: Record<string, unknown> = { model, messages: messages(format), [this.tokenParam]: maxTokens };
      if (structured && format === "json_schema") payload.response_format = { type: "json_schema", json_schema: { name: structured.task.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60) || "result", schema: structured.schema, strict: false } };
      else if (structured && format === "json_object") payload.response_format = { type: "json_object" };
      try {
        return await this.request("POST", "/chat/completions", payload);
      } catch (e) {
        if (!(e instanceof AIResponseError) || !e.message.endsWith("400")) throw e;
        const detail = (e.detail ?? "").toLowerCase();
        if (!flippedTokenParam && /max_completion_tokens|max_tokens/.test(detail)) {
          this.tokenParam = this.tokenParam === "max_tokens" ? "max_completion_tokens" : "max_tokens";
          flippedTokenParam = true;
          continue;
        }
        if (structured && format !== "none" && /response_format|json_schema|json_object|structured/.test(detail)) {
          this.format = format === "json_schema" ? "json_object" : "none";
          continue;
        }
        throw e;
      }
    }
    throw new AIResponseError("AI endpoint returned 400", "The endpoint rejected the request parameters repeatedly.");
  }

  /** Verifies the key, base URL and model with a tiny request. Reasoning models may return no text; success is the HTTP status. */
  async ping(): Promise<void> {
    await this.chat(this.model, () => [{ role: "user", content: "Reply with OK." }], 64);
  }

  async analyze<T>(request: AnalysisRequest<T>): Promise<AnalysisResult<T>> {
    const jsonSchema = z.toJSONSchema(request.schema as z.ZodType) as Record<string, unknown>;
    delete jsonSchema.$schema;
    let prompt = request.prompt;
    let maxTokens = request.maxTokens ?? 8000;
    let lastError = "";
    const usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
    for (let attempt = 0; attempt < 3; attempt++) {
      const userPrompt = prompt;
      const json = await this.chat(
        this.model,
        (format) => [
          { role: "system", content: format === "json_schema" ? request.system : `${request.system}\n\nRespond with a single JSON object and nothing else. It must conform to this JSON Schema:\n${JSON.stringify(jsonSchema)}` },
          { role: "user", content: userPrompt },
        ],
        maxTokens,
        { schema: jsonSchema, task: request.task },
      );
      const u = json.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      usage.calls++;
      usage.inputTokens += u?.prompt_tokens ?? 0;
      usage.outputTokens += u?.completion_tokens ?? 0;
      const choice = (json.choices as { finish_reason?: string; message?: { content?: unknown; refusal?: string | null } }[] | undefined)?.[0];
      if (choice?.message?.refusal) throw new AIResponseError("The model declined this request.", String(choice.message.refusal).slice(0, 300));
      const content = textOf(choice?.message?.content);
      const parsed = parseJson(content);
      if (parsed.ok) {
        const checked = request.schema.safeParse(parsed.value);
        if (checked.success) return { data: checked.data, model: this.model, provider: this.name, usage };
        lastError = checked.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        prompt = `${request.prompt}\n\nYour previous answer was invalid (${lastError}). Return only JSON that matches the schema.`;
      } else if (choice?.finish_reason === "length") {
        // Truncated, often because a reasoning model spent the budget thinking. Retry with more room.
        lastError = "the response was truncated at the output token limit";
        maxTokens = Math.min(maxTokens * 2, 32000);
        prompt = `${request.prompt}\n\nKeep the answer concise and complete.`;
      } else {
        lastError = "the response was not valid JSON";
        prompt = `${request.prompt}\n\nYour previous answer was invalid (${lastError}). Return only JSON that matches the schema.`;
      }
    }
    throw new AIResponseError(`Structured response could not be produced for task "${request.task}": ${lastError}.`);
  }

  async listModels(): Promise<ModelOption[]> {
    const json = await this.request("GET", "/models");
    const rows = (Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : []) as { id?: string; name?: string; created?: number }[];
    const out: ModelOption[] = [];
    for (const r of rows) {
      const id = r.id ?? r.name;
      if (!id || typeof id !== "string") continue;
      const kind = classifyOpenAIModel(id);
      if (kind) out.push({ id, name: id, kind, ...(typeof r.created === "number" ? { created: r.created } : {}) });
    }
    return out.sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id));
  }

  async embed(texts: string[]): Promise<number[][]> {
    const model = resolveEmbeddingModel();
    if (!model) throw new AIResponseError("No embedding model configured (AI_EMBEDDING_MODEL).");
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const json = await this.request("POST", "/embeddings", { model, input: texts.slice(i, i + 64) });
      for (const d of json.data as { embedding: number[] }[]) out.push(d.embedding);
    }
    return out;
  }
}

/** Models that cannot serve chat completions with structured output. Heuristic: users can always type an ID by hand. */
const NON_CHAT = /whisper|tts|dall-e|gpt-image|image|moderation|davinci|babbage|curie|\bada\b|transcribe|realtime|audio|sora|instruct|codex|deep-research|computer-use|-pro\b|search-preview|rerank/i;

export function classifyOpenAIModel(id: string): "chat" | "embedding" | null {
  if (/embed/i.test(id)) return "embedding";
  if (NON_CHAT.test(id)) return null;
  return "chat";
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : (p as { text?: string })?.text ?? "")).join("");
  return "";
}

/** Parse JSON from a model reply, tolerating code fences and surrounding prose from weaker local models. */
function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  for (const candidate of [t, t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)]) {
    if (!candidate) continue;
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      /* try the next candidate */
    }
  }
  return { ok: false };
}
