import { z } from "zod";
import { guard, json } from "@/lib/api";
import { effectiveRouting, EXECUTION_MODES, explainerSettingsSchema, PRIVACY_POLICIES, readExplainerSettings, TTS_PROVIDER_IDS, updateExplainerSettings } from "@/lib/explainer/config";
import { jsonBody } from "@/lib/explainer/http";
import { availableRenderers } from "@/lib/explainer/render";
import { providerStatuses } from "@/lib/explainer/tts";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function state(force = false) {
  const [voices, renderers] = await Promise.all([providerStatuses(force), availableRenderers()]);
  return {
    saved: readExplainerSettings(),
    effective: effectiveRouting(),
    options: { execution: EXECUTION_MODES, privacy: PRIVACY_POLICIES, ttsProviders: TTS_PROVIDER_IDS },
    // Capabilities only: never a key, never a key's presence beyond "available".
    voices: voices.filter((v) => v.id !== "synthetic" || v.available && process.env.EXPLAINER_TTS_PROVIDER === "synthetic").map((v) => ({ id: v.id, label: v.label, local: v.local, wordTimings: v.wordTimings, available: v.available, reason: v.reason, defaultVoice: v.defaultVoice })),
    renderers,
  };
}

/** GET /api/explainer/settings  Provider routing (local / cloud / hybrid), privacy policy, voices and renderers with their availability. */
export async function GET(req: Request) {
  return guard(async () => json(await state(new URL(req.url).searchParams.has("refresh"))));
}

/** PUT /api/explainer/settings  { execution?, privacy?, ttsProvider?, voice?, renderer? } (null clears a value). */
export async function PUT(req: Request) {
  return guard(async () => {
    const patch = await jsonBody(req, z.object(Object.fromEntries(Object.keys(explainerSettingsSchema.shape).map((k) => [k, z.string().max(120).nullable().optional()]))), "See GET /api/explainer/settings for the options.");
    updateExplainerSettings(patch as Record<string, string | null>);
    return json(await state());
  });
}
