import { AppError } from "../util/errors";
import { DEFAULT_EXCLUDED_DIRS } from "./classify";

/**
 * Normalize an archive/upload path and reject anything that could escape the
 * project root. Returns undefined for entries that should simply be skipped
 * (directories, empty names).
 */
export function sanitizeRelativePath(input: string): string | undefined {
  let p = input.replace(/\\/g, "/");
  p = p.replace(/^\.\/+/, "");
  if (p === "" || p.endsWith("/")) return undefined;
  if (p.includes("\0")) throw new AppError("bad_path", `Rejected path containing NUL byte`);
  if (/^[a-zA-Z]:\//.test(p) || p.startsWith("/") || p.startsWith("//")) {
    throw new AppError("path_traversal", `Rejected absolute path in archive: ${input}`, 400, "Archives must contain only relative paths.");
  }
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  if (parts.some((s) => s === "..")) {
    throw new AppError("path_traversal", `Rejected path traversal in archive: ${input}`, 400, "The archive contains a '..' segment that would escape the project root.");
  }
  if (parts.length === 0) return undefined;
  return parts.join("/");
}

/** Remove a single shared top-level directory (GitHub zipballs wrap everything in owner-repo-sha/). */
export function stripCommonRoot(paths: string[]): (p: string) => string {
  if (paths.length === 0) return (p) => p;
  const firstSegments = new Set(paths.map((p) => p.split("/")[0]));
  const allNested = paths.every((p) => p.includes("/"));
  // A single top-level directory is a wrapper (owner-repo-sha/, the picked folder) unless it is itself a directory we exclude by default.
  if (firstSegments.size === 1 && allNested && !DEFAULT_EXCLUDED_DIRS.includes([...firstSegments][0])) {
    const root = [...firstSegments][0] + "/";
    return (p) => (p.startsWith(root) ? p.slice(root.length) : p);
  }
  return (p) => p;
}
