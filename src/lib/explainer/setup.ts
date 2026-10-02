/**
 * Automatic explainer tool setup. When the server starts, Brody checks FFmpeg and Manim; if Manim is missing and can be
 * installed (cairo and pango are present), it runs tools/setup-explainer.mjs in the background, which installs Manim
 * into a private virtualenv. Until it finishes, scenes use the HTML renderer, so nothing waits for it.
 *
 * Never automatic in Docker (the image decides at build time with WITH_MANIM), in CI, in tests, when MANIM_PYTHON names
 * a Python the user manages, or with EXPLAINER_AUTO_SETUP=off. It never installs system packages. A failed or
 * impossible install is remembered (explainer-setup.json next to the database) and retried at most once a day; a manual
 * "Set up now" (POST /api/explainer/setup) always runs.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { runtimeKind } from "../runtime";
import { explainerConfig, explainerVenv } from "./config";
import { ffmpegProblem, run, safeEnv } from "./media";
import { resetManimProbe } from "./render/manim";

export type SetupOutcome = "ready" | "installed" | "ffmpeg-missing" | "needs-system-libraries" | "installable" | "failed";
const OUTCOME_BY_EXIT: Record<number, SetupOutcome> = { 0: "ready", 1: "ffmpeg-missing", 2: "needs-system-libraries", 3: "installable", 4: "failed" };
const RETRY_AFTER_MS = 24 * 60 * 60_000;

export interface SetupState {
  state: "idle" | "checking" | "installing" | "done" | "failed" | "skipped";
  trigger?: "startup" | "manual";
  outcome?: SetupOutcome;
  message?: string;
  log: string[];
  startedAt?: number;
  finishedAt?: number;
}

// On globalThis: the startup hook, the setup route and the settings route may load separate copies of this module.
const store = globalThis as typeof globalThis & { __brodyExplainerSetup?: SetupState };
const get = (): SetupState => store.__brodyExplainerSetup ?? { state: "idle", log: [] };
const set = (patch: Partial<SetupState>, fresh = false) => { store.__brodyExplainerSetup = { ...(fresh ? { log: [] } : get()), ...patch } as SetupState; };
export const setupState = (): SetupState => get();

export function setupScript(): string | null {
  const p = path.join(process.cwd(), "tools", "setup-explainer.mjs");
  return fs.existsSync(/*turbopackIgnore: true*/ p) ? p : null; // brody-ignore: sync-io (one stat)
}

function memoryFile(): string | null {
  if (process.env.EXPLAINER_SETUP_STATE_PATH) return process.env.EXPLAINER_SETUP_STATE_PATH;
  return config.databasePath === ":memory:" ? null : path.join(path.dirname(config.databasePath), "explainer-setup.json");
}
interface Memory { at: number; outcome: SetupOutcome; venv: string }
function remembered(): Memory | null {
  const f = memoryFile();
  if (!f) return null;
  try { return JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ f, "utf8")) as Memory; } catch { return null; } // brody-ignore: sync-io (tiny file)
}
function remember(outcome: SetupOutcome) {
  const f = memoryFile();
  if (!f) return;
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(/*turbopackIgnore: true*/ f, JSON.stringify({ at: Date.now(), outcome, venv: explainerVenv() } satisfies Memory)); } catch { /* best effort */ }
}

export interface Decision { run: boolean; reason: string }

/** Whether the automatic setup should run now (startup). Pure apart from reading the environment and the memory file. */
export function autoSetupDecision(env: NodeJS.ProcessEnv = process.env, now = Date.now()): Decision {
  if ((env.EXPLAINER_AUTO_SETUP ?? "").toLowerCase() === "off") return { run: false, reason: "EXPLAINER_AUTO_SETUP=off" };
  if (env.CI || env.VITEST || env.NODE_ENV === "test") return { run: false, reason: "not automatic in CI or tests" };
  if (runtimeKind() === "docker") return { run: false, reason: "the Docker image decides at build time (WITH_MANIM=1)" };
  if (!["darwin", "linux", "win32"].includes(process.platform)) return { run: false, reason: "automatic setup supports macOS, Linux and Windows" };
  if (env.MANIM_PYTHON) return { run: false, reason: "MANIM_PYTHON is set, so Manim is managed outside Brody" };
  if (!setupScript()) return { run: false, reason: "tools/setup-explainer.mjs is not present in this installation" };
  const m = remembered();
  if (m && m.venv === explainerVenv() && m.outcome !== "ready" && m.outcome !== "installed" && now - m.at < RETRY_AFTER_MS) return { run: false, reason: `the last attempt ended with "${m.outcome}" ${Math.round((now - m.at) / 60_000)} min ago; retried after a day or with Set up now` };
  return { run: true, reason: "check, and install Manim if it is missing" };
}

