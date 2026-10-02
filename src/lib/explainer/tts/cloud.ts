/**
 * Cloud voices. Each one returns MEASURED word timings or is not used for word-synchronised video:
 *
 *  - ElevenLabs  /with-timestamps returns per-character start and end times for the text we sent; folded into words.
 *  - Speechify   /v1/audio/speech returns nested speech marks with word start and end times (the /stream endpoint
 *                does not, which is why it is not used). Adapted from the explainer-video reference (MIT, Paul Lemaistre).
 *  - OpenAI      the speech endpoint returns audio only, so the audio is aligned by OpenAI's transcription model with
 *                word timestamps: timing then comes from the audio itself ("aligned"), never from a words-per-minute guess.
 *
 * Keys come from the environment only. They are sent as request headers, never logged, and scrubbed from every error.
 */
import fs from "node:fs";
import path from "node:path";
import { explainerConfig } from "../config";
import { encodeWav, parseWav } from "../audio";
import { toPcmWav } from "../media";
import { scrubSecrets, TTSError, type TTSProvider, type TTSRequest, type TTSResult, type TTSWord } from "./types";

const cloudCaps = (charLimit: number, wordTimings = true) => ({ supportsWordTimings: wordTimings, supportsSentenceTimings: true, supportsStreaming: true, supportsLocalInference: false, supportsVoiceClone: false, charLimit });

async function call(provider: string, url: string, init: RequestInit, keys: string[], signal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(explainerConfig().ttsTimeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (e) {
    const msg = e instanceof Error ? (e.name === "TimeoutError" ? "the request timed out" : e.message) : String(e);
    throw new TTSError(`${provider}: could not reach the speech service (${scrubSecrets(msg, keys)}).`, provider, true);
  }
  if (!res.ok) {
    const body = scrubSecrets((await res.text().catch(() => "")).slice(0, 400), keys);
    const auth = res.status === 401 || res.status === 403;
    throw new TTSError(`${provider}: HTTP ${res.status}${auth ? " (the API key was rejected; check it in .env)" : ""}${body ? `: ${body}` : ""}`, provider, res.status === 429 || res.status >= 500);
  }
  return res;
}

/** Fold character timings into words of the text we sent. */
export function wordsFromCharacters(text: string, chars: string[], starts: number[], ends: number[]): TTSWord[] {
  // The service echoes the characters it spoke; map them onto our text by walking both in step.
  const words: TTSWord[] = [];
  let ti = 0;
  let cur: TTSWord | null = null;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    while (ti < text.length && text[ti] !== ch && /\s/.test(text[ti])) ti++;
    const at = text[ti] === ch ? ti : -1;
    if (at >= 0) ti++;
    if (/\s/.test(ch)) { if (cur) { words.push(cur); cur = null; } continue; }
    const s = starts[i] * 1000, e = ends[i] * 1000;
    if (!cur) cur = { text: ch, startMs: s, endMs: e, charStart: at >= 0 ? at : undefined, charEnd: at >= 0 ? at + 1 : undefined };
    else { cur.text += ch; cur.endMs = Math.max(cur.endMs, e); if (at >= 0) cur.charEnd = at + 1; }
  }
  if (cur) words.push(cur);
  return words;
}

export class ElevenLabsProvider implements TTSProvider {
  readonly id = "elevenlabs";
  readonly label = "ElevenLabs";
  readonly usdPerMillionChars = 180;
  readonly capabilities = { ...cloudCaps(9_500), supportsVoiceClone: true };
  get defaultVoice() { return explainerConfig().elevenlabsVoice; }
  async unavailableReason() { return explainerConfig().elevenlabsKey ? null : "ELEVENLABS_API_KEY is not set. Add it to .env and restart Brody."; }
  async synthesize(req: TTSRequest): Promise<TTSResult> {
    const cfg = explainerConfig();
    const voice = req.voice || cfg.elevenlabsVoice;
    const res = await call("elevenlabs", `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/with-timestamps?output_format=pcm_44100`, {
      method: "POST", headers: { "xi-api-key": cfg.elevenlabsKey, "Content-Type": "application/json" }, body: JSON.stringify({ text: req.text, model_id: cfg.elevenlabsModel }),
    }, [cfg.elevenlabsKey], req.signal);
    const j = (await res.json()) as { audio_base64?: string; alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] } };
    if (!j.audio_base64 || !j.alignment) throw new TTSError("elevenlabs: the response had no audio or no alignment.", "elevenlabs");
    fs.mkdirSync(req.workDir, { recursive: true });
    const raw = path.join(req.workDir, "speech-44k.wav");
    fs.writeFileSync(raw, encodeWav(Buffer.from(j.audio_base64, "base64"), 44_100));
    const wav = path.join(req.workDir, "speech.wav");
    await toPcmWav(raw, wav, { signal: req.signal });
    const pcm = parseWav(fs.readFileSync(wav));
    const a = j.alignment;
    return { audioPath: wav, words: wordsFromCharacters(req.text, a.characters, a.character_start_times_seconds, a.character_end_times_seconds), durationMs: (pcm.data.length / 2 / pcm.sampleRate) * 1000, timing: { source: "provider", granularity: "word" }, providerMetadata: { voice, model: cfg.elevenlabsModel } };
  }
}

