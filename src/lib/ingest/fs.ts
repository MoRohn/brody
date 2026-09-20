import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { AppError } from "../util/errors";
import { DEFAULT_EXCLUDED_DIRS } from "./classify";
import { sanitizeRelativePath } from "./paths";
import type { RawFile } from "./types";

/**
 * Read a local directory into memory. Symbolic links are never followed, so a
 * repository cannot point the reader at files outside the chosen root.
 * Excluded directories are still read (marked later during normalization) so
 * users can inspect them, except that `.git` internals are skipped entirely.
 */
export interface PrunedDir { path: string; files: number }

function countFiles(dir: string, cap = 500_000): number {
  let n = 0;
  const stack = [dir];
  while (stack.length && n < cap) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    // brody-ignore: sync-io  (CLI helper that counts files in pruned directories; not used by request handlers)
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) { if (e.isSymbolicLink()) continue; if (e.isDirectory()) stack.push(path.join(d, e.name)); else n++; }
  }
  return n;
}

/**
 * Dependency and build directories (node_modules, dist, .venv, ...) are not read by default: they are
 * counted and reported in `pruned` instead, so a normal project folder does not hit the file limit.
 * Pass includeExcluded to read them anyway.
 */
export function readDirectory(root: string, opts: { includeExcluded?: boolean } = {}): { files: RawFile[]; skippedLinks: string[]; pruned: PrunedDir[] } {
  // brody-ignore: sync-io  (CLI and test helper; never called from a request handler)
  const base = fs.realpathSync(root);
  const files: RawFile[] = [];
  const skippedLinks: string[] = [];
  const pruned: PrunedDir[] = [];
  let total = 0;
  const walk = (dir: string) => {
    // brody-ignore: sync-io  (folder reader for the CLI and tests; not used by request handlers)
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(base, abs).split(path.sep).join("/");
      if (entry.isSymbolicLink()) { skippedLinks.push(rel); continue; }
      if (entry.isDirectory()) {
        if (entry.name === ".git") continue;
        if (!opts.includeExcluded && DEFAULT_EXCLUDED_DIRS.includes(entry.name)) { pruned.push({ path: rel, files: countFiles(abs) }); continue; }
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      // brody-ignore: sync-io  (folder reader for the CLI and tests; not used by request handlers)
      const real = fs.realpathSync(abs);
      if (!real.startsWith(base + path.sep) && real !== base) { skippedLinks.push(rel); continue; }
      // brody-ignore: sync-io  (folder reader for the CLI and tests; not used by request handlers)
      const stat = fs.statSync(abs);
      total += stat.size;
      if (files.length >= config.limits.maxFiles) throw new AppError("repo_too_large", `The folder contains more than ${config.limits.maxFiles} files.`, 413, "Exclude dependencies and build output, or raise MAX_FILES.");
      if (total > config.limits.maxTotalBytes) throw new AppError("repo_too_large", `The folder exceeds the ${Math.round(config.limits.maxTotalBytes / 1024 / 1024)} MB limit.`, 413, "Exclude dependencies, build artifacts and data files.");
      const clean = sanitizeRelativePath(rel);
      if (!clean) continue;
      // brody-ignore: sync-io  (folder reader for the CLI and tests; not used by request handlers)
      files.push({ path: clean, content: fs.readFileSync(abs) });
    }
  };
  walk(base);
  return { files, skippedLinks, pruned };
}
