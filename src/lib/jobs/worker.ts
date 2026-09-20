import { claimNextJob, processJob, recoverStaleJobs } from "./index";

interface WorkerState { started?: boolean; busy?: boolean; timer?: NodeJS.Timeout }
const state: WorkerState = ((globalThis as unknown as { __brodyWorker?: WorkerState }).__brodyWorker ??= {});

/** Start the in-process job loop. Safe to call more than once. */
export function startWorker(pollMs = 1500): void {
  if (state.started) return;
  state.started = true;
  const tick = async () => {
    if (state.busy) return;
    state.busy = true;
    try {
      recoverStaleJobs();
      let job = claimNextJob();
      while (job) {
        await processJob(job.id);
        job = claimNextJob();
      }
    } catch (e) {
      console.error("[brody] worker error", e);
    } finally {
      state.busy = false;
    }
  };
  state.timer = setInterval(tick, pollMs);
  state.timer.unref?.();
  void tick();
}

export function stopWorker(): void {
  if (state.timer) clearInterval(state.timer);
  state.started = false;
}

/** Run queued jobs in the foreground until the queue is empty (used by tests and the CLI). */
export async function drainQueue(): Promise<number> {
  let n = 0;
  let job = claimNextJob();
  while (job) {
    await processJob(job.id);
    n++;
    job = claimNextJob();
  }
  return n;
}
