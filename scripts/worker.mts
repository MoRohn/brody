/** Standalone analysis worker. Run with EMBEDDED_WORKER=off on the web server: `npm run worker`. */
import { ensureExplainerTools } from "../src/lib/explainer/setup";
import { startWorker } from "../src/lib/jobs/worker";

startWorker(1000);
console.log("[brody] worker started; polling for analysis and explainer jobs");
// Explainer videos render here: check FFmpeg and Manim, installing Manim in the background if it is missing.
const tools = ensureExplainerTools();
console.log(`[brody] explainer tools: ${tools.run ? "checking (Manim is installed automatically if missing)" : `no automatic setup (${tools.reason})`}`);
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
setInterval(() => undefined, 1 << 30);
