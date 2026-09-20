import { z } from "zod";
import { config } from "../config";
import type { RelationshipRow, SymbolRow } from "../db/schema";
import type { LoadedFile } from "../graph/build";
import { renderEvidence, SAFETY_PREAMBLE, tryAnalyze, untrusted, UsageMeter, type AIProvider } from "../ai";
import { retrieveContext } from "../retrieval";
import { mapLimit } from "../util/concurrency";
import { FILE_CACHED_FIELDS, MODULE_CACHED_FIELDS, SYMBOL_CACHED_FIELDS, fileExplainKey, getExplain, moduleExplainKey, pick, putExplain, symbolExplainKey } from "./cache";
import { sliceLines } from "../util/text";
import type { DocInputs } from "./deterministic";
import { readmeSummary } from "./deterministic";
import type { AreaDoc, ConflictRecord, DocReport, ExecutiveBrief, FileDoc, FlowDoc, ModuleDoc, Statement, SymbolDoc } from "./types";
import { pushAll } from "../util/arrays";

const Ev = z.array(z.string());
const StatementSchema = z.object({ text: z.string(), evidence: Ev });

const SymbolBatchSchema = z.object({ items: z.array(z.object({ index: z.number(), purpose: z.string(), inputs: z.string(), process: z.string(), outputs: z.string(), dependencies: z.array(z.string()), businessMeaning: z.string(), importantBehavior: z.string(), evidence: Ev })) });
const FileBatchSchema = z.object({ items: z.array(z.object({ path: z.string(), purpose: z.string(), responsibilities: z.array(z.string()), howItOperates: z.string(), dataIn: z.string(), dataOut: z.string(), engineeringNotes: z.array(z.string()), evidence: Ev })) });
const AreaSchema = z.object({ purpose: z.string(), businessFunction: z.string(), inputs: z.string(), processing: z.string(), outputs: z.string(), failureModes: z.array(z.string()), relationships: z.string(), evidence: Ev });
const ModuleSchema = z.object({ purpose: z.string(), howFilesWork: z.string(), dataIn: z.string(), dataOut: z.string(), keyFileNotes: z.array(z.object({ path: z.string(), why: z.string() })), evidence: Ev });
const BriefSchema = z.object({
  headline: z.string(),
  summary: z.string(),
  audience: z.string(),
  keyPoints: z.array(z.object({ title: z.string(), detail: z.string() })),
  capabilities: z.array(z.string()),
  health: z.object({ verdict: z.string(), strengths: z.array(z.string()), concerns: z.array(z.string()) }),
  nextSteps: z.array(z.object({ action: z.string(), why: z.string(), priority: z.string() })),
});
const SynthesisSchema = z.object({
  executiveSummary: z.array(StatementSchema),
  architectureOverview: z.array(StatementSchema),
  runtimeFlowNarrative: z.array(StatementSchema),
  runtimeFlowSteps: z.array(z.object({ label: z.string(), detail: z.string(), evidence: Ev })),
  flowNarratives: z.array(z.object({ flowName: z.string(), narrative: z.string(), evidence: Ev })),
  apiArchitecture: z.array(StatementSchema),
  dataArchitecture: z.array(StatementSchema),
  securityModel: z.array(StatementSchema),
  engineeringRisks: z.array(StatementSchema),
  strengths: z.array(StatementSchema),
  recommendations: z.array(StatementSchema),
  conflicts: z.array(z.object({ subject: z.string(), claims: z.array(z.string()) })),
});
const ResolveSchema = z.object({ resolution: z.string(), supportedClaimIndex: z.number(), evidence: Ev });

/** Parse "path:12-30" style citations and keep only those that point at real lines. */
export function validateEvidence(evidence: string[], filesByPath: Map<string, LoadedFile>): { valid: string[]; dropped: number } {
  const valid: string[] = [];
  let dropped = 0;
  for (const e of evidence) {
    const m = e.trim().match(/^(.+?):(\d+)(?:-(\d+))?$/) ?? e.trim().match(/^(.+)$/);
    if (!m) { dropped++; continue; }
    const path = m[1].trim();
    const f = filesByPath.get(path);
    if (!f) { dropped++; continue; }
    const a = m[2] ? Number(m[2]) : undefined;
    const b = m[3] ? Number(m[3]) : a;
    if (a !== undefined && (a < 1 || a > Math.max(1, f.lines) || (b !== undefined && b < a))) { dropped++; continue; }
    valid.push(a === undefined ? path : `${path}:${a}${b && b !== a ? `-${Math.min(b, f.lines)}` : ""}`);
  }
  return { valid, dropped };
}

/** Wrap the <<FACTS>>…<</FACTS>> section of a prompt in the untrusted block (all facts derive from repository content). */
function wrapFacts(prompt: string): string {
  return prompt.replace(/<<FACTS>>([\s\S]*?)<<\/FACTS>>/g, (_m, body: string) => untrusted(body));
}

