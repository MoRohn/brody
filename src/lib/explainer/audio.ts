/**
 * PCM WAV handling for narration.
 *
 * Durations always come from the LENGTH OF THE AUDIO BYTES, never from the header: streaming TTS endpoints send a data
 * size of 0xFFFFFFFF, which makes a header-derived duration about 12 hours long (a trap documented by the
 * explainer-video reference implementation, MIT, Paul Lemaistre). Every section is normalised to one format
 * (48 kHz, 16-bit, mono) so sections can be joined, re-synthesised one at a time and swapped without resampling the rest.
 */
import fs from "node:fs";

export const SAMPLE_RATE = 48_000;
export const BYTES_PER_SAMPLE = 2;

export interface Pcm { sampleRate: number; channels: number; bitsPerSample: number; data: Buffer }

/** Parse a RIFF/WAVE buffer. Walks the chunks (so LIST/fact chunks are skipped) and trusts the file length over the declared data size. */
export function parseWav(buf: Buffer): Pcm {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("Not a RIFF/WAVE file.");
  let off = 12;
  let fmt: { channels: number; sampleRate: number; bitsPerSample: number; format: number } | undefined;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bitsPerSample: buf.readUInt16LE(body + 14) };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV data chunk before its format chunk.");
      if (fmt.format !== 1 && fmt.format !== 0xfffe) throw new Error(`Unsupported WAV encoding ${fmt.format}; expected PCM.`);
      // A streaming header declares 0xFFFFFFFF (or 0): the real end is the end of the buffer.
      const end = size === 0xffffffff || size === 0 || body + size > buf.length ? buf.length : body + size;
      const frame = (fmt.bitsPerSample / 8) * fmt.channels;
      const usable = end - body - ((end - body) % frame);
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bitsPerSample, data: buf.subarray(body, body + usable) };
    }
    off = body + size + (size % 2);
  }
  throw new Error("WAV file has no data chunk.");
}

export function pcmDurationMs(p: Pcm): number {
  return (p.data.length / ((p.bitsPerSample / 8) * p.channels) / p.sampleRate) * 1000;
}

export function wavHeader(dataBytes: number, sampleRate = SAMPLE_RATE, channels = 1, bits = 16): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * (bits / 8), 28);
  h.writeUInt16LE(channels * (bits / 8), 32);
  h.writeUInt16LE(bits, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

export function encodeWav(data: Buffer, sampleRate = SAMPLE_RATE): Buffer {
  return Buffer.concat([wavHeader(data.length, sampleRate), data]);
}

export function readWavFile(p: string): Pcm {
  return parseWav(fs.readFileSync(p));
}

/** Samples (48 kHz mono) in a whole number of video frames: 1600 per frame at 30 fps. */
export function samplesPerFrame(fps: number): number {
  return SAMPLE_RATE / fps;
}

/**
 * Pad 48 kHz mono speech with trailing silence so it fills `pauseMs` more and then the next whole video frame. Section
 * boundaries therefore fall exactly on frame boundaries, and a section re-synthesised later cannot shift the frame grid
 * of the sections after it.
 */
export function padToFrameSlot(p: Pcm, pauseMs: number, fps: number): { data: Buffer; frames: number; slotMs: number; speechMs: number } {
  if (p.sampleRate !== SAMPLE_RATE || p.channels !== 1 || p.bitsPerSample !== 16) throw new Error("Section audio must be 48 kHz mono 16-bit before slotting.");
  const speechSamples = p.data.length / BYTES_PER_SAMPLE;
  const spf = samplesPerFrame(fps);
  const want = speechSamples + Math.round((pauseMs / 1000) * SAMPLE_RATE);
  const frames = Math.max(1, Math.ceil(want / spf));
  const total = frames * spf;
  const data = Buffer.alloc(total * BYTES_PER_SAMPLE);
  p.data.copy(data, 0, 0, Math.min(p.data.length, data.length));
  return { data, frames, slotMs: (frames * 1000) / fps, speechMs: (speechSamples / SAMPLE_RATE) * 1000 };
}

/** Peak and RMS of 16-bit mono audio, for the "audio is not silent" validation. */
export function levels(p: Pcm): { peak: number; rms: number } {
  let peak = 0;
  let sum = 0;
  const n = Math.floor(p.data.length / 2);
  for (let i = 0; i < n; i++) {
    const v = Math.abs(p.data.readInt16LE(i * 2)) / 32768;
    if (v > peak) peak = v;
    sum += v * v;
  }
  return { peak, rms: n ? Math.sqrt(sum / n) : 0 };
}

/** Silent intervals (ms) of at least `minMs`, below `threshold` amplitude. Used to tighten word end times. */
export function silences(p: Pcm, minMs = 90, threshold = 0.01): { startMs: number; endMs: number }[] {
  const n = Math.floor(p.data.length / 2);
  const win = Math.max(1, Math.round(p.sampleRate * 0.01));
  const out: { startMs: number; endMs: number }[] = [];
  let runStart = -1;
  for (let w = 0; w * win < n; w++) {
    let peak = 0;
    for (let i = w * win; i < Math.min(n, (w + 1) * win); i++) peak = Math.max(peak, Math.abs(p.data.readInt16LE(i * 2)) / 32768);
    const quiet = peak < threshold;
    if (quiet && runStart < 0) runStart = w;
    if ((!quiet || (w + 1) * win >= n) && runStart >= 0) {
      const endW = quiet ? w + 1 : w;
      const startMs = ((runStart * win) / p.sampleRate) * 1000;
      const endMs = ((endW * win) / p.sampleRate) * 1000;
      if (endMs - startMs >= minMs) out.push({ startMs, endMs });
      runStart = -1;
    }
  }
  return out;
}
