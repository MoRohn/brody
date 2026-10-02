#!/usr/bin/env node
/**
 * Set up the local tools for Brody explainer videos, on macOS, Linux and Windows.
 *   npm run explainer:setup              check, and install Manim if it is missing and can be installed
 *   npm run explainer:setup -- --check   check only; install nothing
 *
 * Brody also runs this automatically when the server starts and Manim is missing (src/lib/explainer/setup.ts;
 * EXPLAINER_AUTO_SETUP=off turns that off). It never installs system packages: when something is missing it prints the
 * command for this system and stops.
 *
 * Required: FFmpeg with the H.264 (libx264) and AAC encoders.
 * Optional: Manim in a private virtualenv (BRODY_EXPLAINER_VENV), used for diagram scenes; without it every scene uses
 * the built-in HTML/SVG renderer.
 *
 * Exit codes: 0 ready (or Manim installed now); 1 FFmpeg missing or unusable; 2 Manim needs system packages first;
 *             3 (--check only) Manim missing but installable; 4 the Manim install failed.
 * Dependency-free on purpose: it runs before `npm install` has finished as easily as after.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHECK_ONLY = process.argv.includes("--check");
const MANIM_VERSION = "0.19.0";
const WIN = process.platform === "win32";
const MAC = process.platform === "darwin";

const expandHome = (p) => (p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? path.join(os.homedir(), p.slice(2)) : p);
export function defaultVenv() {
  return WIN ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "brody", "explainer-venv") : path.join(os.homedir(), ".local", "share", "brody", "explainer-venv");
}
const VENV = expandHome(process.env.BRODY_EXPLAINER_VENV || defaultVenv());
const venvPython = (v) => (WIN ? path.join(v, "Scripts", "python.exe") : path.join(v, "bin", "python"));

const ok = (s) => console.log(`  ✓ ${s}`);
const miss = (s) => console.log(`  ✗ ${s}`);
const hint = (s) => console.log(`      ${s}`);
/** Run a program without a shell; never throws. */
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: false, windowsHide: true, ...opts });
  return { ok: !r.error && r.status === 0, status: r.error ? null : r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
const has = (cmd, args = ["--version"]) => sh(cmd, args).ok;

function linuxInstallHint(debian, fedora, arch) {
  if (has("apt-get")) hint(`sudo apt install ${debian}`);
  else if (has("dnf")) hint(`sudo dnf install ${fedora}`);
  else if (has("pacman", ["-V"])) hint(`sudo pacman -S ${arch}`);
  else { hint(`Debian/Ubuntu: sudo apt install ${debian}`); hint(`Fedora: sudo dnf install ${fedora}`); }
}

console.log("Brody explainer setup");

// FFmpeg, with the encoders Brody uses (Fedora's default ffmpeg-free has no libx264).
const ffmpeg = sh(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-encoders"]);
if (!ffmpeg.ok || !has(process.env.FFPROBE_PATH || "ffprobe", ["-version"])) {
  miss("FFmpeg is required. Install it, then run this again:");
  if (MAC) hint("brew install ffmpeg");
  else if (WIN) hint("winget install Gyan.FFmpeg   (or: choco install ffmpeg), then open a new terminal");
  else linuxInstallHint("ffmpeg", "ffmpeg   (from RPM Fusion, which includes libx264)", "ffmpeg");
  process.exit(1);
}
if (!/\blibx264\b/.test(ffmpeg.out) || !/\baac\b/.test(ffmpeg.out)) {
  miss(`This FFmpeg has no ${/\blibx264\b/.test(ffmpeg.out) ? "AAC" : "H.264 (libx264)"} encoder, which explainer videos need.`);
  if (!MAC && !WIN) hint("Fedora/RHEL: install ffmpeg from RPM Fusion (sudo dnf swap ffmpeg-free ffmpeg --allowerasing)");
  else hint("Install a full FFmpeg build (macOS: brew install ffmpeg; Windows: winget install Gyan.FFmpeg).");
  process.exit(1);
}
ok(`FFmpeg ${(sh(process.env.FFMPEG_PATH || "ffmpeg", ["-version"]).out.split("\n")[0] ?? "").split(" ")[2] ?? ""} (H.264 and AAC encoders present)`);

// Voices (information only: Brody picks whichever is available).
if (MAC) has("swiftc") ? ok("macOS on-device voice (word timings measured by the speech engine)") : miss("swiftc not found: run xcode-select --install for the on-device voice");
else if (WIN) sh("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices().Count"]).out.trim().match(/^[1-9]/) ? ok("Windows speech voice (word timings measured by the speech engine)") : miss("No Windows speech voice found (Settings > Time & language > Speech > Add voices)");
else if (has("espeak-ng") || has("espeak")) ok("eSpeak NG local voice (sentence-level timing); set PIPER_MODEL for a better local voice");
else if (process.env.PIPER_MODEL) ok("Piper local voice");
else { miss("No local voice: install one so videos can be narrated without a cloud service"); linuxInstallHint("espeak-ng", "espeak-ng", "espeak-ng"); }

// Manim.
const py = venvPython(VENV);
if (fs.existsSync(py) && sh(py, ["-c", "import manim, manimpango"]).ok) {
  ok(`Manim ${sh(py, ["-c", "import manim; print(manim.__version__)"]).out.trim()} in ${VENV}`);
  process.exit(0);
}

// What Manim needs from the system. Windows and macOS (with Homebrew's cairo/pango) use prebuilt wheels.
const uv = has("uv");
const basePython = WIN ? (has("py", ["-3", "--version"]) ? ["py", "-3"] : has("python") ? ["python"] : null) : has("python3") ? ["python3"] : null;
if (!uv && !basePython) {
  miss("Manim needs Python 3.9 or newer (or uv).");
  if (WIN) hint("winget install Python.Python.3.12   (or: winget install astral-sh.uv)");
  else if (MAC) hint("brew install uv");
  else linuxInstallHint("python3 python3-venv", "python3", "python");
  process.exit(2);
}
if (MAC) {
  if (has("brew")) {
    const need = ["cairo", "pango", "pkg-config"].filter((p) => !sh("brew", ["list", "--formula", p]).ok);
    if (need.length) { miss(`Manim needs: ${need.join(" ")}`); hint(`brew install ${need.join(" ")}`); console.log("  (The HTML renderer works without Manim.)"); process.exit(2); }
  } else if (!sh("pkg-config", ["--exists", "cairo", "pangocairo"]).ok) { miss("Manim needs cairo and pango: install Homebrew, then brew install cairo pango pkg-config"); process.exit(2); }
} else if (!WIN) {
  const missing = [];
  if (!sh("pkg-config", ["--exists", "cairo", "pangocairo"]).ok) missing.push("cairo/pango development files");
  if (!has("cc") && !has("gcc")) missing.push("a C compiler (pycairo builds from source on Linux)");
  if (!uv && !sh("python3", ["-c", "import venv, ensurepip"]).ok) missing.push("python3-venv");
  if (missing.length) {
    miss(`Manim needs ${missing.join(", ")}`);
    linuxInstallHint("python3-venv python3-dev build-essential pkg-config libcairo2-dev libpango1.0-dev", "python3-devel gcc pkgconf-pkg-config cairo-devel pango-devel", "base-devel pkgconf cairo pango");
    console.log("  (The HTML renderer works without Manim.)");
    process.exit(2);
  }
}

if (CHECK_ONLY) { miss(`Manim is not installed yet (npm run explainer:setup installs it into ${VENV})`); process.exit(3); }

console.log(`  Installing Manim ${MANIM_VERSION} into ${VENV} …`);
fs.mkdirSync(path.dirname(VENV), { recursive: true });
const stream = { stdio: "inherit" };
let installed;
if (uv) {
  installed = sh("uv", ["venv", "--allow-existing", "--python", "3.12", VENV], stream).ok && sh("uv", ["pip", "install", "--python", py, `manim==${MANIM_VERSION}`], stream).ok;
} else {
  installed = sh(basePython[0], [...basePython.slice(1), "-m", "venv", VENV], stream).ok && sh(py, ["-m", "pip", "install", "--quiet", `manim==${MANIM_VERSION}`], stream).ok;
}
if (!installed) { miss("The Manim install failed (see the output above)."); process.exit(4); }
if (!sh(py, ["-c", "import manim, manimpango"]).ok) { miss("Manim was installed but does not import (see the output above)."); process.exit(4); }
ok(`Manim ${sh(py, ["-c", "import manim; print(manim.__version__)"]).out.trim()} installed. Brody finds it automatically (or set MANIM_PYTHON=${py}).`);
process.exit(0);
