#!/usr/bin/env node
/**
 * One command for the whole validation, on macOS, Linux and Windows: types, lint, tests, both production builds,
 * performance budgets and the browser suite (layout at four widths, five brightness levels, accessibility, keyboard,
 * web performance budgets).
 *   npm run validate              everything
 *   npm run validate -- --quick   skip the browser suite
 * Every step must pass with zero warnings, so a regression in any of them fails the run.
 *
 * Each tool is started through its own JavaScript entry point with this Node (not npx or a shell), so the same command
 * works in PowerShell, cmd, bash and zsh.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const quick = process.argv.includes("--quick");
const env = { ...process.env, AI_PROVIDER: "none", AI_SETTINGS_PATH: path.join(os.tmpdir(), "brody-validate-ai-settings-unused.json") };

/** A package's command, from its own package.json "bin" (exports maps can hide the file from require.resolve). */
function binOf(pkg, name = pkg) {
  const dir = path.dirname(require.resolve(`${pkg}/package.json`));
  const meta = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  const rel = typeof meta.bin === "string" ? meta.bin : meta.bin?.[name];
  if (!rel) throw new Error(`${pkg} declares no "${name}" command`);
  return path.join(dir, rel);
}
const bin = { tsc: binOf("typescript", "tsc"), eslint: binOf("eslint"), vitest: binOf("vitest"), next: binOf("next"), tsx: binOf("tsx"), playwright: binOf("@playwright/test", "playwright") };

const step = (name) => console.log(`\n\x1b[1m== ${name}\x1b[0m`);
function run(args, { capture = false, extraEnv = {} } = {}) {
  const r = spawnSync(process.execPath, args, { cwd: root, env: { ...env, ...extraEnv }, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const out = capture ? `${r.stdout ?? ""}${r.stderr ?? ""}` : "";
  if (r.status !== 0) {
    if (capture) console.log(out);
    console.error(`\n\x1b[1;31mValidation failed at: ${args.map((a) => path.basename(a)).join(" ")}\x1b[0m`);
    process.exit(r.status ?? 1);
  }
  return out;
}

step("Types");
run([bin.tsc, "--noEmit"]);
step("Lint");
run([bin.eslint, "src", "tests", "e2e", "scripts", "--max-warnings=0"]);
step("Unit and integration tests");
run([bin.vitest, "run"]);
step("Production build (webpack, as in Docker)");
let out = run([bin.next, "build", "--webpack"], { capture: true });
if (/compiled with warnings|Module not found|Critical dependency/i.test(out)) { console.log(out.split("\n").filter((l) => /warning|not found|critical/i.test(l)).join("\n")); console.error("The webpack build has warnings."); process.exit(1); }
step("Production build (Turbopack)");
out = run([bin.next, "build"], { capture: true });
if (/build encountered \d+ warning/.test(out)) { console.log(out.slice(out.indexOf("Warning:"), out.indexOf("Warning:") + 2000)); console.error("The Turbopack build has warnings."); process.exit(1); }
run([path.join(root, "tools", "build-worker.mjs")]);
step("Performance budgets");
console.log(run([bin.tsx, "scripts/benchmark.mts", "--budget", "200", "1000"], { capture: true }).split("\n").filter((l) => !/localstorage-file|trace-warnings/.test(l)).join("\n"));
if (!quick) { step("Browser suite"); run([bin.playwright, "test"]); }
console.log("\n\x1b[1;32mValidation passed.\x1b[0m");
