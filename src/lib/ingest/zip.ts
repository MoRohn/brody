import yauzl from "yauzl";
import { config } from "../config";
import { AppError } from "../util/errors";
import { sanitizeRelativePath, stripCommonRoot } from "./paths";
import type { RawFile } from "./types";

export interface ZipExtractResult {
  files: RawFile[];
  warnings: string[];
  skipped: { path: string; reason: string }[];
}

/**
 * Extract a ZIP buffer defensively: entry count limits, per-file and total
 * size limits, compression ratio checks (zip bombs), symlink rejection and
 * path traversal rejection. Nothing is written to disk.
 */
export async function extractZip(buffer: Buffer): Promise<ZipExtractResult> {
  const { maxZipEntries, maxFileBytes, maxTotalBytes, maxZipRatio } = config.limits;
  const files: RawFile[] = [];
  const warnings: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let totalBytes = 0;
  let entryCount = 0;

  const zipfile = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (err, zf) => {
      if (err || !zf) reject(new AppError("bad_zip", `The upload is not a valid ZIP archive: ${err?.message ?? "unknown error"}`, 400, "Re-export the project as a standard ZIP and try again."));
      else resolve(zf);
    });
  });

  await new Promise<void>((resolve, reject) => {
    zipfile.on("error", (e: Error) => {
      // yauzl validates entry names itself: '..' segments, absolute paths and backslashes surface here.
      if (/relative path|absolute path|invalid characters in fileName/i.test(e.message)) reject(new AppError("path_traversal", `Rejected an unsafe path in the archive (${e.message}).`, 400, "Archives must contain only relative paths inside the project."));
      else reject(new AppError("bad_zip", `ZIP read failed: ${e.message}`));
    });
    zipfile.on("end", () => resolve());
    zipfile.on("entry", (entry: yauzl.Entry) => {
      entryCount++;
      if (entryCount > maxZipEntries) {
        reject(new AppError("zip_too_many_entries", `The archive contains more than ${maxZipEntries} entries.`, 413, "Upload a smaller project or exclude build output and dependencies."));
        return;
      }
      let rel: string | undefined;
      try {
        rel = sanitizeRelativePath(entry.fileName);
      } catch (e) {
        reject(e);
        return;
      }
      if (!rel || /\/$/.test(entry.fileName)) {
        zipfile.readEntry();
        return;
      }
      // Reject symlinks (external attrs: unix mode in high 16 bits, 0o120000 = symlink).
      const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
      if ((mode & 0o170000) === 0o120000) {
        skipped.push({ path: rel, reason: "symbolic link" });
        zipfile.readEntry();
        return;
      }
      if (entry.uncompressedSize > maxFileBytes * 8) {
        skipped.push({ path: rel, reason: `entry larger than ${maxFileBytes * 8} bytes` });
        zipfile.readEntry();
        return;
      }
      if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > maxZipRatio && entry.uncompressedSize > 1024 * 1024) {
        reject(new AppError("zip_bomb", `Archive entry ${rel} has a suspicious compression ratio and was rejected.`, 400, "This archive looks like a decompression bomb."));
        return;
      }
      totalBytes += entry.uncompressedSize;
      if (totalBytes > maxTotalBytes) {
        reject(new AppError("repo_too_large", `The archive expands beyond the ${Math.round(maxTotalBytes / 1024 / 1024)} MB limit.`, 413, "Exclude dependencies, build artifacts and data files, then upload again."));
        return;
      }
      zipfile.openReadStream(entry, (err, stream) => {
        if (err || !stream) {
          skipped.push({ path: rel!, reason: `unreadable entry: ${err?.message ?? "unknown"}` });
          zipfile.readEntry();
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        stream.on("data", (c: Buffer) => {
          received += c.length;
          if (received > maxFileBytes * 8) {
            stream.destroy();
            reject(new AppError("zip_bomb", `Archive entry ${rel} produced more data than declared.`, 400));
            return;
          }
          chunks.push(c);
        });
        stream.on("error", (e: Error) => {
          skipped.push({ path: rel!, reason: e.message });
          zipfile.readEntry();
        });
        stream.on("end", () => {
          files.push({ path: rel!, content: Buffer.concat(chunks) });
          zipfile.readEntry();
        });
      });
    });
    zipfile.readEntry();
  });

  const strip = stripCommonRoot(files.map((f) => f.path));
  for (const f of files) f.path = strip(f.path);
  if (files.length === 0) warnings.push("The archive contained no files.");
  return { files, warnings, skipped };
}
