/**
 * Narration text for listening.
 *
 * A narration sentence has two forms: the DISPLAY form (what the transcript and the captions show: `nvidia.com/gpu`,
 * `requestCancel()`, `12%`) and the SPOKEN form sent to the voice (`nvidia dot com slash G P U`, `request cancel`,
 * `12 percent`). Each display token keeps the spoken words it became, so measured word timings can be mapped back onto
 * exactly the text a viewer reads.
 *
 * Also here: sentence splitting that survives decimals, versions, domains and abbreviations, and a controlled
 * technical English linter inspired by ASD-STE100 (short sentences, active verbs, one idea per sentence, approved words),
 * applied as guidance, not as a hard rule set. Browser-safe.
 */

export interface SpeechToken {
  /** Index of the token in its section. */
  index: number;
  display: string;
  spoken: string[];
  sentence: number;
}

const ABBREVIATIONS = new Map<string, string>([
  ["e.g.", "for example"], ["i.e.", "that is"], ["vs.", "versus"], ["vs", "versus"], ["etc.", "and so on"], ["approx.", "about"], ["~", "about"], ["≈", "about"],
  ["→", "to"], ["->", "to"], ["&", "and"], ["w/", "with"], ["w/o", "without"], ["%", "percent"], ["×", "times"],
]);

/** Pronunciations for terms voices commonly get wrong. Keys are lowercase. */
export const LEXICON = new Map<string, string>([
  ["k8s", "Kubernetes"], ["kube", "kube"], ["kubectl", "kube control"], ["dgx", "D G X"], ["vgpu", "v G P U"], ["mig", "mig"], ["cuda", "cuda"],
  ["gpu", "G P U"], ["gpus", "G P Us"], ["cpu", "C P U"], ["cpus", "C P Us"], ["vram", "V RAM"], ["hbm", "H B M"], ["nvlink", "N V link"], ["nccl", "nickel"],
  ["src", "source"], ["lib", "lib"], ["ts", "T S"], ["tsx", "T S X"], ["js", "J S"], ["py", "pie"], ["yaml", "yaml"], ["yml", "yaml"], ["json", "jason"],
  ["sqlite", "S Q lite"], ["sql", "S Q L"], ["api", "A P I"], ["apis", "A P Is"], ["url", "U R L"], ["http", "H T T P"], ["https", "H T T P S"], ["ui", "U I"],
  ["llm", "L L M"], ["llms", "L L Ms"], ["vllm", "v L L M"], ["tts", "T T S"], ["sse", "S S E"], ["ffmpeg", "F F mpeg"], ["mp4", "M P 4"], ["oom", "out of memory"],
  ["ms", "milliseconds"], ["gb", "gigabytes"], ["gib", "gibibytes"], ["mb", "megabytes"], ["tb", "terabytes"], ["gbps", "gigabits per second"],
  ["a100", "A 100"], ["h100", "H 100"], ["h200", "H 200"], ["b200", "B 200"], ["ai", "A I"], ["ml", "M L"], ["io", "I O"], ["ci", "C I"], ["os", "O S"],
]);

const UNIT_SUFFIX: [RegExp, string][] = [[/^(\d+(?:\.\d+)?)(gb|gib|mb|tb|ms|gbps)$/i, "$1 UNIT"], [/^(\d+(?:\.\d+)?)x$/i, "$1 times"]];
const OPERATORS = new Map<string, string>([["=", "equals"], ["==", "equals"], ["+", "plus"], ["*", "times"], ["/", "divided by"], ["−", "minus"], ["<", "is less than"], [">", "is greater than"], ["≤", "is at most"], ["<=", "is at most"], ["≥", "is at least"], [">=", "is at least"], ["≠", "is not"], ["!=", "is not"]]);

