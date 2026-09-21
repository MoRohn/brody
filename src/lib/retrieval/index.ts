import { and, eq } from "drizzle-orm";
import { bulkInsert, getDb, schema, projectRows } from "../db/client";
import type { FileRow, FindingRow, RelationshipRow, SymbolRow } from "../db/schema";
import { getFileContents } from "../ingest/store";
import { getAIProvider } from "../ai";
import type { EvidenceItem } from "../ai/prompt";
import { sliceLines, tokenize } from "../util/text";

export type HitKind = "file" | "symbol" | "finding" | "doc" | "code";

export interface SearchHit {
  kind: HitKind;
  refId: string;
  title: string;
  path?: string;
  line?: number;
  endLine?: number;
  snippet?: string;
  score: number;
  signals: { lexical: number; structural: number; importance: number; semantic: number };
  meta?: Record<string, unknown>;
}

export interface SearchFilters {
  kinds?: HitKind[];
  language?: string;
  extension?: string;
  symbolKind?: string;
  severity?: string;
  category?: string;
  area?: string;
  limit?: number;
}

const STOP = new Set(["the", "a", "an", "is", "are", "was", "were", "how", "does", "do", "what", "where", "which", "who", "when", "why", "this", "that", "and", "or", "of", "to", "in", "on", "for", "with", "it", "its", "be", "by", "from", "at", "as", "work", "works", "used", "use", "uses", "can", "could", "there", "any", "all", "me", "show", "tell", "about", "happen", "happens", "after", "before", "into", "than", "then", "has", "have", "get", "gets", "i", "we", "our", "my", "code", "file", "files", "function", "defined", "define", "implemented", "implementation"]);

interface Entry {
  kind: HitKind;
  refId: string;
  path: string | null;
  title: string;
  terms: string[];
  text: string;
  embedding: number[] | null;
  extra: { language?: string; extension?: string; symbolKind?: string; severity?: string; category?: string; area?: string; line?: number; endLine?: number; importance: number };
}

interface IndexCache {
  stamp: number;
  entries: Entry[];
  df: Map<string, number>;
  avgLen: number;
  /** term -> entries containing it with their term frequency (inverted index) */
  postings: Map<string, { i: number; tf: number }[]>;
  /** lower-cased "title path" per entry for substring boosts */
  hay: string[];
  embedded: number[];
  /** symbol adjacency for structural expansion, built lazily once per index version */
  adj?: Map<string, { id: string; w: number }[]>;
}
const cache = new Map<string, IndexCache>();

export function invalidateIndex(projectId: string): void {
  cache.delete(projectId);
}

/** Build lexical (and optionally semantic) index entries for a project. */
export async function buildSearchIndex(projectId: string, opts: { embed?: boolean } = {}): Promise<{ entries: number; embedded: number }> {
  const db = getDb();
  const files = db.select().from(schema.files).where(and(eq(schema.files.projectId, projectId), eq(schema.files.isExcluded, false))).all();
  const symbols = projectRows(schema.symbols, projectId);
  const rows: (typeof schema.indexEntries.$inferInsert)[] = [];
  const symsByFile = new Map<string, SymbolRow[]>();
  for (const s of symbols) { const l = symsByFile.get(s.fileId) ?? []; l.push(s); symsByFile.set(s.fileId, l); }
  for (const f of files) {
    const syms = symsByFile.get(f.id) ?? [];
    const names = syms.filter((s) => s.kind !== "section").map((s) => s.qualifiedName);
    const text = `${f.path} [${f.language}, ${f.role ?? f.classification}${f.area ? `, ${f.area}` : ""}] ${names.slice(0, 40).join(", ")}`;
    rows.push({ projectId, kind: "file", refId: f.id, filePath: f.path, title: f.path, terms: [...tokenize(f.path), ...names.flatMap((n) => tokenize(n)), ...tokenize(f.area ?? ""), ...tokenize(f.role ?? "")].join(" "), text: text.slice(0, 1200), embedding: null });
  }
  for (const s of symbols) {
    if (s.kind === "section" && !s.documentation) { /* keep headings for doc search */ }
    const text = `${s.kind} ${s.qualifiedName} ${s.signature ?? ""} ${s.documentation ?? ""}`;
    const meta = (s.meta ?? {}) as { fields?: string[] };
    rows.push({ projectId, kind: "symbol", refId: s.id, filePath: s.filePath, title: s.qualifiedName, terms: [...tokenize(s.qualifiedName), ...tokenize(s.filePath), ...tokenize(s.kind), ...tokenize(s.documentation ?? "").slice(0, 40), ...(meta.fields ?? []).flatMap((x) => tokenize(x))].join(" "), text: text.slice(0, 900), embedding: null });
  }
  let embedded = 0;
  const provider = getAIProvider();
  if (opts.embed && provider?.embed) {
    const targets = rows.filter((r) => r.kind === "symbol" || r.kind === "file").slice(0, 4000);
    try {
      const vecs = await provider.embed(targets.map((r) => r.text.slice(0, 600)));
      targets.forEach((r, i) => { r.embedding = vecs[i]; });
      embedded = vecs.length;
    } catch { /* semantic retrieval is optional */ }
  }
  db.transaction((tx) => {
    tx.delete(schema.indexEntries).where(and(eq(schema.indexEntries.projectId, projectId), eq(schema.indexEntries.kind, "file"))).run();
    tx.delete(schema.indexEntries).where(and(eq(schema.indexEntries.projectId, projectId), eq(schema.indexEntries.kind, "symbol"))).run();
    bulkInsert(schema.indexEntries, rows);
  });
  invalidateIndex(projectId);
  return { entries: rows.length, embedded };
}

