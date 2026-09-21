import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.E2E_PORT ?? 3211);
const dbPath = path.join(os.tmpdir(), `brody-e2e-${process.pid}.db`);

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Uses installed Google Chrome by default; set PW_CHANNEL= (empty) to use Playwright's bundled Chromium.
    channel: process.env.PW_CHANNEL === undefined ? "chrome" : process.env.PW_CHANNEL || undefined,
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: "npm run start",
    url: `http://localhost:${PORT}/api/status`,
    reuseExistingServer: false,
    timeout: 60_000,
    // PARSE_WORKER_MIN_FILES=1 makes even the tiny fixtures run on worker threads, so the production server (and dist/parse-worker.cjs) is exercised.
    env: { PORT: String(PORT), PARSE_WORKERS: "2", PARSE_WORKER_MIN_FILES: "1", ALLOWED_HOSTS: "", DATABASE_PATH: dbPath, AI_PROVIDER: "none", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", OPENAI_BASE_URL: `http://127.0.0.1:${process.env.E2E_MOCK_AI_PORT ?? 4599}/v1` },
  },
});
