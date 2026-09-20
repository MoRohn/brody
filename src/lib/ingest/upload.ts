import { config } from "../config";
import { AppError } from "../util/errors";
import { normalizeFiles } from "./normalize";
import { sanitizeRelativePath, stripCommonRoot } from "./paths";
import { createProject, type CreateProjectResult } from "./store";
import type { IngestSource, RawFile } from "./types";
import { extractZip } from "./zip";
import { pushAll } from "../util/arrays";

export type UploadMode = "file" | "files" | "folder" | "zip";

export interface UploadedItem {
  /** Client-provided relative path (webkitRelativePath for folders) or plain file name. */
  name: string;
  content: Buffer;
}

export interface IngestOutcome extends CreateProjectResult {
  warnings: string[];
}

/** Validate and store uploaded content as a new project. Throws AppError with actionable messages. */
export async function ingestUpload(mode: UploadMode, items: UploadedItem[], opts: { name?: string } = {}): Promise<IngestOutcome> {
  if (items.length === 0) throw new AppError("empty_upload", "No files were received.", 400, "Choose at least one file, a folder or a ZIP archive.");
  const warnings: string[] = [];
  let raw: RawFile[] = [];
  let name = opts.name?.trim() || "";

  if (mode === "zip") {
    if (items.length !== 1) throw new AppError("bad_upload", "Upload exactly one ZIP archive.", 400);
    const z = await extractZip(items[0].content);
    raw = z.files;
    pushAll(warnings, z.warnings);
    pushAll(warnings, z.skipped.map((s) => `Skipped ${s.path}: ${s.reason}`));
    name ||= items[0].name.replace(/\.zip$/i, "") || "archive";
  } else if (mode === "folder") {
    const paths = items.map((i) => sanitizeRelativePath(i.name));
    const valid = items.map((it, i) => ({ it, p: paths[i] })).filter((x): x is { it: UploadedItem; p: string } => !!x.p);
    const strip = stripCommonRoot(valid.map((v) => v.p));
    name ||= valid[0]?.p.split("/")[0] ?? "folder";
    raw = valid.map((v) => ({ path: strip(v.p), content: v.it.content }));
  } else {
    const seen = new Set<string>();
    for (const it of items) {
      const base = (it.name.split(/[\\/]/).pop() ?? it.name).trim();
      const p = sanitizeRelativePath(base);
      if (!p) continue;
      let unique = p;
      for (let n = 2; seen.has(unique); n++) unique = p.replace(/(\.[^.]*)?$/, `-${n}$1`);
      seen.add(unique);
      raw.push({ path: unique, content: it.content });
    }
    name ||= mode === "file" ? (raw[0]?.path ?? "file") : `${raw.length} files`;
  }

  if (raw.length === 0) throw new AppError("empty_upload", "The upload contained no readable files.", 400, "Make sure the folder or archive is not empty.");
  const total = raw.reduce((a, f) => a + f.content.length, 0);
  if (raw.length > config.limits.maxFiles) throw new AppError("repo_too_large", `The upload has ${raw.length} files; the limit is ${config.limits.maxFiles}.`, 413, "Exclude dependencies and build output before uploading.");
  if (total > config.limits.maxTotalBytes) throw new AppError("repo_too_large", `The upload is ${Math.round(total / 1024 / 1024)} MB; the limit is ${Math.round(config.limits.maxTotalBytes / 1024 / 1024)} MB.`, 413, "Exclude dependencies, build artifacts and data files.");

  const { files, stats } = normalizeFiles(raw);
  pushAll(warnings, stats.warnings);
  const included = files.filter((f) => !f.isExcluded);
  if (included.length === 0) throw new AppError("no_source", "Every file in the upload was excluded (dependencies, build output or ignored files).", 400, "Upload the project's source files; excluded items can be inspected once analysis starts.");
  if (included.every((f) => f.isBinary)) throw new AppError("binary_only", "The upload contains only binary files, which cannot be analysed as source code.", 400, "Upload source files, not compiled artifacts.");

  const source: IngestSource = { type: mode, name };
  const res = createProject(source, files, stats);
  return { ...res, warnings };
}
