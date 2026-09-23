import fs from "node:fs";
import path from "node:path";
import { openDatabase, closeDatabase, getDb, schema } from "@/lib/db/client";
import { recordUsage, setAIProvider } from "@/lib/ai";
import type { AIProvider, AnalysisRequest, AnalysisResult } from "@/lib/ai";
import { normalizeFiles } from "@/lib/ingest/normalize";
import { createProject } from "@/lib/ingest/store";
import { enqueueAnalysis, getJob } from "@/lib/jobs";
import { drainQueue } from "@/lib/jobs/worker";
import { eq } from "drizzle-orm";

export function freshDb(): void {
  closeDatabase();
  openDatabase(":memory:");
  setAIProvider(null);
}

export function fixtureFiles(dir = "fixtures/sample-shop"): { path: string; content: Buffer }[] {
  const root = path.resolve(dir);
  const out: { path: string; content: Buffer }[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) out.push({ path: path.relative(root, abs).split(path.sep).join("/"), content: fs.readFileSync(abs) });
    }
  };
  walk(root);
  return out;
}

export function fromStrings(files: Record<string, string>): { path: string; content: Buffer }[] {
  return Object.entries(files).map(([p, c]) => ({ path: p, content: Buffer.from(c) }));
}

/** Create a project from in-memory files, run the full pipeline, and return ids. */
export async function analyze(files: { path: string; content: Buffer }[], name = "test-project") {
  const { files: nf, stats } = normalizeFiles(files);
  const { projectId, incremental } = createProject({ type: "folder", name }, nf, stats);
  const job = enqueueAnalysis(projectId);
  await drainQueue();
  const done = getJob(job.id)!;
  const project = getDb().select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()!;
  return { projectId, jobId: job.id, job: done, project, incremental };
}

export interface RecordedCall { task: string; system: string; prompt: string }

/** Scripted provider: returns data derived from the real prompt so evidence points at real lines. */
export class MockProvider implements AIProvider {
  readonly name: string;
  readonly model: string;
  calls: RecordedCall[] = [];
  /** `as` lets a test pose as a real provider and model so usage is priced; by default it is an unpriced "mock". */
  constructor(private script: (req: AnalysisRequest<unknown>) => unknown | undefined | Promise<unknown | undefined>, as: { provider?: string; model?: string } = {}) {
    this.name = as.provider ?? "mock";
    this.model = as.model ?? "mock-model";
  }
  async analyze<T>(request: AnalysisRequest<T>): Promise<AnalysisResult<T>> {
    this.calls.push({ task: request.task, system: request.system, prompt: request.prompt });
    const raw = await this.script(request as AnalysisRequest<unknown>);
    // Like the real providers, report what the call would be billed for (1 token per 4 prompt characters, 100 out).
    const usage = { inputTokens: Math.ceil(request.prompt.length / 4), outputTokens: 100, calls: 1 };
    recordUsage({ provider: this.name, model: this.model, task: request.task, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
    if (raw === undefined) throw new Error(`mock has no script for ${request.task}`);
    const parsed = request.schema.parse(raw);
    return { data: parsed, model: this.model, provider: this.name, usage };
  }
}

/** Find `NN: text` numbered evidence lines in a prompt, returning the first line containing `needle`. */
export function findPromptLine(prompt: string, needle: string): { path: string; line: number; text: string } | undefined {
  const blocks = prompt.split(/<file path="/).slice(1);
  for (const b of blocks) {
    const p = b.slice(0, b.indexOf('"'));
    for (const l of b.split("\n")) {
      const m = l.match(/^(\d+): (.*)$/);
      if (m && m[2].includes(needle)) return { path: p, line: Number(m[1]), text: m[2] };
    }
  }
  return undefined;
}

export { setAIProvider };
