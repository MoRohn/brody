import { eq } from "drizzle-orm";
import { getDb, schema, projectRows } from "../db/client";
import type { Architecture } from "../discover/types";
import { loadProjectFiles } from "../graph/build";
import { UsageMeter, type AIProvider } from "../ai";
import { indexFindingsAndDocs } from "../retrieval";
import { enhanceWithAI } from "./ai";
import { buildBrief } from "./brief";
import { buildModuleDocs } from "./modules";
import { buildAreaDocs, buildFileDocs, buildFlowDocs, buildReport, buildSymbolDocs, type DocInputs } from "./deterministic";
import type { DocReport } from "./types";

export * from "./types";

/** Everything the documentation builders read, loaded once from the database. */
export function loadDocInputs(projectId: string, arch: Architecture): DocInputs {
  const db = getDb();
  const project = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!project) throw new Error("Project not found");
  const files = loadProjectFiles(projectId).filter((f) => !f.isExcluded);
  // Re-read after discovery so roles/areas are current.
  const symbols = projectRows(schema.symbols, projectId);
  const rels = projectRows(schema.relationships, projectId);
  const findings = projectRows(schema.findings, projectId);
  return { projectName: project.name, sourceUrl: project.sourceUrl, branch: project.branch, commit: project.commit, files, symbols, rels, findings, arch };
}

export async function generateDocs(opts: { projectId: string; arch: Architecture; provider: AIProvider | null; meter: UsageMeter; onProgress?: (m: string) => void; isCancelled?: () => boolean }): Promise<DocReport> {
  const db = getDb();
  const project = db.select().from(schema.projects).where(eq(schema.projects.id, opts.projectId)).get();
  if (!project) throw new Error("Project not found");
  const inputs = loadDocInputs(opts.projectId, opts.arch);

  const fileDocs = buildFileDocs(inputs);
  const parts = { symbols: buildSymbolDocs(inputs), files: fileDocs, areas: buildAreaDocs(inputs), flows: buildFlowDocs(inputs), modules: buildModuleDocs(inputs, fileDocs) };
  let report = buildReport(inputs, parts);
  report.brief = buildBrief(report, opts.arch, inputs.findings, project.name);
  if (opts.provider) {
    try {
      report = await enhanceWithAI({ provider: opts.provider, meter: opts.meter, inputs, report, projectId: opts.projectId, onProgress: opts.onProgress, isCancelled: opts.isCancelled });
    } catch (e) {
      report.meta.notes.push(`AI documentation pass failed (${e instanceof Error ? e.message : String(e)}); the deterministic documentation is shown.`);
    }
  } else {
    report.meta.notes.push("No AI provider configured: documentation is generated deterministically from the repository model. Configure a provider for narrative explanations.");
  }
  for (const f of opts.meter.failures) report.meta.notes.push(`AI task ${f.task} failed: ${f.error.slice(0, 160)}`);

  db.update(schema.projects).set({ analysis: { ...(project.analysis ?? {}), docs: report }, updatedAt: Date.now() }).where(eq(schema.projects.id, opts.projectId)).run();
  indexFindingsAndDocs(opts.projectId, docIndexEntries(report));
  return report;
}


/** What the search index holds for the generated documentation: areas, folders, files, symbols, flows and the summary. */
export function docIndexEntries(report: DocReport): { id: string; title: string; text: string; path?: string }[] {
  return [
    ...report.areas.map((a) => ({ id: `area:${a.id}`, title: `Area: ${a.name}`, text: `${a.purpose} ${a.businessFunction} ${a.inputs} ${a.outputs} ${a.relationships}` })),
    ...(report.modules ?? []).map((m) => ({ id: `module:${m.path}`, title: `Folder: ${m.path}/`, text: `${m.purpose} ${m.howFilesWork} ${m.dataIn} ${m.dataOut}` })),
    ...report.files.map((f) => ({ id: `file:${f.path}`, title: `File: ${f.path}`, path: f.path, text: `${f.purpose} ${f.howItOperates} ${f.responsibilities.join(" ")}` })),
    ...report.symbols.map((s) => ({ id: `sym:${s.symbolId}`, title: `Symbol: ${s.name}`, path: s.path, text: `${s.purpose} ${s.process} ${s.businessMeaning}` })),
    ...report.flows.map((f) => ({ id: `flow:${f.id}`, title: `Flow: ${f.name}`, text: f.narrative })),
    { id: "exec", title: "Executive summary", text: `${report.brief ? `${report.brief.headline} ${report.brief.summary} ` : ""}${report.executiveSummary.map((s) => s.text).join(" ")}` },
  ]; 
}
