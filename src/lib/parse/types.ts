export type SymbolKind =
  | "function" | "method" | "class" | "interface" | "type" | "enum" | "constant" | "variable"
  | "route" | "endpoint" | "model" | "schema" | "component" | "hook" | "service" | "job" | "event_handler"
  | "module" | "struct" | "trait" | "namespace" | "property" | "section" | "table";

export interface ParsedSymbol {
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  signature?: string;
  parentName?: string;
  documentation?: string;
  exported: boolean;
  visibility: "public" | "private" | "protected" | "internal";
  meta?: Record<string, unknown>;
  /** Local index used to resolve parent relationships. */
  index: number;
  parentIndex?: number;
}

export interface ParsedImport {
  /** Raw module specifier as written (./x, react, os.path). */
  specifier: string;
  /** Imported names when known. */
  names: string[];
  line: number;
  isTypeOnly?: boolean;
}

export interface ParsedCall {
  /** Callee name: last identifier segment (e.g. `save` from `repo.save`). */
  name: string;
  /** Full callee expression text, truncated. */
  expression: string;
  line: number;
  /** Index of the enclosing symbol in the symbols array, if any. */
  callerIndex?: number;
  /** Up to four argument texts (truncated) for route/event heuristics. */
  args?: string[];
  /** True when the call is a constructor (new X()). */
  isNew?: boolean;
}

export interface ParsedInheritance {
  /** Symbol index of the child. */
  childIndex: number;
  parentName: string;
  kind: "EXTENDS" | "IMPLEMENTS";
}

export interface ParsedFile {
  status: "ast" | "text" | "skipped";
  parser: string;
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  calls: ParsedCall[];
  exports: string[];
  inheritance: ParsedInheritance[];
  /** Identifiers referenced in the file (for cross-file resolution). */
  identifiers: Set<string>;
  /** Decorators/annotations discovered, keyed by symbol index. */
  decorators: Map<number, string[]>;
  error?: string;
  /** Rough complexity: count of branching constructs per symbol index. */
  complexity: Map<number, number>;
}

export function emptyParse(status: ParsedFile["status"], parser: string, error?: string): ParsedFile {
  return { status, parser, symbols: [], imports: [], calls: [], exports: [], inheritance: [], identifiers: new Set(), decorators: new Map(), error, complexity: new Map() };
}
