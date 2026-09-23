import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { config } from "../config";

/**
 * Runtime AI selections (provider and model names), persisted next to the database so the web
 * server and the standalone worker agree. API keys are never stored here; they come from the
 * environment only.
 */
export const PROVIDER_IDS = ["anthropic", "openai-compatible"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export type ProviderChoice = ProviderId | "auto" | "none";

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: "claude-opus-5",
  "openai-compatible": "gpt-4.1",
};

/** Model IDs are opaque strings from the provider; accept anything that cannot smuggle markup or whitespace. */
export const modelIdSchema = z.string().trim().min(1, "Enter a model ID.").max(200).regex(/^[A-Za-z0-9][\w.:/@+-]*$/, "Model IDs may contain letters, digits and . _ : / @ + - only.");

export const settingsSchema = z.object({
  provider: z.enum(["auto", "anthropic", "openai-compatible", "none"]).optional(),
  models: z.object({ anthropic: modelIdSchema.optional(), "openai-compatible": modelIdSchema.optional() }).optional(),
  embeddingModel: modelIdSchema.optional(),
});
export type AISettings = z.infer<typeof settingsSchema>;

/** A patch: a null clears the saved value so the environment or default applies again. */
export const settingsPatchSchema = z.object({
  provider: z.enum(["auto", "anthropic", "openai-compatible", "none"]).nullable().optional(),
  models: z.object({ anthropic: modelIdSchema.nullable().optional(), "openai-compatible": modelIdSchema.nullable().optional() }).optional(),
  embeddingModel: modelIdSchema.nullable().optional(),
});
export type AISettingsPatch = z.infer<typeof settingsPatchSchema>;

/** The saved selection is runtime data, so its reads and writes are marked for the bundler not to trace the project through them. */
function settingsPath(): string | null {
  if (process.env.AI_SETTINGS_PATH) return process.env.AI_SETTINGS_PATH;
  if (config.databasePath === ":memory:") return null;
  return path.join(path.dirname(config.databasePath), "ai-settings.json");
}

let memory: AISettings = {};
let cache: { file: string; mtimeMs: number; value: AISettings } | undefined;

export function readSettings(): AISettings {
  const file = settingsPath();
  if (!file) return memory;
  try {
    const st = fs.statSync(/*turbopackIgnore: true*/ file); // brody-ignore: sync-io (a tiny file, re-read only when its mtime changes)
    if (cache && cache.file === file && cache.mtimeMs === st.mtimeMs) return cache.value;
    const parsed = settingsSchema.safeParse(JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8"))); // brody-ignore: sync-io
    const value = parsed.success ? parsed.data : {};
    cache = { file, mtimeMs: st.mtimeMs, value };
    return value;
  } catch {
    return {};
  }
}

export function updateSettings(patch: AISettingsPatch): AISettings {
  const next: AISettings = JSON.parse(JSON.stringify(readSettings()));
  if (patch.provider !== undefined) {
    if (patch.provider === null) delete next.provider;
    else next.provider = patch.provider;
  }
  if (patch.embeddingModel !== undefined) {
    if (patch.embeddingModel === null) delete next.embeddingModel;
    else next.embeddingModel = patch.embeddingModel;
  }
  if (patch.models) {
    next.models = { ...(next.models ?? {}) };
    for (const id of PROVIDER_IDS) {
      const v = patch.models[id];
      if (v === undefined) continue;
      if (v === null) delete next.models[id];
      else next.models[id] = v;
    }
    if (Object.keys(next.models).length === 0) delete next.models;
  }
  const file = settingsPath();
  if (!file) {
    memory = next;
    return next;
  }
  fs.mkdirSync(/*turbopackIgnore: true*/ path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  // brody-ignore: sync-io (an atomic write of a few hundred bytes when the user saves settings)
  fs.writeFileSync(/*turbopackIgnore: true*/ tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(/*turbopackIgnore: true*/ tmp, file);
  cache = undefined;
  return next;
}

/** Test helper: forget any cached or in-memory settings. */
export function resetSettingsCache(): void {
  memory = {};
  cache = undefined;
}

const LOCAL_URL = /localhost|127\.0\.0\.1|host\.docker\.internal/;

export function providerConfigured(id: ProviderId): boolean {
  if (id === "anthropic") return !!config.ai.anthropicApiKey;
  return !!config.ai.openaiApiKey || LOCAL_URL.test(config.ai.openaiBaseUrl);
}

/** Which provider the environment alone would pick. */
export function environmentProvider(): ProviderChoice {
  const raw = config.ai.provider;
  if (raw !== "auto") return raw;
  if (config.ai.anthropicApiKey) return "anthropic";
  if (providerConfigured("openai-compatible")) return "openai-compatible";
  return "auto";
}

/** The provider choice in force: saved selection first, then the environment. */
export function selectedProvider(): ProviderChoice {
  return readSettings().provider ?? config.ai.provider;
}

/** The concrete provider that will run, or null if none is usable. Auto prefers Anthropic when both are configured. */
export function resolveProvider(): ProviderId | null {
  const choice = selectedProvider();
  if (choice === "none") return null;
  if (choice === "anthropic" || choice === "openai-compatible") return providerConfigured(choice) ? choice : null;
  if (config.ai.anthropicApiKey) return "anthropic";
  if (providerConfigured("openai-compatible")) return "openai-compatible";
  return null;
}

/** Model for a provider: saved selection, then environment, then the built-in default. */
export function resolveModel(id: ProviderId): string {
  const saved = readSettings().models?.[id];
  if (saved) return saved;
  const specific = id === "anthropic" ? config.ai.anthropicModel : config.ai.openaiModel;
  if (specific) return specific;
  const legacy = config.ai.legacyModel;
  if (legacy && environmentProvider() === id) {
    // In automatic mode a Claude model ID cannot be meant for OpenAI (a stale AI_MODEL from an example file); ignore it.
    const stale = config.ai.provider === "auto" && id === "openai-compatible" && /^claude/i.test(legacy);
    if (!stale) return legacy;
  }
  return DEFAULT_MODELS[id];
}

export function resolveEmbeddingModel(): string | undefined {
  return readSettings().embeddingModel ?? config.ai.embeddingModel;
}
