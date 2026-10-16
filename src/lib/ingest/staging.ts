import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config";
import { AppError } from "../util/errors";
import { newId } from "../util/ids";
import { formatBytes } from "../util/text";

/** Working directories untouched for this long belong to abandoned uploads or interrupted imports. */
export const STAGING_IDLE_MS = 6 * 60 * 60 * 1000;

/**
 * Where uploads, archives and repository downloads wait on disk while they are ingested: beside the database, which in
 * Docker is the data volume. Not the system temp directory: Compose mounts /tmp in memory, which staging exists to spare.
 */
export function stagingRoot(): string {
  return config.databasePath === ":memory:" ? path.join(os.tmpdir(), `brody-staging-${process.pid}`) : path.join(path.dirname(config.databasePath), "staging");
}

/** A fresh, empty working directory under the staging root. */
export async function makeWorkDir(prefix: string): Promise<string> {
  const dir = path.join(stagingRoot(), newId(prefix));
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

export async function removeDir(dir: string): Promise<void> {
  await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

export const isDiskFull = (e: unknown): boolean => ["ENOSPC", "EDQUOT"].includes((e as NodeJS.ErrnoException | undefined)?.code ?? "");

export const diskFullError = () => new AppError("insufficient_storage", "The server ran out of disk space while receiving the code.", 507, "Free disk space where Brody keeps its data (the Docker volume, or the folder holding DATABASE_PATH), or upload a smaller project.");

/** Refuse work that cannot fit on disk, keeping room for the database, which grows as the files are ingested. */
export async function ensureFreeSpace(bytes: number): Promise<void> {
  const root = stagingRoot();
  await fs.promises.mkdir(root, { recursive: true });
  let free: number;
  try {
    const s = await fs.promises.statfs(root);
    free = s.bavail * s.bsize;
  } catch {
    return; // Not every filesystem reports free space; writing still fails cleanly when it runs out.
  }
  const needed = bytes + 512 * 1024 * 1024;
  if (free < needed) throw new AppError("insufficient_storage", `The upload needs about ${formatBytes(needed)} of free disk space, and the server has ${formatBytes(free)}.`, 507, "Free disk space where Brody keeps its data (the Docker volume, or the folder holding DATABASE_PATH), or leave dependency and build folders out of the upload.");
}

/** Remove working directories left behind by abandoned uploads, or by imports a restart interrupted. */
export async function sweepStaging(maxIdleMs = STAGING_IDLE_MS): Promise<string[]> {
  const root = stagingRoot();
  let names: string[];
  try { names = await fs.promises.readdir(root); } catch { return []; }
  const now = Date.now();
  const removed: string[] = [];
  await Promise.all(names.map(async (name) => {
    const dir = path.join(root, name);
    const st = await fs.promises.stat(dir).catch(() => null);
    if (st && now - st.mtimeMs > maxIdleMs) { await removeDir(dir); removed.push(name); }
  }));
  return removed;
}
