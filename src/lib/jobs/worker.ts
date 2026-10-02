import { claimNextVideoJob, processVideoJob, recoverStaleVideoJobs } from "../explainer/pipeline";
import { claimNextJob, processJob, recoverStaleJobs } from "./index";

interface WorkerState { started?: boolean; busy?: boolean; videoBusy?: boolean; timer?: NodeJS.Timeout }
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
  // Explainer videos run in their own loop, so a long analysis never holds up a video and a render never holds up analysis.
  const videoTick = async () => {
    if (state.videoBusy) return;
    state.videoBusy = true;
    try {
      recoverStaleVideoJobs();
      let job = claimNextVideoJob();
      while (job) {
        await processVideoJob(job.id);
        job = claimNextVideoJob();
      }
    } catch (e) {
      console.error("[brody] explainer worker error", e);
    } finally {
      state.videoBusy = false;
    }
  };
  state.timer = setInterval(() => { void tick(); void videoTick(); }, pollMs);
  state.timer.unref?.();
  void tick();
  void videoTick();
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

/** Run queued explainer jobs in the foreground until none is left (tests and the CLI). */
export async function drainVideoQueue(): Promise<number> {
  let n = 0;
  let job = claimNextVideoJob();
  while (job) {
    await processVideoJob(job.id);
    n++;
    job = claimNextVideoJob();
  }
  return n;
}
