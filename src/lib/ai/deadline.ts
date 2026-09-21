/** Settle within `ms` or fail with a timeout, whatever the underlying request is doing. */
export function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s.`)), ms); timer.unref?.(); });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}
