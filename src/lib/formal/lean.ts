/**
 * The Lean 4 checker: finding the toolchain, screening model-written Lean source, running it in a
 * locked-down subprocess and reading back which theorems were really proved.
 *
 * Lean source here is written by a model that has read untrusted repository code, so it is treated as
 * hostile. Two separate guarantees are enforced:
 *
 * - Execution safety. Lean can run arbitrary code while it checks a file (`#eval`, `initialize`, macros,
 *   `extern`/`implemented_by`, compiled `native_decide`). `screenLeanSource` rejects every construct that
 *   can execute code or talk to the system before the file ever reaches Lean, and the process runs with a
 *   minimal environment, a private temporary directory, a memory cap and a hard wall-clock kill.
 * - Proof soundness. A theorem counts as proved only if Lean reports no error inside it AND
 *   `#print axioms` (appended by Brody, never by the model, and read only from Brody's own lines) lists
 *   nothing beyond Lean's three standard axioms. `sorry`, `admit`, custom axioms and compiler-trusting
 *   tactics all surface there, so a model cannot fake a proof.
 */
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "../config";

/** The axioms every ordinary Lean proof may rest on. Anything else (sorryAx, Lean.ofReduceBool, user axioms) is refused. */
export const STANDARD_AXIOMS = new Set(["propext", "Classical.choice", "Quot.sound"]);

/** Imports a model may rely on; they are added by Brody when the source needs them. Core Lean needs none. */
const OPTIONAL_IMPORTS: { module: string; when: RegExp }[] = [{ module: "Std.Tactic.BVDecide", when: /\bbv_decide\b|\bbv_omega\b/ }];

/**
 * Constructs refused in model-written Lean. The raw text is scanned (comments and strings included), so nothing can be
 * hidden from the scan by a lexer disagreement; the model is told to avoid these words everywhere.
 */
