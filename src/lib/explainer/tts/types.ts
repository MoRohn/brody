import type { TimingSource } from "../types";

export interface TTSCapabilities {
  /** The provider reports when each word is spoken (from the engine, or by aligning its own audio). */
  supportsWordTimings: boolean;
  supportsSentenceTimings: boolean;
  supportsStreaming: boolean;
  /** Runs on this machine: narration text never leaves it. */
  supportsLocalInference: boolean;
  supportsVoiceClone: boolean;
  /** Longest input accepted in one request; longer text is split on sentence boundaries. */
  charLimit: number;
}

export interface TTSRequest {
  /** The SPOKEN form of the text (see speech.ts). */
  text: string;
  voice?: string;
  /** Directory for the provider's raw output. */
  workDir: string;
  signal?: AbortSignal;
}

export interface TTSWord {
  text: string;
  startMs: number;
  endMs: number;
  /** Character range in request.text, when the provider reports it. */
  charStart?: number;
  charEnd?: number;
}

export interface TTSResult {
  /** 48 kHz mono 16-bit WAV. */
  audioPath: string;
  words: TTSWord[];
  durationMs: number;
  timing: { source: TimingSource; granularity: "word" | "sentence" };
  /** Diagnostic metadata only. Never audio, never a key. */
  providerMetadata?: Record<string, unknown>;
}

export interface TTSProvider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: TTSCapabilities;
  readonly defaultVoice: string;
  /** Null when usable; otherwise why not, with the fix. */
  unavailableReason(): Promise<string | null>;
  synthesize(request: TTSRequest): Promise<TTSResult>;
  /** Voices the user can pick, when the provider can list them cheaply. */
  voices?(): Promise<{ id: string; name: string }[]>;
  /** Approximate price per million characters, when known, for cost accounting. */
  readonly usdPerMillionChars?: number;
}

export class TTSError extends Error {
  constructor(message: string, readonly provider: string, readonly retryable = false) {
    super(message);
    this.name = "TTSError";
  }
}

/** Remove anything key-like, and the configured keys themselves, from a message before it can be logged or stored. */
export function scrubSecrets(message: string, keys: string[] = []): string {
  let m = message;
  for (const k of keys) if (k && k.length >= 8) m = m.split(k).join("[key]");
  return m
    .replace(/\b(sk|xi|sk_live|sk_test)[-_][A-Za-z0-9_-]{8,}\b/g, "[key]")
    .replace(/Bearer\s+\S+/gi, "Bearer [key]")
    .replace(/(xi-api-key|api[-_]?key|authorization)(\s*["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1$2[key]");
}