interface SpeechMark { type?: string; value?: string; start?: number; end?: number; start_time?: number; end_time?: number; chunks?: SpeechMark[] }

export function flattenSpeechMarks(root: SpeechMark): SpeechMark[] {
  const out: SpeechMark[] = [];
  const walk = (n: SpeechMark, depth: number) => {
    if (depth > 20) throw new TTSError("speechify: speech marks are nested more deeply than expected.", "speechify");
    if (n.type === "word") out.push(n);
    for (const c of n.chunks ?? []) walk(c, depth + 1);
  };
  walk(root, 0);
  return out;
}

export class SpeechifyProvider implements TTSProvider {
  readonly id = "speechify";
  readonly label = "Speechify";
  readonly usdPerMillionChars = 10;
  readonly capabilities = cloudCaps(2_000);
  get defaultVoice() { return explainerConfig().speechifyVoice; }
  async unavailableReason() { return explainerConfig().speechifyKey ? null : "SPEECHIFY_API_KEY is not set. Add it to .env and restart Brody."; }
  async synthesize(req: TTSRequest): Promise<TTSResult> {
    const cfg = explainerConfig();
    const res = await call("speechify", "https://api.sws.speechify.com/v1/audio/speech", {
      method: "POST", headers: { Authorization: `Bearer ${cfg.speechifyKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ input: req.text, voice_id: req.voice || cfg.speechifyVoice, model: cfg.speechifyModel, audio_format: "wav" }),
    }, [cfg.speechifyKey], req.signal);
    const j = (await res.json()) as { audio_data?: string; speech_marks?: SpeechMark };
    if (!j.audio_data || !j.speech_marks) throw new TTSError("speechify: the response had no audio_data or no speech_marks.", "speechify");
    fs.mkdirSync(req.workDir, { recursive: true });
    const raw = path.join(req.workDir, "speech-raw.wav");
    fs.writeFileSync(raw, Buffer.from(j.audio_data, "base64"));
    const wav = path.join(req.workDir, "speech.wav");
    await toPcmWav(raw, wav, { signal: req.signal });
    const pcm = parseWav(fs.readFileSync(wav));
    const words = flattenSpeechMarks(j.speech_marks).map((m) => ({ text: m.value ?? "", startMs: m.start_time ?? 0, endMs: m.end_time ?? 0, charStart: m.start, charEnd: m.end }));
    return { audioPath: wav, words, durationMs: (pcm.data.length / 2 / pcm.sampleRate) * 1000, timing: { source: "provider", granularity: "word" }, providerMetadata: { voice: req.voice || cfg.speechifyVoice, model: cfg.speechifyModel } };
  }
}

export class OpenAISpeechProvider implements TTSProvider {
  readonly id = "openai";
  readonly label = "OpenAI speech + transcription alignment";
  readonly usdPerMillionChars = 15;
  readonly capabilities = cloudCaps(4_000);
  get defaultVoice() { return explainerConfig().openaiTtsVoice; }
  async unavailableReason() { return explainerConfig().openaiKey ? null : "OPENAI_API_KEY is not set. Add it to .env and restart Brody."; }
  async synthesize(req: TTSRequest): Promise<TTSResult> {
    const cfg = explainerConfig();
    const keys = [cfg.openaiKey];
    const res = await call("openai", `${cfg.openaiTtsBaseUrl.replace(/\/$/, "")}/audio/speech`, {
      method: "POST", headers: { Authorization: `Bearer ${cfg.openaiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: cfg.openaiTtsModel, voice: req.voice || cfg.openaiTtsVoice, input: req.text, response_format: "wav" }),
    }, keys, req.signal);
    fs.mkdirSync(req.workDir, { recursive: true });
    const raw = path.join(req.workDir, "speech-raw.wav");
    fs.writeFileSync(raw, Buffer.from(await res.arrayBuffer()));
    const wav = path.join(req.workDir, "speech.wav");
    await toPcmWav(raw, wav, { signal: req.signal });
    // Alignment: transcribe our own audio with word timestamps. The words are what was actually spoken, when.
    const form = new FormData();
    form.append("file", new Blob([fs.readFileSync(wav)], { type: "audio/wav" }), "speech.wav");
    form.append("model", cfg.openaiTranscribeModel);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    form.append("prompt", req.text.slice(0, 800));
    const tr = await call("openai", `${cfg.openaiTtsBaseUrl.replace(/\/$/, "")}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${cfg.openaiKey}` }, body: form }, keys, req.signal);
    const j = (await tr.json()) as { words?: { word: string; start: number; end: number }[] };
    if (!j.words?.length) throw new TTSError("openai: the transcription returned no word timestamps, so the speech cannot be aligned.", "openai");
    const pcm = parseWav(fs.readFileSync(wav));
    return { audioPath: wav, words: j.words.map((w) => ({ text: w.word, startMs: w.start * 1000, endMs: w.end * 1000 })), durationMs: (pcm.data.length / 2 / pcm.sampleRate) * 1000, timing: { source: "aligned", granularity: "word" }, providerMetadata: { voice: req.voice || cfg.openaiTtsVoice, model: cfg.openaiTtsModel, aligner: cfg.openaiTranscribeModel } };
  }
}
