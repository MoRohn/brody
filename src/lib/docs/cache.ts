import { eq } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { sha256 } from "../util/ids";
import type { LoadedFile } from "../graph/build";
import type { FileDoc, ModuleDoc, SymbolDoc } from "./types";

/** Bump when prompts or schemas for explanations change. */
const PROMPT_VERSION = "2";

export function fileExplainKey(model: string, d: FileDoc, filesByPath: Map<string, LoadedFile>): string {
  const f = filesByPath.get(d.path);
  const deps = d.dependsOn.map((p) => filesByPath.get(p)?.hash ?? p).sort().join(",");
  return `file:${PROMPT_VERSION}:${model}:${f?.hash ?? d.path}:${sha256(deps).slice(0, 16)}`;
}

export function symbolExplainKey(model: string, s: SymbolDoc, filesByPath: Map<string, LoadedFile>): string {
  const f = filesByPath.get(s.path);
  return `sym:${PROMPT_VERSION}:${model}:${f?.hash ?? s.path}:${s.name}:${s.startLine}-${s.endLine}`;
}

/** A collection's explanation depends on every member file's content, so changing any file invalidates it. */
export function moduleExplainKey(model: string, m: ModuleDoc, filesByPath: Map<string, LoadedFile>): string {
  const hashes = m.files.map((f) => filesByPath.get(f.path)?.hash ?? f.path).sort().join(",");
  return `mod:${PROMPT_VERSION}:${model}:${sha256(`${m.path}|${hashes}`).slice(0, 24)}`;
}

export const MODULE_CACHED_FIELDS = ["purpose", "howFilesWork", "dataIn", "dataOut", "keyFiles", "evidence"] as const;

export function getExplain<T extends Record<string, unknown>>(key: string): T | undefined {
  return getDb().select({ p: schema.explainCache.payload }).from(schema.explainCache).where(eq(schema.explainCache.key, key)).get()?.p as T | undefined;
}

export function putExplain(key: string, kind: string, payload: Record<string, unknown>): void {
  getDb().insert(schema.explainCache).values({ key, kind, payload, createdAt: Date.now() }).onConflictDoUpdate({ target: schema.explainCache.key, set: { payload, createdAt: Date.now() } }).run();
}

export const SYMBOL_CACHED_FIELDS = ["purpose", "inputs", "process", "outputs", "businessMeaning", "importantBehavior", "dependencies", "evidence"] as const;
export const FILE_CACHED_FIELDS = ["purpose", "responsibilities", "howItOperates", "dataIn", "dataOut", "engineeringNotes", "evidence"] as const;

export function pick<T extends object>(obj: T, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f] = (obj as Record<string, unknown>)[f];
  return out;
}
