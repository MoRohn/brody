import { createLintRunner, syntaxDiagnostics, type LintRunner } from "../analysis/checkcore";
import { SYNTAX_WARNING } from "./extract";
import { parseFile } from "./index";
import type { FileChecks, ParsedFile } from "./types";

/** Everything that can be computed for one file without looking at any other file. */
export interface ParseJob { path: string; language: string; source: string; syntax: boolean; lint: boolean }
export interface ParseOutput { parsed?: ParsedFile; error?: string }

let lintRunner: Promise<LintRunner | null> | undefined;

/**
 * Parse a file and run its per-file static checks. This is the single implementation behind both the worker threads and the
 * in-process fallback, so the two can never disagree.
 */
export async function runParseJob(job: ParseJob): Promise<ParseOutput> {
  try {
    const parsed = await parseFile(job.path, job.language, job.source);
    const checks: FileChecks = {};
    if (job.syntax) checks.syntax = syntaxDiagnostics(job.path, job.source);
    // The TypeScript compiler is the authority on TypeScript syntax. When it accepts the file, a tree-sitter error is a
    // gap in the grammar (a bare & in a JSX string, `unique` used as a name), not a problem in the repository, so it is
    // not reported as one; the grammar recovers locally and the rest of the file is extracted as usual.
    if (checks.syntax?.length === 0 && parsed.error === SYNTAX_WARNING) parsed.error = undefined;
    if (job.lint) {
      const runner = await (lintRunner ??= createLintRunner());
      if (runner) checks.lint = runner(job.path, job.source);
    }
    if (checks.syntax || checks.lint) parsed.checks = checks;
    return { parsed };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
