/**
 * eSpeak NG, the small open-source voice packaged by every Linux distribution (apt install espeak-ng) and included in
 * Brody's Docker image, so Linux and Docker can narrate with no key and nothing leaving the machine. Robotic next to
 * Piper or a cloud voice, and like Piper it reports no word timings: it runs in the explicit sentence-level mode
 * (synthesizeBySentence), never pretending to be word-accurate.
 */
import { explainerConfig } from "../config";
import { run } from "../media";
import { synthesizeBySentence } from "./piper";
import { TTSError, type TTSProvider, type TTSRequest, type TTSResult } from "./types";

let found: { at: number; bin: string | null } | undefined;
async function espeakBin(): Promise<string | null> {
  if (found && Date.now() - found.at < 60_000) return found.bin;
  const candidates = [explainerConfig().espeakBin, "espeak-ng", "espeak"].filter((x, i, a) => x && a.indexOf(x) === i);
  let bin: string | null = null;
  for (const c of candidates) {
    try { const r = await run(c, ["--version"], { timeoutMs: 10_000 }); if (r.code === 0) { bin = c; break; } } catch { /* not installed */ }
  }
  found = { at: Date.now(), bin };
  return bin;
}

export class EspeakProvider implements TTSProvider {
  readonly id = "espeak";
  readonly label = "eSpeak NG local voice (sentence-level timing)";
  readonly defaultVoice = "en-us";
  readonly usdPerMillionChars = 0;
  readonly capabilities = { supportsWordTimings: false, supportsSentenceTimings: true, supportsStreaming: false, supportsLocalInference: true, supportsVoiceClone: false, charLimit: 20_000 };

  async unavailableReason(): Promise<string | null> {
    return (await espeakBin()) ? null : "eSpeak NG is not installed (Debian/Ubuntu: sudo apt install espeak-ng; Fedora: sudo dnf install espeak-ng).";
  }

  async synthesize(req: TTSRequest): Promise<TTSResult> {
    const bin = await espeakBin();
    if (!bin) throw new TTSError("eSpeak NG is not installed.", "espeak");
    const cfg = explainerConfig();
    const voice = /^[\w+-]{1,40}$/.test(req.voice ?? "") ? req.voice! : this.defaultVoice;
    // The sentence goes in on stdin, so text starting with "-" can never be read as an option.
    return synthesizeBySentence(req, "espeak", async (sentence, raw) => {
      const r = await run(bin, ["-v", voice, "-s", "160", "-w", raw, "--stdin"], { input: Buffer.from(sentence), timeoutMs: cfg.ttsTimeoutMs, signal: req.signal });
      if (r.code !== 0) throw new TTSError(`eSpeak NG failed: ${r.stderr.trim().slice(-300)}`, "espeak", true);
    }, { voice });
  }
}
