import type { ProcessedImage } from "./visuals";

export interface RawFile {
  /** Normalized, forward-slash relative path. */
  path: string;
  content: Buffer;
}

/** A file waiting on disk to be ingested: large uploads, archives and repository downloads never sit in memory whole. */
export interface StagedFile {
  /** Normalized, forward-slash relative path. */
  path: string;
  size: number;
  /** Absolute path of the bytes on disk. */
  file: string;
}

export interface NormalizedFile {
  path: string;
  name: string;
  directory: string;
  extension: string;
  language: string;
  size: number;
  lines: number;
  hash: string;
  classification: string;
  isBinary: boolean;
  isTest: boolean;
  isGenerated: boolean;
  isVendor: boolean;
  isExcluded: boolean;
  excludeReason?: string;
  isLarge: boolean;
  hasContent: boolean;
  duplicateOf?: string;
  /** UTF-8 text content when available and within limits. */
  text?: string;
  /** A bounded rendering of the file when it is one of the project's visuals (logo, icon, social card, screenshot). */
  image?: ProcessedImage;
}

export interface IngestSource {
  type: "file" | "files" | "folder" | "zip" | "github";
  name: string;
  url?: string;
  owner?: string;
  branch?: string;
  commit?: string;
}

export interface IngestStats {
  total: number;
  included: number;
  excluded: number;
  binary: number;
  bytes: number;
  languages: Record<string, number>;
  warnings: string[];
}
