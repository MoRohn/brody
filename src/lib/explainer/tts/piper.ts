/**
 * Piper, a local neural voice (https://github.com/rhasspy/piper). Private and offline, but it reports no word timings.
 *
 * It is therefore used in an explicitly lower-fidelity mode: each SENTENCE is synthesised on its own and the exact sample
 * count of every sentence is measured, so sentence boundaries are measured facts. Words inside a sentence are spread over
 * the sentence's audible span and marked interpolated; beats then snap to sentence starts (NarrativeBeat.sentenceAnchored),
 * and the manifest and the UI say "sentence-level timing". It never pretends to be word-accurate.
 */
import fs from "node:fs";
import path from "node:path";
import { explainerConfig } from "../config";
import { encodeWav, readWavFile, SAMPLE_RATE, silences } from "../audio";
import { run, toPcmWav } from "../media";
import { splitSentences } from "../speech";
import { TTSError, type TTSProvider, type TTSRequest, type TTSResult, type TTSWord } from "./types";

export const SENTENCE_GAP_MS = 260;

/** Spread a sentence's words over its audible span, weighted by length. Marked as interpolated by the caller. */
export function spreadWords(sentence: string, offsetChars: number, startMs: number, endMs: number): TTSWord[] {
  const re = /\S+/g;
  const items: { w: string; at: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sentence))) items.push({ w: m[0], at: m.index });
  const weight = items.map((x) => x.w.replace(/[^A-Za-z0-9]/g, "").length + 2);
  const total = weight.reduce((a, b) => a + b, 0) || 1;
  let t = startMs;
  return items.map((x, i) => {
    const d = ((endMs - startMs) * weight[i]) / total;
    const w: TTSWord = { text: x.w, startMs: t, endMs: t + d, charStart: offsetChars + x.at, charEnd: offsetChars + x.at + x.w.length };
    t += d;
    return w;
  });
}

/**
 * Speak text one sentence at a time with `speak(sentence, wavPath)`, measuring each sentence's real length, and join
 * the sentences with a fixed pause. Sentence boundaries are measured; words inside a sentence are spread over its
 * audible span and the result says so (granularity "sentence"). Shared by every local voice that reports no timings.
 */
export async function synthesizeBySentence(req: TTSRequest, provider: string, speak: (sentence: string, wavPath: string) => Promise<void>, meta: Record<string, unknown> = {}): Promise<TTSResult> {
  fs.mkdirSync(req.workDir, { recursive: true });
  const sentences = splitSentences(req.text);
  const parts: Buffer[] = [];
  const words: TTSWord[] = [];
  let ms = 0;
  let searchFrom = 0;
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    const raw = path.join(req.workDir, `s${i}-raw.wav`);
    try { await speak(s, raw); } catch (e) { throw e instanceof TTSError ? e : new TTSError(`${provider} failed on sentence ${i + 1}: ${(e as Error).message}`, provider, true); }
    if (!fs.existsSync(raw)) throw new TTSError(`${provider} wrote no audio for sentence ${i + 1}.`, provider, true);
    const wav = path.join(req.workDir, `s${i}.wav`);
    await toPcmWav(raw, wav, { signal: req.signal });
    const pcm = readWavFile(wav);
    const lenMs = (pcm.data.length / 2 / SAMPLE_RATE) * 1000;
    // The audible span inside this sentence's audio: trim leading and trailing silence.
    const q = silences(pcm, 40, 0.012);
    const lead = q[0] && q[0].startMs <= 1 ? q[0].endMs : 0;
    const tail = q.length && Math.abs(q[q.length - 1].endMs - lenMs) < 15 ? q[q.length - 1].startMs : lenMs;
    const at = req.text.indexOf(s, searchFrom);
    searchFrom = at >= 0 ? at + s.length : searchFrom;
    words.push(...spreadWords(s, Math.max(0, at), ms + lead, ms + Math.max(lead + 50, tail)));
    parts.push(pcm.data);
    ms += lenMs;
    if (i < sentences.length - 1) { const gap = Buffer.alloc(Math.round((SENTENCE_GAP_MS / 1000) * SAMPLE_RATE) * 2); parts.push(gap); ms += SENTENCE_GAP_MS; }
    fs.rmSync(raw, { force: true });
    fs.rmSync(wav, { force: true });
  }
  const audioPath = path.join(req.workDir, "speech.wav");
  const data = Buffer.concat(parts);
  fs.writeFileSync(audioPath, encodeWav(data));
  return { audioPath, words, durationMs: (data.length / 2 / SAMPLE_RATE) * 1000, timing: { source: "segment-measured", granularity: "sentence" }, providerMetadata: { ...meta, sentences: sentences.length } };
}

export class PiperProvider implements TTSProvider {
  readonly id = "piper";
  readonly label = "Piper local voice (sentence-level timing)";
  readonly defaultVoice = "default";
  readonly usdPerMillionChars = 0;
  readonly capabilities = { supportsWordTimings: false, supportsSentenceTimings: true, supportsStreaming: false, supportsLocalInference: true, supportsVoiceClone: false, charLimit: 5_000 };

  async unavailableReason(): Promise<string | null> {
    const cfg = explainerConfig();
    if (!cfg.piperModel) return "PIPER_MODEL is not set (path to a Piper .onnx voice).";
    try { const r = await run(cfg.piperBin, ["--help"], { timeoutMs: 10_000 }); return r.code === 0 || /usage/i.test(r.stderr) ? null : "Piper did not start."; } catch { return `Piper was not found (${cfg.piperBin}).`; }
  }

  async synthesize(req: TTSRequest): Promise<TTSResult> {
    const cfg = explainerConfig();
    return synthesizeBySentence(req, "piper", async (sentence, raw) => {
      const r = await run(cfg.piperBin, ["--model", cfg.piperModel, "--output_file", raw], { input: Buffer.from(sentence), timeoutMs: cfg.ttsTimeoutMs, signal: req.signal });
      if (r.code !== 0) throw new TTSError(`Piper failed: ${r.stderr.trim().slice(-300)}`, "piper", true);
    }, { model: path.basename(cfg.piperModel) });
  }
}
