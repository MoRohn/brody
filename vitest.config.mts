import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    environment: "node",
    // Never read the developer's real AI selections (data/ai-settings.json) during tests.
    // Worker threads are exercised by tests/workers.test.ts; everything else parses in-process so the suite stays fast and simple.
    // Formal verification (Lean) is off by default so scripted providers in other suites need no Lean answers; tests/formal.test.ts turns it on.
    env: { PARSE_WORKERS: "0", AI_SETTINGS_PATH: path.join(os.tmpdir(), "brody-vitest-ai-settings-unused.json"), FORMAL_VERIFICATION: "off" },
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Native SQLite and WASM grammars are shared process-wide; keep files isolated but run sequentially for stable timing.
    pool: "forks",
    fileParallelism: false,
  },
});
