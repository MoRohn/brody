import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { config } from "../config";
import { AppError } from "../util/errors";
import { sanitizeRelativePath, stripCommonRoot } from "./paths";
import { diskFullError, isDiskFull } from "./staging";
import type { RawFile, StagedFile } from "./types";

export interface ZipExtractResult {
  files: RawFile[];
  warnings: string[];
  skipped: { path: string; reason: string }[];
}

export interface ZipStageResult {
  files: StagedFile[];
  warnings: string[];
  skipped: { path: string; reason: string }[];
}

const openZip = (source: Buffer | string) => new Promise<yauzl.ZipFile>((resolve, reject) => {
  const opts: yauzl.Options = { lazyEntries: true, autoClose: true, validateEntrySizes: true };
  const done = (err: Error | null, zf?: yauzl.ZipFile) => {
    if (err || !zf) reject(new AppError("bad_zip", `The upload is not a valid ZIP archive: ${err?.message ?? "unknown error"}`, 400, "Re-export the project as a standard ZIP and try again."));
    else resolve(zf);
  };
  if (typeof source === "string") yauzl.open(source, opts, done);
  else yauzl.fromBuffer(source, opts, done);
});

/**
 * Walk a ZIP defensively: entry count limits, per-file and total size limits, compression ratio checks (zip bombs),
 * symlink rejection and path traversal rejection. Each accepted entry's bytes are handed to `consume` as a stream that
 * fails the moment it produces more than it may.
 */
async function walkZip(source: Buffer | string, consume: (rel: string, data: AsyncIterable<Buffer>) => Promise<void>): Promise<{ warnings: string[]; skipped: { path: string; reason: string }[] }> {
  const { maxZipEntries, maxFileBytes, maxTotalBytes, maxZipRatio } = config.limits;
  const skipped: { path: string; reason: string }[] = [];
  let totalBytes = 0;
  let entryCount = 0;
  const zipfile = await openZip(source);

  const onEntry = async (entry: yauzl.Entry): Promise<void> => {
    entryCount++;
    if (entryCount > maxZipEntries) throw new AppError("zip_too_many_entries", `The archive contains more than ${maxZipEntries} entries.`, 413, "Upload a smaller project or exclude build output and dependencies.");
    const rel = sanitizeRelativePath(entry.fileName);
    if (!rel || /\/$/.test(entry.fileName)) return;
    // Reject symlinks (external attrs: unix mode in high 16 bits, 0o120000 = symlink).
    const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
    if ((mode & 0o170000) === 0o120000) { skipped.push({ path: rel, reason: "symbolic link" }); return; }
    if (entry.uncompressedSize > maxFileBytes * 8) { skipped.push({ path: rel, reason: `entry larger than ${maxFileBytes * 8} bytes` }); return; }
    if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > maxZipRatio && entry.uncompressedSize > 1024 * 1024) {
      throw new AppError("zip_bomb", `Archive entry ${rel} has a suspicious compression ratio and was rejected.`, 400, "This archive looks like a decompression bomb.");
    }
    totalBytes += entry.uncompressedSize;
    if (totalBytes > maxTotalBytes) throw new AppError("repo_too_large", `The archive expands beyond the ${Math.round(maxTotalBytes / 1024 / 1024)} MB limit.`, 413, "Exclude dependencies, build artifacts and data files, then upload again.");
    let stream: Readable;
    try {
      stream = await new Promise<Readable>((resolve, reject) => zipfile.openReadStream(entry, (err, s) => (err || !s ? reject(err ?? new Error("unknown")) : resolve(s))));
    } catch (e) {
      skipped.push({ path: rel, reason: `unreadable entry: ${(e as Error).message}` });
      return;
    }
    async function* limited(): AsyncGenerator<Buffer> {
      let received = 0;
      for await (const c of stream) {
        received += (c as Buffer).length;
        if (received > maxFileBytes * 8) { stream.destroy(); throw new AppError("zip_bomb", `Archive entry ${rel} produced more data than declared.`, 400); }
        yield c as Buffer;
      }
    }
    try {
      await consume(rel, limited());
    } catch (e) {
      if (e instanceof AppError) throw e;
      if (isDiskFull(e)) throw diskFullError();
      skipped.push({ path: rel, reason: (e as Error).message });
    }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      zipfile.on("error", (e: Error) => {
        // yauzl validates entry names itself: '..' segments, absolute paths and backslashes surface here.
        if (/relative path|absolute path|invalid characters in fileName/i.test(e.message)) reject(new AppError("path_traversal", `Rejected an unsafe path in the archive (${e.message}).`, 400, "Archives must contain only relative paths inside the project."));
        else reject(new AppError("bad_zip", `ZIP read failed: ${e.message}`));
      });
      zipfile.on("end", () => resolve());
      zipfile.on("entry", (entry: yauzl.Entry) => { onEntry(entry).then(() => zipfile.readEntry(), reject); });
      zipfile.readEntry();
    });
  } finally {
    // An archive on disk holds a file descriptor until it is closed (safe to repeat; reaching the end closes it already).
    zipfile.close();
  }
  return { warnings: [], skipped };
}

/** Extract a ZIP buffer into memory. Nothing is written to disk. */
export async function extractZip(buffer: Buffer): Promise<ZipExtractResult> {
  const files: RawFile[] = [];
  const { warnings, skipped } = await walkZip(buffer, async (rel, data) => {
    const chunks: Buffer[] = [];
    for await (const c of data) chunks.push(c);
    files.push({ path: rel, content: Buffer.concat(chunks) });
  });
  const strip = stripCommonRoot(files.map((f) => f.path));
  for (const f of files) f.path = strip(f.path);
  if (files.length === 0) warnings.push("The archive contained no files.");
  return { files, warnings, skipped };
}

/**
 * Extract a ZIP (a file on disk, or a buffer) into `dir`, one numbered file per entry, so archives far larger than
 * memory can be ingested. Entry names never become paths on disk, so a hostile name cannot reach outside `dir`.
 */
export async function extractZipToDir(source: Buffer | string, dir: string): Promise<ZipStageResult> {
  await fs.promises.mkdir(dir, { recursive: true });
  const files: StagedFile[] = [];
  const { warnings, skipped } = await walkZip(source, async (rel, data) => {
    const file = path.join(dir, String(files.length));
    let size = 0;
    await pipeline(data, async function* (src: AsyncIterable<Buffer>) { for await (const c of src) { size += c.length; yield c; } }, fs.createWriteStream(file));
    files.push({ path: rel, size, file });
  });
  const strip = stripCommonRoot(files.map((f) => f.path));
  for (const f of files) f.path = strip(f.path);
  if (files.length === 0) warnings.push("The archive contained no files.");
  return { files, warnings, skipped };
}
