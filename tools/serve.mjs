// Runs `next dev` or `next start` on the port set in the shell, .env.local or .env (default 3003).
// `next` reads PORT before it loads env files, so a PORT in .env would otherwise be ignored.
//   node tools/serve.mjs dev|start [extra next args]
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
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

const require = createRequire(import.meta.url);
const child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), mode, "-p", port, ...process.argv.slice(3)], {
  stdio: "inherit",
  env: { ...initial, PORT: port },
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