export interface AiDocOptions {
  provider: AIProvider;
  meter: UsageMeter;
  inputs: DocInputs;
  report: DocReport;
  projectId: string;
  onProgress?: (msg: string) => void;
  isCancelled?: () => boolean;
}

export async function enhanceWithAI(opts: AiDocOptions): Promise<DocReport> {
  const { provider, meter, inputs, projectId } = opts;
  const report = opts.report;
  const filesByPath = new Map(inputs.files.map((f) => [f.path, f]));
  const symbolsById = new Map(inputs.symbols.map((s) => [s.id, s]));
  let dropped = 0;
  let aiSections = 0;
  const ground = (statements: { text: string; evidence: string[] }[], fallbackEvidence: string[] = []): Statement[] => {
    const out: Statement[] = [];
    for (const s of statements) {
      const v = validateEvidence(s.evidence, filesByPath);
      dropped += v.dropped;
      if (!s.text.trim()) continue;
      // A statement with no verifiable evidence is not presented as established fact.
      if (v.valid.length === 0 && fallbackEvidence.length === 0) { dropped++; continue; }
      out.push({ text: s.text.trim(), evidence: v.valid.length ? v.valid : fallbackEvidence, origin: "ai" });
    }
    return out;
  };

  const budget = config.ai.contextCharBudget;

  // ---- Level 1: symbols ----------------------------------------------------
  let reused = 0;
  const symbolTargets: SymbolDoc[] = [];
  for (const s of report.symbols.slice(0, config.ai.maxSymbolsExplained)) {
    const cached = getExplain<Record<string, unknown>>(symbolExplainKey(provider.model, s, filesByPath));
    if (cached) { Object.assign(s, cached, { origin: "ai" }); reused++; } else symbolTargets.push(s);
  }
  const symBatches: SymbolDoc[][] = [];
  { let cur: SymbolDoc[] = []; let used = 0; for (const s of symbolTargets) { const size = Math.min(4500, (s.endLine - s.startLine + 1) * 60) + 500; if (cur.length && (used + size > budget || cur.length >= 12)) { symBatches.push(cur); cur = []; used = 0; } cur.push(s); used += size; } if (cur.length) symBatches.push(cur); }
  opts.onProgress?.(`Explaining ${symbolTargets.length} symbols in ${symBatches.length} batches`);
  await mapLimit(symBatches, config.ai.concurrency, async (batch) => {
    if (opts.isCancelled?.()) return;
    const items = batch.map((s) => {
      const f = filesByPath.get(s.path);
      const end = Math.min(s.endLine, s.startLine + 70);
      return { path: s.path, startLine: s.startLine, endLine: end, text: f?.text ? sliceLines(f.text, s.startLine, end) : "", label: s.name };
    });
    const ev = renderEvidence(items, budget);
    const meta = batch.map((s, i) => `[${i}] ${s.kind} ${s.name} at ${s.path}:${s.startLine}-${s.endLine}\n  callers: ${s.usedBy.slice(0, 6).join(", ") || "none known"}\n  calls: ${s.dependencies.slice(0, 8).join(", ") || "none known"}`).join("\n");
    const prompt = `Explain each code symbol below for an engineer who has never seen this repository, in plain operational language. Explain behaviour and why it matters to the product, not syntax.

Graph facts (from static indexing):
${untrusted(meta)}

${ev.text}

For each symbol index return: purpose (what it exists to accomplish), inputs, process (what it actually does, step by step in one or two sentences), outputs (return value or mutation), dependencies (names of things it depends on that appear in the code or graph facts), businessMeaning (why this matters to the product; empty string if it is purely technical), importantBehavior (edge cases, assumptions, non-obvious behaviour actually visible in the code; empty string if none), evidence (citations like "path:start-end" from the excerpts).
Never state something the code does not show. Keep each field under 60 words.`;
    const res = await tryAnalyze(provider, meter, { task: "docs:symbols", system: SAFETY_PREAMBLE, prompt, schema: SymbolBatchSchema, maxTokens: 10000 });
    if (!res) return;
    for (const it of res.items) {
      const s = batch[it.index];
      if (!s || !it.purpose.trim()) continue;
      const v = validateEvidence(it.evidence, filesByPath);
      dropped += v.dropped;
      Object.assign(s, { purpose: it.purpose, inputs: it.inputs || s.inputs, process: it.process || s.process, outputs: it.outputs || s.outputs, businessMeaning: it.businessMeaning, importantBehavior: it.importantBehavior || s.importantBehavior, dependencies: it.dependencies.length ? it.dependencies.slice(0, 10) : s.dependencies, evidence: v.valid.length ? v.valid : s.evidence, origin: "ai" });
      putExplain(symbolExplainKey(provider.model, s, filesByPath), "symbol", pick(s, SYMBOL_CACHED_FIELDS));
    }
    aiSections++;
  });

  // ---- Level 2: files -------------------------------------------------------
  const symbolDocByFile = new Map<string, SymbolDoc[]>();
  for (const s of report.symbols) { const l = symbolDocByFile.get(s.path) ?? []; l.push(s); symbolDocByFile.set(s.path, l); }
  const fileTargets: FileDoc[] = [];
  for (const d of report.files.filter((f) => ["source", "schema"].includes(filesByPath.get(f.path)?.classification ?? "")).slice(0, config.ai.maxFilesExplained)) {
    // Cache key covers this file's content and its direct dependencies, so a changed dependency invalidates the summary.
    const cached = getExplain<Record<string, unknown>>(fileExplainKey(provider.model, d, filesByPath));
    if (cached) { Object.assign(d, cached, { origin: "ai" }); reused++; } else fileTargets.push(d);
  }
  const fileBatches: FileDoc[][] = [];
  { let cur: FileDoc[] = []; let used = 0; for (const f of fileTargets) { const size = Math.min(6000, (filesByPath.get(f.path)?.size ?? 2000)) + 1500; if (cur.length && (used + size > budget || cur.length >= 6)) { fileBatches.push(cur); cur = []; used = 0; } cur.push(f); used += size; } if (cur.length) fileBatches.push(cur); }
  opts.onProgress?.(`Explaining ${fileTargets.length} files in ${fileBatches.length} batches`);
  await mapLimit(fileBatches, config.ai.concurrency, async (batch) => {
    if (opts.isCancelled?.()) return;
    const items = batch.map((d) => { const f = filesByPath.get(d.path)!; const end = Math.min(f.lines, 220); return { path: d.path, startLine: 1, endLine: end, text: sliceLines(f.text ?? "", 1, end) }; });
    const ev = renderEvidence(items, budget);
    const facts = batch.map((d) => `## ${d.path}\nrole: ${d.role}; area: ${d.area}\nimported by: ${d.calledBy.slice(0, 8).join(", ") || "none known"}\ndepends on: ${d.dependsOn.slice(0, 10).join(", ") || "none"}\nsymbol summaries: ${(symbolDocByFile.get(d.path) ?? []).slice(0, 8).map((s) => `${s.name}: ${s.purpose.slice(0, 120)}`).join(" | ") || "none"}`).join("\n\n");
    const prompt = `Write a file-level explanation for each file below. Use the graph facts and the source excerpt (which may be a prefix of a long file).

Scale: each explanation covers ONE file on its own. Describe what this file does and how its own code behaves. Mention other files only where this file imports them or is imported by them. How groups of files work together is documented separately at the folder and area level, so do not write it here.

${untrusted(facts)}

${ev.text}

For each file return: purpose (its role in the system, in one or two sentences that state actual behaviour), responsibilities (2-5 short items), howItOperates (execution behaviour), dataIn, dataOut, engineeringNotes (only concrete observations visible in the code; may be empty), evidence (citations "path:start-end").
Do not describe trivial getters or setters. Explain why the file matters to the product where the evidence supports it.`;
    const res = await tryAnalyze(provider, meter, { task: "docs:files", system: SAFETY_PREAMBLE, prompt, schema: FileBatchSchema, maxTokens: 10000 });
    if (!res) return;
    for (const it of res.items) {
      const d = batch.find((x) => x.path === it.path);
      if (!d || !it.purpose.trim()) continue;
      const v = validateEvidence(it.evidence, filesByPath);
      dropped += v.dropped;
      Object.assign(d, { purpose: it.purpose, responsibilities: it.responsibilities.length ? it.responsibilities.slice(0, 8) : d.responsibilities, howItOperates: it.howItOperates || d.howItOperates, dataIn: it.dataIn || d.dataIn, dataOut: it.dataOut || d.dataOut, engineeringNotes: [...new Set([...d.engineeringNotes, ...it.engineeringNotes])].slice(0, 8), evidence: v.valid.length ? v.valid : d.evidence, origin: "ai" });
      putExplain(fileExplainKey(provider.model, d, filesByPath), "file", pick(d, FILE_CACHED_FIELDS));
    }
    aiSections++;
  });

  // ---- Level 2b: folders and modules (collections of files) -----------------
  const fileDocsByPath = new Map(report.files.map((f) => [f.path, f]));
  const moduleTargets = (report.modules ?? []).slice().sort((a, b) => b.lines - a.lines).slice(0, config.ai.maxModulesExplained);
  opts.onProgress?.(`Explaining how the files in ${moduleTargets.length} folders work together`);
  await mapLimit(moduleTargets, config.ai.concurrency, async (m: ModuleDoc) => {
    if (opts.isCancelled?.()) return;
    const cached = getExplain<Record<string, unknown>>(moduleExplainKey(provider.model, m, filesByPath));
    if (cached) { Object.assign(m, cached, { origin: "ai" }); reused++; return; }
    const r = await narrateModule({ provider, meter, inputs, module: m, fileDocs: fileDocsByPath, filesByPath });
    dropped += r.dropped;
    if (r.ok) { putExplain(moduleExplainKey(provider.model, m, filesByPath), "module", pick(m, MODULE_CACHED_FIELDS)); aiSections++; }
  });

  // ---- Level 3: functional areas -------------------------------------------
  const areaTargets = report.areas.filter((a) => !["Documentation", "Testing"].includes(a.name)).slice(0, 14);
  opts.onProgress?.(`Explaining ${areaTargets.length} functional areas`);
  await mapLimit(areaTargets, config.ai.concurrency, async (a: AreaDoc) => {
    if (opts.isCancelled?.()) return;
    const fdocs = report.files.filter((f) => a.files.includes(f.path)).slice(0, 14);
    const arch = inputs.arch;
    const routes = arch.routes.filter((r) => a.files.includes(r.file)).slice(0, 12).map((r) => `${r.method} ${r.path} -> ${r.handler} (${r.file}:${r.line})`);
    const models = arch.models.filter((m) => a.files.includes(m.file)).slice(0, 10).map((m) => `${m.name} (${m.file}:${m.line}) fields: ${m.fields.slice(0, 8).join(", ")}`);
    const services = arch.externalServices.filter((s) => a.dependencies.includes(s.name)).map((s) => `${s.name}: ${s.purpose}`);
    const prompt = `Write the functional-area documentation for "${a.name}". This area is a coherent part of the system that a business or engineering leader would recognise, not a folder listing.

Scale: this is a macro explanation of a group of files that together deliver one capability. Explain the capability and how the files cooperate to provide it. The individual file summaries below are context only; do not restate them one by one, because each file is documented on its own elsewhere.

Known facts (from static indexing and prior summaries), given as data:
<<FACTS>>Files (${a.files.length}): ${a.files.slice(0, 20).join(", ")}
Routes: ${routes.join("; ") || "none"}
Models: ${models.join("; ") || "none"}
External services: ${services.join("; ") || "none"}
Depends on areas: ${a.dependencies.join(", ") || "none"}
Used by areas: ${arch.areas.find((x) => x.name === a.name)?.usedBy.join(", ") || "none"}
Key components: ${a.components.map((c) => `${c.name} (${c.kind}, ${c.path}:${c.line})`).join("; ")}

File summaries:
${fdocs.map((f) => `- ${f.path}: ${f.purpose.slice(0, 260)}`).join("\n")}<</FACTS>>

Return purpose, businessFunction (what capability it gives users or the organisation), inputs, processing, outputs, failureModes (what can realistically fail, using only the facts above), relationships (what depends on this area and what it depends on), evidence ("path:line" citations drawn from the facts above).`;
    const res = await tryAnalyze(provider, meter, { task: `docs:area:${a.id}`, system: SAFETY_PREAMBLE, prompt: wrapFacts(prompt), schema: AreaSchema, maxTokens: 5000 });
    if (!res) return;
    const v = validateEvidence(res.evidence, filesByPath);
    dropped += v.dropped;
    Object.assign(a, { purpose: res.purpose || a.purpose, businessFunction: res.businessFunction || a.businessFunction, inputs: res.inputs || a.inputs, processing: res.processing || a.processing, outputs: res.outputs || a.outputs, failureModes: res.failureModes.length ? res.failureModes.slice(0, 8) : a.failureModes, relationships: res.relationships || a.relationships, evidence: v.valid.length ? v.valid : a.evidence, origin: "ai" });
    aiSections++;
  });

  // ---- Level 4/5: architecture and executive synthesis ----------------------
  if (!opts.isCancelled?.()) {
    const arch = inputs.arch;
    const readme = readmeSummary(inputs.files);
    const live = inputs.findings.filter((f) => f.verification !== "rejected");
    const prompt = `Write the system-level documentation for the repository "${inputs.projectName}" for technically capable readers and business/engineering leaders who have not seen it.

Facts derived by static indexing, given as data:
<<FACTS>>- Architecture pattern: ${arch.pattern.label} (${arch.pattern.confidence}); ${arch.pattern.reasoning.join(" ")}
- Languages: ${arch.stack.languages.slice(0, 5).map((l) => `${l.name} (${l.files} files)`).join(", ")}
- Frameworks: ${arch.stack.frameworks.filter((f) => !["tooling"].includes(f.category)).map((f) => f.name).join(", ")}
- Databases: ${arch.stack.databases.join(", ") || "none"}
- Entry points: ${arch.entryPoints.slice(0, 6).map((e) => `${e.path}:${e.line ?? 1} (${e.kind}: ${e.reason})`).join("; ")}
- Routes (${arch.routes.length}): ${arch.routes.slice(0, 14).map((r) => `${r.method} ${r.path} (${r.file}:${r.line}, auth ${r.auth})`).join("; ")}
- Models (${arch.models.length}): ${arch.models.slice(0, 12).map((m) => `${m.name} (${m.file}:${m.line})`).join("; ")}
- External services: ${arch.externalServices.slice(0, 12).map((s) => `${s.name} [${s.purpose}]`).join("; ")}
- Infrastructure: ${arch.infra.slice(0, 8).map((i) => `${i.kind} (${i.path})`).join("; ")}
- Tests: ${arch.tests.files.length} files; untested important files: ${arch.tests.untestedCritical.slice(0, 5).map((u) => u.path).join(", ") || "none listed"}
- README statement of purpose (author-written, cite as ${readme?.evidence ?? "n/a"}): ${readme?.text ?? "none"}
- Findings: ${live.length} total (${live.filter((f) => f.severity === "Critical").length} critical, ${live.filter((f) => f.severity === "High").length} high). Top: ${live.filter((f) => ["Critical", "High"].includes(f.severity)).slice(0, 8).map((f) => `${f.code} ${f.title} (${f.filePath}:${f.startLine ?? 1})`).join("; ") || "none"}

Functional area summaries:
${report.areas.slice(0, 14).map((a) => `### ${a.name}\nPurpose: ${a.purpose}\nBusiness function: ${a.businessFunction}\nInputs: ${a.inputs}\nOutputs: ${a.outputs}\nDepends on: ${a.dependencies.slice(0, 6).join(", ")}\nFailure modes: ${a.failureModes.slice(0, 3).join("; ")}\nEvidence: ${a.evidence.join(", ")}`).join("\n\n")}

Traced flows (static call graph):
${report.flows.slice(0, 8).map((f) => `- ${f.name}: ${f.steps.map((s) => s.label).join(" -> ")} [${f.evidence.join(", ")}]`).join("\n")}<</FACTS>>

Produce:
- executiveSummary: 4-7 paragraphs, at most 700 words in total, readable by technical business leadership: what the system is, who or what uses it, major capabilities, architecture, where data enters, how it flows, what the final output is, main strengths, main risks.
- architectureOverview: 2-4 paragraphs on the actual structure. Do not force a label the evidence does not support.
- runtimeFlowNarrative and runtimeFlowSteps: the single most important execution flow, in order (label + detail + evidence per step).
- flowNarratives: for each traced flow name given above, a one or two sentence plain-language explanation (origin, transformation, storage, final consumer).
- apiArchitecture, dataArchitecture, securityModel, engineeringRisks, strengths, recommendations: short evidence-backed statements.
- conflicts: if two of the summaries above make contradictory claims about the same subject (for example one says component X writes directly to the database and another says it only calls a repository), list the subject and both claims verbatim. Otherwise return an empty list.
Every statement needs evidence: an array of "path:start-end" or "path:line" citations copied from the facts above. Business impact statements must be modest and realistic. Where evidence is thin, say what is unknown instead of guessing.`;
    const res = await tryAnalyze(provider, meter, { task: "docs:synthesis", system: SAFETY_PREAMBLE, prompt: wrapFacts(prompt), schema: SynthesisSchema, maxTokens: 14000 });
    if (res) {
      const g = (xs: { text: string; evidence: string[] }[]) => ground(xs);
      const setStatements = (cur: Statement[], next: Statement[]) => (next.length ? next : cur);
      const exec = g(res.executiveSummary);
      if (exec.length) report.executiveSummary = exec;
      const arc = g(res.architectureOverview);
      if (arc.length) report.architectureOverview.paragraphs = [...arc, ...report.architectureOverview.paragraphs.slice(0, 1)];
      const rf = g(res.runtimeFlowNarrative);
      if (rf.length) report.runtimeFlow.narrative = rf;
      const steps = res.runtimeFlowSteps.map((s) => ({ label: s.label, detail: s.detail, evidence: validateEvidence(s.evidence, filesByPath).valid })).filter((s) => s.evidence.length);
      if (steps.length >= 2) report.runtimeFlow.steps = steps;
      for (const fn of res.flowNarratives) {
        const flow = report.flows.find((f) => f.name === fn.flowName);
        const v = validateEvidence(fn.evidence, filesByPath);
        if (flow && fn.narrative.trim() && v.valid.length) { flow.narrative = fn.narrative; flow.evidence = v.valid; flow.origin = "ai"; }
      }
      report.apiArchitecture.paragraphs = setStatements(report.apiArchitecture.paragraphs, [...g(res.apiArchitecture), ...report.apiArchitecture.paragraphs.slice(0, 1)]);
      report.dataArchitecture.paragraphs = setStatements(report.dataArchitecture.paragraphs, [...g(res.dataArchitecture), ...report.dataArchitecture.paragraphs.slice(0, 1)]);
      report.securityModel.paragraphs = [...g(res.securityModel), ...report.securityModel.paragraphs];
      const risks = g(res.engineeringRisks);
      if (risks.length) report.risks.paragraphs = [...risks, ...report.risks.paragraphs.slice(0, 1)];
      const strengths = g(res.strengths);
      if (strengths.length) report.risks.bullets = [...(report.risks.bullets ?? []), ...strengths.map((s) => ({ ...s, text: `Strength: ${s.text}` }))];
      const recs = g(res.recommendations);
      if (recs.length) report.recommendations = [...recs, ...report.recommendations].slice(0, 14);
      aiSections += 1;

      // Conflict detection and re-verification against source evidence.
      for (const c of res.conflicts.slice(0, 5)) {
        if (opts.isCancelled?.()) break;
        const ctx = await retrieveContext(projectId, c.subject, { maxItems: 6, charBudget: 16000 });
        if (ctx.evidence.length === 0 || c.claims.length < 2) { report.conflicts.push({ subject: c.subject, claims: c.claims, resolution: "Source evidence for this subject could not be retrieved; the contradiction remains unresolved.", preferred: "unresolved", evidence: [] }); continue; }
        const ev = renderEvidence(ctx.evidence, 24000);
        const rp = `Two summaries of this repository disagree about the subject given below.\n${untrusted(`Subject: ${c.subject}\n${c.claims.map((x, i) => `Claim ${i}: ${x}`).join("\n")}`)}\n\nDecide which claim the source code supports, using only the evidence below. If neither is fully supported, state what the code actually shows and set supportedClaimIndex to -1.\n\n${ev.text}`;
        const r = await tryAnalyze(provider, meter, { task: "docs:resolve-conflict", system: SAFETY_PREAMBLE, prompt: rp, schema: ResolveSchema, maxTokens: 2500 });
        const v = validateEvidence(r?.evidence ?? [], filesByPath);
        const rec: ConflictRecord = r ? { subject: c.subject, claims: c.claims, resolution: r.resolution, preferred: v.valid.length ? "source-evidence" : "unresolved", evidence: v.valid } : { subject: c.subject, claims: c.claims, resolution: "Resolution call failed; contradiction remains unresolved.", preferred: "unresolved", evidence: [] };
        report.conflicts.push(rec);
        if (rec.preferred === "source-evidence") report.architectureOverview.paragraphs.push({ text: `Clarification on ${c.subject}: ${rec.resolution}`, evidence: rec.evidence, origin: "ai" });
      }
    }
  }

  // ---- Deterministic cross-check of AI data-access claims against the graph -
  pushAll(report.conflicts, crossCheckDataClaims(report, inputs.arch.models.map((m) => m.name), inputs.rels, inputs.symbols, filesByPath, symbolsById));

  if (reused) report.meta.notes.push(`${reused} symbol/file explanation(s) were reused from a previous analysis because the code and its dependencies are unchanged.`);
  // ---- Level 6: the business brief. A second, sequential pass that distils everything above into a consumable summary. ----
  if (!opts.isCancelled?.() && report.brief) {
    opts.onProgress?.("Writing the business summary");
    const b = await narrateBrief({ provider, meter, inputs, report, brief: report.brief });
    if (b) { report.brief = b; aiSections++; }
  }

  report.meta = { ...report.meta, aiUsed: aiSections > 0 || reused > 0, model: provider.model, provider: provider.name, aiSections, deterministicSections: report.meta.deterministicSections, droppedUngrounded: dropped };
  return report;
}

const WRITE_CLAIM = /\b(writes?|persists?|saves?|inserts?|updates?|stores?|deletes?)\b/i;

/**
 * Compare generated statements about data access with the relationship graph and
 * the file text. When a summary claims a write to a model that neither the graph
 * nor the source supports, the claim is reverted to the deterministic text.
 */
export function crossCheckDataClaims(report: DocReport, modelNames: string[], rels: RelationshipRow[], symbols: SymbolRow[], filesByPath: Map<string, LoadedFile>, symbolsById: Map<string, SymbolRow>): ConflictRecord[] {
  const conflicts: ConflictRecord[] = [];
  if (modelNames.length === 0) return conflicts;
  const writesByFile = new Map<string, Set<string>>();
  for (const r of rels) {
    if (r.kind !== "WRITES_TO") continue;
    const src = r.sourceType === "symbol" ? symbolsById.get(r.sourceId)?.filePath : undefined;
    const model = symbolsById.get(r.targetId)?.name;
    if (src && model) { const s = writesByFile.get(src) ?? new Set(); s.add(model); writesByFile.set(src, s); }
  }
  void symbols;
  for (const f of report.files) {
    if (f.origin !== "ai") continue;
    const text = `${f.dataOut} ${f.howItOperates} ${f.purpose}`;
    for (const m of modelNames) {
      if (!new RegExp(`\\b${m}\\b`).test(text) || !WRITE_CLAIM.test(text)) continue;
      const graphWrites = writesByFile.get(f.path)?.has(m) ?? false;
      const src = filesByPath.get(f.path)?.text ?? "";
      const sourceMentions = new RegExp(`\\b${m}\\b`).test(src);
      if (!graphWrites && !sourceMentions) {
        conflicts.push({ subject: `${f.path} writes to ${m}`, claims: [`AI summary: ${f.dataOut}`, `Repository graph: no WRITES_TO relationship and the file never references ${m}`], resolution: "The generated claim has no support in the indexed source; the deterministic description was kept.", preferred: "graph", evidence: [f.path] });
        f.dataOut = "Return values to callers";
        f.origin = "deterministic";
      }
    }
  }
  return conflicts;
}

export type { FlowDoc };


/**
 * Ask the model how a collection of files works together, and merge the answer into the ModuleDoc. Used for every
 * folder during analysis and for any custom selection on demand. The prompt is built from the per-file summaries
 * (hierarchical synthesis) plus graph facts, and it forbids re-describing files one by one.
 */
export async function narrateModule(opts: { provider: AIProvider; meter: UsageMeter; inputs: DocInputs; module: ModuleDoc; fileDocs: Map<string, FileDoc>; filesByPath: Map<string, LoadedFile> }): Promise<{ ok: boolean; dropped: number }> {
  const { provider, meter, inputs, module: m, fileDocs, filesByPath } = opts;
  const set = new Set(m.files.map((f) => f.path));
  const routes = inputs.arch.routes.filter((r) => set.has(r.file)).slice(0, 10).map((r) => `${r.method} ${r.path} -> ${r.handler} (${r.file}:${r.line})`);
  const models = inputs.arch.models.filter((x) => set.has(x.file)).slice(0, 8).map((x) => `${x.name} (${x.file}:${x.line})`);
  const summaries = m.files.slice(0, 18).map((f) => `- ${f.path} [${f.role}, ${f.lines} lines]: ${(fileDocs.get(f.path)?.purpose ?? f.purpose).slice(0, 220)}`);
  const prompt = `Explain how the files in ${m.kind === "folder" ? `the folder "${m.path}/"` : "this selected group of files"} work TOGETHER as one unit. There are ${m.fileCount} files.

Scale: this is a macro explanation of a collection. Do NOT restate what each file does one by one; every file is already documented on its own and its summary is given below only as context. Explain instead: the job of the group as a whole, how work moves between the files (which one coordinates, which one is shared, who calls whom), what the rest of the system uses it for, what it needs from outside, and what data goes in and comes out. If the files turn out to be unrelated, say so plainly rather than inventing a story.

Facts derived by static indexing, given as data:
<<FACTS>>Files:
${summaries.join("\n")}
Imports between these files: ${m.internalLinks.map((l) => `${l.from} -> ${l.to}`).join("; ") || "none"}
Used from outside through: ${m.publicSurface.map((s) => `${s.name} (${s.kind}, used by ${s.usedBy} file(s))`).join("; ") || "nothing detected"}
Depends on: ${m.dependsOn.join(", ") || "nothing outside"}; packages: ${m.externalPackages.join(", ") || "none"}
Used by folders: ${m.usedBy.join(", ") || "none"}
Routes: ${routes.join("; ") || "none"}
Models: ${models.join("; ") || "none"}
Open review findings: ${m.findings.top.join("; ") || "none"}
Functional areas: ${m.areas.join(", ") || "none"}<</FACTS>>

Return purpose (one or two sentences about the group as a whole), howFilesWork (three or four sentences about the interaction between the files), dataIn, dataOut, keyFileNotes (up to five files that matter most and why, each path exactly as listed above), evidence ("path:line" citations drawn from the facts above).`;
  const res = await tryAnalyze(provider, meter, { task: `docs:module:${m.path || "selection"}`, system: SAFETY_PREAMBLE, prompt: wrapFacts(prompt), schema: ModuleSchema, maxTokens: 4000 });
  if (!res || !res.purpose.trim()) return { ok: false, dropped: 0 };
  const v = validateEvidence(res.evidence, filesByPath);
  const notes = res.keyFileNotes.filter((n) => set.has(n.path) && n.why.trim()).slice(0, 5);
  Object.assign(m, {
    purpose: res.purpose.trim(), howFilesWork: res.howFilesWork.trim() || m.howFilesWork, dataIn: res.dataIn.trim() || m.dataIn, dataOut: res.dataOut.trim() || m.dataOut,
    keyFiles: notes.length ? notes.map((n) => ({ path: n.path, why: n.why.trim() })) : m.keyFiles, evidence: v.valid.length ? v.valid : m.evidence, origin: "ai" as const,
  });
  return { ok: true, dropped: v.dropped };
}


const trim = (t: string, max: number) => t.replace(/\s+/g, " ").trim().slice(0, max);

/**
 * Sequential step after the technical synthesis: rewrite the in-depth, evidence-linked summary as a short business
 * brief. The model sees the summary ("Summary evidence") plus computed facts, and may not add anything that is not in
 * them. Numbers always come from the deterministic brief, never from the model. Returns undefined if the call fails,
 * in which case the deterministic brief stays.
 */
export async function narrateBrief(opts: { provider: AIProvider; meter: UsageMeter; inputs: DocInputs; report: DocReport; brief: ExecutiveBrief }): Promise<ExecutiveBrief | undefined> {
  const { provider, meter, inputs, report, brief } = opts;
  const live = inputs.findings.filter((f) => f.verification !== "rejected");
  const sevCount = ["Critical", "High", "Medium", "Low", "Informational"].map((s) => `${live.filter((f) => f.severity === s).length} ${s.toLowerCase()}`).join(", ");
  const serious = live.filter((f) => f.severity === "Critical" || f.severity === "High").slice(0, 6).map((f) => `- [${f.severity}] ${f.title}${f.businessImpact ? ` (impact: ${trim(f.businessImpact, 160)})` : ""}`);
  const areas = report.areas.filter((a) => !["Documentation", "Testing", "Configuration"].includes(a.name)).slice(0, 10).map((a) => `- ${a.name}: ${trim(a.purpose, 160)}`);
  const prompt = `Write the Executive Summary of a software repository for a business audience: executives, product owners and other non-engineers who must decide what to do about it.

You are given a long technical summary and supporting facts. Distil them; do not repeat them. Use plain language. Do not use file paths, function names or code terms; describe what the software does for the organisation and what could go wrong for it. Every claim must follow from the facts below. Do not invent numbers, customers, goals or timelines. If something is not known, say so in a few words.

Facts, given as data:
<<FACTS>>Product: ${inputs.projectName} (${inputs.arch.applicationType})
Computed numbers: ${brief.metrics.map((m) => `${m.label}: ${m.value}`).join("; ")}
Review findings by severity: ${sevCount}
Most serious findings:
${serious.join("\n") || "- none"}
Functional areas:
${areas.join("\n") || "- none"}
Recommendations from the technical report:
${report.recommendations.slice(0, 6).map((r) => `- ${trim(r.text, 200)}`).join("\n") || "- none"}
External services: ${inputs.arch.externalServices.map((s) => s.name).join(", ") || "none"}

Technical summary to distil (this is the "Summary evidence"; readers can open it for sources):
${report.executiveSummary.map((s) => `- ${trim(s.text, 500)}`).join("\n")}<</FACTS>>

Return:
- headline: one sentence, at most 25 words, saying what this is and why it matters.
- summary: two or three sentences in plain language.
- audience: who uses it, in one sentence, or "Not stated in the repository".
- keyPoints: four to six slide-style messages. Each has a title of at most four words (for example "What it does", "How it is built", "Where the risk is", "What to do next") and a detail of at most 25 words.
- capabilities: four to seven business capabilities, each one line of at most 16 words.
- health: verdict (one sentence), strengths (up to four short bullets) and concerns (up to four short bullets, each in terms of business consequence).
- nextSteps: three to five actions in order of importance, each with action (at most 20 words), why (at most 20 words) and priority "Now", "Next" or "Later".`;
  const res = await tryAnalyze(provider, meter, { task: "docs:brief", system: SAFETY_PREAMBLE, prompt: wrapFacts(prompt), schema: BriefSchema, maxTokens: 3500 });
  if (!res || !res.headline.trim() || res.keyPoints.length === 0) return undefined;
  const priority = (p: string): "Now" | "Next" | "Later" => (/^now/i.test(p) ? "Now" : /^later/i.test(p) ? "Later" : "Next");
  return {
    headline: trim(res.headline, 260),
    summary: trim(res.summary, 700) || brief.summary,
    audience: trim(res.audience, 200),
    keyPoints: res.keyPoints.filter((k) => k.title.trim() && k.detail.trim()).slice(0, 6).map((k) => ({ title: trim(k.title, 40), detail: trim(k.detail, 240) })),
    capabilities: res.capabilities.map((c) => trim(c, 140)).filter(Boolean).slice(0, 7),
    health: { verdict: trim(res.health.verdict, 260) || brief.health.verdict, strengths: res.health.strengths.map((x) => trim(x, 160)).filter(Boolean).slice(0, 4), concerns: res.health.concerns.map((x) => trim(x, 200)).filter(Boolean).slice(0, 4) },
    nextSteps: res.nextSteps.filter((n) => n.action.trim()).slice(0, 5).map((n) => ({ action: trim(n.action, 180), why: trim(n.why, 180), priority: priority(n.priority) })),
    metrics: brief.metrics,
    origin: "ai",
  };
}
