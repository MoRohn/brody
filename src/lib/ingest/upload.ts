import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { config } from "../config";
import { getDb, schema } from "../db/client";
import { AppError } from "../util/errors";
import { formatBytes } from "../util/text";
import { normalizeStagedFiles } from "./normalize";
import { sanitizeRelativePath, stripCommonRoot } from "./paths";
import { makeWorkDir, removeDir } from "./staging";
import { createProject, type CreateProjectResult } from "./store";
import type { IngestSource, StagedFile } from "./types";
import { extractZipToDir } from "./zip";
import { pushAll } from "../util/arrays";

export type UploadMode = "file" | "files" | "folder" | "zip";

export interface UploadedItem {
  /** Client-provided relative path (webkitRelativePath for folders) or plain file name. */
  name: string;
  content: Buffer;
}

/** An uploaded item already written to disk (see ./sessions.ts). */
export interface StagedItem {
  /** Client-provided relative path (webkitRelativePath for folders) or plain file name. */
  name: string;
  size: number;
  /** Absolute path of the bytes on disk. */
  file: string;
}

export interface IngestOutcome extends CreateProjectResult {
  warnings: string[];
}

/** ingestStaged for an upload that arrived in one request and is held in memory: it is written out first, then read the same way. */
export async function ingestUpload(mode: UploadMode, items: UploadedItem[], opts: { name?: string; previousProjectId?: string } = {}): Promise<IngestOutcome> {
  if (items.length === 0) throw new AppError("empty_upload", "No files were received.", 400, "Choose at least one file, a folder or a ZIP archive.");
  const dir = await makeWorkDir("in");
  try {
    const staged: StagedItem[] = [];
    for (const [i, it] of items.entries()) {
      const file = path.join(dir, `u${i}`);
      await fs.promises.writeFile(file, it.content);
      staged.push({ name: it.name, size: it.content.length, file });
    }
    return await ingestStaged(mode, staged, dir, opts);
  } finally {
    await removeDir(dir);
  }
}

/**
 * Validate and store uploaded content, read from disk, as a new project. Throws AppError with actionable messages.
 * `workDir` is a scratch directory the caller removes afterwards (a ZIP is extracted into it).
 * `previousProjectId` makes the upload a new version of that project (Re-analyze with updated code): it is compared with
 * that version file by file, whatever the folder or archive is called.
 */
export async function ingestStaged(mode: UploadMode, items: StagedItem[], workDir: string, opts: { name?: string; previousProjectId?: string } = {}): Promise<IngestOutcome> {
  if (items.length === 0) throw new AppError("empty_upload", "No files were received.", 400, "Choose at least one file, a folder or a ZIP archive.");
  const warnings: string[] = [];
  let raw: StagedFile[] = [];
  const previous = opts.previousProjectId ? getDb().select({ name: schema.projects.name }).from(schema.projects).where(eq(schema.projects.id, opts.previousProjectId)).get() : undefined;
  if (opts.previousProjectId && !previous) throw new AppError("project_not_found", "The project this upload updates no longer exists.", 404, "Upload it as a new project from the home page instead.");
  // A new version keeps the project's name, so it stays one project in the list however the folder is called today.
  let name = opts.name?.trim() || previous?.name || "";

  if (mode === "zip") {
    if (items.length !== 1) throw new AppError("bad_upload", "Upload exactly one ZIP archive.", 400);
    const z = await extractZipToDir(items[0].file, path.join(workDir, "unzipped"));
    raw = z.files;
    pushAll(warnings, z.warnings);
    pushAll(warnings, z.skipped.map((s) => `Skipped ${s.path}: ${s.reason}`));
    name ||= items[0].name.replace(/\.zip$/i, "") || "archive";
  } else if (mode === "folder") {
    const paths = items.map((i) => sanitizeRelativePath(i.name));
    const valid = items.map((it, i) => ({ it, p: paths[i] })).filter((x): x is { it: StagedItem; p: string } => !!x.p);
    const strip = stripCommonRoot(valid.map((v) => v.p));
    name ||= valid[0]?.p.split("/")[0] ?? "folder";
    raw = valid.map((v) => ({ path: strip(v.p), size: v.it.size, file: v.it.file }));
  } else {
    const seen = new Set<string>();
    for (const it of items) {
      const base = (it.name.split(/[\\/]/).pop() ?? it.name).trim();
      const p = sanitizeRelativePath(base);
      if (!p) continue;
      let unique = p;
      for (let n = 2; seen.has(unique); n++) unique = p.replace(/(\.[^.]*)?$/, `-${n}$1`);
      seen.add(unique);
      raw.push({ path: unique, size: it.size, file: it.file });
    }
    name ||= mode === "file" ? (raw[0]?.path ?? "file") : `${raw.length} files`;
  }

  if (raw.length === 0) throw new AppError("empty_upload", "The upload contained no readable files.", 400, "Make sure the folder or archive is not empty.");
  const total = raw.reduce((a, f) => a + f.size, 0);
  if (raw.length > config.limits.maxFiles) throw new AppError("repo_too_large", `The upload has ${raw.length} files; the limit is ${config.limits.maxFiles}.`, 413, "Exclude dependencies and build output before uploading, or raise MAX_FILES.");
  if (total > config.limits.maxTotalBytes) throw new AppError("repo_too_large", `The upload is ${formatBytes(total)}; the limit is ${formatBytes(config.limits.maxTotalBytes)}.`, 413, "Exclude dependencies, build artifacts and data files, or raise MAX_TOTAL_BYTES.");

  const { files, stats } = await normalizeStagedFiles(raw);
  pushAll(warnings, stats.warnings);
  const included = files.filter((f) => !f.isExcluded);
  if (included.length === 0) throw new AppError("no_source", "Every file in the upload was excluded (dependencies, build output or ignored files).", 400, "Upload the project's source files; excluded items can be inspected once analysis starts.");
  if (included.every((f) => f.isBinary)) throw new AppError("binary_only", "The upload contains only binary files, which cannot be analysed as source code.", 400, "Upload source files, not compiled artifacts.");

  const source: IngestSource = { type: mode, name };
  const res = createProject(source, files, stats, undefined, { previousId: opts.previousProjectId });
  return { ...res, warnings };
}
