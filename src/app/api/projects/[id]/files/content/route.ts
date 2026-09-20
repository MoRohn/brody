import { and, eq } from "drizzle-orm";
import { getReadyProject, guard, json } from "@/lib/api";
import { getDb, schema } from "@/lib/db/client";
import type { DocReport } from "@/lib/docs/types";
import { getFileContent } from "@/lib/ingest/store";
import { changeImpact } from "@/lib/map";
import { AppError } from "@/lib/util/errors";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const MAX_RETURN = 600_000;

export async function GET(req: Request, { params }: Ctx) {
  return guard(async () => {
    const { id } = await params;
    const project = getReadyProject(id);
    const path = new URL(req.url).searchParams.get("path");
    if (!path) throw new AppError("invalid_request", "Provide a file path.", 400);
    const db = getDb();
    const file = db.select().from(schema.files).where(and(eq(schema.files.projectId, id), eq(schema.files.path, path))).get();
    if (!file) throw new AppError("file_not_found", `No file "${path}" exists in this project.`, 404);
    let content: string | null = null;
    let note: string | undefined;
    if (file.isBinary) note = "Binary file: content is not shown.";
    else if (!file.hasContent) note = `File is larger than the ${Math.round(2)} MB content limit, so only metadata was stored.`;
    else { content = getFileContent(file.hash) ?? null; if (content && content.length > MAX_RETURN) { content = content.slice(0, MAX_RETURN); note = "File truncated for display."; } }
    const symbols = db.select().from(schema.symbols).where(and(eq(schema.symbols.projectId, id), eq(schema.symbols.fileId, file.id))).all().sort((a, b) => a.startLine - b.startLine);
    const symbolIds = new Set(symbols.map((s) => s.id));
    const rels = db.select().from(schema.relationships).where(eq(schema.relationships.projectId, id)).all();
    const filesById = new Map(db.select().from(schema.files).where(eq(schema.files.projectId, id)).all().map((f) => [f.id, f]));
    const symbolsById = new Map(db.select().from(schema.symbols).where(eq(schema.symbols.projectId, id)).all().map((s) => [s.id, s]));
    const outgoing = new Set<string>(), incoming = new Set<string>(), tests = new Set<string>(), externals = new Set<string>();
    for (const r of rels) {
      const srcIn = r.sourceId === file.id || symbolIds.has(r.sourceId);
      const tgtIn = r.targetId === file.id || symbolIds.has(r.targetId);
      if (r.kind === "TESTS" && tgtIn) { const tf = filesById.get(r.sourceId); if (tf) tests.add(tf.path); continue; }
      if (srcIn && !tgtIn && ["IMPORTS", "CALLS", "USES", "INSTANTIATES", "EXTENDS", "IMPLEMENTS", "READS_FROM", "WRITES_TO"].includes(r.kind)) {
        const tp = r.targetType === "file" ? filesById.get(r.targetId)?.path : r.targetType === "symbol" ? symbolsById.get(r.targetId)?.filePath : undefined;
        if (tp && tp !== file.path) outgoing.add(tp);
      }
      if (srcIn && r.kind === "DEPENDS_ON") externals.add(r.targetId.replace(/^pkg:/, ""));
      if (tgtIn && !srcIn && ["IMPORTS", "CALLS", "USES", "INSTANTIATES", "EXTENDS", "IMPLEMENTS", "ROUTES_TO"].includes(r.kind)) {
        const sp = r.sourceType === "file" ? filesById.get(r.sourceId)?.path : r.sourceType === "symbol" ? symbolsById.get(r.sourceId)?.filePath : undefined;
        if (sp && sp !== file.path) incoming.add(sp);
      }
    }
    const findings = db.select().from(schema.findings).where(and(eq(schema.findings.projectId, id), eq(schema.findings.filePath, path))).all().filter((f) => f.verification !== "rejected").map(({ projectId: _p, ...f }) => f);
    const docs = ((project.analysis ?? {}) as { docs?: DocReport }).docs;
    const fileDoc = docs?.files.find((f) => f.path === path) ?? null;
    const symbolDocs = docs?.symbols.filter((s) => s.path === path) ?? [];
    const impact = changeImpact(id, { type: "file", id: file.id });
    return json({
      file: { id: file.id, path: file.path, language: file.language, size: file.size, lines: file.lines, classification: file.classification, role: file.role, area: file.area, isTest: file.isTest, isExcluded: file.isExcluded, excludeReason: file.excludeReason, parseStatus: file.parseStatus, parseError: file.parseError, importance: file.importance, imports: file.imports, exports: file.exports },
      content, note,
      symbols: symbols.map((s) => ({ id: s.id, name: s.name, qualifiedName: s.qualifiedName, kind: s.kind, startLine: s.startLine, endLine: s.endLine, signature: s.signature, exported: s.exported, parentId: s.parentId, inbound: s.inboundCount, outbound: s.outboundCount, doc: symbolDocs.find((d) => d.symbolId === s.id) ?? null })),
      dependencies: { outgoing: [...outgoing].sort(), incoming: [...incoming].sort(), external: [...externals].sort(), tests: [...tests].sort() },
      findings, fileDoc, impact: impact ? { summary: impact.summary, affectedRoutes: impact.affectedRoutes, affectedTests: impact.affectedTests, chains: impact.chains, upstream: impact.upstream.slice(0, 40), downstream: impact.downstream.slice(0, 40) } : null,
    });
  });
}
