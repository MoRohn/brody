import fs from "node:fs";
import { createHash } from "node:crypto";
import ignore from "ignore";
import { isBinaryFile, isBinaryFileSync } from "isbinaryfile";
import { config } from "../config";
import { bulkInsert, schema } from "../db/client";
import { sha256 } from "../util/ids";
import { countLines } from "../util/text";
import { classifyPath } from "./classify";
import { extensionOf } from "./languages";
import type { IngestStats, NormalizedFile, RawFile, StagedFile } from "./types";
import { pickVisuals, processImage, type VisualCandidate } from "./visuals";

/** What normalization needs to know about one file's bytes. `content` is present when the bytes were read whole. */
interface Facts { size: number; isBinary: boolean; hash: string; content?: Buffer }

const isGitignore = (p: string) => p === ".gitignore" || p.endsWith("/.gitignore");
/** READMEs whose images may be the project's screenshots: at the root, or one folder down (docs/, .github/). */
const isReadme = (p: string) => /^([^/]+\/)?readme(\.(md|markdown|mdx|rst|txt))?$/i.test(p);
const visualsOf = (files: { path: string; size: number }[], readmes: { path: string; text: string }[]) => new Map<string, VisualCandidate>(pickVisuals(files, readmes).map((v) => [v.path, v]));

/**
 * The per-file rules shared by in-memory and staged ingestion: gitignore filtering, classification, duplicate
 * detection, size flags and the running totals. Files must be added in path order (the first path keeps a duplicate).
 */
function createNormalizer(count: number, gitignores: { path: string; text: string }[]) {
  const warnings: string[] = [];
  const { maxFiles, maxFileBytes, largeFileBytes } = config.limits;

  // Build gitignore matchers per directory that contains a .gitignore.
  const ignorers: { dir: string; ig: ReturnType<typeof ignore> }[] = [];
  for (const g of gitignores) {
    const dir = g.path === ".gitignore" ? "" : g.path.slice(0, -".gitignore".length);
    try {
      ignorers.push({ dir, ig: ignore().add(g.text) });
    } catch {
      warnings.push(`Could not parse ${g.path}; ignoring it.`);
    }
  }
  const gitIgnored = (p: string): boolean => {
    for (const { dir, ig } of ignorers) {
      if (dir === "" || p.startsWith(dir)) {
        const rel = dir === "" ? p : p.slice(dir.length);
        if (rel && ig.ignores(rel)) return true;
      }
    }
    return false;
  };

  const files: NormalizedFile[] = [];
  const hashToPath = new Map<string, string>();
  const languages: Record<string, number> = {};
  let bytes = 0;
  let binaryCount = 0;
  let included = 0;
  let excluded = 0;

  if (count > maxFiles) {
    warnings.push(`The project has ${count} files; only the first ${maxFiles} (sorted by path) were retained.`);
  }

  const add = (path: string, { size, isBinary, hash, content }: Facts): NormalizedFile => {
    const c = classifyPath(path, { isBinary });
    const ignored = gitIgnored(path);
    let isExcluded = c.isExcludedByDefault || ignored;
    let excludeReason = c.excludeReason ?? (ignored ? "matched .gitignore" : undefined);
    if (c.isVendor && !isExcluded) {
      isExcluded = true;
      excludeReason = "vendored third-party code";
    }
    const hasContent = !isBinary && size <= maxFileBytes;
    if (!isExcluded && !isBinary && size > maxFileBytes) {
      warnings.push(`${path} is ${Math.round(size / 1024)} KB and exceeds the per-file content limit; only metadata was kept.`);
    }
    const text = hasContent && content ? content.toString("utf8") : undefined;
    const duplicateOf = !isExcluded && size > 64 ? hashToPath.get(hash) : undefined;
    if (!isExcluded && size > 64 && !duplicateOf) hashToPath.set(hash, path);

    const nf: NormalizedFile = {
      path,
      name: path.split("/").pop() ?? path,
      directory: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
      extension: extensionOf(path),
      language: isBinary ? "Binary" : c.language,
      size,
      lines: text ? countLines(text) : 0,
      hash,
      classification: c.classification,
      isBinary,
      isTest: c.isTest,
      isGenerated: c.isGenerated,
      isVendor: c.isVendor,
      isExcluded,
      excludeReason,
      isLarge: size > largeFileBytes,
      hasContent,
      duplicateOf,
      text,
    };
    files.push(nf);
    if (isExcluded) excluded++;
    else {
      included++;
      bytes += size;
      if (isBinary) binaryCount++;
      else if (nf.language !== "Unknown" && nf.language !== "Text") languages[nf.language] = (languages[nf.language] ?? 0) + size;
    }
    return nf;
  };

  const result = () => ({ files, stats: { total: files.length, included, excluded, binary: binaryCount, bytes, languages, warnings } as IngestStats });
  return { add, result };
}

