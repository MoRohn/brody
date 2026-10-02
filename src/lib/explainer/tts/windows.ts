/**
 * The Windows speech engine (SAPI, System.Speech), driven through PowerShell: no key, no install, and narration never
 * leaves the machine. Word timing is MEASURED: the synthesizer writes to a WAV file and raises SpeakProgress for every
 * word with its AudioPosition in that output, the same principle as the macOS voice. Word ends are tightened with the
 * audio's own silences (wordsFromMarks).
 */
import fs from "node:fs";
import path from "node:path";
import { explainerConfig } from "../config";
import { readWavFile } from "../audio";
import { run, toPcmWav } from "../media";
import { wordsFromMarks } from "./macos";
import { TTSError, type TTSProvider, type TTSRequest, type TTSResult } from "./types";

/** Reads the text from a UTF-8 file (never the command line), writes WAV and prints the word marks as JSON. */
export const SAPI_SCRIPT = String.raw`
param([string]$In, [string]$Out, [string]$Voice = "", [switch]$ListVoices)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($ListVoices) {
  $s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { [pscustomobject]@{ id = $_.VoiceInfo.Name; culture = $_.VoiceInfo.Culture.Name } } | ConvertTo-Json -Compress
  exit 0
}
if ($Voice) { try { $s.SelectVoice($Voice) } catch { } }
$text = [System.IO.File]::ReadAllText($In, [System.Text.Encoding]::UTF8)
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile($Out, $fmt)
$script:marks = New-Object System.Collections.ArrayList
$s.add_SpeakProgress({ param($sender, $e) [void]$script:marks.Add(@{ ms = $e.AudioPosition.TotalMilliseconds; loc = $e.CharacterPosition; len = $e.CharacterCount }) })
$s.Speak($text)
$name = $s.Voice.Name
$s.SetOutputToNull()
$s.Dispose()
@{ voice = $name; marks = @($script:marks) } | ConvertTo-Json -Compress -Depth 4
`;

let checked: { at: number; reason: string | null } | undefined;

async function scriptPath(): Promise<string> {
  const p = path.join(explainerConfig().dir, "bin", "brody-sapi.ps1");
  if (!fs.existsSync(p) || fs.readFileSync(p, "utf8") !== SAPI_SCRIPT) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, SAPI_SCRIPT); }
  return p;
}
const ps = (script: string, args: string[], signal?: AbortSignal) => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args], { timeoutMs: explainerConfig().ttsTimeoutMs, signal });

export class WindowsSpeechProvider implements TTSProvider {
  readonly id = "windows";
  readonly label = "Windows speech voice";
  readonly defaultVoice = "";
  readonly usdPerMillionChars = 0;
  readonly capabilities = { supportsWordTimings: true, supportsSentenceTimings: true, supportsStreaming: false, supportsLocalInference: true, supportsVoiceClone: false, charLimit: 20_000 };

  async unavailableReason(): Promise<string | null> {
    if (process.platform !== "win32") return "The Windows speech voice is only available on Windows.";
    if (checked && Date.now() - checked.at < 5 * 60_000) return checked.reason;
    try {
      const r = await ps(await scriptPath(), ["-ListVoices"]);
      const voices = r.code === 0 ? (JSON.parse(r.stdout.toString() || "[]") as unknown) : null;
      checked = { at: Date.now(), reason: voices && (Array.isArray(voices) ? voices.length : 1) ? null : "No Windows speech voice is installed (Settings > Time & language > Speech > Add voices)." };
    } catch (e) { checked = { at: Date.now(), reason: `Windows speech could not start: ${(e as Error).message}` }; }
    return checked.reason;
  }

  async voices(): Promise<{ id: string; name: string }[]> {
    const r = await ps(await scriptPath(), ["-ListVoices"]);
    const list = JSON.parse(r.stdout.toString() || "[]") as { id: string; culture: string } | { id: string; culture: string }[];
    return (Array.isArray(list) ? list : [list]).map((v) => ({ id: v.id, name: `${v.id} (${v.culture})` }));
  }

  async synthesize(req: TTSRequest): Promise<TTSResult> {
    fs.mkdirSync(req.workDir, { recursive: true });
    const input = path.join(req.workDir, "speech.txt");
    const raw = path.join(req.workDir, "speech-sapi.wav");
    const wav = path.join(req.workDir, "speech.wav");
    fs.writeFileSync(input, req.text, "utf8");
    const voice = /^[\w .()-]{0,80}$/.test(req.voice ?? "") ? req.voice ?? "" : "";
    const r = await ps(await scriptPath(), ["-In", input, "-Out", raw, ...(voice ? ["-Voice", voice] : [])], req.signal);
    if (r.code !== 0) throw new TTSError(`Windows speech failed (exit ${r.code}): ${r.stderr.trim().slice(0, 300)}`, "windows", true);
    const meta = JSON.parse(r.stdout.toString().trim().split(/\r?\n/).pop() ?? "{}") as { voice?: string; marks?: { ms: number; loc: number; len: number }[] };
    await toPcmWav(raw, wav, { signal: req.signal });
    fs.rmSync(raw, { force: true });
    const pcm = readWavFile(wav);
    const durationMs = (pcm.data.length / 2 / pcm.sampleRate) * 1000;
    const words = wordsFromMarks(req.text, (meta.marks ?? []).map((m) => ({ startMs: m.ms, loc: m.loc, end: m.loc + m.len })), pcm, durationMs);
    if (!words.length) throw new TTSError("Windows speech reported no word positions.", "windows");
    return { audioPath: wav, words, durationMs, timing: { source: "provider", granularity: "word" }, providerMetadata: { voice: meta.voice ?? voice, marks: meta.marks?.length ?? 0 } };
  }
}
