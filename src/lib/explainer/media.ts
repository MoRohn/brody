/**
 * FFmpeg and ffprobe, run as plain subprocesses: no shell, a minimal environment (never the server's API keys), a hard
 * timeout and cancellation. Every helper returns facts measured from the files themselves.
 *
 * Two lessons from the explainer-video reference implementation (MIT, Paul Lemaistre) are built in:
 *  - frame extraction puts `-ss` AFTER `-i`, because seeking before the input lands on a keyframe and can return a frame
 *    that is missing objects the file really contains;
 *  - scenes are padded to their exact frame count before they are concatenated, so per-scene rounding cannot accumulate.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { explainerConfig } from "./config";

export class MediaError extends Error {
  constructor(message: string, readonly tool: string, readonly stderr = "") { super(message); this.name = "MediaError"; }
}

export interface RunOptions { timeoutMs?: number; signal?: AbortSignal; input?: Buffer; cwd?: string; env?: NodeJS.ProcessEnv }
export interface RunResult { code: number; stdout: Buffer; stderr: string; ms: number }

/** A minimal environment for media and renderer subprocesses: enough to find binaries and fonts, nothing secret. */
/** Variables a subprocess needs to find binaries, fonts, temp space, the user profile and a network proxy; never keys. */
const SAFE_ENV = [
  "PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "FONTCONFIG_PATH", "FONTCONFIG_FILE", "XDG_CACHE_HOME", "PKG_CONFIG_PATH", "DYLD_FALLBACK_LIBRARY_PATH", "LD_LIBRARY_PATH",
  // Windows: programs (Python included) fail or misbehave without these.
  "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "ProgramFiles", "ProgramFiles(x86)", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
  // Package installs behind a proxy.
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "PIP_INDEX_URL", "PIP_EXTRA_INDEX_URL", "UV_INDEX_URL", "UV_CACHE_DIR",
];

export function safeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const k of SAFE_ENV) if (process.env[k]) env[k] = process.env[k]!;
  env.LC_ALL ??= "C";
  return { ...env, ...extra } as unknown as NodeJS.ProcessEnv;
}

let encoderCheck: { at: number; bin: string; problem: string | null } | undefined;

/**
 * Why this FFmpeg cannot make explainer videos, or null when it can: it must run and have the H.264 (libx264) and AAC
 * encoders (Fedora's default ffmpeg-free has no libx264). Cached for five minutes.
 */
export async function ffmpegProblem(): Promise<string | null> {
  const bin = explainerConfig().ffmpeg;
  if (encoderCheck && encoderCheck.bin === bin && Date.now() - encoderCheck.at < 5 * 60_000) return encoderCheck.problem;
  let problem: string | null;
  try {
    const r = await run(bin, ["-hide_banner", "-encoders"], { timeoutMs: 15_000 });
    const list = r.stdout.toString();
    const lacking = [/\blibx264\b/.test(list) ? "" : "H.264 (libx264)", /\baac\b/.test(list) ? "" : "AAC"].filter(Boolean);
    problem = r.code !== 0 ? `ffmpeg did not run (exit ${r.code}).` : lacking.length ? `This FFmpeg has no ${lacking.join(" or ")} encoder; install a full build (npm run explainer:setup names the command for this system).` : null;
  } catch {
    problem = "FFmpeg is not installed (npm run explainer:setup names the install command for this system).";
  }
  encoderCheck = { at: Date.now(), bin, problem };
  return problem;
}

export function run(bin: string, args: string[], o: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let child: ChildProcess;
    try {
      child = spawn(bin, args, { cwd: o.cwd, env: o.env ?? safeEnv(), stdio: [o.input ? "pipe" : "ignore", "pipe", "pipe"], shell: false });
    } catch (e) {
      reject(new MediaError(`Could not start ${path.basename(bin)}: ${(e as Error).message}`, bin));
      return;
    }
    const out: Buffer[] = [];
    let err = "";
    child.stdout!.on("data", (d: Buffer) => out.push(d));
    child.stderr!.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-20_000); });
    const kill = (why: string) => { try { child.kill("SIGKILL"); } catch { /* gone */ } finishErr(why); };
    let settled = false;
    const finishErr = (why: string) => { if (settled) return; settled = true; clearTimeout(timer); reject(new MediaError(why, bin, err)); };
    const timer = setTimeout(() => kill(`${path.basename(bin)} took longer than ${Math.round((o.timeoutMs ?? 0) / 1000)} s and was stopped.`), o.timeoutMs ?? 10 * 60_000);
    o.signal?.addEventListener("abort", () => kill(`${path.basename(bin)} was cancelled.`), { once: true });
    child.on("error", (e) => finishErr(`Could not run ${path.basename(bin)}: ${e.message}`));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err, ms: Date.now() - t0 });
    });
    if (o.input) { child.stdin!.on("error", () => { /* closed early; the exit code reports it */ }); child.stdin!.end(o.input); }
  });
}

