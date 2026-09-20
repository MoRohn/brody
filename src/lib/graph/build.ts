import { eq, and } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import type { FileRow } from "../db/schema";
import { getFileContents } from "../ingest/store";
import { parseFile, type ParsedFile } from "../parse";
import { getCachedParse, parseCacheKey, putCachedParse } from "../parse/cache";
import { newId } from "../util/ids";
import { externalPackageName, readPathAliases, resolveImport } from "./resolve";
import { maxOf } from "../util/arrays";

export interface BuildResult {
  parsed: number;
  /** Files whose parse result was reused from a previous analysis (same content hash). */
  reused: number;
  astParsed: number;
  textParsed: number;
  skipped: number;
  symbols: number;
  relationships: number;
  errors: { path: string; error: string }[];
}

export interface LoadedFile extends FileRow {
  text?: string;
}

interface SymRef {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  exported: boolean;
  parentId?: string;
  startLine: number;
  endLine: number;
}

interface RelDraft {
  kind: string;
  sourceType: "file" | "symbol" | "external";
  sourceId: string;
  targetType: "file" | "symbol" | "external";
  targetId: string;
  filePath?: string;
  line?: number;
  confidence: number;
  meta?: Record<string, unknown>;
}

const CALLABLE_KINDS = new Set(["function", "method", "class", "component", "hook", "service", "endpoint", "struct", "model", "job", "event_handler", "constant", "variable", "trait", "interface", "type", "enum", "schema"]);
const WRITE_VERBS = /^(create|createMany|insert|insertOne|insertMany|update|updateOne|updateMany|upsert|delete|deleteOne|deleteMany|remove|save|persist|bulk_create|bulkCreate|destroy|add|add_all|merge|execute|commit|flush|truncate|set|put|write|push|sadd|hset|lpush|rpush|incr|decr|expire|del|setex|zadd)$/i;
const READ_VERBS = /^(find|findOne|findMany|findUnique|findFirst|findAll|findById|get|getOne|getMany|query|select|fetch|count|aggregate|groupBy|exists|first|all|filter|list|load|read|scan|search|where|one|hget|hgetall|smembers|lrange|zrange|mget|exists)$/i;

/** Load included, text-bearing files for a project along with content. */
export function loadProjectFiles(projectId: string, opts: { includeExcluded?: boolean } = {}): LoadedFile[] {
  const db = getDb();
  const rows = db.select().from(schema.files).where(eq(schema.files.projectId, projectId)).all();
  const wanted = rows.filter((r) => (opts.includeExcluded || !r.isExcluded) && r.hasContent && !r.isBinary);
  const contents = getFileContents(wanted.map((r) => r.hash));
  return rows.map((r) => ({ ...r, text: wanted.includes(r) ? contents.get(r.hash) : undefined }));
}

