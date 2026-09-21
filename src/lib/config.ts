/**
 * Central runtime configuration. Every tunable comes from the environment so
 * the same build can be deployed with different limits and providers.
 */
import os from "node:os";
import path from "node:path";

/** Worker threads that fit this machine: spare cores, capped at 4, and only as many as memory allows (cgroup limit aware). */
function defaultParseWorkers(): number {
  const limit = (process as { constrainedMemory?: () => number }).constrainedMemory?.() || Infinity;
  const memory = Math.min(os.totalmem(), limit);
  const byMemory = Math.floor((memory * 0.8 - 1.5 * 1024 ** 3) / (300 * 1024 ** 2));
  return Math.max(0, Math.min(4, os.availableParallelism() - 1, byMemory));
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  databasePath: process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "brody.db"),
  limits: {
    /** Maximum number of files accepted for a single project. */
    maxFiles: int("MAX_FILES", 20000),
    /** Maximum total uncompressed bytes accepted for a single project. */
    maxTotalBytes: int("MAX_TOTAL_BYTES", 300 * 1024 * 1024),
    /** Files larger than this are stored as metadata only (no content). */
    maxFileBytes: int("MAX_FILE_BYTES", 2 * 1024 * 1024),
    /** Files larger than this are flagged as unusually large. */
    largeFileBytes: int("LARGE_FILE_BYTES", 300 * 1024),
    /** Maximum ZIP entries processed. */
    maxZipEntries: int("MAX_ZIP_ENTRIES", 50000),
    /** Maximum compression ratio for any ZIP entry before it is treated as a bomb. */
    maxZipRatio: int("MAX_ZIP_RATIO", 200),
    /** Maximum request body for uploads. */
    maxUploadBytes: int("MAX_UPLOAD_BYTES", 200 * 1024 * 1024),
  },
  ai: {
    provider: (process.env.AI_PROVIDER ?? "auto") as "auto" | "anthropic" | "openai-compatible" | "none",
    /**
     * Per-provider model overrides from the environment. AI_MODEL is the legacy single setting and
     * applies only to whichever provider the environment selects, so a Claude model ID is never
     * sent to an OpenAI endpoint (or the reverse).
     */
    anthropicModel: process.env.ANTHROPIC_MODEL,
    openaiModel: process.env.OPENAI_MODEL,
    legacyModel: process.env.AI_MODEL,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    /** Required by API keys that are not scoped to one workspace. Sent as the anthropic-workspace-id header. */
    anthropicWorkspaceId: process.env.ANTHROPIC_WORKSPACE_ID,
    openaiBaseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    openaiApiKey: process.env.OPENAI_API_KEY,
    embeddingModel: process.env.AI_EMBEDDING_MODEL,
    /** Maximum concurrent model calls. */
    concurrency: int("AI_CONCURRENCY", 3),
    /** Maximum files that receive an individual AI explanation. */
    maxFilesExplained: int("AI_MAX_FILES_EXPLAINED", 80),
    /** Maximum folders that receive an AI explanation of how their files work together. */
    maxModulesExplained: int("AI_MAX_MODULES_EXPLAINED", 24),
    /** Maximum symbols that receive an individual AI explanation. */
    maxSymbolsExplained: int("AI_MAX_SYMBOLS_EXPLAINED", 160),
    /** Maximum files included in AI review passes. */
    maxFilesReviewed: int("AI_MAX_FILES_REVIEWED", 60),
    /** Maximum findings sent to the AI verification pass. */
    maxFindingsVerified: int("AI_MAX_FINDINGS_VERIFIED", 40),
    /** Rough character budget per model request. */
    contextCharBudget: int("AI_CONTEXT_CHAR_BUDGET", 60000),
  },
  github: {
    /** Server-side token used when the user supplies none. Never logged. */
    token: process.env.GITHUB_TOKEN,
    apiBase: process.env.GITHUB_API_BASE ?? "https://api.github.com",
  },
  /**
   * Parsing (and the per-file static checks that go with it) runs on worker threads. PARSE_WORKERS sets how many; 0 keeps
   * everything on the main thread. The default leaves one core for the web server, caps at 4, and also fits the memory
   * available (each worker holds its own copy of the grammars, TypeScript and ESLint, about 300 MB). Analyses with fewer than
   * PARSE_WORKER_MIN_FILES files to parse stay in-process: starting workers costs about a second, which only pays off on
   * larger repositories.
   */
  parse: {
    workers: process.env.PARSE_WORKERS !== undefined && process.env.PARSE_WORKERS !== "" ? Math.max(0, Math.floor(Number(process.env.PARSE_WORKERS)) || 0) : defaultParseWorkers(),
    minFiles: Number(process.env.PARSE_WORKER_MIN_FILES) || 400,
    workerPath: process.env.BRODY_PARSE_WORKER || undefined,
  },
  staticAnalysis: {
    enabled: process.env.STATIC_ANALYSIS !== "off",
    ruffPath: process.env.RUFF_PATH ?? "ruff",
    pythonPath: process.env.PYTHON_PATH ?? "python3",
    goPath: process.env.GO_PATH ?? "go",
  },
  /** Secret used to encrypt stored GitHub credentials at rest. */
  credentialSecret: process.env.CREDENTIAL_SECRET,
};

export type AppConfig = typeof config;
