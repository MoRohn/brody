import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { guard, json } from "@/lib/api";
import { checkProvider, providerStatus } from "@/lib/ai";
import { resolveEmbeddingModel } from "@/lib/ai/settings";
import { config } from "@/lib/config";
import { runtimeKind } from "@/lib/runtime";

export const dynamic = "force-dynamic";
const run = promisify(execFile);

async function has(cmd: string, args: string[] = ["--version"]): Promise<boolean> {
  try {
    await run(cmd, args, { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

let cached: { at: number; value: Record<string, boolean> } | undefined;

/** Analyzer availability is probed asynchronously and cached for a minute so the event loop is never blocked. */
async function analyzers() {
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  const [python, ruff, gofmt] = await Promise.all([has(config.staticAnalysis.pythonPath), has(config.staticAnalysis.ruffPath), has(config.staticAnalysis.goPath.replace(/go$/, "gofmt"), ["-h"])]);
  const value = { python, ruff, gofmt, enabled: config.staticAnalysis.enabled };
  cached = { at: Date.now(), value };
  return value;
}

export async function GET(req: Request) {
  const check = new URL(req.url).searchParams.get("check");
  const ai = check ? await checkProvider(check === "force") : providerStatus();
  return guard(async () => json({
    ai,
    runtime: runtimeKind(),
    embeddings: !!resolveEmbeddingModel(),
    github: { serverToken: !!config.github.token },
    limits: config.limits,
    analyzers: await analyzers(),
  }));
}
