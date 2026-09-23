/**
 * Rebuild the parse worker bundle before the suite runs. The worker threads load dist/parse-worker.cjs, so a bundle left
 * over from before a source change would make worker results differ from in-process results (tests/workers.test.ts)
 * and hide that change from every pipeline test that parses on workers. Building takes well under a second.
 */
export default async function setup(): Promise<void> {
  const { buildWorker } = await import("../tools/build-worker.mjs");
  await buildWorker();
}
