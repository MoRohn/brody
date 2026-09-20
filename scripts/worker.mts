/** Standalone analysis worker. Run with EMBEDDED_WORKER=off on the web server: `npm run worker`. */
import { startWorker } from "../src/lib/jobs/worker";

startWorker(1000);
console.log("[brody] worker started; polling for analysis jobs");
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
setInterval(() => undefined, 1 << 30);
