import { eq, inArray } from "drizzle-orm";
import { bulkInsert, getDb, schema } from "../db/client";
import type { ParsedFile } from "./types";

/** Bump when extraction logic changes so stale cached parses are ignored. */
export const PARSER_VERSION = "3"; // 3: cached results also carry the per-file static checks (syntax diagnostics, ESLint)

export function parseCacheKey(language: string, path: string, hash: string): string {
  const variant = /\.(tsx|jsx)$/i.test(path) ? "x" : "";
  return `${PARSER_VERSION}:${language}${variant}:${hash}`;
}

interface Serialized extends Omit<ParsedFile, "identifiers" | "decorators" | "complexity"> {
  identifiers: string[];
  decorators: [number, string[]][];
  complexity: [number, number][];
}

export function serializeParsed(p: ParsedFile): string {
  const s: Serialized = { ...p, identifiers: [...p.identifiers].slice(0, 5000), decorators: [...p.decorators.entries()], complexity: [...p.complexity.entries()] };
  return JSON.stringify(s);
}

export function deserializeParsed(payload: string): ParsedFile {
  const s = JSON.parse(payload) as Serialized;
  return { ...s, identifiers: new Set(s.identifiers), decorators: new Map(s.decorators), complexity: new Map(s.complexity) };
}

export function getCachedParse(key: string): ParsedFile | undefined {
  const row = getDb().select({ payload: schema.parseCache.payload }).from(schema.parseCache).where(eq(schema.parseCache.key, key)).get();
  if (!row) return undefined;
  try { return deserializeParsed(row.payload); } catch { return undefined; }
}

/** Look up many keys with one query per 500. Keys that are missing or unreadable are simply absent from the result. */
export function getCachedParses(keys: string[]): Map<string, ParsedFile> {
  const out = new Map<string, ParsedFile>();
  const unique = [...new Set(keys)];
  for (let i = 0; i < unique.length; i += 500) {
    const rows = getDb().select({ key: schema.parseCache.key, payload: schema.parseCache.payload }).from(schema.parseCache).where(inArray(schema.parseCache.key, unique.slice(i, i + 500))).all();
    for (const r of rows) { try { out.set(r.key, deserializeParsed(r.payload)); } catch { /* treated as a miss */ } }
  }
  return out;
}

/** Which of these keys are cached, without reading the payloads. */
export function existingParseKeys(keys: string[]): Set<string> {
  const out = new Set<string>();
  const unique = [...new Set(keys)];
  for (let i = 0; i < unique.length; i += 500) {
    for (const r of getDb().select({ key: schema.parseCache.key }).from(schema.parseCache).where(inArray(schema.parseCache.key, unique.slice(i, i + 500))).all()) out.add(r.key);
  }
  return out;
}

/** Store many parse results in one transaction. */
export function putCachedParses(entries: { key: string; parsed: ParsedFile }[]): void {
  const now = Date.now();
  bulkInsert(schema.parseCache, entries.map((e) => ({ key: e.key, payload: serializeParsed(e.parsed), createdAt: now })), { ignoreConflicts: true });
}

export function putCachedParse(key: string, parsed: ParsedFile): void {
  getDb().insert(schema.parseCache).values({ key, payload: serializeParsed(parsed), createdAt: Date.now() }).onConflictDoNothing().run();
}
