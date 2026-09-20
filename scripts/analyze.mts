/**
 * Analyse a local directory from the command line and write the reports.
 *   npm run analyze -- ./path/to/project [--out ./out] [--name my-project]
 * Writes CODEBASE_REPORT.md, report.pdf, report.docx, report.html and report.json. Uses the same pipeline as the web app.
 */
import fs from "node:fs";
import path from "node:path";
import { getAIProvider } from "../src/lib/ai";
import { getDb, schema } from "../src/lib/db/client";
import { buildHtml, buildJson, buildMarkdown, exportFile } from "../src/lib/export";
import { readDirectory } from "../src/lib/ingest/fs";
import { normalizeFiles } from "../src/lib/ingest/normalize";
import { createProject } from "../src/lib/ingest/store";
import { enqueueAnalysis, getJob } from "../src/lib/jobs";
import { drainQueue } from "../src/lib/jobs/worker";
import { eq } from "drizzle-orm";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
if (!dir) { console.error("Usage: npm run analyze -- <directory> [--out <dir>] [--name <name>]"); process.exit(2); }
if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { console.error(`Not a directory: ${dir}`); process.exit(2); }

const out = path.resolve(opt("out") ?? ".");
const name = opt("name") ?? path.basename(path.resolve(dir));
console.log(`AI provider: ${getAIProvider() ? `${getAIProvider()!.name} (${getAIProvider()!.model})` : "none (deterministic analysis only)"}`);
const { files: raw, skippedLinks, pruned } = readDirectory(dir, { includeExcluded: args.includes("--include-excluded") });
for (const p of pruned) console.log(`Not read: ${p.path}/ (${p.files.toLocaleString()} files in a dependency or build directory; use --include-excluded to analyse it)`);
if (skippedLinks.length) console.log(`Skipped ${skippedLinks.length} symbolic link(s).`);
const { files, stats } = normalizeFiles(raw);
const { projectId } = createProject({ type: "folder", name }, files, stats);
const job = enqueueAnalysis(projectId);
await drainQueue();
const done = getJob(job.id)!;
for (const s of done.stages) console.log(`${s.status.padEnd(8)} ${String(s.startedAt && s.finishedAt ? s.finishedAt - s.startedAt : 0).padStart(6)}ms ${s.label}${s.detail ? ` — ${s.detail.slice(0, 110)}` : ""}`);
if (done.status !== "succeeded") { console.error(`\nAnalysis ${done.status}: ${done.error}`); process.exit(1); }
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "CODEBASE_REPORT.md"), buildMarkdown(projectId));
fs.writeFileSync(path.join(out, "report.html"), buildHtml(projectId));
fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(buildJson(projectId), null, 2));
for (const fmt of ["pdf", "docx"] as const) { const r = await exportFile(projectId, fmt, "full"); fs.writeFileSync(path.join(out, `report.${fmt}`), r.body as Buffer); }
const n = getDb().select().from(schema.findings).where(eq(schema.findings.projectId, projectId)).all().length;
console.log(`\nDone. ${n} findings. Reports written to ${out}`);
