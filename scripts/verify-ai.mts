import { eq } from "drizzle-orm";
import { getAIProvider, providerStatus } from "../src/lib/ai";
import { closeDatabase, getDb, openDatabase, schema } from "../src/lib/db/client";
import { readDirectory } from "../src/lib/ingest/fs";
import { normalizeFiles } from "../src/lib/ingest/normalize";
import { createProject } from "../src/lib/ingest/store";
import { enqueueAnalysis, getJob } from "../src/lib/jobs";
import { drainQueue } from "../src/lib/jobs/worker";
import type { DocReport } from "../src/lib/docs/types";
import { askRepository } from "../src/lib/ask";

/**
 * Live check of the configured AI provider against the sample repository.
 * Usage: npm run verify:ai   (reads .env; prints results, exits non-zero if AI did not run)
 * Makes real, billable API calls (roughly 20-30 requests on the small fixture).
 */
openDatabase(":memory:");
console.log("provider:", JSON.stringify(providerStatus()), "instance:", getAIProvider()?.name);
const { files: raw } = readDirectory(new URL("../fixtures/sample-shop", import.meta.url).pathname);
const { files, stats } = normalizeFiles(raw);
const { projectId } = createProject({ type: "folder", name: "sample-shop" }, files, stats);
const job = enqueueAnalysis(projectId);
const t0 = Date.now();
await drainQueue();
const j = getJob(job.id)!;
console.log("status:", j.status, "error:", j.error, "elapsed:", Math.round((Date.now() - t0) / 1000) + "s");
for (const s of j.stages) console.log(" ", s.status.padEnd(7), s.label, "-", (s.detail ?? "").slice(0, 140));
const sum = j.summary as { usage: unknown; aiFailures: { task: string; error: string }[]; ai: { passes: unknown[] } } | null;
console.log("usage:", JSON.stringify(sum?.usage), "failures:", JSON.stringify(sum?.aiFailures?.slice(0, 4)));
console.log("passes:", JSON.stringify(sum?.ai?.passes));
const live = (j.summary as { aiUsage?: { calls: number; inputTokens: number; outputTokens: number; costUsd: number | null; models: { model: string; calls: number; costUsd: number | null; priceBasis: string }[]; stages: { label: string; calls: number; costUsd: number | null }[] } } | null)?.aiUsage;
console.log("ai usage:", live ? `${live.calls} requests, ${live.inputTokens} in / ${live.outputTokens} out, cost ${live.costUsd === null ? "n/a" : `$${live.costUsd.toFixed(4)}`}` : "not recorded");
for (const m of live?.models ?? []) console.log(`  model ${m.model}: ${m.calls} requests, ${m.costUsd === null ? "n/a" : `$${m.costUsd.toFixed(4)}`} (${m.priceBasis})`);
for (const st of live?.stages ?? []) console.log(`  step ${st.label}: ${st.calls} requests, ${st.costUsd === null ? "n/a" : `$${st.costUsd.toFixed(4)}`}`);
const formal = (getDb().select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()!.analysis as { formal?: { status: string; reason?: string; lean?: string; totals: Record<string, number>; targets: { symbol: string; filePath: string; status: string; note: string; rounds: number; properties: { theorem: string; intent: string; outcome: string; claim: string; witness: string; errors: string[] }[] }[] } }).formal;
console.log("\nFORMAL", formal?.status, formal?.reason ?? "", formal?.lean ?? "", JSON.stringify(formal?.totals ?? {}));
for (const t of formal?.targets ?? []) {
  console.log(`- ${t.symbol} (${t.filePath}) ${t.status}, ${t.rounds} round(s)${t.note ? `: ${t.note.slice(0, 160)}` : ""}`);
  for (const p of t.properties) console.log(`    ${p.outcome.padEnd(14)} [${p.intent}] ${p.theorem}: ${p.claim.slice(0, 140)}${p.witness ? ` | witness: ${p.witness.slice(0, 100)}` : ""}${p.errors.length ? ` | lean: ${p.errors[0].slice(0, 120).replace(/\n/g, " ")}` : ""}`);
}
const findings = getDb().select().from(schema.findings).where(eq(schema.findings.projectId, projectId)).all();
console.log("\nFINDINGS", findings.length, "ai:", findings.filter((f) => f.origin === "ai").length);
for (const f of findings.filter((x) => x.origin === "ai" || (x.verificationNote ?? "").includes("AI"))) console.log(`- ${f.code} [${f.severity}/${f.confidence}/${f.verification}] ${f.origin} ${f.filePath}:${f.startLine} ${f.title}\n    note: ${(f.verificationNote ?? "").slice(0, 220)}${f.patch ? "\n    PATCH: yes" : ""}`);
const docs = (getDb().select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()!.analysis as { docs: DocReport }).docs;
console.log("\nDOCS aiUsed:", docs.meta.aiUsed, "aiSections:", docs.meta.aiSections, "dropped:", docs.meta.droppedUngrounded, "conflicts:", docs.conflicts.length);
console.log("EXEC SUMMARY:"); for (const s of docs.executiveSummary) console.log(" *", s.origin, s.text.slice(0, 400), JSON.stringify(s.evidence));
const sym = docs.symbols.find((s) => s.name === "createOrder")!;
console.log("\nSYMBOL createOrder:", JSON.stringify({ origin: sym.origin, purpose: sym.purpose, process: sym.process, business: sym.businessMeaning, behavior: sym.importantBehavior, evidence: sym.evidence }, null, 1));
const fl = docs.files.find((f) => f.path === "src/services/paymentService.ts")!;
console.log("FILE paymentService:", JSON.stringify({ origin: fl.origin, purpose: fl.purpose, notes: fl.engineeringNotes }, null, 1));
const mod = docs.modules?.find((m) => m.path === "src/services");
console.log("\nFOLDER src/services (group of files):", JSON.stringify({ origin: mod?.origin, purpose: mod?.purpose, howFilesWork: mod?.howFilesWork, keyFiles: mod?.keyFiles, evidence: mod?.evidence }, null, 1));
console.log("FILE vs FOLDER separation: file purpose =", JSON.stringify(fl.purpose.slice(0, 200)), "| folder text =", JSON.stringify((mod?.howFilesWork ?? "").slice(0, 200)));
console.log("AREA sample:", JSON.stringify(docs.areas.find((a) => a.origin === "ai") ?? null, null, 1).slice(0, 700));
console.log("notes:", docs.meta.notes);
const a = await askRepository(projectId, "How does the application handle a failed Stripe payment?");
console.log("\nASK mode:", a.mode, "conf:", a.confidence, "insufficient:", a.insufficientEvidence, "\n", a.answer, "\ncites:", a.citations.map((c) => `${c.path}:${c.startLine}-${c.endLine}`), "\nnotes:", a.notes, a.usage);
closeDatabase();
const aiFindings = findings.filter((f) => f.origin === "ai").length;
if (mod?.origin !== "ai") { console.error("\nAI verification FAILED: the folder-level explanation was not written by the AI."); process.exit(1); }
if (!docs.meta.aiUsed || (sum?.aiFailures?.length ?? 0) > 0) { console.error("\nAI verification FAILED: the provider did not complete all requests (see failures above)."); process.exit(1); }
console.log(`\nAI verification passed: ${aiFindings} AI-origin findings, documentation written by ${docs.meta.model}.`);