const FORBIDDEN: { re: RegExp; why: string }[] = [
  { re: /^\s*import\b/m, why: "imports are added by Brody" },
  { re: /#(?!v\[)[A-Za-z_]+/, why: "#-commands (#eval, #print, #exit, ...) are not allowed" },
  { re: /\b(sorry|admit)\b/, why: "incomplete proofs (sorry/admit) are not allowed" },
  { re: /\baxiom\b/, why: "new axioms are not allowed" },
  { re: /\bunsafe\b/, why: "unsafe code is not allowed" },
  { re: /\b(extern|implemented_by|csimp)\b|(@\[|\battribute\s*\[)[^\]]*\b(export|init|builtin_init)\b/, why: "attributes that swap in compiled or native code are not allowed" },
  { re: /\b(initialize|builtin_initialize)\b/, why: "initialisers run code and are not allowed" },
  { re: /\b(macro|macro_rules|syntax|elab|elab_rules|declare_syntax_cat|notation|infix|infixl|infixr|prefix|postfix)\b/, why: "syntax extensions and elaborators are not allowed" },
  { re: /\b(run_cmd|run_elab|run_meta|run_tac)\b/, why: "meta-level execution is not allowed" },
  { re: /\bset_option\b/, why: "options are set by Brody" },
  { re: /\b(native_decide|native|ofReduceBool|reduceBool|trustCompiler)\b/, why: "compiler-trusted evaluation is not allowed; use decide, simp or omega" },
  { re: /\b(E|Base)?IO\b|\bunsafe(Base|E)?IO\b|\bSystem\.|\bFFI\b/, why: "IO and system access are not allowed" },
  { re: /\bLean\.(Elab|Meta|Environment|Compiler|Parser)\b/, why: "meta-programming is not allowed" },
];

export interface ScreenResult { ok: boolean; problems: string[] }

export function screenLeanSource(src: string): ScreenResult {
  const problems: string[] = [];
  for (const f of FORBIDDEN) {
    const m = f.re.exec(src);
    if (m) problems.push(`\`${m[0].trim()}\`: ${f.why}`);
  }
  if (src.length > 60_000) problems.push("the Lean source is too long");
  return { ok: problems.length === 0, problems };
}

export const THEOREM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---------------------------------------------------------------------------
// Toolchain discovery
// ---------------------------------------------------------------------------

export interface LeanToolchain {
  /** The real `lean` binary inside the toolchain (never the elan proxy, which may try to download toolchains). */
  bin: string;
  version: string;
}

let toolchain: Promise<LeanToolchain | null> | undefined;
let unavailableReason = "";

/** Find a usable Lean 4 toolchain once per process. Returns null (with `leanUnavailableReason`) when there is none. */
export function findLean(): Promise<LeanToolchain | null> {
  if (!toolchain) toolchain = locate();
  return toolchain;
}

export function leanUnavailableReason(): string {
  return unavailableReason;
}

/** Forget the discovered toolchain (tests, or after installing Lean while the server runs). */
export function resetLean(): void {
  toolchain = undefined;
  unavailableReason = "";
}

async function locate(): Promise<LeanToolchain | null> {
  const candidates = config.formal.leanBin ? [config.formal.leanBin] : ["lean", path.join(os.homedir(), ".elan", "bin", "lean")];
  for (const c of candidates) {
    // `--print-prefix` resolves the toolchain directory, so later runs call its binary directly.
    // The elan proxy finds its toolchains through HOME or ELAN_HOME (set when elan lives outside the home directory).
    const prefix = await run(c, ["--print-prefix"], { timeoutMs: 30_000, env: { HOME: os.homedir(), ...(process.env.ELAN_HOME ? { ELAN_HOME: process.env.ELAN_HOME } : {}) } });
    if (prefix.code !== 0 || !prefix.stdout.trim()) continue;
    const bin = path.join(prefix.stdout.trim(), "bin", process.platform === "win32" ? "lean.exe" : "lean");
    const ver = await run(bin, ["--version"], { timeoutMs: 30_000 });
    const m = /version (\d+)\.(\d+)\.(\d+)/.exec(ver.stdout);
    if (!m) continue;
    if (Number(m[1]) < 4 || (Number(m[1]) === 4 && Number(m[2]) < 12)) {
      unavailableReason = `Lean ${m[1]}.${m[2]}.${m[3]} is too old; formal verification needs Lean 4.12 or newer.`;
      continue;
    }
    return { bin, version: `${m[1]}.${m[2]}.${m[3]}` };
  }
  unavailableReason ||= config.formal.leanBin
    ? `LEAN_BIN is set to ${config.formal.leanBin}, but it could not be run.`
    : "Lean 4 was not found. Install it with elan (https://lean-lang.org/install) or set LEAN_BIN to the lean binary.";
  return null;
}

// ---------------------------------------------------------------------------
// Running Lean
// ---------------------------------------------------------------------------

function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs: number; env?: Record<string, string>; sandbox?: boolean }): Promise<{ code: number | null; stdout: string; stderr: string; timedOut?: boolean }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (r: { code: number | null; stdout: string; stderr: string; timedOut?: boolean }) => { if (!settled) { settled = true; resolve(r); } };
    // An optional isolation wrapper (for example bubblewrap without network) is put in front of checks, not discovery.
    const [exe, ...argv] = opts.sandbox && config.formal.sandboxPrefix.length ? [...config.formal.sandboxPrefix, cmd, ...args] : [cmd, ...args];
    let child;
    try {
      child = spawn(exe, argv, {
        cwd: opts.cwd,
        // Nothing from the server's environment (API keys, tokens) reaches Lean.
        env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8", HOME: opts.env?.HOME ?? os.tmpdir(), ...opts.env } as unknown as NodeJS.ProcessEnv,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      finish({ code: null, stdout, stderr: String(e) });
      return;
    }
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish({ code: null, stdout, stderr: `${stderr}\n[timed out]`, timedOut: true }); }, opts.timeoutMs);
    child.stdout.on("data", (d: Buffer) => { if (stdout.length < 4_000_000) stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { if (stderr.length < 200_000) stderr += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); finish({ code: null, stdout, stderr: String(e) }); });
    child.on("close", (code) => { clearTimeout(timer); finish({ code, stdout, stderr }); });
  });
}

export interface LeanMessage {
  severity: "error" | "warning" | "information";
  line: number;
  endLine: number;
  text: string;
}

export interface TheoremOutcome {
  name: string;
  /** Proved with no errors and only standard axioms. */
  proved: boolean;
  axioms: string[];
  /** Errors Lean reported inside this theorem (for the repair loop). */
  errors: string[];
}

export interface LeanCheck {
  /** The exact file that was checked, as shown to users. */
  source: string;
  /** Errors outside every theorem (in the model's definitions). */
  modelErrors: string[];
  theorems: TheoremOutcome[];
  timedOut: boolean;
  /** The source was refused before running Lean. */
  refused?: string[];
  ms: number;
}

/**
 * Check a model and its theorems. Each theorem is checked on its own terms: a failure in one does not hide the others,
 * because Lean keeps elaborating later declarations after an error.
 */
