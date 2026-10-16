import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { importBundle, isBundleZip, type ImportResult } from "../bundle";
import { config } from "../config";
import { getDb, schema } from "../db/client";
import { AppError } from "../util/errors";
import { newId } from "../util/ids";
import { formatBytes } from "../util/text";
import { diskFullError, ensureFreeSpace, isDiskFull, removeDir, stagingRoot, sweepStaging } from "./staging";
import { ingestStaged, type IngestOutcome, type StagedItem } from "./upload";

/**
 * Uploads of any size up to MAX_UPLOAD_BYTES, sent by the browser as many small requests:
 *
 *   1. createUploadSession: the client describes every file (path and size). Limits are checked here, before any byte
 *      is sent, and the description is kept on disk in the session's directory.
 *   2. writeUploadPieces: batches of whole small files, or one piece of a large file, written to disk as they arrive.
 *      Pieces of one file arrive in order; a retried piece may repeat bytes already written.
 *   3. finishUploadSession: every file is checked for completeness, then ingested from disk and the directory removed.
 *
 * No request carries more than UPLOAD_PIECE_BYTES of file data, so memory stays flat however large the project is.
 */

/** File data per request. Small enough that no request holds much memory, large enough to keep requests few. */
export const UPLOAD_PIECE_BYTES = 16 * 1024 * 1024;

const Description = z.object({
  mode: z.enum(["file", "files", "folder", "zip", "bundle"]),
  name: z.string().max(500).optional(),
  previous: z.string().max(100).optional(),
  files: z.array(z.object({ path: z.string().min(1).max(4096), size: z.number().int().min(0) })),
});
type Description = z.infer<typeof Description>;
export type UploadSessionMode = Description["mode"];

const ID = /^up_[0-9a-f]{20}$/;
const dirOf = (id: string) => path.join(stagingRoot(), id);
const pieceFile = (id: string, index: number) => path.join(dirOf(id), "files", String(index));
const expired = () => new AppError("upload_expired", "This upload is no longer in progress on the server.", 404, "Start the upload again.");

/** Descriptions of sessions in progress, read from disk on a miss (after a restart, or from another route's module copy). */
const sessions = new Map<string, Description>();
/** Sessions being ingested: no more pieces, and no second finish. */
const finishing = new Set<string>();

export async function createUploadSession(body: unknown): Promise<{ id: string; pieceBytes: number }> {
  const parsed = Description.safeParse(body);
  if (!parsed.success) throw new AppError("invalid_request", "The upload description is not valid.", 400, "Send the mode and a list of files, each with its path and size.");
  const d = parsed.data;
  if (d.files.length === 0) throw new AppError("empty_upload", "No files were chosen.", 400, "Choose at least one file, a folder or a ZIP archive.");
  if ((d.mode === "zip" || d.mode === "bundle") && d.files.length !== 1) throw new AppError("bad_upload", d.mode === "zip" ? "Upload exactly one ZIP archive." : "Open exactly one Brody export.", 400);
  const { maxFiles, maxUploadBytes } = config.limits;
  if (d.files.length > maxFiles) throw new AppError("repo_too_large", `The upload has ${d.files.length.toLocaleString("en-US")} files; the limit is ${maxFiles.toLocaleString("en-US")}.`, 413, "Leave dependency and build folders out of the upload, or raise MAX_FILES.");
  const total = d.files.reduce((a, f) => a + f.size, 0);
  if (total > maxUploadBytes) throw new AppError("upload_too_large", `The upload is ${formatBytes(total)}, over the ${formatBytes(maxUploadBytes)} limit.`, 413, "Leave dependency and build folders out of the upload, or raise MAX_UPLOAD_BYTES.");
  if (d.previous && !getDb().select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, d.previous)).get()) {
    throw new AppError("project_not_found", "The project this upload updates no longer exists.", 404, "Upload it as a new project from the home page instead.");
  }
  await sweepStaging();
  // A ZIP is extracted beside itself, so it needs room for its contents as well.
  await ensureFreeSpace(d.mode === "zip" ? total * 2 : total);
  const id = newId("up");
  await fs.promises.mkdir(path.join(dirOf(id), "files"), { recursive: true });
  await fs.promises.writeFile(path.join(dirOf(id), "session.json"), JSON.stringify(d));
  sessions.set(id, d);
  return { id, pieceBytes: UPLOAD_PIECE_BYTES };
}

