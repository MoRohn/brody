/**
 * On-device speech on macOS through AVSpeechSynthesizer: no key, no network, and the narration never leaves the machine.
 *
 * Word timing is MEASURED, not estimated: the synthesizer is asked to write its audio to buffers instead of the speakers,
 * and its "will speak range" callback fires between those buffers. The number of samples written before a word's callback
 * is the word's start in the audio. Word ends are tightened with the silences in the audio itself. (Verified against
 * silence detection on the rendered audio: starts land within about 20 ms of the audible onset.)
 *
 * The helper is a small Swift program compiled once into the explainer directory.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { explainerConfig } from "../config";
import { readWavFile, silences, type Pcm } from "../audio";
import { MediaError, run, safeEnv, toPcmWav } from "../media";
import { sha256 } from "../../util/ids";
import { TTSError, type TTSProvider, type TTSRequest, type TTSResult, type TTSWord } from "./types";


const SWIFT = String.raw`
import AVFoundation
import Foundation

struct Req: Decodable { let text: String; let voice: String?; let out: String; let rate: Float? }
final class Marks: NSObject, AVSpeechSynthesizerDelegate {
  var samples: Int64 = 0
  var marks: [[String: Int64]] = []
  func speechSynthesizer(_ s: AVSpeechSynthesizer, willSpeakRangeOfSpeechString r: NSRange, utterance: AVSpeechUtterance) {
    marks.append(["offset": samples, "loc": Int64(r.location), "len": Int64(r.length)])
  }
}
func emit(_ o: Any) { let d = try! JSONSerialization.data(withJSONObject: o); FileHandle.standardOutput.write(d); FileHandle.standardOutput.write("\n".data(using: .utf8)!) }

let args = CommandLine.arguments
if args.count > 1 && args[1] == "--voices" {
  emit(AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("en") }.map { ["id": $0.identifier, "name": $0.name, "language": $0.language, "quality": $0.quality.rawValue] })
  exit(0)
}
let input = FileHandle.standardInput.readDataToEndOfFile()
guard let req = try? JSONDecoder().decode(Req.self, from: input) else { FileHandle.standardError.write("bad request\n".data(using: .utf8)!); exit(2) }
let synth = AVSpeechSynthesizer()
let marks = Marks()
synth.delegate = marks
let utt = AVSpeechUtterance(string: req.text)
var voice: AVSpeechSynthesisVoice? = nil
if let v = req.voice, !v.isEmpty { voice = AVSpeechSynthesisVoice(identifier: v) ?? AVSpeechSynthesisVoice.speechVoices().first { $0.name == v } }
if voice == nil { voice = AVSpeechSynthesisVoice(identifier: "com.apple.voice.compact.en-US.Samantha") ?? AVSpeechSynthesisVoice(language: "en-US") }
utt.voice = voice
if let r = req.rate { utt.rate = r }
var file: AVAudioFile? = nil
var rate: Double = 0
var finished = false
var failure: String? = nil
synth.write(utt) { buf in
  guard let pcm = buf as? AVAudioPCMBuffer else { return }
  if pcm.frameLength == 0 { finished = true; return }
  do {
    if file == nil {
      rate = pcm.format.sampleRate
      file = try AVAudioFile(forWriting: URL(fileURLWithPath: req.out), settings: pcm.format.settings, commonFormat: pcm.format.commonFormat, interleaved: pcm.format.isInterleaved)
    }
    try file!.write(from: pcm)
    marks.samples += Int64(pcm.frameLength)
  } catch { failure = "\(error)"; finished = true }
}
let start = Date()
while !finished && Date().timeIntervalSince(start) < 300 { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
if let f = failure { FileHandle.standardError.write(f.data(using: .utf8)!); exit(3) }
if !finished || file == nil { FileHandle.standardError.write("synthesis produced no audio\n".data(using: .utf8)!); exit(4) }
emit(["sampleRate": rate, "samples": marks.samples, "marks": marks.marks, "voice": voice?.identifier ?? ""])
`;

let compiled: Promise<string> | undefined;

async function helper(): Promise<string> {
  const cfg = explainerConfig();
  const bin = path.join(cfg.dir, "bin", `brody-speech-${sha256(SWIFT).slice(0, 12)}`);
  if (fs.existsSync(bin)) return bin;
  compiled ??= (async () => {
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    const src = `${bin}.swift`;
    fs.writeFileSync(src, SWIFT);
    const r = await run(cfg.swiftc, ["-O", src, "-o", `${bin}.tmp`], { timeoutMs: 180_000 });
    if (r.code !== 0) throw new TTSError(`The macOS speech helper could not be compiled: ${r.stderr.trim().split("\n").slice(-3).join(" ")}`, "macos");
    fs.renameSync(`${bin}.tmp`, bin);
    return bin;
  })().finally(() => { compiled = undefined; });
  return compiled;
}

function runHelper(bin: string, input: string | null, args: string[], signal?: AbortSignal, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: safeEnv(), stdio: ["pipe", "pipe", "pipe"], shell: false });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new TTSError("On-device speech took too long.", "macos", true)); }, timeoutMs);
    signal?.addEventListener("abort", () => { child.kill("SIGKILL"); reject(new TTSError("Speech was cancelled.", "macos")); }, { once: true });
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(new TTSError(`Could not start the macOS speech helper: ${e.message}`, "macos")); });
    child.on("close", (code) => { clearTimeout(timer); if (code === 0) resolve(out); else reject(new TTSError(`On-device speech failed (exit ${code}): ${err.trim().slice(0, 300)}`, "macos", true)); });
    child.stdin.end(input ?? "");
  });
}

/**
 * Words from a speech engine's word marks (audio position plus character range in the spoken text). A voice may split
 * one word into several ranges ("G", "P", "Us"): ranges touching inside one whitespace-delimited word are merged. Each
 * word ends at the next word's start, or earlier at the first silence inside its slot. Shared by macOS and Windows.
 */