export async function checkLean(lean: LeanToolchain, model: string, theorems: { name: string; text: string }[]): Promise<LeanCheck> {
  const started = Date.now();
  const body = [model.trim(), ...theorems.map((t) => t.text.trim())].join("\n\n");
  const screen = screenLeanSource(body);
  const names = theorems.map((t) => t.name);
  const bad = names.filter((n) => !THEOREM_NAME.test(n) || names.indexOf(n) !== names.lastIndexOf(n));
  if (bad.length) screen.problems.push(`invalid or duplicate theorem names: ${bad.join(", ")}`);
  const header = [...OPTIONAL_IMPORTS.filter((i) => i.when.test(body)).map((i) => `import ${i.module}`), "set_option autoImplicit false"];
  // Theorem positions are located in the assembled file so errors can be attributed to them.
  const pieces: string[] = [...header, "", model.trim(), ""];
  const spans: { name: string; from: number; to: number }[] = [];
  for (const t of theorems) {
    const from = pieces.join("\n").split("\n").length + 1;
    pieces.push(t.text.trim(), "");
    spans.push({ name: t.name, from, to: pieces.join("\n").split("\n").length });
  }
  const auditFrom = pieces.join("\n").split("\n").length + 1;
  for (const t of theorems) pieces.push(`#print axioms ${t.name}`);
  const source = pieces.join("\n") + "\n";
  const shown = source.split("\n").slice(0, auditFrom - 1).join("\n");
  if (!screen.ok) return { source: shown, modelErrors: [], theorems: theorems.map((t) => ({ name: t.name, proved: false, axioms: [], errors: [] })), timedOut: false, refused: screen.problems, ms: Date.now() - started };
  for (const t of theorems) {
    if (!new RegExp(`\\btheorem\\s+${t.name}\\b`).test(t.text)) screen.problems.push(`theorem ${t.name} is not declared under that name`);
  }
  if (screen.problems.length) return { source: shown, modelErrors: [], theorems: theorems.map((t) => ({ name: t.name, proved: false, axioms: [], errors: [] })), timedOut: false, refused: screen.problems, ms: Date.now() - started };

  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "brody-lean-")));
  try {
    const file = path.join(dir, "Check.lean");
    await fsp.writeFile(file, source);
    const res = await run(lean.bin, ["--json", `-M${config.formal.memoryMb}`, `-DmaxHeartbeats=${config.formal.maxHeartbeats}`, "Check.lean"], { cwd: dir, timeoutMs: config.formal.timeoutMs, env: { HOME: dir }, sandbox: true });
    const messages = parseMessages(res.stdout);
    const outcome = spans.map((s): TheoremOutcome => ({ name: s.name, proved: false, axioms: [], errors: [] }));
    const modelErrors: string[] = [];
    for (const m of messages) {
      if (m.line >= auditFrom) {
        // Only Brody's own `#print axioms` lines are read here, so text the model prints elsewhere cannot pose as an audit.
        const a = /^'([^']+)' (?:depends on axioms: \[([^\]]*)\]|does not depend on any axioms)/.exec(m.text);
        const idx = m.line - auditFrom;
        if (a && outcome[idx] && a[1] === outcome[idx].name) outcome[idx].axioms = (a[2] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
        else if (m.severity === "error" && outcome[idx]) outcome[idx].errors.push(m.text);
        continue;
      }
      if (m.severity !== "error") continue;
      const span = spans.findIndex((s) => m.line >= s.from && m.line < s.to);
      if (span >= 0) outcome[span].errors.push(`line ${m.line - spans[span].from + 1}: ${m.text}`);
      else modelErrors.push(`line ${m.line}: ${m.text}`);
    }
    const audited = new Set(messages.filter((m) => m.line >= auditFrom && /depends on axioms|does not depend on any axioms/.test(m.text)).map((m) => m.line - auditFrom));
    for (const [i, o] of outcome.entries()) {
      o.proved = !res.timedOut && audited.has(i) && o.errors.length === 0 && modelErrors.length === 0 && o.axioms.every((x) => STANDARD_AXIOMS.has(x));
      if (!o.proved && !o.errors.length && o.axioms.some((x) => !STANDARD_AXIOMS.has(x))) o.errors.push(`the proof depends on non-standard axioms: ${o.axioms.filter((x) => !STANDARD_AXIOMS.has(x)).join(", ")}`);
    }
    if (res.timedOut) modelErrors.push(`Lean did not finish within ${Math.round(config.formal.timeoutMs / 1000)} s; simplify the model or the proofs.`);
    else if (!messages.length && res.code !== 0) modelErrors.push(`Lean failed to run: ${res.stderr.slice(0, 300)}`);
    return { source: shown, modelErrors: modelErrors.map(clip), theorems: outcome.map((o) => ({ ...o, errors: o.errors.map(clip) })), timedOut: !!res.timedOut, ms: Date.now() - started };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

const clip = (s: string) => (s.length > 900 ? `${s.slice(0, 900)}…` : s);

function parseMessages(stdout: string): LeanMessage[] {
  const out: LeanMessage[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const m = JSON.parse(line) as { severity?: string; pos?: { line: number }; endPos?: { line: number }; data?: string };
      if (!m.pos || typeof m.data !== "string") continue;
      out.push({ severity: (m.severity as LeanMessage["severity"]) ?? "information", line: m.pos.line, endLine: m.endPos?.line ?? m.pos.line, text: m.data });
    } catch { /* not a message */ }
  }
  return out;
}
