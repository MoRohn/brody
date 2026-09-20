import { config } from "../config";
import { AnthropicProvider } from "./anthropic";
import { explainAIError } from "./errors";
import { OpenAICompatibleProvider } from "./openai";
import { providerConfigured, resolveModel, type ProviderId } from "./settings";
import type { ModelOption } from "./types";

export type ModelSource = "api" | "cache" | "builtin";

export interface ModelList {
  provider: ProviderId;
  configured: boolean;
  /** api: fetched just now. cache: an earlier fetch (see error if a refresh failed). builtin: suggestions only. */
  source: ModelSource;
  fetchedAt: number | null;
  models: ModelOption[];
  embeddingModels: ModelOption[];
  /** The model that will be used for this provider today. */
  selected: string;
  error?: { summary: string; hint: string };
}

const TTL_MS = 10 * 60_000;

const builtin = (ids: [string, string][], kind: ModelOption["kind"] = "chat"): ModelOption[] => ids.map(([id, name]) => ({ id, name, kind }));

/** Suggestions shown when the provider's catalogue cannot be fetched (no key, offline, unsupported endpoint). */
export const BUILTIN_MODELS: Record<ProviderId, { chat: ModelOption[]; embedding: ModelOption[] }> = {
  anthropic: {
    chat: builtin([
      ["claude-opus-5", "Claude Opus 5"],
      ["claude-fable-5-1", "Claude Fable 5.1"],
      ["claude-sonnet-5", "Claude Sonnet 5"],
      ["claude-haiku-4-5", "Claude Haiku 4.5"],
    ]),
    embedding: [],
  },
  "openai-compatible": {
    chat: builtin([
      ["gpt-5", "gpt-5"],
      ["gpt-5-mini", "gpt-5-mini"],
      ["gpt-4.1", "gpt-4.1"],
      ["gpt-4.1-mini", "gpt-4.1-mini"],
      ["gpt-4o", "gpt-4o"],
    ]),
    embedding: builtin([["text-embedding-3-small", "text-embedding-3-small"], ["text-embedding-3-large", "text-embedding-3-large"]], "embedding"),
  },
};

const cache = new Map<string, { at: number; models: ModelOption[] }>();

function cacheKey(id: ProviderId): string {
  return id === "openai-compatible" ? `${id}|${config.ai.openaiBaseUrl}` : id;
}

/** Forget cached catalogues (after credentials or endpoints change, and in tests). */
export function clearModelCache(): void {
  cache.clear();
}

function fetchCatalogue(id: ProviderId): Promise<ModelOption[]> {
  const p = id === "anthropic" ? new AnthropicProvider({ apiKey: config.ai.anthropicApiKey }) : new OpenAICompatibleProvider();
  return p.listModels();
}

function split(all: ModelOption[]): { chat: ModelOption[]; embedding: ModelOption[] } {
  return { chat: all.filter((m) => m.kind === "chat"), embedding: all.filter((m) => m.kind === "embedding") };
}

/**
 * List the models a provider offers. `refresh` bypasses the cache. A failed refresh never throws:
 * the last good catalogue (or built-in suggestions) is returned with the reason in `error`, so the
 * selector keeps working and the user can still type a model ID by hand.
 */
export async function listModels(id: ProviderId, opts: { refresh?: boolean } = {}): Promise<ModelList> {
  const selected = resolveModel(id);
  const configured = providerConfigured(id);
  const key = cacheKey(id);
  const hit = cache.get(key);
  const base = { provider: id, configured, selected };
  if (!configured) {
    const b = BUILTIN_MODELS[id];
    return {
      ...base,
      source: "builtin",
      fetchedAt: null,
      models: b.chat,
      embeddingModels: b.embedding,
      error: id === "anthropic"
        ? { summary: "No Anthropic API key is configured.", hint: "Set ANTHROPIC_API_KEY in .env and restart Brody to load your account's models." }
        : { summary: "No OpenAI API key is configured.", hint: "Set OPENAI_API_KEY (and OPENAI_BASE_URL for a non-OpenAI endpoint) in .env and restart Brody to load your account's models." },
    };
  }
  if (hit && !opts.refresh && Date.now() - hit.at < TTL_MS) return { ...base, source: "cache", fetchedAt: hit.at, models: split(hit.models).chat, embeddingModels: split(hit.models).embedding };
  try {
    const models = await fetchCatalogue(id);
    if (models.length === 0) throw new Error("The provider returned an empty model list.");
    cache.set(key, { at: Date.now(), models });
    const s = split(models);
    return { ...base, source: "api", fetchedAt: Date.now(), models: s.chat, embeddingModels: s.embedding };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const error = /empty model list/.test(raw)
      ? { summary: "The provider returned no models.", hint: "The endpoint may not support listing. Type a model ID by hand." }
      : explainAIError(raw);
    if (hit) {
      const s = split(hit.models);
      return { ...base, source: "cache", fetchedAt: hit.at, models: s.chat, embeddingModels: s.embedding, error };
    }
    const b = BUILTIN_MODELS[id];
    return { ...base, source: "builtin", fetchedAt: null, models: b.chat, embeddingModels: b.embedding, error };
  }
}
