import { z } from "zod";
import { config } from "../config";
import { AnthropicProvider } from "./anthropic";
import { explainAIError } from "./errors";
import { OpenAICompatibleProvider } from "./openai";
import { resolveModel, resolveProvider, selectedProvider } from "./settings";
import { AIUnavailableError, type AIProvider, type AnalysisRequest, type AnalysisResult, type AnalysisUsage } from "./types";

export * from "./types";
export * from "./prompt";
export * from "./errors";
export { resolveModel, resolveProvider, selectedProvider } from "./settings";

let override: AIProvider | null | undefined;

/** Inject a provider (tests, or embedding applications). Pass undefined to restore configuration. */
export function setAIProvider(p: AIProvider | null | undefined): void {
  override = p;
}

export interface ProviderStatus {
  available: boolean;
  provider: string;
  model: string;
  reason?: string;
}

const instances = new Map<string, AIProvider>();

/** Forget cached provider instances and health results. Call after settings or credentials change. */
export function resetProviderCache(): void {
  instances.clear();
  healthCache = undefined;
}

/** The provider that will run, built from the saved selection (or the environment), or null if none is usable. */
export function getAIProvider(): AIProvider | null {
  if (override !== undefined) return override;
  const id = resolveProvider();
  if (!id) return null;
  const model = resolveModel(id);
  // Instances are reused so per-endpoint adaptations (token parameter, refusal fallbacks) are learned once.
  const key = `${id}|${model}|${id === "openai-compatible" ? config.ai.openaiBaseUrl : ""}`;
  let p = instances.get(key);
  if (!p) {
    p = id === "anthropic" ? new AnthropicProvider({ apiKey: config.ai.anthropicApiKey, model }) : new OpenAICompatibleProvider({ model });
    instances.set(key, p);
  }
  return p;
}

export function providerStatus(): ProviderStatus {
  const p = getAIProvider();
  if (p) return { available: true, provider: p.name, model: p.model };
  const choice = selectedProvider();
  const model = resolveModel(choice === "openai-compatible" ? "openai-compatible" : "anthropic");
  const reason =
    choice === "none" ? "AI is turned off. Choose a provider in AI settings to enable AI review and narrative documentation. Deterministic analysis still runs."
    : choice === "anthropic" ? "Anthropic is selected but ANTHROPIC_API_KEY is not set. Add it to .env and restart Brody, or pick another provider in AI settings."
    : choice === "openai-compatible" ? "OpenAI is selected but OPENAI_API_KEY is not set. Add it to .env and restart Brody, or pick another provider in AI settings."
    : "No AI provider is configured. Set ANTHROPIC_API_KEY, or OPENAI_API_KEY, in .env to enable AI review and narrative documentation. Deterministic analysis still runs.";
  return { available: false, provider: choice === "none" || choice === "auto" ? "none" : choice, model, reason };
}

/** Tracks usage across a whole analysis job. */
export class UsageMeter {
  usage: AnalysisUsage = { inputTokens: 0, outputTokens: 0, calls: 0 };
  failures: { task: string; error: string }[] = [];
  add(u: AnalysisUsage): void {
    this.usage.inputTokens += u.inputTokens;
    this.usage.outputTokens += u.outputTokens;
    this.usage.calls += u.calls;
  }
}

/** Run a structured request and swallow provider failures into the meter so one failed pass never aborts the whole job. */
export async function tryAnalyze<T>(provider: AIProvider | null, meter: UsageMeter, req: AnalysisRequest<T>): Promise<T | undefined> {
  if (!provider) return undefined;
  try {
    const r: AnalysisResult<T> = await provider.analyze(req);
    meter.add(r.usage);
    return r.data;
  } catch (e) {
    meter.failures.push({ task: req.task, error: e instanceof Error ? e.message : String(e) });
    return undefined;
  }
}

export function requireProvider(): AIProvider {
  const p = getAIProvider();
  if (!p) throw new AIUnavailableError(providerStatus().reason ?? "AI provider unavailable");
  return p;
}

export interface ProviderHealth extends ProviderStatus {
  checked: boolean;
  ok?: boolean;
  problem?: { summary: string; hint: string };
}

let healthCache: { at: number; key: string; value: ProviderHealth } | undefined;

/** Verify that the configured provider accepts our credentials (cached for five minutes). */
export async function checkProvider(force = false): Promise<ProviderHealth> {
  const status = providerStatus();
  if (!status.available) return { ...status, checked: false };
  const p = getAIProvider();
  const key = `${status.provider}:${status.model}`;
  if (!force && healthCache && healthCache.key === key && Date.now() - healthCache.at < 5 * 60_000) return healthCache.value;
  let value: ProviderHealth;
  try {
    if (p?.ping) await p.ping();
    else if (p) await p.analyze({ task: "ping", system: "Reply in JSON.", prompt: 'Return {"ok": true}.', schema: z.object({ ok: z.boolean() }), maxTokens: 50 });
    value = { ...status, checked: true, ok: true };
  } catch (e) {
    value = { ...status, checked: true, ok: false, problem: explainAIError(e instanceof Error ? e.message : String(e)) };
  }
  healthCache = { at: Date.now(), key, value };
  return value;
}
