/** Start the in-process analysis worker when the Node.js server boots. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.EMBEDDED_WORKER !== "off") {
    const { startWorker } = await import("./lib/jobs/worker");
    startWorker();
  }
}
