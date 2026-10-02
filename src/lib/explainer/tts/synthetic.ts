/**
 * A deterministic stand-in voice for tests and machines without any speech engine (CI on Linux). It writes a soft tone
 * per word with real silences between words and sentences, so every downstream stage (alignment, beats, captions, mux,
 * validation) runs on real audio whose word times are known exactly. Labelled "synthetic" everywhere; never chosen
 * automatically unless EXPLAINER_TTS_PROVIDER=synthetic.
 */
import fs from "node:fs";
import path from "node:path";
import { encodeWav, SAMPLE_RATE } from "../audio";
import type { TTSProvider, TTSRequest, TTSResult, TTSWord } from "./types";

/** Speaking time of a word, from its letters: about 160 words a minute for ordinary prose. */
export function syntheticWordMs(word: string): number {
  const letters = word.replace(/[^A-Za-z0-9]/g, "").length;
  return 150 + letters * 38;
}

export class SyntheticProvider implements TTSProvider {
  readonly id = "synthetic";
  readonly label = "Synthetic test voice";
  readonly defaultVoice = "tone";
  readonly usdPerMillionChars = 0;
  readonly capabilities = { supportsWordTimings: true, supportsSentenceTimings: true, supportsStreaming: false, supportsLocalInference: true, supportsVoiceClone: false, charLimit: 100_000 };
  /** Test hook: fail the next N calls, or throw on text matching a pattern. */
  failNext = 0;
  failOn?: RegExp;
  calls: string[] = [];

  async unavailableReason(): Promise<string | null> { return null; }

  async synthesize(req: TTSRequest): Promise<TTSResult> {
    this.calls.push(req.text);
    if (this.failNext > 0) { this.failNext--; throw new Error("synthetic provider: simulated network timeout"); }
    if (this.failOn?.test(req.text)) throw new Error("synthetic provider: simulated failure for this text");
    fs.mkdirSync(req.workDir, { recursive: true });
    const words: TTSWord[] = [];
    const chunks: Buffer[] = [];
    let ms = 60;
    chunks.push(Buffer.alloc(Math.round((60 / 1000) * SAMPLE_RATE) * 2));
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(req.text))) {
      const w = m[0];
      const dur = syntheticWordMs(w);
      const n = Math.round((dur / 1000) * SAMPLE_RATE);
      const buf = Buffer.alloc(n * 2);
      const freq = 180 + (w.length % 7) * 22;
      for (let i = 0; i < n; i++) {
        const env = Math.min(1, i / 480, (n - i) / 480);
        buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE) * 6000 * env), i * 2);
      }
      words.push({ text: w, startMs: ms, endMs: ms + dur, charStart: m.index, charEnd: m.index + w.length });
      chunks.push(buf);
      ms += dur;
      const gap = /[.!?]$/.test(w) ? 340 : /[,;:]$/.test(w) ? 160 : 60;
      chunks.push(Buffer.alloc(Math.round((gap / 1000) * SAMPLE_RATE) * 2));
      ms += gap;
    }
    const data = Buffer.concat(chunks);
    const audioPath = path.join(req.workDir, "speech.wav");
    fs.writeFileSync(audioPath, encodeWav(data));
    return { audioPath, words, durationMs: (data.length / 2 / SAMPLE_RATE) * 1000, timing: { source: "synthetic", granularity: "word" }, providerMetadata: { words: words.length } };
  }
}
