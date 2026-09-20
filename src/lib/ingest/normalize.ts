import ignore from "ignore";
import { isBinaryFileSync } from "isbinaryfile";
import { config } from "../config";
import { sha256 } from "../util/ids";
import { countLines } from "../util/text";
import { classifyPath } from "./classify";
import { extensionOf } from "./languages";
import type { IngestStats, NormalizedFile, RawFile } from "./types";

/**
 * Turn raw bytes into the normalized file model: gitignore filtering, binary
 * detection, hashing, classification, duplicate detection, size flags.
 * Files excluded by default are kept as metadata so users can inspect them.
 */
export function normalizeFiles(raw: RawFile[]): { files: NormalizedFile[]; stats: IngestStats } {
  const warnings: string[] = [];
  const { maxFiles, maxFileBytes, largeFileBytes } = config.limits;
  const sorted = [...raw].sort((a, b) => a.path.localeCompare(b.path));

  // Build gitignore matchers per directory that contains a .gitignore.
  const ignorers: { dir: string; ig: ReturnType<typeof ignore> }[] = [];
  for (const f of sorted) {
    if (f.path === ".gitignore" || f.path.endsWith("/.gitignore")) {
      const dir = f.path === ".gitignore" ? "" : f.path.slice(0, -".gitignore".length);
      try {
        ignorers.push({ dir, ig: ignore().add(f.content.toString("utf8")) });
      } catch {
        warnings.push(`Could not parse ${f.path}; ignoring it.`);
      }
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

  if (sorted.length > maxFiles) {
    warnings.push(`The project has ${sorted.length} files; only the first ${maxFiles} (sorted by path) were retained.`);
  }

  for (const f of sorted.slice(0, maxFiles)) {
    const size = f.content.length;
    const isBinary = size > 0 && isBinaryFileSync(f.content);
    const c = classifyPath(f.path, { isBinary });
    const hash = sha256(f.content);
    const ignored = gitIgnored(f.path);
    let isExcluded = c.isExcludedByDefault || ignored;
    let excludeReason = c.excludeReason ?? (ignored ? "matched .gitignore" : undefined);
    if (c.isVendor && !isExcluded) {
      isExcluded = true;
      excludeReason = "vendored third-party code";
    }
    const hasContent = !isBinary && size <= maxFileBytes;
    if (!isExcluded && !isBinary && size > maxFileBytes) {
      warnings.push(`${f.path} is ${Math.round(size / 1024)} KB and exceeds the per-file content limit; only metadata was kept.`);
    }
    const text = hasContent ? f.content.toString("utf8") : undefined;
    const duplicateOf = !isExcluded && size > 64 ? hashToPath.get(hash) : undefined;
    if (!isExcluded && size > 64 && !duplicateOf) hashToPath.set(hash, f.path);

    const nf: NormalizedFile = {
      path: f.path,
      name: f.path.split("/").pop() ?? f.path,
      directory: f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "",
      extension: extensionOf(f.path),
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
  }

  return { files, stats: { total: files.length, included, excluded, binary: binaryCount, bytes, languages, warnings } };
}
