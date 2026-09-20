import { eq } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import type { ParsedFile } from "./types";

/** Bump when extraction logic changes so stale cached parses are ignored. */
export const PARSER_VERSION = "2";

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

export function putCachedParse(key: string, parsed: ParsedFile): void {
  getDb().insert(schema.parseCache).values({ key, payload: serializeParsed(parsed), createdAt: Date.now() }).onConflictDoNothing().run();
}
