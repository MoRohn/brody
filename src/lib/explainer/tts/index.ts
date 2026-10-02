/**
 * TTS provider registry and routing (LOCAL / CLOUD / HYBRID).
 *
 * Routing picks, in order: the provider the request names (if the mode and privacy policy allow it), then local voices
 * that measure word timing, then local voices with sentence timing, then (cloud and hybrid only, and only when privacy
 * allows) cloud voices. A provider that fails is skipped and the next eligible one is tried; the manifest records which
 * one spoke and why.
 */
import { effectiveRouting, type TtsProviderId } from "../config";
import type { PrivacyDecision } from "../privacy";
import { ElevenLabsProvider, OpenAISpeechProvider, SpeechifyProvider } from "./cloud";
import { MacSpeechProvider } from "./macos";
import { EspeakProvider } from "./espeak";
import { PiperProvider } from "./piper";
import { WindowsSpeechProvider } from "./windows";
import { SyntheticProvider } from "./synthetic";
import type { TTSProvider } from "./types";

export * from "./types";
export { SyntheticProvider } from "./synthetic";

interface Registry { providers: Map<string, TTSProvider>; override?: TTSProvider[] }
const reg: Registry = ((globalThis as unknown as { __brodyTts?: Registry }).__brodyTts ??= { providers: new Map() });

function build(): Map<string, TTSProvider> {
  if (reg.providers.size === 0) {
    // Order is the preference among equals: word-timed local voices, then sentence-timed ones (Piper sounds better than
    // eSpeak NG), then cloud voices.
    for (const p of [new MacSpeechProvider(), new WindowsSpeechProvider(), new PiperProvider(), new EspeakProvider(), new OpenAISpeechProvider(), new ElevenLabsProvider(), new SpeechifyProvider(), new SyntheticProvider()]) reg.providers.set(p.id, p);
  }
  return reg.providers;
}

/** Tests and embedding applications can replace the registry. Pass undefined to restore it. */
export function setTtsProviders(providers: TTSProvider[] | undefined): void {
  reg.override = providers;
}

export function allTtsProviders(): TTSProvider[] {
  return reg.override ?? [...build().values()];
}

export function getTtsProvider(id: string): TTSProvider | undefined {
  return allTtsProviders().find((p) => p.id === id);
}

export interface ProviderStatusRow {
  id: string;
  label: string;
  local: boolean;
  wordTimings: boolean;
  available: boolean;
  reason: string | null;
  defaultVoice: string;
  capabilities: TTSProvider["capabilities"];
}

const statusCache = new Map<string, { at: number; reason: string | null }>();

export async function providerStatuses(force = false): Promise<ProviderStatusRow[]> {
  const out: ProviderStatusRow[] = [];
  for (const p of allTtsProviders()) {
    let c = statusCache.get(p.id);
    if (force || !c || Date.now() - c.at > 60_000) { c = { at: Date.now(), reason: await p.unavailableReason().catch((e) => String(e?.message ?? e)) }; statusCache.set(p.id, c); }
    out.push({ id: p.id, label: p.label, local: p.capabilities.supportsLocalInference, wordTimings: p.capabilities.supportsWordTimings, available: c.reason === null, reason: c.reason, defaultVoice: p.defaultVoice, capabilities: p.capabilities });
  }
  return out;
}

export interface RouteRequest {
  execution?: "local" | "cloud" | "hybrid";
  requested?: string;
  privacy: PrivacyDecision;
}

export interface Route { candidates: TTSProvider[]; skipped: { id: string; why: string }[]; execution: "local" | "cloud" | "hybrid" }

export async function routeTts(req: RouteRequest): Promise<Route> {
  const routing = effectiveRouting();
  const execution = req.execution ?? routing.execution;
  const requested = req.requested && req.requested !== "auto" ? req.requested : routing.ttsProvider !== "auto" ? routing.ttsProvider : undefined;
  const statuses = await providerStatuses();
  const skipped: { id: string; why: string }[] = [];
  const eligible = (p: TTSProvider): boolean => {
    const st = statuses.find((s) => s.id === p.id);
    if (!st?.available) { skipped.push({ id: p.id, why: st?.reason ?? "unavailable" }); return false; }
    const local = p.capabilities.supportsLocalInference;
    if (execution === "local" && !local) { skipped.push({ id: p.id, why: "execution is local-only" }); return false; }
    if (execution === "cloud" && local && p.id !== requested) { skipped.push({ id: p.id, why: "execution is cloud" }); return false; }
    if (!local && !req.privacy.externalAllowed) { skipped.push({ id: p.id, why: req.privacy.blockedBecause ?? "privacy policy" }); return false; }
    // The synthetic voice is a test instrument; it is only used when asked for by name.
    if (p.id === "synthetic" && requested !== "synthetic") return false;
    return true;
  };
  const rank = (p: TTSProvider) => (p.id === requested ? -10 : 0) + (p.capabilities.supportsLocalInference ? (execution === "cloud" ? 4 : 0) : execution === "local" ? 9 : 2) + (p.capabilities.supportsWordTimings ? 0 : 3);
  const candidates = allTtsProviders().filter(eligible).sort((a, b) => rank(a) - rank(b));
  return { candidates, skipped, execution };
}

export type { TtsProviderId };
