#!/usr/bin/env node
/**
 * Keep package-lock.json valid for the npm that CI and the Docker image use: the one bundled with the latest
 * Node 24 LTS (both run Node 24).
 *   node scripts/lockfile.mjs check   fail, with the fix, unless `npm ci` accepts the lock file under that npm
 *   node scripts/lockfile.mjs fix     let that npm rewrite the lock file (no install)
 *
 * Why: npm versions disagree about optional packages (for example the @emnapi/* entries of wasm32-wasi builds),
 * so a lock file written by an older npm can fail `npm ci` in CI even though it works locally. Dependency-free,
 * so CI can run it before `npm ci`.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const NODE_MAJOR = "24";
const mode = process.argv[2];
if (mode !== "check" && mode !== "fix") {
  console.error("Usage: node scripts/lockfile.mjs check|fix");
  process.exit(2);
}

const localNpm = () => spawnSync("npm", ["-v"], { encoding: "utf8" }).stdout.trim();

/** The npm bundled with the latest Node 24 release, or the local npm when nodejs.org cannot be reached. */
async function targetNpm() {
  try {
    const res = await fetch("https://nodejs.org/dist/index.json", { signal: AbortSignal.timeout(15_000) });
    const release = (await res.json()).find((r) => r.version.startsWith(`v${NODE_MAJOR}.`));
    if (release?.npm) return { npm: release.npm, node: release.version };
  } catch { /* offline */ }
  const npm = localNpm();
  console.warn(`Could not reach nodejs.org; checking with the local npm ${npm} instead.`);
  return { npm, node: process.version };
}

function npm(version, cwd, args) {
  const cmd = version === localNpm() ? ["npm", args] : ["npx", ["-y", `npm@${version}`, ...args]];
  const r = spawnSync(cmd[0], [...cmd[1], "--ignore-scripts", "--no-audit", "--no-fund"], { cwd, encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Run npm on a scratch copy of package.json and the lock file, so the repository and node_modules are untouched. */
function inScratch(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brody-lock-"));
  try {
    for (const f of ["package.json", "package-lock.json"]) fs.copyFileSync(path.join(root, f), path.join(dir, f));
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const target = await targetNpm();
const label = `npm ${target.npm} (Node ${target.node})`;

if (mode === "check") {
  const r = inScratch((dir) => npm(target.npm, dir, ["ci", "--dry-run"]));
  if (r.ok) {
    console.log(`package-lock.json is in sync for ${label}.`);
    process.exit(0);
  }
  console.log(`package-lock.json is NOT in sync for ${label}, the npm CI uses:`);
  for (const line of r.out.split("\n").filter((l) => /npm error (Missing|Invalid)/.test(l)).slice(0, 20)) console.log(`  ${line.replace(/^npm error /, "")}`);
  console.log(`\nThis usually means it was written by a different npm${localNpm() !== target.npm ? ` (yours is ${localNpm()})` : ""}.`);
  console.log(`Run \`npm run lockfile:fix\`, or use Node ${NODE_MAJOR} LTS locally so \`npm install\` writes a matching file.`);
  process.exit(1);
}

const next = inScratch((dir) => {
  const r = npm(target.npm, dir, ["install", "--package-lock-only"]);
  if (!r.ok) {
    console.error(`${label} could not update the lock file:\n${r.out}`);
    process.exit(1);
  }
  return fs.readFileSync(path.join(dir, "package-lock.json"), "utf8");
});
const current = fs.readFileSync(path.join(root, "package-lock.json"), "utf8");
fs.writeFileSync(path.join(root, "package-lock.json"), next);
console.log(next === current ? `package-lock.json was already right for ${label}.` : `package-lock.json rewritten by ${label}. Commit it.`);
