/**
 * Explainer configuration: environment first, then the saved runtime selection (explainer-settings.json next to the
 * database, like ai-settings.json), then defaults. Keys are read from the environment only and are never saved,
 * returned by the API, logged or written into an artifact.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { config } from "../config";

export const EXECUTION_MODES = ["local", "cloud", "hybrid"] as const;
export const PRIVACY_POLICIES = ["local-only", "ask", "allow"] as const;
export const TTS_PROVIDER_IDS = ["macos", "piper", "openai", "elevenlabs", "speechify", "synthetic"] as const;
export type TtsProviderId = (typeof TTS_PROVIDER_IDS)[number];

const int = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

function defaultManimPython(): string {
  const venv = path.join(os.homedir(), ".local", "share", "brody", "explainer-venv", "bin", "python");
  // brody-ignore: sync-io (checked once per configuration read; a single stat)
  return fs.existsSync(venv) ? venv : "python3";
}

/** Read lazily so tests and the settings panel see changes without a restart. */
export function explainerConfig() {
  const dataDir = config.databasePath === ":memory:" ? path.join(os.tmpdir(), `brody-explainers-${process.pid}`) : path.join(path.dirname(config.databasePath), "explainers");
  return {
    dir: process.env.EXPLAINER_DIR || dataDir,
    ffmpeg: process.env.FFMPEG_PATH || "ffmpeg",
    ffprobe: process.env.FFPROBE_PATH || "ffprobe",
    manimPython: process.env.MANIM_PYTHON || defaultManimPython(),
    swiftc: process.env.SWIFTC_PATH || "swiftc",
    piperBin: process.env.PIPER_BIN || "piper",
    piperModel: process.env.PIPER_MODEL || "",
    openaiKey: process.env.OPENAI_API_KEY || "",
    /** TTS has its own base URL: OPENAI_BASE_URL often points at a local chat-only endpoint. */
    openaiTtsBaseUrl: process.env.OPENAI_TTS_BASE_URL || "https://api.openai.com/v1",
    openaiTtsModel: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
    openaiTtsVoice: process.env.OPENAI_TTS_VOICE || "alloy",
    openaiTranscribeModel: process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1",
    elevenlabsKey: process.env.ELEVENLABS_API_KEY || "",
    elevenlabsVoice: process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb",
    elevenlabsModel: process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2",
    speechifyKey: process.env.SPEECHIFY_API_KEY || "",
    speechifyVoice: process.env.SPEECHIFY_VOICE || "geffen_32",
    speechifyModel: process.env.SPEECHIFY_MODEL || "simba-3.2",
    /** Pause between sections, before rounding up to a whole frame. */
    sectionPauseMs: int("EXPLAINER_SECTION_PAUSE_MS", 420),
    jobTimeoutMs: int("EXPLAINER_JOB_TIMEOUT_MS", 45 * 60_000),
    ttsTimeoutMs: int("EXPLAINER_TTS_TIMEOUT_MS", 120_000),
    renderTimeoutMs: int("EXPLAINER_RENDER_TIMEOUT_MS", 15 * 60_000),
    renderConcurrency: int("EXPLAINER_RENDER_CONCURRENCY", Math.max(1, Math.min(3, os.availableParallelism() - 1))),
    maxAttempts: int("EXPLAINER_MAX_ATTEMPTS", 3),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Saved selections
// ---------------------------------------------------------------------------------------------------------------------
export const explainerSettingsSchema = z.object({
  execution: z.enum(EXECUTION_MODES).optional(),
  privacy: z.enum(PRIVACY_POLICIES).optional(),
  ttsProvider: z.enum(["auto", ...TTS_PROVIDER_IDS]).optional(),
  voice: z.string().trim().max(120).regex(/^[\w .:()/-]*$/).optional(),
  renderer: z.enum(["auto", "manim", "html"]).optional(),
});
export type ExplainerSettings = z.infer<typeof explainerSettingsSchema>;

function settingsPath(): string | null {
  if (process.env.EXPLAINER_SETTINGS_PATH) return process.env.EXPLAINER_SETTINGS_PATH;
  if (config.databasePath === ":memory:") return null;
  return path.join(path.dirname(config.databasePath), "explainer-settings.json");
}
let memory: ExplainerSettings = {};

export function readExplainerSettings(): ExplainerSettings {
  const file = settingsPath();
  if (!file) return memory;
  try {
    const parsed = explainerSettingsSchema.safeParse(JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8"))); // brody-ignore: sync-io (tiny file)
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function updateExplainerSettings(patch: Partial<Record<keyof ExplainerSettings, string | null>>): ExplainerSettings {
  const next: Record<string, unknown> = { ...readExplainerSettings() };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null || v === "") delete next[k];
    else next[k] = v;
  }
  const value = explainerSettingsSchema.parse(next);
  const file = settingsPath();
  if (!file) memory = value;
  else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(/*turbopackIgnore: true*/ file, JSON.stringify(value, null, 2));
  }
  return value;
}

/** Effective routing: saved selection, then environment, then defaults (local execution, ask before sending anything out). */
export function effectiveRouting() {
  const s = readExplainerSettings();
  const env = (k: string) => process.env[k] || undefined;
  return {
    execution: (s.execution ?? env("EXPLAINER_EXECUTION") ?? "local") as (typeof EXECUTION_MODES)[number],
    privacy: (s.privacy ?? env("EXPLAINER_PRIVACY") ?? "ask") as (typeof PRIVACY_POLICIES)[number],
    ttsProvider: (s.ttsProvider ?? env("EXPLAINER_TTS_PROVIDER") ?? "auto") as TtsProviderId | "auto",
    voice: s.voice ?? env("EXPLAINER_VOICE"),
    renderer: (s.renderer ?? env("EXPLAINER_RENDERER") ?? "auto") as "auto" | "manim" | "html",
  };
}
