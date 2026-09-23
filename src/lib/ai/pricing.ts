/**
 * List prices used to estimate what an analysis cost. They are estimates: they ignore taxes, credits, negotiated
 * discounts and batch or priority tiers, and they go stale. Update PRICES_AS_OF with the tables, or set AI_PRICING to
 * override any model (JSON, USD per million tokens): {"my-model": {"input": 3, "output": 15, "cachedInput": 0.3}}.
 */

/** USD per million tokens. cacheWrite applies to Anthropic prompt-cache writes; cachedInput to cache reads. */
export interface Rate { input: number; output: number; cachedInput?: number; cacheWrite?: number }

export const PRICES_AS_OF = "2026-09-23";

/** Anthropic first-party API list prices. Cache reads are 0.1x input and 5-minute cache writes 1.25x input. */
const anthropic = (input: number, output: number, cachedInput = input / 10): Rate => ({ input, output, cachedInput, cacheWrite: input * 1.25 });
const ANTHROPIC: Record<string, Rate> = {
  "claude-fable-5-1": anthropic(10, 50, 0.25),
  "claude-mythos-5-1": anthropic(10, 50),
  "claude-fable-5": anthropic(10, 50),
  "claude-opus-5-5": anthropic(4, 20, 0.2),
  "claude-opus-5": anthropic(5, 25),
  "claude-opus-4-8": anthropic(5, 25),
  "claude-opus-4-7": anthropic(5, 25),
  "claude-opus-4-6": anthropic(5, 25),
  "claude-sonnet-5": anthropic(2, 10),
  "claude-sonnet-4-6": anthropic(3, 15),
  "claude-haiku-4-5": anthropic(1, 5),
};

/** OpenAI API standard-tier list prices (api.openai.com only; other OpenAI-compatible endpoints price differently). */
const OPENAI: Record<string, Rate> = {
  "gpt-5": { input: 1.25, cachedInput: 0.125, output: 10 },
  "gpt-5-mini": { input: 0.25, cachedInput: 0.025, output: 2 },
  "gpt-5-nano": { input: 0.05, cachedInput: 0.005, output: 0.4 },
  "gpt-5.6-sol": { input: 4, cachedInput: 0.4, output: 20 },
  "gpt-5.6-terra": { input: 2, cachedInput: 0.2, output: 12 },
  "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, output: 1.2 },
  "gpt-4.1": { input: 2, cachedInput: 0.5, output: 8 },
  "gpt-4.1-mini": { input: 0.4, cachedInput: 0.1, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, cachedInput: 0.025, output: 0.4 },
  "gpt-4o": { input: 2.5, cachedInput: 1.25, output: 10 },
  "gpt-4o-mini": { input: 0.15, cachedInput: 0.075, output: 0.6 },
  o3: { input: 2, cachedInput: 0.5, output: 8 },
  "o4-mini": { input: 1.1, cachedInput: 0.275, output: 4.4 },
  "text-embedding-3-small": { input: 0.02, output: 0 },
  "text-embedding-3-large": { input: 0.13, output: 0 },
};

export interface PriceLookup {
  rate: Rate | null;
  /** list: published price table; custom: AI_PRICING; none: no price known (a local model, or an unknown one). */
  source: "list" | "custom" | "none";
  /** One line explaining the basis, shown beside the estimate. */
  basis: string;
}

/** Strip platform prefixes and date snapshots so "anthropic.claude-opus-5" and "gpt-4o-2024-08-06" find their rates. */
export function normalizeModelId(model: string): string {
  return model.trim().toLowerCase().replace(/^(anthropic|openai)[./]/, "").replace(/@.*$/, "").replace(/-\d{8}$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

let customCache: { raw: string; rates: Record<string, Rate> } | undefined;
function customRates(): Record<string, Rate> {
  const raw = process.env.AI_PRICING ?? "";
  if (customCache?.raw === raw) return customCache.rates;
  const rates: Record<string, Rate> = {};
  if (raw.trim()) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, Partial<Rate>>)) {
        if (v && Number.isFinite(v.input) && Number.isFinite(v.output)) rates[normalizeModelId(k)] = { input: Number(v.input), output: Number(v.output), ...(Number.isFinite(v.cachedInput) ? { cachedInput: Number(v.cachedInput) } : {}), ...(Number.isFinite(v.cacheWrite) ? { cacheWrite: Number(v.cacheWrite) } : {}) };
      }
    } catch {
      console.warn("[brody] AI_PRICING is not valid JSON; list prices are used instead.");
    }
  }
  customCache = { raw, rates };
  return rates;
}

/** The price for one model on one provider. `openaiHost` tells api.openai.com apart from local or third-party endpoints. */
export function priceFor(provider: string, model: string, openaiHost?: string): PriceLookup {
  const id = normalizeModelId(model);
  const custom = customRates()[id];
  if (custom) return { rate: custom, source: "custom", basis: "Your rates from AI_PRICING" };
  if (provider === "anthropic" && ANTHROPIC[id]) return { rate: ANTHROPIC[id], source: "list", basis: `Anthropic API list price as of ${PRICES_AS_OF}` };
  if (provider === "openai-compatible") {
    if (openaiHost && openaiHost !== "api.openai.com") return { rate: null, source: "none", basis: `Self-hosted or third-party endpoint (${openaiHost}); set AI_PRICING to estimate its cost` };
    if (OPENAI[id]) return { rate: OPENAI[id], source: "list", basis: `OpenAI API list price as of ${PRICES_AS_OF}` };
  }
  return { rate: null, source: "none", basis: `No published price on file for ${model}; set AI_PRICING to estimate it` };
}

export interface TokenCounts { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }

/** USD for a token count at a rate. Cached tokens fall back to the input price when the rate does not list them. */
export function costOf(rate: Rate, t: TokenCounts): number {
  return (t.inputTokens * rate.input + t.outputTokens * rate.output + t.cacheReadTokens * (rate.cachedInput ?? rate.input) + t.cacheWriteTokens * (rate.cacheWrite ?? rate.input)) / 1_000_000;
}