/** Add findings and generated documentation sections to the search index. */
export function indexFindingsAndDocs(projectId: string, docs: { id: string; title: string; text: string; path?: string }[]): void {
  const db = getDb();
  const findings = projectRows(schema.findings, projectId);
  db.transaction((tx) => {
    tx.delete(schema.indexEntries).where(and(eq(schema.indexEntries.projectId, projectId), eq(schema.indexEntries.kind, "finding"))).run();
    tx.delete(schema.indexEntries).where(and(eq(schema.indexEntries.projectId, projectId), eq(schema.indexEntries.kind, "doc"))).run();
    const rows: (typeof schema.indexEntries.$inferInsert)[] = [];
    for (const f of findings) {
      if (f.verification === "rejected") continue;
      const text = `${f.code} ${f.title} ${f.whatHappens} ${f.whyItMatters} ${f.remediation}`;
      rows.push({ projectId, kind: "finding", refId: f.id, filePath: f.filePath, title: `${f.code} ${f.title}`, terms: [...tokenize(f.title), ...tokenize(f.category), ...tokenize(f.severity), ...tokenize(f.filePath ?? ""), ...tokenize(f.whatHappens).slice(0, 40)].join(" "), text: text.slice(0, 1200), embedding: null });
    }
    for (const d of docs) rows.push({ projectId, kind: "doc", refId: d.id, filePath: d.path ?? null, title: d.title, terms: [...tokenize(d.title), ...tokenize(d.text).slice(0, 300)].join(" "), text: d.text.slice(0, 1500), embedding: null });
    bulkInsert(schema.indexEntries, rows);
  });
  invalidateIndex(projectId);
}

