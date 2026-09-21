import { and, eq, desc, inArray, isNull, ne } from "drizzle-orm";
import { bulkInsert, getDb, onClose, schema } from "../db/client";
import { newId, sha256 } from "../util/ids";
import type { IngestSource, IngestStats, NormalizedFile } from "./types";
import { encryptSecret } from "./credentials";

type IncrementalStats = { changed: number; unchanged: number; added: number; removed: number; previousProjectId?: string };

/** Insert an empty project row (used when file contents arrive later, e.g. a GitHub download inside a job). */
export function createPendingProject(source: IngestSource, token?: string): string {
  const db = getDb();
  const now = Date.now();
  const projectId = newId("prj");
  db.transaction((tx) => {
    tx.insert(schema.projects).values({
      id: projectId, name: source.name, sourceType: source.type, sourceUrl: source.url ?? null, owner: source.owner ?? null, branch: source.branch ?? null, commit: source.commit ?? null,
      sourceHash: "pending", status: "importing", createdAt: now, updatedAt: now,
    }).run();
    if (token) tx.insert(schema.credentials).values({ projectId, encrypted: encryptSecret(token), createdAt: now }).run();
  });
  return projectId;
}

/** Store normalized files for a project and compute the incremental diff against the previous analysis of the same source. */
export function attachFiles(projectId: string, source: IngestSource, files: NormalizedFile[], stats: IngestStats): IncrementalStats {
  const db = getDb();
  const sourceHash = sha256(files.map((f) => `${f.path}:${f.hash}`).join("\n"));
  const previous = db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(and(eq(schema.projects.sourceType, source.type), source.url ? eq(schema.projects.sourceUrl, source.url) : isNull(schema.projects.sourceUrl), eq(schema.projects.name, source.name), ne(schema.projects.id, projectId), eq(schema.projects.status, "ready")))
    .orderBy(desc(schema.projects.createdAt))
    .limit(1)
    .all()[0];
  const prevFiles = previous
    ? new Map(db.select({ path: schema.files.path, hash: schema.files.hash }).from(schema.files).where(eq(schema.files.projectId, previous.id)).all().map((f) => [f.path, f.hash]))
    : new Map<string, string>();
  let changed = 0, unchanged = 0, added = 0, removed = 0;
  const seen = new Set<string>();
  for (const f of files) {
    if (f.isExcluded) continue;
    seen.add(f.path);
    const prev = prevFiles.get(f.path);
    if (prev === undefined) added++;
    else if (prev === f.hash) unchanged++;
    else changed++;
  }
  for (const p of prevFiles.keys()) if (!seen.has(p)) removed++;
  const included = files.filter((f) => !f.isExcluded);
  const lineCount = included.reduce((a, f) => a + f.lines, 0);
  const incremental: IncrementalStats = { changed, unchanged, added, removed, previousProjectId: previous?.id };

  db.transaction((tx) => {
    tx.update(schema.projects).set({
      sourceHash, fileCount: included.length, sourceFileCount: included.filter((f) => f.classification === "source").length, totalBytes: stats.bytes, lineCount, languages: stats.languages,
      incremental: incremental as unknown as Record<string, number>, previousProjectId: previous?.id ?? null, updatedAt: Date.now(),
    }).where(eq(schema.projects.id, projectId)).run();
    const blobRows = new Map<string, { hash: string; content: string; size: number }>();
    for (const f of files) if (f.text !== undefined && !blobRows.has(f.hash)) blobRows.set(f.hash, { hash: f.hash, content: f.text, size: f.size });
    const blobList = [...blobRows.values()];
    bulkInsert(schema.blobs, blobList, { ignoreConflicts: true });
    tx.delete(schema.files).where(eq(schema.files.projectId, projectId)).run();
    const rows = files.map((f) => ({
      id: newId("f"), projectId, path: f.path, name: f.name, directory: f.directory, extension: f.extension, language: f.language, size: f.size, lines: f.lines, hash: f.hash,
      classification: f.classification, isBinary: f.isBinary, isTest: f.isTest, isGenerated: f.isGenerated, isVendor: f.isVendor, isExcluded: f.isExcluded, excludeReason: f.excludeReason ?? null,
      isLarge: f.isLarge, hasContent: f.text !== undefined, duplicateOf: f.duplicateOf ?? null, parseStatus: "pending",
    }));
    bulkInsert(schema.files, rows);
  });
  return incremental;
}

export interface CreateProjectResult {
  projectId: string;
  stats: IngestStats;
  incremental: IncrementalStats;
}

export function createProject(source: IngestSource, files: NormalizedFile[], stats: IngestStats, token?: string): CreateProjectResult {
  const projectId = createPendingProject(source, token);
  const incremental = attachFiles(projectId, source, files, stats);
  getDb().update(schema.projects).set({ status: "created" }).where(eq(schema.projects.id, projectId)).run();
  return { projectId, stats, incremental };
}

export function getFileContent(hash: string): string | undefined {
  const db = getDb();
  return db.select({ content: schema.blobs.content }).from(schema.blobs).where(eq(schema.blobs.hash, hash)).get()?.content;
}

/**
 * Blobs are content-addressed, so a hash always maps to the same text and a cached copy can never be stale. One analysis
 * reads every file's text in six different stages; keeping recent blobs in memory turns five of those reads into lookups.
 * The cache is bounded by characters, evicting the oldest first.
 */
const BLOB_CACHE_CHARS = 48_000_000;
const blobCache = new Map<string, string>();
let blobCacheChars = 0;
export function clearBlobCache(): void { blobCache.clear(); blobCacheChars = 0; }
onClose(clearBlobCache);
function rememberBlob(hash: string, content: string): void {
  if (content.length > BLOB_CACHE_CHARS / 8 || blobCache.has(hash)) return;
  blobCache.set(hash, content);
  blobCacheChars += content.length;
  for (const [k, v] of blobCache) { if (blobCacheChars <= BLOB_CACHE_CHARS) break; blobCache.delete(k); blobCacheChars -= v.length; }
}

export function getFileContents(hashes: string[]): Map<string, string> {
  const db = getDb();
  const out = new Map<string, string>();
  const missing: string[] = [];
  for (const h of new Set(hashes)) { const c = blobCache.get(h); if (c !== undefined) out.set(h, c); else missing.push(h); }
  for (let i = 0; i < missing.length; i += 500) {
    const rows = db.select().from(schema.blobs).where(inArray(schema.blobs.hash, missing.slice(i, i + 500))).all();
    for (const r of rows) { out.set(r.hash, r.content); rememberBlob(r.hash, r.content); }
  }
  return out;
}

export function deleteProject(projectId: string): boolean {
  const db = getDb();
  const exists = db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!exists) return false;
  db.transaction((tx) => {
    tx.delete(schema.files).where(eq(schema.files.projectId, projectId)).run();
    tx.delete(schema.symbols).where(eq(schema.symbols.projectId, projectId)).run();
    tx.delete(schema.relationships).where(eq(schema.relationships.projectId, projectId)).run();
    tx.delete(schema.findings).where(eq(schema.findings.projectId, projectId)).run();
    tx.delete(schema.jobs).where(eq(schema.jobs.projectId, projectId)).run();
    tx.delete(schema.indexEntries).where(eq(schema.indexEntries.projectId, projectId)).run();
    tx.delete(schema.questions).where(eq(schema.questions.projectId, projectId)).run();
    tx.delete(schema.credentials).where(eq(schema.credentials.projectId, projectId)).run();
    tx.delete(schema.projects).where(eq(schema.projects.id, projectId)).run();
  });
  return true;
}
