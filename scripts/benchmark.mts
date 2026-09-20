/**
 * Pipeline benchmark on synthetic repositories.
 *   npm run benchmark -- 200 1000 3000        (file counts; default 200 1000)
 * Prints per-stage timings, peak memory, database size and export times.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDatabase, openDatabase } from "../src/lib/db/client";
import { exportFile, buildMarkdown } from "../src/lib/export";
import { normalizeFiles } from "../src/lib/ingest/normalize";
import { createProject } from "../src/lib/ingest/store";
import { enqueueAnalysis, getJob } from "../src/lib/jobs";
import { drainQueue } from "../src/lib/jobs/worker";
import { search } from "../src/lib/retrieval";
import { changeImpact, loadModel, moduleGraph, areaGraph } from "../src/lib/map";
import { askRepository } from "../src/lib/ask";

function synth(n: number): { path: string; content: Buffer }[] {
  const files: { path: string; content: Buffer }[] = [];
  const mods = Math.max(4, Math.round(Math.sqrt(n)));
  const perMod = Math.ceil(n / mods);
  for (let m = 0; m < mods; m++) {
    for (let i = 0; i < perMod && files.length < n; i++) {
      const imports = [];
      for (let k = 1; k <= 3; k++) { const tm = (m + k) % mods; const ti = (i * 7 + k) % perMod; imports.push(`import { fn_${tm}_${ti} } from "../mod${tm}/file${ti}";`); }
      const fns = Array.from({ length: 6 }, (_, f) => `/** Function ${f} of file ${i} in module ${m}. */\nexport function ${f === 0 ? `fn_${m}_${i}` : `helper_${m}_${i}_${f}`}(x: number): number {\n  if (x > ${f}) { return ${f === 0 ? `fn_${(m + 1) % mods}_${(i * 7 + 1) % perMod}(x - 1)` : `helper_${m}_${i}_${f - 1}(x)`} + 1; }\n  return x * ${f + 1};\n}`).join("\n\n");
      const body = `${imports.join("\n")}\n\nexport interface Rec${i} { id: number; name: string }\n\n${fns}\n\nexport class Service${m}_${i} {\n  run(v: number) { return fn_${m}_${i}(v) + helper_${m}_${i}_1(v); }\n}\n`;
      files.push({ path: `src/mod${m}/file${i}.ts`, content: Buffer.from(body) });
      if (i % 10 === 0) files.push({ path: `tests/mod${m}/file${i}.test.ts`, content: Buffer.from(`import { fn_${m}_${i} } from "../../src/mod${m}/file${i}";\nit("works", () => { expect(fn_${m}_${i}(1)).toBeGreaterThan(0); });\n`) });
    }
  }
  files.push({ path: "package.json", content: Buffer.from(JSON.stringify({ name: "synthetic", dependencies: { express: "4" } })) });
  return files;
}

const sizes = process.argv.slice(2).map(Number).filter(Boolean);
if (sizes.length === 0) sizes.push(200, 1000);
const ms = (t: number) => `${Math.round(t)}ms`.padStart(8);
const rss = () => Math.round(process.memoryUsage().rss / 1024 / 1024);

for (const n of sizes) {
  const dbPath = path.join(os.tmpdir(), `bench-${n}-${process.pid}.db`);
  closeDatabase();
  openDatabase(dbPath);
  const raw = synth(n);
  const t0 = performance.now();
  const { files, stats } = normalizeFiles(raw);
  const tNorm = performance.now() - t0;
  const t1 = performance.now();
  const { projectId } = createProject({ type: "folder", name: `synthetic-${n}` }, files, stats);
  const tStore = performance.now() - t1;
  const job = enqueueAnalysis(projectId);
  const t2 = performance.now();
  await drainQueue();
  const tPipe = performance.now() - t2;
  const j = getJob(job.id)!;
  if (j.status !== "succeeded") { console.error(`n=${n}: ${j.status} ${j.error}`); continue; }
  const lines = files.reduce((a, f) => a + f.lines, 0);
  console.log(`\n=== ${n} source files (${files.length} total, ${lines.toLocaleString()} lines) ===`);
  console.log(`normalize ${ms(tNorm)}   store ${ms(tStore)}   pipeline ${ms(tPipe)}   rss ${rss()} MB   db ${(fs.statSync(dbPath).size / 1024 / 1024).toFixed(1)} MB`);
  for (const s of j.stages) console.log(`  ${s.label.padEnd(42)} ${ms(s.startedAt && s.finishedAt ? s.finishedAt - s.startedAt : 0)}  ${(s.detail ?? "").slice(0, 70)}`);
  const time = async (label: string, fn: () => unknown | Promise<unknown>) => { const s = performance.now(); await fn(); console.log(`  ${label.padEnd(42)} ${ms(performance.now() - s)}`); };
  console.log("  -- interactive operations --");
  await time("loadModel (cold)", () => loadModel(projectId));
  await time("areaGraph", () => areaGraph(projectId));
  await time("moduleGraph (top 60)", () => moduleGraph(projectId, { limit: 60 }));
  const sym = loadModel(projectId).symbols.find((s) => s.name.startsWith("fn_1_"))!;
  await time("changeImpact (symbol)", () => changeImpact(projectId, { type: "symbol", id: sym.id }));
  await time("search (cold index)", () => search(projectId, "helper service run", { includeCode: true }));
  await time("search (warm)", () => search(projectId, "fn_2_3", { includeCode: true }));
  await time("ask (graph)", () => askRepository(projectId, `Which components depend on ${sym.name}?`));
  await time("markdown report", () => buildMarkdown(projectId));
  await time("PDF (full)", async () => { const r = await exportFile(projectId, "pdf", "full"); console.log(`     -> ${((r.body as Buffer).length / 1024).toFixed(0)} KB`); });
  await time("DOCX (full)", async () => { const r = await exportFile(projectId, "docx", "full"); console.log(`     -> ${((r.body as Buffer).length / 1024).toFixed(0)} KB`); });
  console.log(`  peak rss ${rss()} MB`);
  closeDatabase();
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });
}