function load(projectId: string): IndexCache {
  const db = getDb();
  const stamp = db.select({ u: schema.projects.updatedAt }).from(schema.projects).where(eq(schema.projects.id, projectId)).get()?.u ?? 0;
  const hit = cache.get(projectId);
  if (hit && hit.stamp === stamp) return hit;
  const rows = projectRows(schema.indexEntries, projectId);
  const files = new Map(projectRows(schema.files, projectId).map((f) => [f.id, f]));
  const symbols = new Map(projectRows(schema.symbols, projectId).map((s) => [s.id, s]));
  const findings = new Map(projectRows(schema.findings, projectId).map((f) => [f.id, f]));
  const filesByPath = new Map([...files.values()].map((f) => [f.path, f]));
  const entries: Entry[] = rows.map((r) => {
    const kind = r.kind as HitKind;
    const extra: Entry["extra"] = { importance: 0 };
    if (kind === "file") { const f = files.get(r.refId); if (f) Object.assign(extra, { language: f.language, extension: f.extension, area: f.area ?? undefined, importance: f.importance }); }
    else if (kind === "symbol") { const s = symbols.get(r.refId); const f = s ? files.get(s.fileId) : undefined; if (s) Object.assign(extra, { symbolKind: s.kind, language: f?.language, extension: f?.extension, area: f?.area ?? undefined, line: s.startLine, endLine: s.endLine, importance: s.importance }); }
    else if (kind === "finding") { const fi = findings.get(r.refId); const f = fi?.filePath ? filesByPath.get(fi.filePath) : undefined; if (fi) Object.assign(extra, { severity: fi.severity, category: fi.category, language: f?.language, extension: f?.extension, area: fi.area ?? f?.area ?? undefined, line: fi.startLine ?? undefined, endLine: fi.endLine ?? undefined, importance: fi.severity === "Critical" ? 1 : fi.severity === "High" ? 0.7 : 0.3 }); }
    else if (kind === "doc") { const f = r.filePath ? filesByPath.get(r.filePath) : undefined; Object.assign(extra, { language: f?.language, area: f?.area ?? undefined, importance: 0.4 }); }
    return { kind, refId: r.refId, path: r.filePath, title: r.title, terms: r.terms.split(" ").filter(Boolean), text: r.text, embedding: r.embedding ?? null, extra };
  });
  const df = new Map<string, number>();
  const postings = new Map<string, { i: number; tf: number }[]>();
  let totalLen = 0;
  entries.forEach((e, i) => {
    totalLen += e.terms.length;
    const tf = new Map<string, number>();
    for (const t of e.terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [t, n] of tf) {
      df.set(t, (df.get(t) ?? 0) + 1);
      const list = postings.get(t);
      if (list) list.push({ i, tf: n }); else postings.set(t, [{ i, tf: n }]);
    }
  });
  const hay = entries.map((e) => `${e.title} ${e.path ?? ""}`.toLowerCase());
  const embedded = entries.flatMap((e, i) => (e.embedding ? [i] : []));
  const c: IndexCache = { stamp, entries, df, avgLen: entries.length ? totalLen / entries.length : 1, postings, hay, embedded };
  cache.set(projectId, c);
  return c;
}

