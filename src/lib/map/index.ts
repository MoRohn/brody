import { eq } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import type { FileRow, FindingRow, RelationshipRow, SymbolRow } from "../db/schema";
import type { Architecture } from "../discover/types";
import { AREA_HINTS } from "../discover/catalog";
import { glyphFor, riskGlyph, type NodeType, type RiskLevel } from "./legend";

export * from "./legend";

export interface GraphNode {
  id: string;
  label: string;
  type: NodeType;
  path?: string;
  line?: number;
  risk: RiskLevel;
  size: number;
  area?: string;
  group?: string;
  meta?: Record<string, unknown>;
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: string;
  weight: number;
}
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  totalNodes: number;
}

interface Model {
  files: FileRow[];
  filesById: Map<string, FileRow>;
  filesByPath: Map<string, FileRow>;
  symbols: SymbolRow[];
  symbolsById: Map<string, SymbolRow>;
  rels: RelationshipRow[];
  findings: FindingRow[];
  arch: Architecture;
  fileRisk: Map<string, RiskLevel>;
  symbolRisk: Map<string, RiskLevel>;
  /** file -> file edges aggregated from imports and cross-file symbol relationships */
  fileEdges: Map<string, Map<string, { kind: string; weight: number }>>;
}

const cache = new Map<string, { stamp: number; model: Model }>();
const SEV_RANK: Record<string, number> = { Critical: 4, High: 3, Medium: 2, Low: 1, Informational: 0 };
const RISK_BY_RANK: RiskLevel[] = ["none", "low", "medium", "high", "critical"];

export function loadModel(projectId: string): Model {
  const db = getDb();
  const project = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!project) throw new Error("Project not found");
  const hit = cache.get(projectId);
  if (hit && hit.stamp === project.updatedAt) return hit.model;
  const files = db.select().from(schema.files).where(eq(schema.files.projectId, projectId)).all().filter((f) => !f.isExcluded);
  const symbols = db.select().from(schema.symbols).where(eq(schema.symbols.projectId, projectId)).all();
  const rels = db.select().from(schema.relationships).where(eq(schema.relationships.projectId, projectId)).all();
  const findings = db.select().from(schema.findings).where(eq(schema.findings.projectId, projectId)).all().filter((f) => f.verification !== "rejected");
  const arch = ((project.analysis ?? {}) as { architecture?: Architecture }).architecture as Architecture;
  const filesById = new Map(files.map((f) => [f.id, f]));
  const filesByPath = new Map(files.map((f) => [f.path, f]));
  const symbolsById = new Map(symbols.map((s) => [s.id, s]));

  const fileRisk = new Map<string, RiskLevel>();
  const symbolRisk = new Map<string, RiskLevel>();
  const symsByFile = new Map<string, SymbolRow[]>();
  for (const s of symbols) { const l = symsByFile.get(s.filePath) ?? []; l.push(s); symsByFile.set(s.filePath, l); }
  const bump = (m: Map<string, RiskLevel>, key: string, rank: number) => { const cur = RISK_BY_RANK.indexOf(m.get(key) ?? "none"); if (rank > cur) m.set(key, RISK_BY_RANK[rank]); };
  for (const f of findings) {
    if (!f.filePath) continue;
    const rank = SEV_RANK[f.severity] ?? 0;
    if (rank === 0) continue;
    bump(fileRisk, f.filePath, rank);
    const inSyms = (symsByFile.get(f.filePath) ?? []).filter((s) => f.startLine && s.startLine <= f.startLine && s.endLine >= (f.endLine ?? f.startLine));
    const best = inSyms.sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0];
    if (best) bump(symbolRisk, best.id, rank);
  }

  const fileEdges = new Map<string, Map<string, { kind: string; weight: number }>>();
  const addEdge = (a: string, b: string, kind: string) => {
    if (a === b) return;
    const m = fileEdges.get(a) ?? new Map();
    const cur = m.get(b);
    if (cur) cur.weight++;
    else m.set(b, { kind, weight: 1 });
    fileEdges.set(a, m);
  };
  const pathOf = (type: string, id: string) => (type === "file" ? filesById.get(id)?.path : type === "symbol" ? symbolsById.get(id)?.filePath : undefined);
  for (const r of rels) {
    if (!["IMPORTS", "CALLS", "INSTANTIATES", "EXTENDS", "IMPLEMENTS", "USES", "READS_FROM", "WRITES_TO"].includes(r.kind)) continue;
    const a = pathOf(r.sourceType, r.sourceId);
    const b = pathOf(r.targetType, r.targetId);
    if (a && b) addEdge(a, b, r.kind === "IMPORTS" ? "IMPORTS" : r.kind === "READS_FROM" || r.kind === "WRITES_TO" ? r.kind : "CALLS");
  }
  const model: Model = { files, filesById, filesByPath, symbols, symbolsById, rels, findings, arch, fileRisk, symbolRisk, fileEdges };
  cache.set(projectId, { stamp: project.updatedAt, model });
  return model;
}

