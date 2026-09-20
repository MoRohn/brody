import { eq } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { parseReport } from "./document";
import { renderDocx } from "./docx";
import { buildHtmlDocument } from "./html";
import { buildMarkdown, isScope, loadReportData, SCOPES, type ReportScope } from "./markdown";
import { renderPdf } from "./pdf";

import { buildBrief } from "../docs/brief";
export { buildMarkdown, isScope, SCOPES, type ReportScope } from "./markdown";
export { buildHtmlDocument } from "./html";

export type ExportFormat = "md" | "html" | "pdf" | "docx" | "json" | "print";
export const FORMATS: ExportFormat[] = ["md", "html", "pdf", "docx", "json", "print"];

export const CONTENT_TYPES: Record<ExportFormat, string> = {
  md: "text/markdown; charset=utf-8",
  html: "text/html; charset=utf-8",
  print: "text/html; charset=utf-8",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  json: "application/json; charset=utf-8",
};

export function buildHtml(projectId: string, opts: { print?: boolean; scope?: ReportScope } = {}): string {
  const scope = opts.scope ?? "full";
  const { project } = loadReportData(projectId);
  return buildHtmlDocument(`${SCOPES[scope].title}: ${project.name}`, buildMarkdown(projectId, { scope }), { print: opts.print });
}

/** Structured export with every layer of the repository model. */
export function buildJson(projectId: string): Record<string, unknown> {
  const db = getDb();
  const { project, arch, docs, findings } = loadReportData(projectId);
  const files = db.select().from(schema.files).where(eq(schema.files.projectId, projectId)).all();
  const symbols = db.select().from(schema.symbols).where(eq(schema.symbols.projectId, projectId)).all();
  const relationships = db.select().from(schema.relationships).where(eq(schema.relationships.projectId, projectId)).all();
  const { analysis, ...projectCore } = project;
  const pipeline = (analysis as { pipeline?: unknown; inventory?: unknown; map?: unknown } | null) ?? {};
  return {
    project: projectCore,
    architecture: { ...arch, secrets: arch.secrets.map((s) => ({ path: s.path, line: s.line, kind: s.kind })) },
    files: files.map((f) => ({ id: f.id, path: f.path, language: f.language, size: f.size, lines: f.lines, hash: f.hash, classification: f.classification, role: f.role, area: f.area, isTest: f.isTest, isGenerated: f.isGenerated, isVendor: f.isVendor, isExcluded: f.isExcluded, excludeReason: f.excludeReason, imports: f.imports, exports: f.exports, parseStatus: f.parseStatus, importance: f.importance })),
    symbols: symbols.map((s) => ({ id: s.id, name: s.name, qualifiedName: s.qualifiedName, kind: s.kind, file: s.filePath, startLine: s.startLine, endLine: s.endLine, signature: s.signature, visibility: s.visibility, parentId: s.parentId, documentation: s.documentation, exported: s.exported, inbound: s.inboundCount, outbound: s.outboundCount, importance: s.importance, meta: s.meta })),
    relationships: relationships.map((r) => ({ kind: r.kind, sourceType: r.sourceType, sourceId: r.sourceId, targetType: r.targetType, targetId: r.targetId, file: r.filePath, line: r.line, confidence: r.confidence })),
    findings: findings.map(({ projectId: _p, ...f }) => f),
    documentation: docs,
    flows: arch.flows,
    dependencies: { external: arch.dependencies, services: arch.externalServices, internalAreas: arch.areas.map((a) => ({ name: a.name, dependsOn: a.dependsOn, usedBy: a.usedBy })) },
    metadata: { exportedAt: new Date().toISOString(), generator: "brody", analysis: pipeline.pipeline ?? null, inventory: pipeline.inventory ?? null, ai: docs.meta },
  };
}

export interface ExportResult {
  body: Buffer | string;
  contentType: string;
  filename: string;
}

const cache = new Map<string, { at: number; result: ExportResult }>();
const CACHE_MAX = 12;

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "project";

/** Produce one report file. PDF and Word are generated from the same Markdown the app shows, so all formats agree. */
export async function exportFile(projectId: string, format: ExportFormat, scope: ReportScope = "full"): Promise<ExportResult> {
  const { project } = loadReportData(projectId);
  const key = `${projectId}:${project.updatedAt}:${format}:${scope}`;
  const cacheable = scope !== "ask"; // questions are appended without touching the project
  const hit = cacheable ? cache.get(key) : undefined;
  if (hit) return hit.result;

  const base = safe(project.name);
  const stem = `${base}-${SCOPES[scope].slug}`;
  let result: ExportResult;
  if (format === "json") {
    result = { body: JSON.stringify(buildJson(projectId), null, 2), contentType: CONTENT_TYPES.json, filename: `${base}-report.json` };
  } else if (format === "md") {
    result = { body: buildMarkdown(projectId, { scope }), contentType: CONTENT_TYPES.md, filename: scope === "full" ? "CODEBASE_REPORT.md" : `${stem}.md` };
  } else if (format === "html" || format === "print") {
    result = { body: buildHtml(projectId, { scope, print: format === "print" }), contentType: CONTENT_TYPES.html, filename: `${stem}.html` };
  } else {
    const data = loadReportData(projectId);
    const brief = data.docs.brief ?? buildBrief(data.docs, data.arch, data.findings, project.name);
    // In the PDF the executive summary is a set of slides, so its text version is left out of the body.
    const withSlides = format === "pdf" && SCOPES[scope].sections.includes("exec");
    const doc = parseReport(buildMarkdown(projectId, { scope, deck: withSlides }));
    const meta = { footer: `${SCOPES[scope].title} · ${project.name}`, author: "Brody" };
    if (format === "pdf") result = { body: await renderPdf(doc, meta, withSlides ? { brief, projectName: project.name } : undefined), contentType: CONTENT_TYPES.pdf, filename: `${stem}.pdf` };
    else result = { body: await renderDocx(doc, meta), contentType: CONTENT_TYPES.docx, filename: `${stem}.docx` };
  }
  if (cacheable) {
    cache.set(key, { at: Date.now(), result });
    while (cache.size > CACHE_MAX) cache.delete([...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0][0]);
  }
  return result;
}

export function isFormat(v: string): v is ExportFormat {
  return (FORMATS as string[]).includes(v);
}

export { isScope as isReportScope };
