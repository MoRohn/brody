// Runs `next dev` or `next start` on the port set in the shell, .env.local or .env (default 3003).
// `next` reads PORT before it loads env files, so a PORT in .env would otherwise be ignored.
//   node tools/serve.mjs dev|start [extra next args]
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import nextEnv from "@next/env";

const mode = process.argv[2];
if (mode !== "dev" && mode !== "start") {
  console.error("Usage: node tools/serve.mjs dev|start");
  process.exit(2);
}

// Read the env files without keeping them in this process's environment: Next loads them again itself,
// and in dev it reloads them on change, which only works for values not already pinned in process.env.
const initial = { ...process.env };
const { combinedEnv } = nextEnv.loadEnvConfig(process.cwd(), mode === "dev", { info: () => {}, error: console.error });
const port = combinedEnv.PORT || "3003";

// Brody's address. BRODY_URL is set by Docker Compose, which knows the published port; otherwise the port is our own.
const url = (combinedEnv.BRODY_URL || `http://brody.localhost:${port}`).replace(/\/+$/, "");

const require = createRequire(import.meta.url);
const child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), mode, "-p", port, ...process.argv.slice(3)], {
  stdio: ["inherit", "pipe", "inherit"],
  // Output goes through a pipe now, so keep Next's colours when this process itself writes to a terminal.
  env: { ...initial, PORT: port, ...(process.stdout.isTTY && !initial.NO_COLOR && !initial.FORCE_COLOR ? { FORCE_COLOR: "1" } : {}) },
});
// Next announces its raw listen addresses: loopback with the internal port and, in Docker, the container's private IP,
// which no browser can reach. Announce Brody's address in their place; every other line passes through unchanged.
createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
  const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
  if (/^\s*-\s*Network:/.test(plain)) return;
  process.stdout.write(/^\s*-\s*Local:/.test(plain) ? `- Brody:         ${url}\n` : `${line}\n`);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
// "close" rather than "exit": it fires after the piped output has been fully written.
child.on("close", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