export function nodeTypeForFile(f: FileRow): NodeType {
  switch (f.role) {
    case "entry": return "entry";
    case "ui": return "ui";
    case "api": return "api";
    case "data": case "schema": return "model";
    case "test": return "test";
    case "config": return "config";
    case "infra": return "infra";
    case "job": return "job";
    case "service": case "ai": return "service";
    default: return "util";
  }
}

export function nodeTypeForSymbol(s: SymbolRow, file?: FileRow): NodeType {
  switch (s.kind) {
    case "endpoint": case "route": return "api";
    case "model": case "table": case "schema": return "model";
    case "component": case "hook": return "ui";
    case "service": return "service";
    case "job": case "event_handler": return "job";
  }
  if ((s.meta as { entry?: boolean } | null)?.entry) return "entry";
  if (file?.isTest) return "test";
  return file ? (nodeTypeForFile(file) === "entry" ? "util" : nodeTypeForFile(file)) : "util";
}

const roleDescription: Record<string, string> = { entry: "entry points", ui: "user interface", api: "API layer", service: "services", data: "data layer", schema: "schemas", job: "background jobs", ai: "AI", infra: "infrastructure", config: "configuration", test: "tests", docs: "documentation", util: "utilities" };

// ---------------------------------------------------------------------------
// A. Repository tree
// ---------------------------------------------------------------------------
export interface TreeNode {
  name: string;
  path: string;
  type: "dir" | "file";
  role?: string;
  note?: string;
  risk?: RiskLevel;
  files?: number;
  children?: TreeNode[];
  language?: string;
  lines?: number;
}

export function repositoryTree(projectId: string, opts: { includeExcluded?: boolean } = {}): TreeNode {
  const db = getDb();
  const m = loadModel(projectId);
  const rows = opts.includeExcluded ? db.select().from(schema.files).where(eq(schema.files.projectId, projectId)).all() : m.files;
  const root: TreeNode = { name: "", path: "", type: "dir", children: [], files: 0 };
  const dirRoles = new Map<string, Map<string, number>>();
  for (const f of rows) {
    const parts = f.path.split("/");
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join("/");
      let next = cur.children!.find((c) => c.type === "dir" && c.name === parts[i]);
      if (!next) { next = { name: parts[i], path: p, type: "dir", children: [], files: 0 }; cur.children!.push(next); }
      next.files = (next.files ?? 0) + 1;
      if (f.role) { const r = dirRoles.get(p) ?? new Map(); r.set(f.role, (r.get(f.role) ?? 0) + 1); dirRoles.set(p, r); }
      const risk = m.fileRisk.get(f.path);
      if (risk && RISK_BY_RANK.indexOf(risk) > RISK_BY_RANK.indexOf(next.risk ?? "none")) next.risk = risk;
      cur = next;
    }
    cur.children!.push({ name: parts[parts.length - 1], path: f.path, type: "file", role: f.role ?? f.classification, risk: m.fileRisk.get(f.path), language: f.language, lines: f.lines, note: f.isExcluded ? `excluded: ${f.excludeReason}` : undefined });
    root.files = (root.files ?? 0) + 1;
  }
  const finish = (n: TreeNode) => {
    if (n.type === "dir") {
      const r = dirRoles.get(n.path);
      const hint = AREA_HINTS.find((h) => h.match.test(n.path + "/"));
      const total = r ? [...r.values()].reduce((a, b) => a + b, 0) : 0;
      const top = r ? [...r.entries()].sort((a, b) => b[1] - a[1])[0] : undefined;
      if (top) n.role = top[0];
      if (hint && n.name.length > 0 && hint.match.test(n.name + "/")) n.note = hint.description.replace(/\.$/, "").toLowerCase();
      else if (top && total > 0 && top[1] / total >= 0.7) n.note = roleDescription[top[0]] ?? top[0];
      n.children!.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
      n.children!.forEach(finish);
    }
  };
  finish(root);
  return root;
}