const TRAILING = /[.,;:!?)\]"'»”’]+$/;
const LEADING = /^[("'\[«“‘]+/;

function splitIdentifier(s: string): string[] {
  return s
    .replace(/\(\)$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_]+/)
    .filter(Boolean);
}

function speakWord(w: string): string[] {
  const lower = w.toLowerCase();
  const lex = LEXICON.get(lower);
  if (lex) return lex.split(" ");
  for (const [re, out] of UNIT_SUFFIX) {
    const m = w.match(re);
    if (m) return out.replace("$1", m[1]).replace("UNIT", LEXICON.get((m[2] ?? "").toLowerCase()) ?? m[2] ?? "").split(" ").filter(Boolean);
  }
  if (/^\d+%$/.test(w)) return [w.slice(0, -1), "percent"];
  return [w];
}

/** Spoken words for one display token (without its surrounding punctuation). */
export function toSpoken(core: string): string[] {
  if (!core) return [];
  const abbr = ABBREVIATIONS.get(core.toLowerCase());
  if (abbr) return abbr.split(" ");
  const op = OPERATORS.get(core);
  if (op) return op.split(" ");
  // URL: speak the host and path, never the scheme.
  const url = core.match(/^https?:\/\/(.+)$/i);
  if (url) return toSpoken(url[1].replace(/\/$/, ""));
  // Anything with separators: domains, paths, resource names (nvidia.com/gpu), versions (v1.2.3) and dotted identifiers.
  if (/^v?\d+(\.\d+){2,}$/.test(core)) { const [first, ...rest] = core.replace(/^v/i, "").split("."); return [...(/^v/i.test(core) ? ["version"] : []), first, ...rest.flatMap((p) => ["point", p])]; }
  if (/^\d+(\.\d+)?$/.test(core)) return [core];
  if (/[A-Za-z0-9][./:\\][A-Za-z0-9]/.test(core) || /^[./]/.test(core)) {
    const out: string[] = [];
    for (const part of core.split(/([./:\\])/)) {
      if (!part) continue;
      if (part === ".") out.push("dot");
      else if (part === "/" || part === "\\") out.push("slash");
      else if (part === ":") continue;
      else out.push(...splitIdentifier(part).flatMap(speakWord));
    }
    return out;
  }
  if (/[a-z][A-Z]|_|\(\)$/.test(core) && /^[A-Za-z_][\w]*(\(\))?$/.test(core)) return splitIdentifier(core).flatMap(speakWord);
  if (/^[A-Za-z0-9]+-[A-Za-z0-9-]+$/.test(core)) return core.split("-").flatMap(speakWord);
  return speakWord(core);
}

/**
 * Split narration into sentences. A full stop ends a sentence only when followed by whitespace and an uppercase letter,
 * a digit or the end, and the word before it is not a known abbreviation; so 1.5, nvidia.com and e.g. stay intact.
 */
export function splitSentences(text: string): string[] {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return [];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c !== "." && c !== "!" && c !== "?") continue;
    const next = t[i + 1];
    if (next !== undefined && next !== " ") continue;
    const after = t.slice(i + 2, i + 3);
    if (next === " " && after && !/[A-Z0-9"“(]/.test(after)) continue;
    const word = t.slice(t.lastIndexOf(" ", i - 1) + 1, i + 1).toLowerCase();
    if (ABBREVIATIONS.has(word) || /^(mr|mrs|dr|no|fig|approx)\.$/.test(word)) continue;
    out.push(t.slice(start, i + 1).trim());
    start = i + 2;
  }
  if (start < t.length) out.push(t.slice(start).trim());
  return out.filter(Boolean);
}

/** Tokens of a section's narration, sentence by sentence. */
export function tokenize(text: string): SpeechToken[] {
  const tokens: SpeechToken[] = [];
  splitSentences(text).forEach((sentence, si) => {
    for (const display of sentence.split(" ").filter(Boolean)) {
      const lead = display.match(LEADING)?.[0] ?? "";
      const trail = display.match(TRAILING)?.[0] ?? "";
      let core = display.slice(lead.length, display.length - trail.length);
      // A trailing "()" belongs to the identifier, not to punctuation.
      if (trail.startsWith(")") && core.endsWith("(")) core = core.slice(0, -1);
      const spoken = core ? toSpoken(core) : [];
      // Keep sentence punctuation on the last spoken word: voices use it for prosody.
      const punct = trail.replace(/[)\]"'»”’]/g, "");
      if (spoken.length && punct) spoken[spoken.length - 1] += punct;
      tokens.push({ index: tokens.length, display, spoken, sentence: si });
    }
  });
  return tokens;
}

export function spokenText(tokens: SpeechToken[]): string {
  return tokens.flatMap((t) => t.spoken).join(" ");
}

/** Normalised comparison form of a word: lowercase letters and digits only. */
export const normWord = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}

// ---------------------------------------------------------------------------------------------------------------------
// Controlled technical English
// ---------------------------------------------------------------------------------------------------------------------

/** Words with a plainer approved alternative (ASD-STE100 style). */
export const SIMPLER = new Map<string, string>([
  ["utilize", "use"], ["utilizes", "uses"], ["utilized", "used"], ["utilizing", "using"], ["leverage", "use"], ["leverages", "uses"], ["leveraging", "using"],
  ["facilitate", "help"], ["facilitates", "helps"], ["commence", "start"], ["commences", "starts"], ["terminate", "stop"], ["terminates", "stops"],
  ["approximately", "about"], ["subsequently", "then"], ["additionally", "also"], ["furthermore", "also"], ["numerous", "many"], ["sufficient", "enough"],
  ["in order to", "to"], ["prior to", "before"], ["due to the fact that", "because"], ["is able to", "can"], ["are able to", "can"], ["a number of", "some"],
]);
const FILLER = ["basically", "essentially", "actually", "really", "very", "simply", "just", "delve", "seamless", "seamlessly", "robust", "cutting-edge", "game-changer", "in today's world", "it's worth noting that", "it is important to note that", "let's dive in", "let's dive into"];
const SPOKEN_HEADING = /^(section|chapter|part|step)\s+\d+\s*[:.-]|^in this (section|video|chapter)\b|^(introduction|conclusion|summary)\s*[:.-]/i;

