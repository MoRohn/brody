import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    environment: "node",
    // Never read the developer's real AI selections (data/ai-settings.json) during tests.
    env: { AI_SETTINGS_PATH: path.join(os.tmpdir(), "brody-vitest-ai-settings-unused.json") },
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Native SQLite and WASM grammars are shared process-wide; keep files isolated but run sequentially for stable timing.
    pool: "forks",
    fileParallelism: false,
  },
});
