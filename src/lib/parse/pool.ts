import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { config } from "../config";
import { runParseJob, type ParseJob, type ParseOutput } from "./run";
import type { WorkerReply, WorkerRequest } from "./worker";

/**
 * A pool of worker threads that parse files and run their per-file checks in parallel, off the main thread (so the web
 * server stays responsive during a long analysis). It degrades quietly: if no worker can be started, or one fails, the
 * affected files are parsed in-process with exactly the same code, so a result is never lost or different.
 */
export interface PoolInfo { mode: "workers" | "inline"; workers: number; reason?: string }

interface Task { id: number; owner: object; jobs: ParseJob[]; resolve: (o: ParseOutput[]) => void; reject: (e: Error) => void }
interface Slot { worker: Worker; task?: Task; timer?: NodeJS.Timeout }

const BATCH_JOBS = 24;
const BATCH_CHARS = 400_000;
const TASK_TIMEOUT_MS = 120_000;
const IDLE_MS = 60_000;

let slots: Slot[] = [];
let queue: Task[] = [];
let nextId = 1;
let failures = 0;
let idleTimer: NodeJS.Timeout | undefined;
let resolved: { file: string; execArgv: string[] } | null | undefined;
let wanted = 1; // workers worth having for the work in flight
let lastInfo: PoolInfo = { mode: "inline", workers: 0, reason: "not started" };

/** The compiled bundle if there is one (production), otherwise the TypeScript source run through tsx (development, tests). */
function resolveWorker(): { file: string; execArgv: string[] } | null {
  if (resolved !== undefined && !config.parse.workerPath) return resolved;
  const explicit = config.parse.workerPath;
  const roots = [process.cwd(), path.join(process.cwd(), "..")];
  // brody-ignore: sync-io  (a handful of existence checks, once per process)
  const bundle = explicit && fs.existsSync(explicit) ? explicit : roots.map((r) => path.join(r, "dist", "parse-worker.cjs")).find((c) => fs.existsSync(c));
  let out: { file: string; execArgv: string[] } | null = null;
  if (bundle) out = { file: bundle, execArgv: [] };
  else {
    const source = roots.map((r) => path.join(r, "src", "lib", "parse", "worker.ts")).find((c) => fs.existsSync(c)); // brody-ignore: sync-io
    // Whether tsx is installed, found on disk rather than through a module request that bundlers would try to follow.
    const tsx = roots.some((r) => fs.existsSync(path.join(r, "node_modules", "tsx", "package.json"))); // brody-ignore: sync-io
    if (source && tsx) out = { file: source, execArgv: ["--import", "tsx"] };
  }
  if (!explicit) resolved = out;
  return out;
}

function armIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (queue.length === 0 && slots.every((s) => !s.task)) void shutdownPool(); }, IDLE_MS);
  idleTimer.unref();
}

function spawn(): Slot | null {
  const target = resolveWorker();
  if (!target) return null;
  let worker: Worker;
  try { worker = new Worker(target.file, { execArgv: target.execArgv }); } catch { failures++; return null; }
  worker.unref(); // an idle pool never keeps the process alive
  const slot: Slot = { worker };
  worker.on("message", (reply: WorkerReply) => {
    const t = slot.task;
    if (!t || t.id !== reply.id) return;
    finish(slot);
    t.resolve(reply.outputs);
    pump();
  });
  const fail = (err: Error) => {
    const t = slot.task;
    slots = slots.filter((s) => s !== slot);
    if (slot.timer) clearTimeout(slot.timer);
    slot.task = undefined;
    failures++;
    if (t) t.reject(err);
    void worker.terminate().catch(() => undefined);
    pump();
  };
  worker.on("error", (e) => fail(e instanceof Error ? e : new Error(String(e))));
  worker.on("exit", (code) => { if (slots.includes(slot)) fail(new Error(`parse worker exited (${code})`)); });
  slots.push(slot);
  return slot;
}

function finish(slot: Slot) {
  if (slot.timer) clearTimeout(slot.timer);
  slot.timer = undefined;
  slot.task = undefined;
}

function pump() {
  while (queue.length) {
    let slot = slots.find((s) => !s.task);
    if (!slot && slots.length < Math.min(config.parse.workers, wanted) && failures < 3) slot = spawn() ?? undefined;
    if (!slot) break;
    const task = queue.shift()!;
    slot.task = task;
    slot.timer = setTimeout(() => { const s = slot!; if (s.task === task) { slots = slots.filter((x) => x !== s); task.reject(new Error("parse worker timed out")); void s.worker.terminate().catch(() => undefined); failures++; pump(); } }, TASK_TIMEOUT_MS);
    slot.timer.unref();
    slot.worker.postMessage({ id: task.id, jobs: task.jobs } satisfies WorkerRequest);
  }
  // Nothing is running and nothing can be started (the worker will not load, or kept failing): hand every waiting task back so
  // its files are parsed in-process instead of waiting for a worker that will never come.
  if (queue.length && slots.length === 0) {
    const stranded = queue;
    queue = [];
    for (const t of stranded) t.reject(new Error("no parse worker available"));
  }
  armIdle();
}

