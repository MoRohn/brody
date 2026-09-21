import ts from "typescript";
import type { LintMessage, SyntaxDiag } from "../parse/types";

/**
 * The per-file JavaScript/TypeScript checks (syntax diagnostics and ESLint), kept free of database and framework code so
 * the same implementation runs in a worker thread beside the parser and, as a fallback, on the main thread.
 */
export const SYNTAX_PATH = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
export const LINT_PATH = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const MAX_SYNTAX_FILES = 3000;
const MAX_LINT_FILES = 1500;
const MAX_LINT_BYTES = 400_000;

interface CheckFile { path: string; text?: string; isGenerated: boolean; size: number }

/** Files the syntax check covers, in repository order and capped, exactly as the analyzer selects them. */
export function syntaxTargets<T extends CheckFile>(files: T[]): T[] {
  return files.filter((f) => f.text !== undefined && SYNTAX_PATH.test(f.path) && !f.isGenerated).slice(0, MAX_SYNTAX_FILES);
}

/** Files ESLint covers, in repository order and capped. */
export function lintTargets<T extends CheckFile>(files: T[]): T[] {
  return files.filter((f) => f.text !== undefined && LINT_PATH.test(f.path) && !f.isGenerated && f.size < MAX_LINT_BYTES).slice(0, MAX_LINT_FILES);
}

/** The TypeScript parser's own diagnostics (no module resolution, no execution): at most three per file. */
export function syntaxDiagnostics(filePath: string, text: string): SyntaxDiag[] {
  const kind = /\.tsx$/.test(filePath) ? ts.ScriptKind.TSX : /\.jsx$/.test(filePath) ? ts.ScriptKind.JSX : /\.tsx?$|\.[cm]ts$/.test(filePath) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  // setParentNodes is off: diagnostics do not need parent pointers and building them costs about a sixth of the parse.
  const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, false, kind);
  const diags = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  return diags.slice(0, 3).map((d) => ({ line: sf.getLineAndCharacterOfPosition(d.start ?? 0).line + 1, message: ts.flattenDiagnosticMessageText(d.messageText, "\n") }));
}

const RULES: Record<string, [string | number, ...unknown[]] | string> = {
  // no-eval and no-new-func are left out on purpose: Brody's own "eval" and "new-function" rules already report them, and two findings for one line is noise.
  "no-implied-eval": "error", "no-dupe-keys": "error", "no-dupe-else-if": "error", "no-duplicate-case": "error",
  "no-unreachable": "warn", "no-self-assign": "error", "no-cond-assign": "warn", "use-isnan": "error", "valid-typeof": "error", "no-fallthrough": "warn",
  "no-unsafe-negation": "error", "no-unsafe-finally": "error", "no-loss-of-precision": "warn", "no-prototype-builtins": "warn", "no-sparse-arrays": "warn",
  "no-compare-neg-zero": "error", "no-constant-binary-expression": "error", "no-unsafe-optional-chaining": "error", "no-async-promise-executor": "error",
  "no-await-in-loop": "off", "no-empty-pattern": "warn", "no-self-compare": "warn", "require-atomic-updates": "off", "no-unmodified-loop-condition": "warn",
  "no-setter-return": "error", "no-import-assign": "error", "no-const-assign": "error", "no-class-assign": "error", "no-func-assign": "error", "getter-return": "error",
};

export type LintRunner = (filePath: string, text: string) => { ok: boolean; messages: LintMessage[] };

/**
 * ESLint with a fixed embedded rule set (repository configs are never loaded, they are executable code). Returns null when
 * the TypeScript parser for ESLint is not installed.
 */
export async function createLintRunner(): Promise<LintRunner | null> {
  let parser: unknown;
  try {
    parser = await import("@typescript-eslint/parser");
  } catch {
    return null;
  }
  const { Linter } = await import("eslint");
  const linter = new Linter({ configType: "flat" });
  // One config object for the whole run: ESLint normalizes a config array on every verify() call, so building it per file repeated that work.
  const flatConfig = [{
    // Not "**/*": ESLint 9 treats a universal pattern as matching only .js/.mjs/.cjs, so every TypeScript and JSX file was skipped
    // ("No matching configuration found") and the analyzer reported nothing for them. Name the extensions explicitly.
    files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
    languageOptions: { parser: parser as never, ecmaVersion: "latest" as const, sourceType: "module" as const, parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: RULES as never,
  }];
  return (filePath, text) => {
    try {
      const messages = linter.verify(text, flatConfig, { filename: filePath });
      return { ok: true, messages: messages.slice(0, 5).map((m) => ({ ruleId: m.ruleId, fatal: !!m.fatal, message: m.message, line: m.line, endLine: m.endLine, severity: m.severity })) };
    } catch {
      return { ok: false, messages: [] }; // unparsable file: the syntax analyzer reports it
    }
  };
}