async function runScript(args: string[], onLine: (l: string) => void, timeoutMs: number): Promise<number> {
  const script = setupScript();
  if (!script) throw new Error("tools/setup-explainer.mjs was not found.");
  return new Promise((resolve, reject) => {
    // Only what the installer needs from the environment: never the server's API keys or tokens.
    // The setup is a Node script, run with this Node: no shell, the same on macOS, Linux and Windows.
    const child = spawn(process.execPath, [script, ...args], { cwd: process.cwd(), env: safeEnv({ BRODY_EXPLAINER_VENV: explainerVenv() }), stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`The setup took longer than ${Math.round(timeoutMs / 60_000)} minutes and was stopped.`)); }, timeoutMs);
    let buf = "";
    const feed = (d: Buffer) => { buf += d.toString(); const lines = buf.split(/\r?\n/); buf = lines.pop() ?? ""; for (const l of lines) if (l.trim()) onLine(l.trimEnd()); };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); if (buf.trim()) onLine(buf.trim()); resolve(code ?? -1); });
  });
}

/**
 * Check, and install Manim when it is missing and installable. Returns the final state. A second call while one runs
 * returns the running state.
 */
export async function runExplainerSetup(trigger: "startup" | "manual"): Promise<SetupState> {
  const cur = get();
  if (cur.state === "checking" || cur.state === "installing") return cur;
  set({ state: "checking", trigger, startedAt: Date.now(), message: "Checking FFmpeg and Manim" }, true);
  const log = (l: string) => set({ log: [...get().log, l].slice(-80) });
  try {
    const check = OUTCOME_BY_EXIT[await runScript(["--check"], log, 2 * 60_000)] ?? "failed";
    if (check !== "installable") {
      remember(check);
      set({ state: check === "ready" ? "done" : check === "failed" ? "failed" : "skipped", outcome: check, finishedAt: Date.now(), message: describe(check) });
      return get();
    }
    set({ state: "installing", message: "Installing Manim in the background; scenes use the HTML renderer until it is ready" });
    const outcome = OUTCOME_BY_EXIT[await runScript([], log, 20 * 60_000)] ?? "failed";
    const final: SetupOutcome = outcome === "ready" ? "installed" : outcome;
    remember(final);
    resetManimProbe();
    set({ state: final === "installed" ? "done" : "failed", outcome: final, finishedAt: Date.now(), message: describe(final) });
  } catch (e) {
    remember("failed");
    set({ state: "failed", outcome: "failed", finishedAt: Date.now(), message: e instanceof Error ? e.message : String(e) });
  }
  return get();
}

export function describe(o: SetupOutcome): string {
  switch (o) {
    case "ready": return "FFmpeg and Manim are ready.";
    case "installed": return "Manim was installed; new videos use it for diagram scenes.";
    case "ffmpeg-missing": return "FFmpeg (with H.264 and AAC) is missing, so videos cannot be made. The setup log names the install command for this system; install it and restart Brody.";
    case "needs-system-libraries": return "Manim needs packages from the system first (the setup log names them). Until then scenes use the HTML renderer.";
    case "installable": return "Manim is not installed yet.";
    default: return "The Manim install failed; scenes use the HTML renderer. See the setup log, then try Set up now.";
  }
}

/** Startup hook: decide, and run in the background when needed. Never throws, never blocks the server. */
export function ensureExplainerTools(): Decision {
  const d = autoSetupDecision();
  if (!d.run) { set({ state: "skipped", message: d.reason, finishedAt: Date.now() }, true); return d; }
  void runExplainerSetup("startup").then((s) => {
    if (s.outcome === "installed") console.log("[brody] explainer setup: Manim installed into", explainerVenv());
    else if (s.outcome && s.outcome !== "ready") console.log(`[brody] explainer setup: ${s.message}`);
  }, () => {});
  return d;
}

/** Facts for the settings panel: FFmpeg version, and the setup state. */
export async function toolSummary(): Promise<{ ffmpeg: string | null; ffmpegProblem: string | null; setup: SetupState; venv: string; autoSetup: Decision }> {
  let ffmpeg: string | null = null;
  try { const r = await run(explainerConfig().ffmpeg, ["-version"], { timeoutMs: 10_000 }); ffmpeg = r.code === 0 ? (r.stdout.toString().split("\n")[0].split(" ")[2] ?? "installed") : null; } catch { ffmpeg = null; }
  return { ffmpeg, ffmpegProblem: await ffmpegProblem(), setup: get(), venv: explainerVenv(), autoSetup: autoSetupDecision() };
}
