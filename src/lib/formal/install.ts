/**
 * One-click Lean install ("Add Lean"). Installs the pinned Lean 4 toolchain through elan, installing elan itself
 * first when it is missing, then re-runs toolchain discovery. Runs in the background; progress is read from
 * `leanInstallState()` (reported by /api/status).
 *
 * Only elan's official installer and toolchains are fetched, into ELAN_HOME (default ~/.elan); nothing from
 * the server's environment (API keys, tokens) reaches the installer.
 */
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "@/lib/config";
import { runtimeKind } from "@/lib/runtime";
import { elanHome, findLean, resetLean } from "./lean";

/** The toolchain the Docker image ships, so local and container proofs behave the same. */
export const LEAN_TOOLCHAIN = "leanprover/lean4:v4.34.0";
const ELAN_INIT_URL = "https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh";
const STEP_TIMEOUT_MS = 20 * 60_000;

export interface LeanInstallState {
  state: "idle" | "installing" | "done" | "failed";
  step?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

// Kept on globalThis: the install route and the status route may load separate copies of this module.
const store = globalThis as typeof globalThis & { __brodyLeanInstall?: LeanInstallState };
const get = (): LeanInstallState => store.__brodyLeanInstall ?? { state: "idle" };
const set = (patch: Partial<LeanInstallState>, fresh = false) => { store.__brodyLeanInstall = { ...(fresh ? {} : get()), ...patch } as LeanInstallState; };

export function leanInstallState(): LeanInstallState {
  return get();
}

/** Whether Add Lean can run here, and why not. */
export function canInstallLean(): { ok: boolean; reason?: string } {
  if (runtimeKind() === "docker") return { ok: false, reason: "The Docker image ships Lean. Rebuild it with docker compose up --build." };
  if (process.platform !== "darwin" && process.platform !== "linux") return { ok: false, reason: "Add Lean supports macOS and Linux. Install Lean with elan: https://lean-lang.org/install" };
  if (config.formal.leanBin) return { ok: false, reason: `LEAN_BIN is set to ${config.formal.leanBin}. Fix or remove it to let Brody find or install Lean.` };
  return { ok: true };
}

/** Start the install unless one is already running. Returns the state right after starting. */
export function startLeanInstall(): LeanInstallState {
  if (get().state === "installing") return get();
  set({ state: "installing", step: "Starting", startedAt: Date.now() }, true);
  void install().then(
    () => set({ state: "done", step: "Lean is ready", finishedAt: Date.now() }),
    (e: unknown) => set({ state: "failed", error: e instanceof Error ? e.message : String(e), finishedAt: Date.now() }),
  );
  return get();
}

async function install(): Promise<void> {
  let elan = await findElan();
  if (!elan) {
    set({ step: "Downloading the elan installer" });
    const res = await fetch(ELAN_INIT_URL, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Could not download the elan installer (HTTP ${res.status}).`);
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "brody-elan-"));
    const script = path.join(dir, "elan-init.sh");
    try {
      await fsp.writeFile(script, await res.text(), { mode: 0o700 });
      set({ step: "Installing elan" });
      await exec("sh", [script, "-y", "--no-modify-path", "--default-toolchain", LEAN_TOOLCHAIN]);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
    elan = await findElan();
    if (!elan) throw new Error("elan was installed but could not be run. See the server log.");
  }
  // elan-init only records the default toolchain and fetches it lazily on first use, so install it explicitly.
  set({ step: `Downloading and installing ${LEAN_TOOLCHAIN}` });
  await exec(elan, ["toolchain", "install", LEAN_TOOLCHAIN]);
  set({ step: "Checking Lean" });
  resetLean();
  if (!(await findLean())) throw new Error("Lean was installed but could not be run. See the server log.");
}

/** elan on PATH or in ELAN_HOME, or null. */
async function findElan(): Promise<string | null> {
  for (const c of ["elan", path.join(elanHome(), "bin", "elan")]) {
    try {
      await exec(c, ["--version"], 15_000, true);
      return c;
    } catch { /* try the next */ }
  }
  return null;
}

function exec(cmd: string, args: string[], timeoutMs = STEP_TIMEOUT_MS, quiet = false): Promise<void> {
  return new Promise((resolve, reject) => {
    let tail = "";
    const keep = (b: Buffer) => { tail = (tail + b.toString()).slice(-2000); };
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: os.homedir(), LANG: "C.UTF-8" };
    if (process.env.ELAN_HOME) env.ELAN_HOME = process.env.ELAN_HOME;
    let child;
    try {
      child = spawn(cmd, args, { env: env as unknown as NodeJS.ProcessEnv, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      reject(e);
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else {
        if (!quiet) console.error(`[brody] ${path.basename(cmd)} ${args.join(" ")} failed:\n${tail}`);
        reject(new Error(`${path.basename(cmd)} exited with ${code ?? "a signal"}: ${tail.trim().split("\n").pop() ?? ""}`.slice(0, 400)));
      }
    });
  });
}