function batches(jobs: ParseJob[]): ParseJob[][] {
  const out: ParseJob[][] = [];
  let cur: ParseJob[] = [];
  let chars = 0;
  for (const j of jobs) {
    if (cur.length && (cur.length >= BATCH_JOBS || chars + j.source.length > BATCH_CHARS)) { out.push(cur); cur = []; chars = 0; }
    cur.push(j);
    chars += j.source.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Why work stays on the main thread, or undefined when workers are usable for this many files. */
export function inlineReason(fileCount: number): string | undefined {
  if (config.parse.workers <= 0) return "workers are switched off (PARSE_WORKERS=0)";
  // Workers that are already running cost nothing to start, so a small batch may use them; a cold pool is only worth it for a large one.
  if (fileCount < config.parse.minFiles && slots.length === 0) return `only ${fileCount} files to parse (workers start at ${config.parse.minFiles})`;
  if (failures >= 3) return "worker threads kept failing";
  if (!resolveWorker()) return "no worker bundle found (run npm run build:worker)";
  return undefined;
}

async function inline(jobs: ParseJob[], onDone?: (n: number) => void): Promise<ParseOutput[]> {
  const out: ParseOutput[] = [];
  for (const j of jobs) {
    out.push(await runParseJob(j));
    onDone?.(1);
    if (out.length % 25 === 0) await new Promise<void>((r) => setImmediate(r)); // keep the HTTP server responsive
  }
  return out;
}

/**
 * Parse many files, in parallel when workers are available. Outputs are in the same order as the jobs. `onProgress` is called
 * on the calling thread with the number of files finished so far; if it throws (for example to cancel the analysis), files
 * not yet started are dropped and the error is rethrown once the batches already running have returned.
 */
export async function parseMany(jobs: ParseJob[], opts: { onProgress?: (done: number) => void } = {}): Promise<ParseOutput[]> {
  if (jobs.length === 0) return [];
  const reason = inlineReason(jobs.length);
  let finished = 0;
  let abort: unknown;
  const report = (n: number) => {
    finished += n;
    if (abort !== undefined) return;
    try { opts.onProgress?.(finished); } catch (e) { abort = e ?? new Error("cancelled"); }
  };
  if (reason) {
    lastInfo = { mode: "inline", workers: 0, reason };
    const out = await inline(jobs, report);
    if (abort !== undefined) throw abort;
    return out;
  }
  const owner = {};
  const groups = batches(jobs);
  // About one worker per 150 files: each one costs a fraction of a second to start and a few hundred MB, so a mid-sized repository does not need all of them.
  wanted = Math.max(wanted, Math.ceil(jobs.length / 150));
  const results = await Promise.all(groups.map((g) => new Promise<ParseOutput[]>((resolve, reject) => { queue.push({ id: nextId++, owner, jobs: g, resolve, reject }); pump(); })
    .then((o) => {
      report(g.length);
      if (abort !== undefined) {
        // Cancelled: drop this call's waiting batches, settling them so nothing is left pending.
        const dropped = queue.filter((t) => t.owner === owner);
        queue = queue.filter((t) => t.owner !== owner);
        for (const t of dropped) t.resolve([]);
      }
      return o;
    })
    .catch(async () => { if (abort !== undefined) return [] as ParseOutput[]; const o = await inline(g); report(g.length); return o; })));
  if (abort !== undefined) throw abort;
  lastInfo = failures > 0 && slots.length === 0 ? { mode: "inline", workers: 0, reason: "worker threads failed; parsed in-process" } : { mode: "workers", workers: Math.min(config.parse.workers, Math.max(1, slots.length)) };
  return results.flat();
}

/** How the most recent parse was run, for the job's progress detail. */
export function poolInfo(): PoolInfo { return lastInfo; }

/** Stop every worker (idle timeout, tests). A later parse starts fresh ones. */
export async function shutdownPool(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  const stopping = slots;
  slots = [];
  wanted = 1;
  for (const s of stopping) { if (s.timer) clearTimeout(s.timer); s.task?.reject(new Error("pool shut down")); }
  await Promise.all(stopping.map((s) => s.worker.terminate().catch(() => undefined)));
}

/** Forget cached worker resolution and failure counts (tests that change the configuration). */
export function resetPool(): void {
  resolved = undefined;
  failures = 0;
}