export function wordsFromMarks(text: string, marks: { startMs: number; loc: number; end: number }[], pcm: Pcm, durationMs: number): TTSWord[] {
  const quiet = silences(pcm, 70, 0.012);
  const merged: { startMs: number; loc: number; end: number }[] = [];
  for (const m of [...marks].sort((a, b) => a.startMs - b.startMs || a.loc - b.loc)) {
    const prev = merged[merged.length - 1];
    if (prev && m.loc <= prev.end && !/\s/.test(text.slice(prev.end, m.loc + 1))) { prev.end = Math.max(prev.end, m.end); continue; }
    if (prev && m.loc === prev.end && !/\s/.test(text[m.loc - 1] ?? " ")) { prev.end = m.end; continue; }
    merged.push({ ...m });
  }
  return merged.map((m, i) => {
    const nextStart = i + 1 < merged.length ? merged[i + 1].startMs : durationMs;
    // End at the first silence that begins inside the word's slot, if any.
    const gap = quiet.find((s) => s.startMs > m.startMs + 40 && s.startMs < nextStart);
    return { text: text.slice(m.loc, m.end), startMs: m.startMs, endMs: Math.max(m.startMs + 20, gap ? gap.startMs : nextStart), charStart: m.loc, charEnd: m.end };
  });
}

export class MacSpeechProvider implements TTSProvider {
  readonly id = "macos";
  readonly label = "macOS on-device voice";
  readonly defaultVoice = "com.apple.voice.compact.en-US.Samantha";
  readonly usdPerMillionChars = 0;
  readonly capabilities = { supportsWordTimings: true, supportsSentenceTimings: true, supportsStreaming: false, supportsLocalInference: true, supportsVoiceClone: false, charLimit: 20_000 };

  async unavailableReason(): Promise<string | null> {
    if (process.platform !== "darwin") return "On-device macOS speech is only available on macOS.";
    try { await helper(); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
  }

  async voices(): Promise<{ id: string; name: string }[]> {
    const out = await runHelper(await helper(), null, ["--voices"]);
    return (JSON.parse(out) as { id: string; name: string; language: string }[]).map((v) => ({ id: v.id, name: `${v.name} (${v.language})` }));
  }

  async synthesize(req: TTSRequest): Promise<TTSResult> {
    const bin = await helper();
    fs.mkdirSync(req.workDir, { recursive: true });
    const caf = path.join(req.workDir, "speech.caf");
    const wav = path.join(req.workDir, "speech.wav");
    const raw = await runHelper(bin, JSON.stringify({ text: req.text, voice: req.voice || this.defaultVoice, out: caf }), [], req.signal, explainerConfig().ttsTimeoutMs);
    const meta = JSON.parse(raw.trim().split("\n").pop()!) as { sampleRate: number; samples: number; marks: { offset: number; loc: number; len: number }[]; voice: string };
    try { await toPcmWav(caf, wav, { signal: req.signal }); } catch (e) { throw new TTSError(e instanceof MediaError ? e.message : String(e), "macos"); }
    fs.rmSync(caf, { force: true });
    const pcm = readWavFile(wav);
    const durationMs = (pcm.data.length / 2 / pcm.sampleRate) * 1000;
    const words = wordsFromMarks(req.text, meta.marks.map((m) => ({ startMs: (m.offset / meta.sampleRate) * 1000, loc: m.loc, end: m.loc + m.len })), pcm, durationMs);
    return { audioPath: wav, words, durationMs, timing: { source: "provider", granularity: "word" }, providerMetadata: { voice: meta.voice, engineSampleRate: meta.sampleRate, marks: meta.marks.length } };
  }
}