export function queryTerms(query: string): string[] {
  const raw = tokenize(query).filter((t) => !STOP.has(t));
  const out = new Set(raw);
  for (const t of raw) { if (t.endsWith("s") && t.length > 3) out.add(t.slice(0, -1)); if (t.endsWith("ing") && t.length > 5) out.add(t.slice(0, -3)); if (t.endsWith("ed") && t.length > 4) out.add(t.slice(0, -2)); }
  return [...out];
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function passes(e: Entry, f: SearchFilters): boolean {
  if (f.kinds && f.kinds.length && !f.kinds.includes(e.kind)) return false;
  if (f.language && e.extra.language !== f.language) return false;
  if (f.extension && e.extra.extension !== f.extension.replace(/^\./, "")) return false;
  if (f.symbolKind && e.extra.symbolKind !== f.symbolKind) return false;
  if (f.severity && e.extra.severity !== f.severity) return false;
  if (f.category && e.extra.category !== f.category) return false;
  if (f.area && e.extra.area !== f.area) return false;
  return true;
}

export interface RetrievalOptions extends SearchFilters {
  /** Include a raw-content scan across file text. */
  includeCode?: boolean;
  /** Provide a precomputed query embedding for semantic scoring. */
  queryEmbedding?: number[];
}

/** Hybrid retrieval: lexical BM25, structural graph expansion, importance prior, optional semantic similarity. */
export async function search(projectId: string, query: string, opts: RetrievalOptions = {}): Promise<SearchHit[]> {
  const limit = opts.limit ?? 30;
  const idx = load(projectId);
  const terms = queryTerms(query);
  const q = query.trim().toLowerCase();
  if (!q) return [];
  let queryEmbedding = opts.queryEmbedding;
  const provider = getAIProvider();
  if (!queryEmbedding && provider?.embed && idx.entries.some((e) => e.embedding)) {
    try { queryEmbedding = (await provider.embed([query]))[0]; } catch { /* optional */ }
  }
  const k1 = 1.4, b = 0.6;
  const N = idx.entries.length || 1;
  // Candidate generation from the inverted index: only entries that share a term (or a substring, or an embedding) are scored.
  const lex = new Map<number, { score: number; matched: Set<string> }>();
  const touch = (i: number) => { let x = lex.get(i); if (!x) { x = { score: 0, matched: new Set() }; lex.set(i, x); } return x; };
  for (const t of terms) {
    const list = idx.postings.get(t);
    if (!list) continue;
    const dfv = idx.df.get(t) ?? 1;
    const idf = Math.log(1 + (N - dfv + 0.5) / (dfv + 0.5));
    for (const { i, tf } of list) {
      const len = idx.entries[i].terms.length;
      const x = touch(i);
      x.score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * len) / idx.avgLen)));
      x.matched.add(t);
    }
  }
  const phraseHit = new Set<number>();
  for (let i = 0; i < idx.hay.length; i++) {
    const h = idx.hay[i];
    let hit = false;
    for (const t of terms) if (h.includes(t)) { touch(i).matched.add(t); lex.get(i)!.score += 1.2; hit = true; }
    if (q.length >= 2 && h.includes(q)) { touch(i); phraseHit.add(i); hit = true; }
    void hit;
  }
  if (queryEmbedding) for (const i of idx.embedded) touch(i);
  const scored: SearchHit[] = [];
  for (const [i, x] of lex) {
    const e = idx.entries[i];
    if (!passes(e, opts)) continue;
    let lexical = x.score;
    if (terms.length) lexical *= 0.5 + (0.5 * x.matched.size) / terms.length;
    if (phraseHit.has(i)) lexical += 4;
    const semantic = queryEmbedding && e.embedding ? Math.max(0, cosine(queryEmbedding, e.embedding)) : 0;
    if (lexical <= 0 && semantic < 0.35) continue;
    scored.push({ kind: e.kind, refId: e.refId, title: e.title, path: e.path ?? undefined, line: e.extra.line, endLine: e.extra.endLine, snippet: e.text.slice(0, 240), score: 0, signals: { lexical, structural: 0, importance: e.extra.importance, semantic }, meta: { symbolKind: e.extra.symbolKind, severity: e.extra.severity, category: e.extra.category, language: e.extra.language, area: e.extra.area } });
  }
  let maxLex = 1e-9;
  for (const sc of scored) if (sc.signals.lexical > maxLex) maxLex = sc.signals.lexical;
  for (const s of scored) s.score = (s.signals.lexical / maxLex) * 1.0 + s.signals.semantic * 0.8 + s.signals.importance * 0.25;
  scored.sort((a, b2) => b2.score - a.score);

  // Structural expansion: neighbours of the strongest symbol hits.
  const top = scored.filter((s) => s.kind === "symbol").slice(0, 5);
  if (top.length && (!opts.kinds || opts.kinds.includes("symbol"))) {
    if (!idx.adj) {
      const rels = projectRows(schema.relationships, projectId);
      const adj = new Map<string, { id: string; w: number }[]>();
      for (const r of rels) {
        if (r.targetType !== "symbol" || r.sourceType !== "symbol") continue;
        if (!["CALLS", "INSTANTIATES", "EXTENDS", "IMPLEMENTS", "READS_FROM", "WRITES_TO", "USES", "ROUTES_TO"].includes(r.kind)) continue;
        for (const [x, y] of [[r.sourceId, r.targetId], [r.targetId, r.sourceId]]) { const l = adj.get(x) ?? []; l.push({ id: y, w: r.confidence }); adj.set(x, l); }
      }
      idx.adj = adj;
    }
    const bySym = idx.adj;
    const byId = new Map(scored.map((s) => [s.refId, s]));
    const symbolEntries = new Map(idx.entries.filter((e) => e.kind === "symbol").map((e) => [e.refId, e]));
    for (const t of top) {
      for (const nb of (bySym.get(t.refId) ?? []).slice(0, 12)) {
        const e = symbolEntries.get(nb.id);
        if (!e || !passes(e, opts)) continue;
        const bonus = 0.25 * t.score * nb.w;
        const existing = byId.get(nb.id);
        if (existing) { existing.signals.structural += bonus; existing.score += bonus; }
        else {
          const hit: SearchHit = { kind: "symbol", refId: e.refId, title: e.title, path: e.path ?? undefined, line: e.extra.line, endLine: e.extra.endLine, snippet: e.text.slice(0, 240), score: bonus + e.extra.importance * 0.1, signals: { lexical: 0, structural: bonus, importance: e.extra.importance, semantic: 0 }, meta: { symbolKind: e.extra.symbolKind, via: t.title } };
          scored.push(hit);
          byId.set(nb.id, hit);
        }
      }
    }
    scored.sort((a, b2) => b2.score - a.score);
  }

  let hits = scored.slice(0, limit);
  if (opts.includeCode && terms.length && (!opts.kinds || opts.kinds.includes("code"))) {
    hits = hits.concat(searchCode(projectId, terms, q, { ...opts, limit: Math.max(8, Math.floor(limit / 2)) }));
  }
  return hits;
}

