import { parentPort } from "node:worker_threads";
import { runParseJob, type ParseJob, type ParseOutput } from "./run";

/**
 * Worker-thread entry. It is bundled to dist/parse-worker.cjs by tools/build-worker.mjs (and run from source under tsx in
 * development). It imports nothing from the database or the web framework: only the parser, the extractors and the checks.
 */
export interface WorkerRequest { id: number; jobs: ParseJob[] }
export interface WorkerReply { id: number; outputs: ParseOutput[] }

if (!parentPort) throw new Error("parse worker must run inside a worker thread");
const port = parentPort;
port.on("message", async (req: WorkerRequest) => {
  const outputs: ParseOutput[] = [];
  for (const job of req.jobs) outputs.push(await runParseJob(job));
  port.postMessage({ id: req.id, outputs } satisfies WorkerReply);
});