export async function buildGraph(projectId: string, onProgress?: (done: number, total: number) => void, onPhase?: (phase: "parse" | "graph") => void): Promise<BuildResult> {
  const db = getDb();
  const allFiles = loadProjectFiles(projectId);
  const files = allFiles.filter((f) => !f.isExcluded && f.text !== undefined);
  const filesByPath = new Map(allFiles.map((f) => [f.path, f]));
  const pathSet = new Set(allFiles.filter((f) => !f.isExcluded).map((f) => f.path));
  const aliases = readPathAliases(filesByPath);
  const result: BuildResult = { parsed: 0, reused: 0, astParsed: 0, textParsed: 0, skipped: 0, symbols: 0, relationships: 0, errors: [] };

  // Clean previous graph data for this project (re-analysis).
  db.delete(schema.symbols).where(eq(schema.symbols.projectId, projectId)).run();
  db.delete(schema.relationships).where(eq(schema.relationships.projectId, projectId)).run();

  const parsed = new Map<string, ParsedFile>();
  let done = 0;
  onPhase?.("parse");
  for (const f of files) {
    try {
      const key = parseCacheKey(f.language, f.path, f.hash);
      let p = getCachedParse(key);
      if (p) result.reused++;
      else {
        p = await parseFile(f.path, f.language, f.text!);
        if (p.status !== "skipped" || f.language !== "Unknown") putCachedParse(key, p);
      }
      parsed.set(f.path, p);
      if (p.status === "ast") result.astParsed++;
      else if (p.status === "text") result.textParsed++;
      else result.skipped++;
      if (p.error) result.errors.push({ path: f.path, error: p.error });
    } catch (e) {
      result.errors.push({ path: f.path, error: e instanceof Error ? e.message : String(e) });
    }
    result.parsed++;
    done++;
    if (done % 25 === 0) {
      onProgress?.(done, files.length);
      // Yield so the HTTP server stays responsive while parsing large repositories.
      await new Promise<void>((r) => setImmediate(r));
    }
  }
  onProgress?.(files.length, files.length);
  onPhase?.("graph");

  // Symbols
  const symbolRows: (typeof schema.symbols.$inferInsert)[] = [];
  const symsByFile = new Map<string, SymRef[]>();
  const symsByName = new Map<string, SymRef[]>();
  const idByFileIndex = new Map<string, string[]>();
  for (const f of files) {
    const p = parsed.get(f.path);
    if (!p) continue;
    const ids: string[] = [];
    for (let i = 0; i < p.symbols.length; i++) ids.push(newId("sym"));
    idByFileIndex.set(f.path, ids);
    const refs: SymRef[] = [];
    p.symbols.forEach((s, i) => {
      const ref: SymRef = { id: ids[i], name: s.name, kind: s.kind, filePath: f.path, exported: s.exported, parentId: s.parentIndex !== undefined ? ids[s.parentIndex] : undefined, startLine: s.startLine, endLine: s.endLine };
      refs.push(ref);
      const list = symsByName.get(s.name) ?? [];
      list.push(ref);
      symsByName.set(s.name, list);
      const decorators = p.decorators.get(i);
      const complexity = p.complexity.get(i);
      symbolRows.push({
        id: ids[i], projectId, fileId: f.id, filePath: f.path, name: s.name, qualifiedName: s.qualifiedName, kind: s.kind, startLine: s.startLine, endLine: s.endLine,
        signature: s.signature ?? null, visibility: s.visibility, parentId: ref.parentId ?? null, documentation: s.documentation ?? null, exported: s.exported,
        meta: { ...(s.meta ?? {}), ...(decorators ? { decorators } : {}), ...(complexity !== undefined ? { complexity } : {}) },
      });
    });
    symsByFile.set(f.path, refs);
  }

  const rels: RelDraft[] = [];
  const relKey = new Set<string>();
  const addRel = (r: RelDraft) => {
    const key = `${r.kind}|${r.sourceId}|${r.targetId}`;
    if (relKey.has(key)) return;
    relKey.add(key);
    rels.push(r);
  };

  const fileImports = new Map<string, Set<string>>();
  const fileImportedNames = new Map<string, Map<string, string>>(); // path -> (name -> targetPath)
  const modelNames = new Map<string, SymRef>();
  for (const [, refs] of symsByFile) for (const r of refs) if (r.kind === "model" || r.kind === "table") modelNames.set(r.name.toLowerCase(), r);

  for (const f of files) {
    const p = parsed.get(f.path);
    if (!p) continue;
    const importsResolved = new Set<string>();
    const importedNames = new Map<string, string>();
    const externals = new Set<string>();
    for (const imp of p.imports) {
      const target = resolveImport(f.path, imp.specifier, f.language, pathSet, aliases);
      if (target && target !== f.path) {
        importsResolved.add(target);
        addRel({ kind: "IMPORTS", sourceType: "file", sourceId: f.id, targetType: "file", targetId: filesByPath.get(target)!.id, filePath: f.path, line: imp.line, confidence: 1, meta: { specifier: imp.specifier, names: imp.names.slice(0, 20), typeOnly: imp.isTypeOnly ?? false } });
        for (const n of imp.names) {
          importedNames.set(n, target);
          const targetSym = (symsByFile.get(target) ?? []).find((s) => s.name === n && !s.parentId);
          if (targetSym) addRel({ kind: "USES", sourceType: "file", sourceId: f.id, targetType: "symbol", targetId: targetSym.id, filePath: f.path, line: imp.line, confidence: 0.95 });
        }
      } else if (!target) {
        const pkg = externalPackageName(imp.specifier, f.language);
        if (pkg && !externals.has(pkg)) {
          externals.add(pkg);
          addRel({ kind: "DEPENDS_ON", sourceType: "file", sourceId: f.id, targetType: "external", targetId: `pkg:${pkg}`, filePath: f.path, line: imp.line, confidence: 1, meta: { specifier: imp.specifier, names: imp.names.slice(0, 20) } });
        }
      }
    }
    fileImports.set(f.path, importsResolved);
    fileImportedNames.set(f.path, importedNames);
  }

  const resolveName = (name: string, fromPath: string): { ref: SymRef; confidence: number } | undefined => {
    const cands = symsByName.get(name);
    if (!cands || cands.length === 0) return undefined;
    const local = cands.find((c) => c.filePath === fromPath);
    if (local) return { ref: local, confidence: 0.9 };
    const importedFrom = fileImportedNames.get(fromPath)?.get(name);
    if (importedFrom) {
      const hit = cands.find((c) => c.filePath === importedFrom);
      if (hit) return { ref: hit, confidence: 0.95 };
    }
    const imports = fileImports.get(fromPath) ?? new Set();
    const viaImport = cands.filter((c) => imports.has(c.filePath));
    if (viaImport.length === 1) return { ref: viaImport[0], confidence: 0.85 };
    if (viaImport.length > 1) return { ref: viaImport[0], confidence: 0.6 };
    const exported = cands.filter((c) => c.exported && !c.parentId);
    if (exported.length === 1) return { ref: exported[0], confidence: 0.5 };
    if (cands.length === 1) return { ref: cands[0], confidence: 0.4 };
    return undefined;
  };

  for (const f of files) {
    const p = parsed.get(f.path);
    if (!p) continue;
    const ids = idByFileIndex.get(f.path)!;
    const refs = symsByFile.get(f.path) ?? [];
    // Inheritance
    for (const inh of p.inheritance) {
      const childId = ids[inh.childIndex];
      const parentName = inh.parentName.split(/[.:]/).pop()!;
      const resolved = resolveName(parentName, f.path);
      if (resolved && resolved.ref.id !== childId) addRel({ kind: inh.kind, sourceType: "symbol", sourceId: childId, targetType: "symbol", targetId: resolved.ref.id, filePath: f.path, line: p.symbols[inh.childIndex].startLine, confidence: resolved.confidence });
      else addRel({ kind: inh.kind, sourceType: "symbol", sourceId: childId, targetType: "external", targetId: `type:${inh.parentName}`, filePath: f.path, line: p.symbols[inh.childIndex].startLine, confidence: 0.7 });
    }
    // Calls
    const seenCall = new Set<string>();
    for (const call of p.calls) {
      const sourceType = call.callerIndex !== undefined ? "symbol" : "file";
      const sourceId = call.callerIndex !== undefined ? ids[call.callerIndex] : f.id;
      const key = `${sourceId}|${call.name}|${call.expression}`;
      // Data access heuristics: <model>.<verb> or repo.<verb>(Model)
      const exprLower = call.expression.toLowerCase();
      const segs = exprLower.split(/[.:]/);
      for (const seg of segs.slice(0, -1)) {
        const model = modelNames.get(seg) ?? modelNames.get(seg.replace(/s$/, "")) ?? modelNames.get(seg + "s");
        if (model && sourceId !== model.id) {
          if (WRITE_VERBS.test(call.name)) addRel({ kind: "WRITES_TO", sourceType, sourceId, targetType: "symbol", targetId: model.id, filePath: f.path, line: call.line, confidence: 0.7, meta: { expression: call.expression } });
          else if (READ_VERBS.test(call.name)) addRel({ kind: "READS_FROM", sourceType, sourceId, targetType: "symbol", targetId: model.id, filePath: f.path, line: call.line, confidence: 0.7, meta: { expression: call.expression } });
          break;
        }
      }
      // Event heuristics
      const firstArg = call.args?.[0];
      const strArg = firstArg && /^['"`]/.test(firstArg) ? firstArg.replace(/^['"`]|['"`]$/g, "") : undefined;
      if (strArg && strArg.length < 80 && !/^\//.test(strArg)) {
        if (/^(emit|publish|dispatch|trigger|enqueue|sendEvent|broadcast|produce|notify)$/.test(call.name)) addRel({ kind: "EMITS", sourceType, sourceId, targetType: "external", targetId: `event:${strArg}`, filePath: f.path, line: call.line, confidence: 0.7 });
        if (/^(on|once|subscribe|addListener|addEventListener|consume|listen|handle|register|process|receive)$/.test(call.name) && !/^(click|change|submit|load|error|close|open|message|data|end|keydown|keyup|input|focus|blur|scroll|resize)$/.test(strArg)) addRel({ kind: "SUBSCRIBES_TO", sourceType, sourceId, targetType: "external", targetId: `event:${strArg}`, filePath: f.path, line: call.line, confidence: 0.6 });
      }
      if (seenCall.has(key)) continue;
      seenCall.add(key);
      const resolved = resolveName(call.name, f.path);
      if (!resolved) continue;
      if (!CALLABLE_KINDS.has(resolved.ref.kind)) continue;
      if (resolved.ref.id === sourceId) continue;
      const isCtor = call.isNew || (resolved.ref.kind === "class" || resolved.ref.kind === "service" || resolved.ref.kind === "model" || resolved.ref.kind === "struct");
      const kind = isCtor && (call.isNew || /^[A-Z]/.test(call.name)) ? "INSTANTIATES" : resolved.ref.kind === "component" && /^[A-Z]/.test(call.name) ? "USES" : "CALLS";
      addRel({ kind, sourceType, sourceId, targetType: "symbol", targetId: resolved.ref.id, filePath: f.path, line: call.line, confidence: resolved.confidence, meta: { expression: call.expression } });
    }
    // JSX component usage: identifiers matching imported component symbols
    if (f.language === "TypeScript" || f.language === "JavaScript") {
      for (const [name, target] of fileImportedNames.get(f.path) ?? []) {
        if (!/^[A-Z]/.test(name)) continue;
        if (!p.identifiers.has(name)) continue;
        const targetSym = (symsByFile.get(target) ?? []).find((s) => s.name === name && !s.parentId);
        if (targetSym && (targetSym.kind === "component" || targetSym.kind === "hook")) {
          const users = refs.filter((r) => r.kind === "component" || r.kind === "function" || r.kind === "hook");
          const src = users[0];
          addRel({ kind: "USES", sourceType: src ? "symbol" : "file", sourceId: src ? src.id : f.id, targetType: "symbol", targetId: targetSym.id, filePath: f.path, confidence: 0.8 });
        }
      }
    }
    // Tests
    if (f.isTest) {
      for (const target of fileImports.get(f.path) ?? []) {
        const tf = filesByPath.get(target);
        if (tf && !tf.isTest) addRel({ kind: "TESTS", sourceType: "file", sourceId: f.id, targetType: "file", targetId: tf.id, filePath: f.path, confidence: 0.9 });
      }
      const called = new Set<string>();
      for (const call of p.calls) {
        const r = resolveName(call.name, f.path);
        if (r && r.ref.filePath !== f.path && !filesByPath.get(r.ref.filePath)?.isTest && !called.has(r.ref.id)) {
          called.add(r.ref.id);
          addRel({ kind: "TESTS", sourceType: "file", sourceId: f.id, targetType: "symbol", targetId: r.ref.id, filePath: f.path, line: call.line, confidence: Math.min(0.9, r.confidence) });
        }
      }
      // Fallback: name-based test target (foo.test.ts -> foo.ts)
      if (![...fileImports.get(f.path) ?? []].length) {
        const base = f.name.replace(/[._-](test|spec)\.[^.]+$/, "").replace(/^test_/, "").replace(/_test\.(py|go)$/, "");
        const cand = allFiles.find((o) => !o.isTest && !o.isExcluded && o.name.replace(/\.[^.]+$/, "") === base.replace(/\.[^.]+$/, ""));
        if (cand) addRel({ kind: "TESTS", sourceType: "file", sourceId: f.id, targetType: "file", targetId: cand.id, filePath: f.path, confidence: 0.6 });
      }
    }
  }

  // Counts and importance
  const inbound = new Map<string, number>();
  const outbound = new Map<string, number>();
  for (const r of rels) {
    outbound.set(r.sourceId, (outbound.get(r.sourceId) ?? 0) + 1);
    inbound.set(r.targetId, (inbound.get(r.targetId) ?? 0) + 1);
  }
  const importance = computeImportance(rels, [...symbolRows.map((s) => s.id), ...files.map((f) => f.id)]);
  for (const s of symbolRows) {
    s.inboundCount = inbound.get(s.id) ?? 0;
    s.outboundCount = outbound.get(s.id) ?? 0;
    let imp = importance.get(s.id) ?? 0;
    if (s.exported) imp += 0.05;
    if (s.kind === "endpoint" || s.kind === "model" || s.kind === "service" || s.kind === "job") imp += 0.1;
    if ((s.meta as Record<string, unknown> | undefined)?.entry) imp += 0.3;
    s.importance = Math.min(1, imp);
  }

  const importanceById = new Map(symbolRows.map((r) => [r.id, r.importance ?? 0]));
  db.transaction((tx) => {
    for (let i = 0; i < symbolRows.length; i += 200) tx.insert(schema.symbols).values(symbolRows.slice(i, i + 200)).run();
    const relRows = rels.map((r) => ({ id: newId("rel"), projectId, kind: r.kind, sourceType: r.sourceType, sourceId: r.sourceId, targetType: r.targetType, targetId: r.targetId, filePath: r.filePath ?? null, line: r.line ?? null, confidence: r.confidence, meta: r.meta ?? null }));
    for (let i = 0; i < relRows.length; i += 200) tx.insert(schema.relationships).values(relRows.slice(i, i + 200)).run();
    for (const f of files) {
      const p = parsed.get(f.path);
      const fileImp = importance.get(f.id) ?? 0;
      let symImp = 0;
      for (const sr of symsByFile.get(f.path) ?? []) symImp = Math.max(symImp, importanceById.get(sr.id) ?? 0);
      tx.update(schema.files).set({
        imports: [...(fileImports.get(f.path) ?? [])],
        exports: p?.exports.slice(0, 200) ?? [],
        parseStatus: p ? (p.status === "ast" ? "ast" : p.status === "text" ? "text" : "skipped") : "error",
        parseError: p?.error ?? null,
        module: f.directory || ".",
        importance: Math.min(1, fileImp * 0.7 + symImp * 0.3 + (inbound.get(f.id) ?? 0) * 0.01),
      }).where(and(eq(schema.files.id, f.id), eq(schema.files.projectId, projectId))).run();
    }
  });

  result.symbols = symbolRows.length;
  result.relationships = rels.length;
  return result;
}

/** Simplified PageRank over the relationship graph; returns scores normalized to [0,1]. */
export function computeImportance(rels: RelDraft[], nodeIds: string[], iterations = 20): Map<string, number> {
  const nodes = new Set(nodeIds);
  const out = new Map<string, string[]>();
  for (const r of rels) {
    if (!nodes.has(r.sourceId) || !nodes.has(r.targetId)) continue;
    const list = out.get(r.sourceId) ?? [];
    list.push(r.targetId);
    out.set(r.sourceId, list);
  }
  const n = nodes.size || 1;
  let rank = new Map<string, number>([...nodes].map((id) => [id, 1 / n]));
  const d = 0.85;
  for (let i = 0; i < iterations; i++) {
    const next = new Map<string, number>([...nodes].map((id) => [id, (1 - d) / n]));
    for (const id of nodes) {
      const targets = out.get(id);
      const r = rank.get(id) ?? 0;
      if (!targets || targets.length === 0) continue;
      const share = (d * r) / targets.length;
      for (const t of targets) next.set(t, (next.get(t) ?? 0) + share);
    }
    rank = next;
  }
  const max = maxOf(rank.values(), 1e-9);
  const norm = new Map<string, number>();
  for (const [id, v] of rank) norm.set(id, v / max);
  return norm;
}