/** Scan file contents for query terms, returning matching lines. */
export function searchCode(projectId: string, terms: string[], phrase: string, opts: SearchFilters): SearchHit[] {
  const db = getDb();
  const files = db.select().from(schema.files).where(and(eq(schema.files.projectId, projectId), eq(schema.files.isExcluded, false), eq(schema.files.hasContent, true))).all()
    .filter((f) => !f.isBinary && (!opts.language || f.language === opts.language) && (!opts.extension || f.extension === opts.extension.replace(/^\./, "")) && (!opts.area || f.area === opts.area));
  const contents = getFileContents(files.map((f) => f.hash));
  const out: SearchHit[] = [];
  const needle = phrase.length >= 3 ? phrase : "";
  for (const f of files) {
    const text = contents.get(f.hash);
    if (!text) continue;
    const lower = text.toLowerCase();
    if (needle ? !lower.includes(needle) && !terms.every((t) => lower.includes(t)) : !terms.every((t) => lower.includes(t))) continue;
    const lines = text.split("\n");
    let shown = 0;
    for (let i = 0; i < lines.length && shown < 3; i++) {
      const ll = lines[i].toLowerCase();
      if ((needle && ll.includes(needle)) || (terms.length > 0 && terms.filter((t) => ll.includes(t)).length >= Math.min(2, terms.length))) {
        out.push({ kind: "code", refId: `${f.id}:${i + 1}`, title: f.path, path: f.path, line: i + 1, endLine: i + 1, snippet: lines[i].trim().slice(0, 220), score: 0.5 + f.importance * 0.3 + (needle && ll.includes(needle) ? 0.4 : 0), signals: { lexical: 1, structural: 0, importance: f.importance, semantic: 0 }, meta: { language: f.language } });
        shown++;
      }
    }
    if (out.length > 400) break;
  }
  return out.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 12);
}

// ---------------------------------------------------------------------------
// Context assembly for AI tasks
// ---------------------------------------------------------------------------
export interface ContextBundle {
  hits: SearchHit[];
  evidence: EvidenceItem[];
}

/** Turn ranked hits into source excerpts with real line ranges. */
export async function retrieveContext(projectId: string, query: string, opts: { charBudget?: number; maxItems?: number; filters?: SearchFilters } = {}): Promise<ContextBundle> {
  const hits = await search(projectId, query, { ...opts.filters, limit: 24, includeCode: true });
  const files = new Map(projectRows(schema.files, projectId).map((f) => [f.path, f]));
  const symbols = new Map(projectRows(schema.symbols, projectId).map((s) => [s.id, s]));
  const hashes = new Set<string>();
  for (const h of hits) { const f = h.path ? files.get(h.path) : undefined; if (f) hashes.add(f.hash); }
  const contents = getFileContents([...hashes]);
  const evidence: EvidenceItem[] = [];
  const seen = new Set<string>();
  const maxItems = opts.maxItems ?? 14;
  for (const h of hits) {
    if (evidence.length >= maxItems) break;
    const f = h.path ? files.get(h.path) : undefined;
    if (!f || h.kind === "finding" && !h.line) continue;
    const content = contents.get(f.hash);
    if (!content) continue;
    let start = h.line ?? 1;
    let end = h.endLine ?? Math.min(f.lines, start + 40);
    if (h.kind === "symbol") { const s = symbols.get(h.refId); if (s) { start = s.startLine; end = Math.min(s.endLine, s.startLine + 120); } }
    else if (h.kind === "file") { start = 1; end = Math.min(f.lines, 80); }
    else if (h.kind === "code") { start = Math.max(1, (h.line ?? 1) - 6); end = Math.min(f.lines, (h.line ?? 1) + 14); }
    else if (h.kind === "finding") { start = Math.max(1, start - 3); end = Math.min(f.lines, end + 5); }
    const key = `${f.path}:${Math.floor(start / 20)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    evidence.push({ path: f.path, startLine: start, endLine: end, text: sliceLines(content, start, end), label: h.title });
  }
  return { hits, evidence };
}

export type { FileRow, FindingRow, RelationshipRow };
