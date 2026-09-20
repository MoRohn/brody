import path from "node:path";
import { guard, json } from "@/lib/api";
import { checkProvider, providerStatus, resetProviderCache, selectedProvider } from "@/lib/ai";
import { config } from "@/lib/config";
import { DEFAULT_MODELS, providerConfigured, readSettings, resolveEmbeddingModel, resolveModel, settingsPatchSchema, updateSettings } from "@/lib/ai/settings";
import { runtimeKind } from "@/lib/runtime";
import { AppError } from "@/lib/util/errors";

export const dynamic = "force-dynamic";

function endpoint(): string {
  try {
    const u = new URL(config.ai.openaiBaseUrl);
    return `${u.origin}${u.pathname}`.replace(/\/$/, "");
  } catch {
    return "";
  }
}

/** Current selections and which providers have credentials. Never includes a key. */
function view() {
  const saved = readSettings();
  return {
    provider: selectedProvider(),
    savedProvider: saved.provider ?? null,
    effective: providerStatus(),
    providers: {
      anthropic: { label: "Anthropic (Claude)", configured: providerConfigured("anthropic"), model: resolveModel("anthropic"), defaultModel: DEFAULT_MODELS.anthropic, savedModel: saved.models?.anthropic ?? null, keyVariable: "ANTHROPIC_API_KEY" },
      "openai-compatible": { label: "OpenAI (or compatible)", configured: providerConfigured("openai-compatible"), model: resolveModel("openai-compatible"), defaultModel: DEFAULT_MODELS["openai-compatible"], savedModel: saved.models?.["openai-compatible"] ?? null, keyVariable: "OPENAI_API_KEY", endpoint: endpoint() },
    },
    /** Where API keys are entered. Keys are only ever read from the environment, never accepted over HTTP. */
    envFile: path.join(process.cwd(), ".env"),
    runtime: runtimeKind(),
    embeddingModel: { value: resolveEmbeddingModel() ?? null, saved: saved.embeddingModel ?? null },
  };
}

export async function GET() {
  return guard(() => json(view()));
}

/** Save provider and model selections. Body: { provider?, models?: { anthropic?, "openai-compatible"? }, embeddingModel? }; null clears a value. */
export async function PUT(req: Request) {
  return guard(async () => {
    // Requiring JSON forces a CORS preflight, so other websites cannot change these settings from a browser.
    if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new AppError("unsupported_media_type", "Send the settings as JSON.", 415);
    const body = await req.json().catch(() => null);
    const parsed = settingsPatchSchema.safeParse(body);
    if (!parsed.success) throw new AppError("invalid_settings", `Those AI settings are not valid: ${parsed.error.issues[0]?.message ?? "unrecognised input"}`, 400, "Choose a provider and a model ID such as claude-opus-5 or gpt-4.1.");
    updateSettings(parsed.data);
    resetProviderCache();
    const test = new URL(req.url).searchParams.get("test");
    const health = test ? await checkProvider(true) : undefined;
    return json({ ...view(), health });
  });
}