export interface StyleIssue { sentence: number; kind: "long" | "parenthetical" | "passive" | "filler" | "complex-word" | "heading" | "semicolon"; detail: string }

export function lintNarration(text: string, opts: { maxWords?: number } = {}): { issues: StyleIssue[]; score: number; sentences: number; avgWords: number } {
  const maxWords = opts.maxWords ?? 22;
  const sentences = splitSentences(text);
  const issues: StyleIssue[] = [];
  sentences.forEach((s, i) => {
    const n = wordCount(s);
    if (n > maxWords) issues.push({ sentence: i, kind: "long", detail: `${n} words (aim for ${maxWords} or fewer)` });
    if (/\([^)]{12,}\)/.test(s)) issues.push({ sentence: i, kind: "parenthetical", detail: "a long parenthetical is hard to hear" });
    if (/;/.test(s)) issues.push({ sentence: i, kind: "semicolon", detail: "split at the semicolon" });
    if (/\b(is|are|was|were|be|been|being)\s+(\w+ed|built|made|done|given|taken|shown|known|sent|held|kept)\b(?!\s+(to|on|in|at)\b)/i.test(s) && !/\b(is|are)\s+(used|based|called|named|allowed|limited)\b/i.test(s)) issues.push({ sentence: i, kind: "passive", detail: "prefer an active verb: the subject does the thing" });
    const lower = s.toLowerCase();
    for (const f of FILLER) if (new RegExp(`\\b${f.replace(/[-']/g, "\\$&")}\\b`).test(lower)) issues.push({ sentence: i, kind: "filler", detail: `remove "${f}"` });
    for (const [w, alt] of SIMPLER) if (new RegExp(`\\b${w}\\b`).test(lower)) issues.push({ sentence: i, kind: "complex-word", detail: `"${w}" → "${alt}"` });
    if (SPOKEN_HEADING.test(s)) issues.push({ sentence: i, kind: "heading", detail: "do not speak headings aloud" });
  });
  const words = sentences.reduce((a, s) => a + wordCount(s), 0);
  const penalty = issues.reduce((a, x) => a + (x.kind === "long" || x.kind === "heading" ? 2 : 1), 0);
  return { issues, score: sentences.length ? Math.max(0, 1 - penalty / (sentences.length * 2)) : 1, sentences: sentences.length, avgWords: sentences.length ? words / sentences.length : 0 };
}

/** Apply the mechanical parts of the style guide: approved words, no fillers, no spoken headings, long sentences split. */
export function controlNarration(text: string, opts: { maxWords?: number } = {}): string {
  const maxWords = opts.maxWords ?? 22;
  let t = ` ${text.replace(/\s+/g, " ").trim()} `;
  for (const [w, alt] of [...SIMPLER].sort((a, b) => b[0].length - a[0].length)) {
    t = t.replace(new RegExp(`\\b${w}\\b`, "gi"), (m) => (m[0] === m[0].toUpperCase() ? alt[0].toUpperCase() + alt.slice(1) : alt));
  }
  for (const f of FILLER) t = t.replace(new RegExp(`\\s${f.replace(/[-']/g, "\\$&")},?(?=\\s)`, "gi"), "");
  const out: string[] = [];
  for (let s of splitSentences(t.trim())) {
    s = s.replace(SPOKEN_HEADING, "").trim();
    if (!s) continue;
    s = s[0].toUpperCase() + s.slice(1);
    // Semicolons become full stops.
    const parts = s.split(/;\s+/).map((p, i, arr) => (i < arr.length - 1 ? `${p.replace(/[,.]$/, "")}.` : p));
    for (const p of parts) out.push(...splitLong(p, maxWords));
  }
  return out.map((s) => s[0].toUpperCase() + s.slice(1)).join(" ");
}

function splitLong(s: string, maxWords: number): string[] {
  if (wordCount(s) <= maxWords) return [s];
  // Split at ", and " / ", but " / ", so " nearest the middle, keeping both halves at least four words long.
  const words = s.split(" ");
  const mid = words.length / 2;
  let best = -1;
  for (let i = 4; i < words.length - 4; i++) {
    if (!/,$/.test(words[i - 1]) || !/^(and|but|so|which|because|while|then)$/i.test(words[i])) continue;
    if (best < 0 || Math.abs(i - mid) < Math.abs(best - mid)) best = i;
  }
  if (best < 0) return [s];
  const first = `${words.slice(0, best).join(" ").replace(/,$/, "")}.`;
  let restWords = words.slice(best);
  if (/^(and|so|then)$/i.test(restWords[0])) restWords = restWords.slice(1);
  if (/^which$/i.test(restWords[0])) restWords = ["This", ...restWords.slice(1)];
  const rest = restWords.join(" ");
  return [...splitLong(first, maxWords), ...splitLong(rest[0].toUpperCase() + rest.slice(1), maxWords)];
}
