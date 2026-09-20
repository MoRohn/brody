export interface RawFile {
  /** Normalized, forward-slash relative path. */
  path: string;
  content: Buffer;
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