export function treeToText(root: TreeNode, opts: { depth?: number; maxChildren?: number; name?: string } = {}): string {
  const maxDepth = opts.depth ?? 3;
  const maxChildren = opts.maxChildren ?? 14;
  const lines: string[] = [`${opts.name ?? "repository"}/`];
  const walk = (n: TreeNode, prefix: string, depth: number) => {
    const kids = n.children ?? [];
    const shown = kids.slice(0, maxChildren);
    shown.forEach((c, i) => {
      const last = i === shown.length - 1 && kids.length <= maxChildren;
      const risk = c.risk && c.risk !== "none" ? ` ${riskGlyph(c.risk)}` : "";
      const note = c.type === "dir" && c.note ? `  # ${c.note} (${c.files} files)` : "";
      lines.push(`${prefix}${last ? "└── " : "├── "}${c.name}${c.type === "dir" ? "/" : ""}${risk}${note}`);
      if (c.type === "dir" && depth < maxDepth) walk(c, prefix + (last ? "    " : "│   "), depth + 1);
    });
    if (kids.length > maxChildren) lines.push(`${prefix}└── … ${kids.length - maxChildren} more`);
  };
  walk(root, "", 1);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// B/C. Architecture map and dependency graphs
// ---------------------------------------------------------------------------
export function areaGraph(projectId: string): Graph {
  const m = loadModel(projectId);
  const areaOf = (p: string) => m.filesByPath.get(p)?.area ?? undefined;
  const nodes = new Map<string, GraphNode>();
  for (const a of m.arch.areas) {
    if (a.role === "docs") continue;
    const risk = a.files.reduce<RiskLevel>((acc, p) => { const r = m.fileRisk.get(p) ?? "none"; return RISK_BY_RANK.indexOf(r) > RISK_BY_RANK.indexOf(acc) ? r : acc; }, "none");
    const type: NodeType = a.role === "ui" ? "ui" : a.role === "api" ? "api" : a.role === "data" || a.role === "schema" ? "model" : a.role === "test" ? "test" : a.role === "config" ? "config" : a.role === "infra" ? "infra" : a.role === "job" ? "job" : a.role === "entry" ? "entry" : a.role === "util" ? "util" : "service";
    nodes.set(a.name, { id: a.name, label: a.name, type, risk, size: a.files.length, area: a.name, group: "area", meta: { files: a.files.length, role: a.role } });
  }
  const weights = new Map<string, number>();
  for (const [a, targets] of m.fileEdges) for (const [b, e] of targets) {
    const aa = areaOf(a), ab = areaOf(b);
    if (!aa || !ab || aa === ab || !nodes.has(aa) || !nodes.has(ab)) continue;
    weights.set(`${aa}\u0000${ab}`, (weights.get(`${aa}\u0000${ab}`) ?? 0) + e.weight);
  }
  const edges: GraphEdge[] = [...weights.entries()].map(([k, w]) => { const [s, t] = k.split("\u0000"); return { id: `${s}->${t}`, source: s, target: t, kind: "CALLS", weight: w }; });
  // External services as star nodes
  for (const s of m.arch.externalServices.filter((x) => !["ai-framework", "observability", "analytics"].includes(x.category)).slice(0, 12)) {
    const id = `ext:${s.name}`;
    nodes.set(id, { id, label: s.name, type: "external", risk: "none", size: 1, group: "external", meta: { category: s.category } });
    const areas = new Map<string, number>();
    for (const e of s.evidence) { const a = areaOf(e.path); if (a && nodes.has(a)) areas.set(a, (areas.get(a) ?? 0) + 1); }
    for (const [a, w] of areas) edges.push({ id: `${a}->${id}`, source: a, target: id, kind: "OPTIONAL", weight: w });
  }
  return { nodes: [...nodes.values()], edges, truncated: false, totalNodes: nodes.size };
}

export function moduleGraph(projectId: string, opts: { area?: string; directory?: string; limit?: number } = {}): Graph {
  const m = loadModel(projectId);
  const limit = opts.limit ?? 60;
  let files = m.files.filter((f) => !f.isTest && ["source", "schema", "config"].includes(f.classification));
  if (opts.area) files = files.filter((f) => f.area === opts.area);
  if (opts.directory) files = files.filter((f) => f.path.startsWith(opts.directory!.replace(/\/?$/, "/")));
  const total = files.length;
  files = files.sort((a, b) => b.importance - a.importance).slice(0, limit);
  const ids = new Set(files.map((f) => f.path));
  const nodes: GraphNode[] = files.map((f) => ({ id: f.path, label: f.name, type: nodeTypeForFile(f), path: f.path, line: 1, risk: m.fileRisk.get(f.path) ?? "none", size: Math.max(1, Math.round(f.importance * 10)), area: f.area ?? undefined, meta: { lines: f.lines, role: f.role } }));
  const edges: GraphEdge[] = [];
  for (const a of ids) for (const [b, e] of m.fileEdges.get(a) ?? []) if (ids.has(b)) edges.push({ id: `${a}->${b}`, source: a, target: b, kind: e.kind, weight: e.weight });
  return { nodes, edges, truncated: total > files.length, totalNodes: total };
}

// ---------------------------------------------------------------------------
// D. Symbol graph
// ---------------------------------------------------------------------------
export interface SymbolNeighborhood {
  symbol: { id: string; name: string; kind: string; path: string; line: number; endLine: number; signature: string | null; risk: RiskLevel };
  calledBy: { id: string; name: string; path: string; line: number; kind: string }[];
  calls: { id: string; name: string; path: string; line: number; kind: string }[];
  imports: string[];
  extends: string[];
  implements: string[];
  returns: string[];
  testedBy: string[];
  reads: string[];
  writes: string[];
  routes: string[];
  findings: { id: string; code: string; title: string; severity: string }[];
}

export function symbolNeighborhood(projectId: string, symbolId: string): SymbolNeighborhood | undefined {
  const m = loadModel(projectId);
  const s = m.symbolsById.get(symbolId);
  if (!s) return undefined;
  const ref = (id: string) => { const t = m.symbolsById.get(id); return t ? { id: t.id, name: t.qualifiedName, path: t.filePath, line: t.startLine, kind: t.kind } : undefined; };
  const out: SymbolNeighborhood = { symbol: { id: s.id, name: s.qualifiedName, kind: s.kind, path: s.filePath, line: s.startLine, endLine: s.endLine, signature: s.signature, risk: m.symbolRisk.get(s.id) ?? "none" }, calledBy: [], calls: [], imports: [], extends: [], implements: [], returns: [], testedBy: [], reads: [], writes: [], routes: [], findings: [] };
  const file = m.filesByPath.get(s.filePath);
  const seen = new Set<string>();
  for (const r of m.rels) {
    const key = `${r.kind}|${r.sourceId}|${r.targetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (r.targetId === s.id) {
      if (["CALLS", "INSTANTIATES", "USES"].includes(r.kind)) {
        const src = r.sourceType === "symbol" ? ref(r.sourceId) : r.sourceType === "file" ? (() => { const f = m.filesById.get(r.sourceId); return f ? { id: f.id, name: f.path, path: f.path, line: r.line ?? 1, kind: "file" } : undefined; })() : undefined;
        if (src) out.calledBy.push(src);
      } else if (r.kind === "TESTS") { const f = m.filesById.get(r.sourceId); if (f) out.testedBy.push(f.path); }
      else if (r.kind === "ROUTES_TO") out.routes.push(String(r.sourceId).replace(/^route:/, ""));
      else if (r.kind === "WRITES_TO" || r.kind === "READS_FROM") { const src = m.symbolsById.get(r.sourceId); if (src) (r.kind === "WRITES_TO" ? out.writes : out.reads).push(`${src.qualifiedName} (${src.filePath}:${r.line ?? src.startLine})`); }
      else if (r.kind === "EXTENDS" || r.kind === "IMPLEMENTS") { const src = m.symbolsById.get(r.sourceId); if (src) out.calledBy.push({ id: src.id, name: `${src.qualifiedName} (${r.kind.toLowerCase()})`, path: src.filePath, line: src.startLine, kind: src.kind }); }
    }
    if (r.sourceId === s.id) {
      if (["CALLS", "INSTANTIATES", "USES"].includes(r.kind) && r.targetType === "symbol") { const t = ref(r.targetId); if (t) out.calls.push(t); }
      else if (r.kind === "EXTENDS") out.extends.push(m.symbolsById.get(r.targetId)?.qualifiedName ?? r.targetId.replace(/^type:/, ""));
      else if (r.kind === "IMPLEMENTS") out.implements.push(m.symbolsById.get(r.targetId)?.qualifiedName ?? r.targetId.replace(/^type:/, ""));
      else if (r.kind === "READS_FROM" || r.kind === "WRITES_TO") { const t = m.symbolsById.get(r.targetId); if (t) (r.kind === "WRITES_TO" ? out.writes : out.reads).push(`${t.qualifiedName} (${t.filePath})`); }
    }
  }
  if (file) for (const r of m.rels) if (r.kind === "IMPORTS" && r.sourceId === file.id) { const t = m.filesById.get(r.targetId); if (t) out.imports.push(t.path); else if (r.targetType === "external") out.imports.push(r.targetId.replace(/^pkg:/, "")); }
  if (file) for (const r of m.rels) if (r.kind === "DEPENDS_ON" && r.sourceId === file.id) out.imports.push(r.targetId.replace(/^pkg:/, ""));
  const ret = s.signature?.match(/(?:\)\s*(?::|->)\s*|=>\s*)([A-Z][\w<>\[\]|]*)/)?.[1]?.replace(/<.*$/, "");
  if (ret) out.returns.push(ret);
  const uniq = <T,>(xs: T[], key: (x: T) => string) => { const s2 = new Set<string>(); return xs.filter((x) => { const k = key(x); if (s2.has(k)) return false; s2.add(k); return true; }); };
  out.calledBy = uniq(out.calledBy, (x) => x.id).slice(0, 30);
  out.calls = uniq(out.calls, (x) => x.id).slice(0, 30);
  out.imports = [...new Set(out.imports)].slice(0, 30);
  out.testedBy = [...new Set(out.testedBy)];
  out.reads = [...new Set(out.reads)].slice(0, 20);
  out.writes = [...new Set(out.writes)].slice(0, 20);
  out.findings = m.findings.filter((f) => f.filePath === s.filePath && f.startLine && f.startLine >= s.startLine && f.startLine <= s.endLine).map((f) => ({ id: f.id, code: f.code, title: f.title, severity: f.severity }));
  return out;
}

export function symbolGraph(projectId: string, symbolId: string, depth = 1, limit = 50): Graph {
  const m = loadModel(projectId);
  const start = m.symbolsById.get(symbolId);
  if (!start) return { nodes: [], edges: [], truncated: false, totalNodes: 0 };
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const adj = new Map<string, { other: string; kind: string; dir: "out" | "in" }[]>();
  for (const r of m.rels) {
    if (r.sourceType !== "symbol" || r.targetType !== "symbol") continue;
    if (!["CALLS", "INSTANTIATES", "USES", "EXTENDS", "IMPLEMENTS", "READS_FROM", "WRITES_TO"].includes(r.kind)) continue;
    (adj.get(r.sourceId) ?? adj.set(r.sourceId, []).get(r.sourceId)!).push({ other: r.targetId, kind: r.kind, dir: "out" });
    (adj.get(r.targetId) ?? adj.set(r.targetId, []).get(r.targetId)!).push({ other: r.sourceId, kind: r.kind, dir: "in" });
  }
  const addNode = (s: SymbolRow) => { if (!nodes.has(s.id)) nodes.set(s.id, { id: s.id, label: s.qualifiedName, type: nodeTypeForSymbol(s, m.filesByPath.get(s.filePath)), path: s.filePath, line: s.startLine, risk: m.symbolRisk.get(s.id) ?? "none", size: Math.max(1, Math.round(s.importance * 10)) }); };
  addNode(start);
  let frontier = [start.id];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const id of frontier) for (const e of (adj.get(id) ?? []).slice(0, 20)) {
      const o = m.symbolsById.get(e.other);
      if (!o || nodes.size >= limit) continue;
      const isNew = !nodes.has(o.id);
      addNode(o);
      const [src, tgt] = e.dir === "out" ? [id, o.id] : [o.id, id];
      if (!edges.some((x) => x.source === src && x.target === tgt && x.kind === e.kind)) edges.push({ id: `${src}->${tgt}:${e.kind}`, source: src, target: tgt, kind: e.kind, weight: 1 });
      if (isNew) next.push(o.id);
    }
    frontier = next;
  }
  return { nodes: [...nodes.values()], edges, truncated: nodes.size >= limit, totalNodes: nodes.size };
}

// ---------------------------------------------------------------------------
// E. Change impact
// ---------------------------------------------------------------------------
export interface ImpactNode { id: string; label: string; path?: string; line?: number; type: NodeType; depth: number; via: string }
export interface ImpactResult {
  target: { id: string; label: string; path: string; line?: number; type: "file" | "symbol" };
  upstream: ImpactNode[];
  downstream: ImpactNode[];
  affectedRoutes: { route: string; path: string; line: number }[];
  affectedTests: string[];
  chains: string[][];
  summary: string;
}

export function changeImpact(projectId: string, target: { type: "file" | "symbol"; id: string }, maxDepth = 4): ImpactResult | undefined {
  const m = loadModel(projectId);
  const up = new Map<string, string[]>(); // node -> callers
  const down = new Map<string, string[]>();
  const relKinds = target.type === "file" ? ["IMPORTS", "CALLS", "INSTANTIATES", "USES", "EXTENDS", "IMPLEMENTS"] : ["CALLS", "INSTANTIATES", "USES", "EXTENDS", "IMPLEMENTS", "READS_FROM", "WRITES_TO", "ROUTES_TO"];
  const nodeKey = (type: string, id: string): string | undefined => target.type === "file" ? (type === "file" ? m.filesById.get(id)?.path : type === "symbol" ? m.symbolsById.get(id)?.filePath : undefined) : type === "symbol" ? id : type === "file" ? `file:${id}` : `ext:${id}`;
  for (const r of m.rels) {
    if (!relKinds.includes(r.kind)) continue;
    const a = nodeKey(r.sourceType, r.sourceId);
    const b = nodeKey(r.targetType, r.targetId);
    if (!a || !b || a === b) continue;
    (down.get(a) ?? down.set(a, []).get(a)!).push(b);
    (up.get(b) ?? up.set(b, []).get(b)!).push(a);
  }
  let startKey: string;
  let targetInfo: ImpactResult["target"];
  if (target.type === "file") {
    const f = m.filesById.get(target.id) ?? m.filesByPath.get(target.id);
    if (!f) return undefined;
    startKey = f.path;
    targetInfo = { id: f.id, label: f.path, path: f.path, type: "file" };
  } else {
    const s = m.symbolsById.get(target.id);
    if (!s) return undefined;
    startKey = s.id;
    targetInfo = { id: s.id, label: s.qualifiedName, path: s.filePath, line: s.startLine, type: "symbol" };
  }
  const describe = (key: string, depth: number, via: string): ImpactNode => {
    if (target.type === "file") { const f = m.filesByPath.get(key); return { id: key, label: key, path: key, line: 1, type: f ? nodeTypeForFile(f) : "util", depth, via }; }
    const s = m.symbolsById.get(key);
    if (s) return { id: key, label: s.qualifiedName, path: s.filePath, line: s.startLine, type: nodeTypeForSymbol(s, m.filesByPath.get(s.filePath)), depth, via };
    return { id: key, label: key.replace(/^(file|ext):/, ""), type: "util", depth, via };
  };
  const bfs = (adj: Map<string, string[]>) => {
    const parent = new Map<string, string>();
    const depth = new Map<string, number>([[startKey, 0]]);
    let frontier = [startKey];
    const nodes: ImpactNode[] = [];
    for (let d = 1; d <= maxDepth && frontier.length; d++) {
      const next: string[] = [];
      for (const k of frontier) for (const o of adj.get(k) ?? []) {
        if (depth.has(o)) continue;
        depth.set(o, d);
        parent.set(o, k);
        next.push(o);
        nodes.push(describe(o, d, k === startKey ? "direct" : `via ${describe(k, d - 1, "").label}`));
        if (nodes.length > 200) return { nodes, parent };
      }
      frontier = next;
    }
    return { nodes, parent };
  };
  const upward = bfs(up);
  const downward = bfs(down);
  // Routes affected: any upstream file/symbol that handles a route.
  const routeRels = m.rels.filter((r) => r.kind === "ROUTES_TO");
  const affectedRoutes: ImpactResult["affectedRoutes"] = [];
  const upstreamKeys = new Set([startKey, ...upward.nodes.map((n) => n.id)]);
  for (const r of routeRels) {
    const s = m.symbolsById.get(r.targetId);
    if (!s) continue;
    const key = target.type === "file" ? s.filePath : s.id;
    if (upstreamKeys.has(key)) affectedRoutes.push({ route: String(r.sourceId).replace(/^route:/, ""), path: s.filePath, line: s.startLine });
  }
  // Tests
  const affectedTests = new Set<string>();
  for (const r of m.rels) {
    if (r.kind !== "TESTS") continue;
    const tk = r.targetType === "file" ? m.filesById.get(r.targetId)?.path : m.symbolsById.get(r.targetId)?.filePath;
    const tsym = r.targetType === "symbol" ? r.targetId : undefined;
    const hit = target.type === "file" ? (tk && upstreamKeys.has(tk)) : ((tsym && upstreamKeys.has(tsym)) || (tk && tk === targetInfo.path));
    if (hit) { const tf = m.filesById.get(r.sourceId); if (tf) affectedTests.add(tf.path); }
  }
  // Chains from target up to terminal consumers (routes, UI, entry)
  const chains: string[][] = [];
  const terminals = upward.nodes.filter((n) => ["api", "ui", "entry", "job"].includes(n.type)).sort((a, b) => a.depth - b.depth).slice(0, 5);
  for (const t of terminals) {
    const chain: string[] = [];
    let cur: string | undefined = t.id;
    while (cur) { chain.push(describe(cur, 0, "").label); cur = upward.parent.get(cur); }
    chains.push(chain.reverse());
  }
  const chainsOrdered = chains;
  const summary = `Changing ${targetInfo.label} can affect ${upward.nodes.length} upstream ${upward.nodes.length === 1 ? "component" : "components"}${affectedRoutes.length ? `, including ${affectedRoutes.length} route${affectedRoutes.length > 1 ? "s" : ""}` : ""}, and depends on ${downward.nodes.length} downstream ${downward.nodes.length === 1 ? "component" : "components"}. ${affectedTests.size ? `${affectedTests.size} test file(s) exercise this code.` : "No test is known to exercise this code."}`;
  return { target: targetInfo, upstream: upward.nodes, downstream: downward.nodes, affectedRoutes: affectedRoutes.slice(0, 20), affectedTests: [...affectedTests], chains: chainsOrdered, summary };
}

// ---------------------------------------------------------------------------
// Textual and Mermaid renderings
// ---------------------------------------------------------------------------
const boxLine = (text: string, width: number) => `│ ${text.padEnd(width - 2).slice(0, width - 2)} │`;
function box(title: string, lines: string[], width = 46): string[] {
  const top = `┌${"─".repeat(width)}┐`;
  return [top, boxLine(`${title}`, width), `├${"─".repeat(width)}┤`, ...lines.map((l) => boxLine(l, width)), `└${"─".repeat(width)}┘`];
}
const center = (lines: string[], width = 60) => lines.map((l) => " ".repeat(Math.max(0, Math.floor((width - l.length) / 2))) + l);

/** Generate the system architecture map from detected layers, routes, models and services. */
export function architectureDiagramText(projectId: string): string {
  const m = loadModel(projectId);
  const a = m.arch;
  const count = (role: string) => m.files.filter((f) => f.role === role).length;
  const blocks: string[][] = [];
  const hasUi = count("ui") > 0 || a.routes.some((r) => r.kind === "page");
  if (hasUi) blocks.push(box(`${glyphFor("ui")} Web / UI Layer`, [`${count("ui")} files, ${a.routes.filter((r) => r.kind === "page").length} pages`, ...a.stack.frameworks.filter((f) => ["frontend-framework", "ui-library"].includes(f.category)).slice(0, 2).map((f) => f.name)]));
  const apiRoutes = a.routes.filter((r) => r.kind !== "page");
  if (apiRoutes.length || count("api")) blocks.push(box(`${glyphFor("api")} API Layer`, [`${apiRoutes.length} routes`, ...[...new Set(apiRoutes.map((r) => r.framework))].slice(0, 2)]));
  const workerFiles = new Set(a.entryPoints.filter((e) => e.kind === "worker" || e.kind === "scheduled").map((e) => e.path));
  if (workerFiles.size || count("job")) blocks.push(box(`${glyphFor("job")} Background Jobs`, [`${Math.max(count("job"), workerFiles.size)} files`, ...a.entryPoints.filter((e) => e.kind === "worker" || e.kind === "scheduled").slice(0, 2).map((e) => e.path)]));
  const svc = m.files.filter((f) => f.role === "service" || f.role === "util" || f.role === "ai");
  if (svc.length) blocks.push(box(`${glyphFor("service")} Service / Domain Layer`, [`${svc.length} files`, ...a.areas.filter((x) => x.role === "service").slice(0, 3).map((x) => x.name)]));
  const dataBox = box(`${glyphFor("model")} Data Layer`, [`${a.models.length} models`, ...a.stack.databases.slice(0, 3)]);
  const ext = a.externalServices.filter((s) => !["observability", "analytics", "ai-framework"].includes(s.category));
  const extBox = box(`${glyphFor("external")} External Services`, ext.length ? ext.slice(0, 6).map((s) => `${s.name} (${s.category})`) : ["none detected"]);
  const out: string[] = [];
  const entries = a.entryPoints.filter((e) => e.kind !== "test-runner").slice(0, 3);
  if (entries.length) { out.push(...center(box(`${glyphFor("entry")} Entry Points`, entries.map((e) => `${e.path} (${e.kind})`))), ...center(["│", "▼"])); }
  blocks.forEach((b, i) => { out.push(...center(b)); if (i < blocks.length - 1) out.push(...center(["│", "▼"])); });
  out.push(...center(["│", "├───────────────┐", "▼               ▼"]));
  const left = dataBox;
  const right = extBox;
  const h = Math.max(left.length, right.length);
  for (let i = 0; i < h; i++) out.push(`${(left[i] ?? "").padEnd(48)}  ${right[i] ?? ""}`);
  return out.join("\n");
}

function mermaidId(s: string): string { return "n" + s.replace(/[^A-Za-z0-9]/g, "_").slice(0, 50) + "_" + Math.abs([...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)).toString(36); }
const mmLabel = (s: string) => s.replace(/"/g, "'").replace(/[\[\]{}()<>]/g, " ").slice(0, 48);

export function graphToMermaid(g: Graph, direction: "LR" | "TD" = "LR"): string {
  const lines = [`flowchart ${direction}`];
  for (const n of g.nodes) {
    const label = `${glyphFor(n.type)} ${mmLabel(n.label)}${n.risk !== "none" ? ` ${riskGlyph(n.risk)}` : ""}`;
    const id = mermaidId(n.id);
    const shape = n.type === "model" ? `${id}{{"${label}"}}` : n.type === "external" ? `${id}(["${label}"])` : n.type === "api" ? `${id}[/"${label}"/]` : n.type === "entry" ? `${id}(("${label}"))` : `${id}["${label}"]`;
    lines.push(`  ${shape}`);
  }
  for (const e of g.edges) {
    const arrow = e.kind === "IMPORTS" ? "-.->" : e.kind === "OPTIONAL" ? "-.->" : e.kind === "WRITES_TO" ? "==>" : "-->";
    lines.push(`  ${mermaidId(e.source)} ${arrow}${e.weight > 1 ? `|${e.weight}|` : ""} ${mermaidId(e.target)}`);
  }
  return lines.join("\n");
}

export function architectureMermaid(projectId: string): string {
  return graphToMermaid(areaGraph(projectId), "LR");
}

/** Entity names must be unique and made of word characters. Same-named models in different files get a folder or file suffix. */
export function entityNames(models: { id?: string; name: string; file: string }[]): Map<string, string> {
  const clean = (x: string) => x.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "_$1");
  const count = new Map<string, number>();
  for (const m of models) count.set(m.name, (count.get(m.name) ?? 0) + 1);
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const m of models) {
    let name = clean(m.name);
    if ((count.get(m.name) ?? 0) > 1) {
      const parts = m.file.replace(/\.[^./]+$/, "").split("/");
      name = clean(`${m.name}_${parts.slice(-2).join("_")}`);
    }
    let n = name; let i = 2;
    while (used.has(n)) n = `${name}_${i++}`;
    used.add(n);
    out.set(m.id ?? `${m.file}#${m.name}`, n);
  }
  return out;
}

const ER_TYPE = (t: string) => {
  const base = t.replace(/\bOptional\[|\bList\[|\blist\[|\bSet\[|\bArray</g, "").replace(/[\]>?|]/g, " ").trim().split(/\s+/)[0] ?? "";
  return (base || "field").replace(/[^A-Za-z0-9_]/g, "_").slice(0, 22) || "field";
};

/** Entity-relationship diagram for every detected model, with typed attributes and cardinality-aware relationships. */
export function erMermaid(projectId: string): string | undefined {
  const m = loadModel(projectId);
  const models = m.arch.models.slice(0, 40);
  if (models.length < 1) return undefined;
  const names = entityNames(models);
  const idOf = (x: { id?: string; file: string; name: string }) => x.id ?? `${x.file}#${x.name}`;
  const known = new Set(models.map(idOf));
  const lines = ["erDiagram"];
  for (const mod of models) {
    const fk = new Set((mod.relations ?? []).map((r) => r.via));
    lines.push(`  ${names.get(idOf(mod))} {`);
    const typed = mod.fieldTypes?.length ? mod.fieldTypes : mod.fields.map((n) => ({ name: n, type: "" }));
    for (const f of typed.slice(0, 14)) {
      const key = f.name === "id" || f.name === "_id" ? " PK" : fk.has(f.name) ? " FK" : "";
      lines.push(`    ${ER_TYPE(f.type)} ${f.name.replace(/[^A-Za-z0-9_]/g, "_")}${key}`);
    }
    if (typed.length === 0) lines.push("    field fields_not_detected");
    lines.push("  }");
  }
  // A relationship line: the owner holds the reference. "many" fields make the target a set; optional ones may be empty.
  const seen = new Set<string>();
  const relationsOf = (mod: (typeof models)[number]) => mod.relations ?? mod.references.flatMap((r) => { const t = models.find((x) => x.name === r); return t ? [{ target: idOf(t), targetName: t.name, via: "reference", cardinality: "one" as const }] : []; });
  for (const mod of models) for (const r of relationsOf(mod)) {
    if (!known.has(r.target)) continue;
    const a = names.get(idOf(mod))!; const b = names.get(r.target)!;
    const key = `${a}>${b}>${r.via}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Read left to right from the owning model: a list field means one owner has many targets; a single reference (or a foreign key) means many owners can share one target, which may be optional.
    const card = r.cardinality === "many" ? "||--o{" : r.cardinality === "optional" ? "}o--o|" : "}o--||";
    lines.push(`  ${a} ${card} ${b} : "${r.via.replace(/"/g, "")}"`);
  }
  return lines.join("\n");
}

export function impactMermaid(impact: ImpactResult): string {
  const g: Graph = { nodes: [], edges: [], truncated: false, totalNodes: 0 };
  const add = (id: string, label: string, type: NodeType) => { if (!g.nodes.some((n) => n.id === id)) g.nodes.push({ id, label, type, risk: "none", size: 1 }); };
  add(impact.target.id, impact.target.label, "service");
  for (const chain of impact.chains) for (let i = 0; i < chain.length; i++) {
    add(chain[i], chain[i], i === chain.length - 1 ? "api" : "util");
    if (i > 0) g.edges.push({ id: `${chain[i - 1]}>${chain[i]}`, source: chain[i - 1], target: chain[i], kind: "CALLS", weight: 1 });
  }
  return graphToMermaid(g, "TD");
}