async function ok(bin: string, args: string[], o: RunOptions = {}): Promise<RunResult> {
  const r = await run(bin, args, o);
  if (r.code !== 0) throw new MediaError(`${path.basename(bin)} failed (exit ${r.code}): ${lastLines(r.stderr)}`, bin, r.stderr);
  return r;
}

export function lastLines(s: string, n = 4): string {
  return s.trim().split("\n").filter((l) => l.trim()).slice(-n).join(" | ").slice(0, 600);
}

// ---------------------------------------------------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------------------------------------------------
export interface ProbeInfo {
  durationMs: number;
  video?: { codec: string; width: number; height: number; fps: number; frames: number | null; durationMs: number | null; pixFmt: string };
  audio?: { codec: string; sampleRate: number; channels: number; durationMs: number | null };
  sizeBytes: number;
}

export async function probe(file: string, o: RunOptions = {}): Promise<ProbeInfo> {
  const r = await ok(explainerConfig().ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-count_packets", file], { timeoutMs: 60_000, ...o });
  const j = JSON.parse(r.stdout.toString()) as { format?: { duration?: string; size?: string }; streams?: Record<string, string | number>[] };
  const v = j.streams?.find((s) => s.codec_type === "video");
  const a = j.streams?.find((s) => s.codec_type === "audio");
  const rate = (s: string | number | undefined) => { const [n, d] = String(s ?? "0/1").split("/").map(Number); return d ? n / d : n; };
  const dur = (s: string | number | undefined) => (s === undefined || s === "N/A" ? null : Math.round(Number(s) * 1000));
  return {
    durationMs: Math.round(Number(j.format?.duration ?? 0) * 1000),
    sizeBytes: Number(j.format?.size ?? 0),
    video: v ? { codec: String(v.codec_name), width: Number(v.width), height: Number(v.height), fps: rate(v.avg_frame_rate ?? v.r_frame_rate), frames: v.nb_read_packets !== undefined ? Number(v.nb_read_packets) : v.nb_frames !== undefined ? Number(v.nb_frames) : null, durationMs: dur(v.duration), pixFmt: String(v.pix_fmt) } : undefined,
    audio: a ? { codec: String(a.codec_name), sampleRate: Number(a.sample_rate), channels: Number(a.channels), durationMs: dur(a.duration) } : undefined,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------------------------------------------------

/** Decode any audio (mp3, caf, aiff, wav at any rate) to 48 kHz mono 16-bit WAV. */
export async function toPcmWav(input: string, output: string, o: RunOptions = {}): Promise<void> {
  await ok(explainerConfig().ffmpeg, ["-v", "error", "-y", "-i", input, "-ac", "1", "-ar", "48000", "-sample_fmt", "s16", "-f", "wav", output], { timeoutMs: 120_000, ...o });
}

// ---------------------------------------------------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------------------------------------------------
const X264 = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", "-preset", "veryfast", "-crf", "20", "-g", "60", "-bf", "0"];

/**
 * Encode a stream of raw RGBA frames to H.264. `frames` yields exactly `count` frames; writing respects back-pressure, so
 * memory stays flat however long the scene is.
 */
export async function encodeRgbaFrames(output: string, size: { width: number; height: number }, fps: number, count: number, frame: (i: number) => Buffer | Promise<Buffer>, o: RunOptions = {}): Promise<RunResult> {
  const args = ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${size.width}x${size.height}`, "-r", String(fps), "-i", "-", ...X264, "-r", String(fps), "-frames:v", String(count), "-an", output];
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn(explainerConfig().ffmpeg, args, { env: safeEnv(), stdio: ["pipe", "ignore", "pipe"], shell: false });
    let err = "";
    let failed = false;
    child.stderr.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-20_000); });
    const timer = setTimeout(() => { failed = true; child.kill("SIGKILL"); reject(new MediaError("Encoding took too long and was stopped.", "ffmpeg", err)); }, o.timeoutMs ?? 20 * 60_000);
    o.signal?.addEventListener("abort", () => { failed = true; child.kill("SIGKILL"); reject(new MediaError("Encoding was cancelled.", "ffmpeg", err)); }, { once: true });
    child.on("error", (e) => { failed = true; clearTimeout(timer); reject(new MediaError(`Could not run ffmpeg: ${e.message}`, "ffmpeg")); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failed) return;
      if (code !== 0) reject(new MediaError(`ffmpeg could not encode frames (exit ${code}): ${lastLines(err)}`, "ffmpeg", err));
      else resolve({ code: 0, stdout: Buffer.alloc(0), stderr: err, ms: Date.now() - t0 });
    });
    child.stdin.on("error", () => { /* reported by close */ });
    (async () => {
      for (let i = 0; i < count && !failed; i++) {
        const buf = await frame(i);
        if (!child.stdin.write(buf)) await new Promise<void>((r) => child.stdin.once("drain", () => r()));
      }
      child.stdin.end();
    })().catch((e) => { failed = true; child.kill("SIGKILL"); clearTimeout(timer); reject(e); });
  });
}

/**
 * Re-encode a rendered scene to the shared format and EXACTLY `frames` frames: shorter input is padded by cloning its
 * last frame, longer input is cut. Every scene then has the same codec parameters and can be concatenated without
 * re-encoding, and each starts on its planned frame.
 */
export async function conformScene(input: string, output: string, frames: number, fps: number, size: { width: number; height: number }, o: RunOptions = {}): Promise<void> {
  const vf = `scale=${size.width}:${size.height}:flags=lanczos,fps=${fps},tpad=stop_mode=clone:stop_duration=${Math.ceil(frames / fps) + 2}`;
  await ok(explainerConfig().ffmpeg, ["-v", "error", "-y", "-i", input, "-vf", vf, ...X264, "-frames:v", String(frames), "-an", output], { timeoutMs: 10 * 60_000, ...o });
}

/** Join conformed scenes without re-encoding. */
export async function concatScenes(inputs: string[], output: string, o: RunOptions = {}): Promise<void> {
  const list = `${output}.txt`;
  fs.writeFileSync(list, inputs.map((f) => `file '${path.resolve(f).replace(/'/g, "'\\''")}'`).join("\n") + "\n");
  try {
    await ok(explainerConfig().ffmpeg, ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", output], { timeoutMs: 10 * 60_000, ...o });
  } finally {
    fs.rmSync(list, { force: true });
  }
}

/** Join section WAVs (already 48 kHz mono, frame-slotted) into one narration track. */
export function concatWavs(inputs: string[], output: string): number {
  const parts = inputs.map((f) => {
    const buf = fs.readFileSync(f);
    // Section files are written by Brody with a plain 44-byte header.
    return buf.subarray(44);
  });
  const data = Buffer.concat(parts);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8, "ascii"); header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(48_000, 24); header.writeUInt32LE(96_000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii"); header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(output, Buffer.concat([header, data]));
  return (data.length / 2 / 48_000) * 1000;
}

/** Put the narration under the picture. The video stream is copied; audio is AAC. */
export async function mux(video: string, audio: string, output: string, o: RunOptions = {}): Promise<void> {
  await ok(explainerConfig().ffmpeg, ["-v", "error", "-y", "-i", video, "-i", audio, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-movflags", "+faststart", output], { timeoutMs: 10 * 60_000, ...o });
}

/** One exact frame as PNG, optionally scaled to `width`. Seeks after -i so the frame is exact. */
export async function extractFrame(video: string, ms: number, output: string, width?: number, o: RunOptions = {}): Promise<void> {
  const args = ["-v", "error", "-y", "-i", video, "-ss", (ms / 1000).toFixed(3), "-frames:v", "1"];
  if (width) args.push("-vf", `scale=${width}:-2:flags=lanczos`);
  await ok(explainerConfig().ffmpeg, [...args, output], { timeoutMs: 120_000, ...o });
}

/** Fully decode the file. Any decoder error fails, so a file that probes fine but is corrupt mid-stream is caught. */
export async function decodeCheck(file: string, o: RunOptions = {}): Promise<{ ok: boolean; errors: string }> {
  const r = await run(explainerConfig().ffmpeg, ["-v", "error", "-xerror", "-i", file, "-f", "null", "-"], { timeoutMs: 10 * 60_000, ...o });
  return { ok: r.code === 0 && !r.stderr.trim(), errors: lastLines(r.stderr) };
}

/** Grey-level statistics of single frames, for the empty-frame check. Returns the standard deviation (0..255) per sample. */
export async function frameSpread(video: string, times: number[], o: RunOptions = {}): Promise<number[]> {
  const out: number[] = [];
  for (const ms of times) {
    const r = await run(explainerConfig().ffmpeg, ["-v", "error", "-i", video, "-ss", (ms / 1000).toFixed(3), "-frames:v", "1", "-vf", "scale=160:90,format=gray", "-f", "rawvideo", "-"], { timeoutMs: 60_000, ...o });
    const px = r.stdout;
    if (r.code !== 0 || px.length === 0) { out.push(-1); continue; }
    let sum = 0, sq = 0;
    for (const v of px) { sum += v; sq += v * v; }
    const mean = sum / px.length;
    out.push(Math.sqrt(Math.max(0, sq / px.length - mean * mean)));
  }
  return out;
}