const factsOf = (content: Buffer): Facts => ({ size: content.length, isBinary: content.length > 0 && isBinaryFileSync(content), hash: sha256(content), content });

/**
 * Turn raw bytes into the normalized file model: gitignore filtering, binary
 * detection, hashing, classification, duplicate detection, size flags.
 * Files excluded by default are kept as metadata so users can inspect them.
 * The project's visuals (logo, icons, screenshots; see ./visuals.ts) are rendered into `image`.
 */
export function normalizeFiles(raw: RawFile[]): { files: NormalizedFile[]; stats: IngestStats } {
  const sorted = [...raw].sort((a, b) => a.path.localeCompare(b.path));
  const n = createNormalizer(sorted.length, sorted.filter((f) => isGitignore(f.path)).map((f) => ({ path: f.path, text: f.content.toString("utf8") })));
  const kept = sorted.slice(0, config.limits.maxFiles);
  const visuals = visualsOf(kept.map((f) => ({ path: f.path, size: f.content.length })), kept.filter((f) => isReadme(f.path)).map((f) => ({ path: f.path, text: f.content.toString("utf8") })));
  const drawn = new Set<string>();
  for (const f of kept) {
    const nf = n.add(f.path, factsOf(f.content));
    const v = visuals.get(f.path);
    if (v && !nf.isExcluded && !drawn.has(nf.hash)) { drawn.add(nf.hash); nf.image = processImage(f.path, f.content, v.kind); }
  }
  return n.result();
}

/** Read one staged file. Bytes beyond the content limit are only streamed through the hash, never held whole. */
async function stagedFacts(f: StagedFile): Promise<Facts> {
  if (f.size <= config.limits.maxFileBytes) return factsOf(f.size === 0 ? Buffer.alloc(0) : await fs.promises.readFile(f.file));
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of fs.createReadStream(f.file, { highWaterMark: 1024 * 1024 })) { hash.update(chunk as Buffer); size += (chunk as Buffer).length; }
  return { size, isBinary: await isBinaryFile(f.file), hash: hash.digest("hex") };
}

/** Text goes to the blob table in batches as it is read, so memory holds one batch rather than the whole project. */
const BLOB_BATCH_CHARS = 32 * 1024 * 1024;

/**
 * normalizeFiles for files staged on disk, for uploads and archives too large to hold in memory. Each file's text is
 * written to the blob table as soon as it is read and dropped from the result (`text` is undefined, `hasContent` says
 * whether a blob exists), and the project's visuals go straight to the image table, so memory grows with the number of
 * files, not their size.
 */
export async function normalizeStagedFiles(staged: StagedFile[]): Promise<{ files: NormalizedFile[]; stats: IngestStats }> {
  const { maxFiles, maxFileBytes } = config.limits;
  const sorted = [...staged].sort((a, b) => a.path.localeCompare(b.path));
  const kept = sorted.slice(0, maxFiles);
  const gitignores: { path: string; text: string }[] = [];
  const readmes: { path: string; text: string }[] = [];
  for (const f of sorted) if (isGitignore(f.path) && f.size <= maxFileBytes) gitignores.push({ path: f.path, text: (await fs.promises.readFile(f.file)).toString("utf8") });
  for (const f of kept) if (isReadme(f.path) && f.size <= maxFileBytes) readmes.push({ path: f.path, text: (await fs.promises.readFile(f.file)).toString("utf8") });
  const n = createNormalizer(sorted.length, gitignores);
  const visuals = visualsOf(kept, readmes);
  const drawn = new Set<string>();

  let batch: { hash: string; content: string; size: number }[] = [];
  let batchChars = 0;
  const seen = new Set<string>();
  const flush = () => { bulkInsert(schema.blobs, batch, { ignoreConflicts: true }); batch = []; batchChars = 0; };
  for (const f of kept) {
    const facts = await stagedFacts(f);
    const nf = n.add(f.path, facts);
    const v = visuals.get(f.path);
    if (v && !nf.isExcluded && !drawn.has(nf.hash)) {
      drawn.add(nf.hash);
      const img = processImage(f.path, facts.content ?? (await fs.promises.readFile(f.file)), v.kind);
      if (img) bulkInsert(schema.images, [{ hash: nf.hash, mime: img.mime, width: img.width, height: img.height, data: img.data, meta: img.meta }], { ignoreConflicts: true });
    }
    if (nf.text === undefined) continue;
    if (!seen.has(nf.hash)) {
      seen.add(nf.hash);
      batch.push({ hash: nf.hash, content: nf.text, size: nf.size });
      batchChars += nf.text.length;
      if (batchChars >= BLOB_BATCH_CHARS) flush();
    }
    nf.text = undefined;
  }
  flush();
  return n.result();
}
