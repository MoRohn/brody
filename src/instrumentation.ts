/**
 * When the Node.js server boots: start the in-process job worker, and check the explainer tools (FFmpeg, Manim),
 * installing Manim in the background when it is missing and can be installed (src/lib/explainer/setup.ts).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.EMBEDDED_WORKER !== "off") {
    const { startWorker } = await import("./lib/jobs/worker");
    startWorker();
    // Rendering happens in the worker, so the tools are checked where it runs (npm run worker does the same).
    const { ensureExplainerTools } = await import("./lib/explainer/setup");
    ensureExplainerTools();
  }
}