async function loadSession(id: string): Promise<Description> {
  if (!ID.test(id)) throw expired();
  if (finishing.has(id)) throw new AppError("upload_finishing", "This upload has already been received and is being processed.", 409);
  const known = sessions.get(id);
  if (known) return known;
  try {
    const d = Description.parse(JSON.parse(await fs.promises.readFile(path.join(dirOf(id), "session.json"), "utf8")));
    sessions.set(id, d);
    return d;
  } catch {
    throw expired();
  }
}

/** Write a batch of pieces. The form repeats `index` (the file's position in the description), `offset` and `data`. */
export async function writeUploadPieces(id: string, form: FormData): Promise<{ received: number }> {
  const d = await loadSession(id);
  const indexes = form.getAll("index").map(Number);
  const offsets = form.getAll("offset").map(Number);
  const data = form.getAll("data");
  if (data.length === 0 || indexes.length !== data.length || offsets.length !== data.length) throw new AppError("invalid_upload", "Each piece of the upload needs an index, an offset and its data.", 400);
  let received = 0;
  for (let k = 0; k < data.length; k++) {
    const piece = data[k];
    const index = indexes[k];
    const offset = offsets[k];
    const entry = Number.isInteger(index) ? d.files[index] : undefined;
    if (!entry || typeof piece === "string" || !Number.isInteger(offset) || offset < 0 || offset + piece.size > entry.size) {
      throw new AppError("invalid_upload", "A piece of the upload does not match the files it described.", 400, "Start the upload again.");
    }
    const file = pieceFile(id, index);
    const have = await fs.promises.stat(file).then((s) => s.size, () => 0);
    if (offset > have) throw new AppError("upload_out_of_order", `Part of ${entry.path} did not arrive.`, 409, "Start the upload again.");
    const bytes = Buffer.from(await piece.arrayBuffer());
    let handle: fs.promises.FileHandle | undefined;
    try {
      // No O_TRUNC: a piece lands at its offset in whatever has already been written.
      handle = await fs.promises.open(file, fs.constants.O_WRONLY | fs.constants.O_CREAT);
      await handle.write(bytes, 0, bytes.length, offset);
    } catch (e) {
      if (isDiskFull(e)) throw diskFullError();
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw expired();
      throw e;
    } finally {
      await handle?.close();
    }
    received += bytes.length;
  }
  // Activity keeps the session from being swept as abandoned.
  const now = new Date();
  await fs.promises.utimes(dirOf(id), now, now).catch(() => undefined);
  return { received };
}

export type FinishedUpload = { kind: "project"; outcome: IngestOutcome } | { kind: "bundle"; imported: ImportResult };

/** Check that every file arrived whole, then ingest the upload (or open it, for a Brody export). The session ends either way. */
export async function finishUploadSession(id: string): Promise<FinishedUpload> {
  const d = await loadSession(id);
  finishing.add(id);
  try {
    const items: StagedItem[] = [];
    const incomplete: string[] = [];
    for (const [i, f] of d.files.entries()) {
      const file = pieceFile(id, i);
      const size = f.size === 0 ? 0 : await fs.promises.stat(file).then((s) => s.size, () => -1);
      if (size !== f.size) incomplete.push(f.path);
      items.push({ name: f.path, size: f.size, file });
    }
    if (incomplete.length) throw new AppError("upload_incomplete", `${incomplete.length === 1 ? "1 file" : `${incomplete.length} files`} did not arrive completely (${incomplete[0]}${incomplete.length > 1 ? ", …" : ""}).`, 409, "Start the upload again.");
    if (d.mode === "bundle" || (d.mode === "zip" && (await isBundleZip(items[0].file)))) return { kind: "bundle", imported: await importBundle(items[0].file) };
    return { kind: "project", outcome: await ingestStaged(d.mode, items, dirOf(id), { name: d.name, previousProjectId: d.previous }) };
  } finally {
    sessions.delete(id);
    await removeDir(dirOf(id));
    finishing.delete(id);
  }
}

/** Abandon an upload and free its disk space. */
export async function cancelUploadSession(id: string): Promise<void> {
  if (!ID.test(id) || finishing.has(id)) return;
  sessions.delete(id);
  await removeDir(dirOf(id));
}
