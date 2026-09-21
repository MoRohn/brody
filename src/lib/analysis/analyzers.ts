import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLintRunner, lintTargets, syntaxDiagnostics, syntaxTargets, SYNTAX_PATH, type LintRunner } from "./checkcore";
import { config } from "../config";
import type { LoadedFile } from "../graph/build";
import type { FileChecks } from "../parse/types";
import type { FindingDraft, Severity } from "../review/types";

export interface AnalyzerStatus {
  name: string;
  status: "ran" | "skipped" | "unavailable" | "error";
  detail: string;
  findings: number;
  files?: number;
}

/**
 * Run a binary without a shell, with a hard timeout and output cap. Analyzers
 * only read files that were extracted into a private temp directory, and never
 * execute repository code.
 */
function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; input?: string } = {}): Promise<{ code: number | null; stdout: string; stderr: string; missing?: boolean }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (r: { code: number | null; stdout: string; stderr: string; missing?: boolean }) => {
      if (!done) { done = true; resolve(r); }
    };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: { PATH: process.env.PATH ?? "", HOME: os.tmpdir(), LANG: "C.UTF-8" } as unknown as NodeJS.ProcessEnv, shell: false });
    } catch {
      finish({ code: null, stdout, stderr, missing: true });
      return;
    }
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish({ code: null, stdout, stderr: stderr + "\n[timed out]" }); }, opts.timeoutMs ?? 60000);
    child.stdout.on("data", (d: Buffer) => { if (stdout.length < 8_000_000) stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { if (stderr.length < 200_000) stderr += d.toString(); });
    child.on("error", (e: NodeJS.ErrnoException) => { clearTimeout(timer); finish({ code: null, stdout, stderr: String(e), missing: e.code === "ENOENT" }); });
    child.on("close", (code: number | null) => { clearTimeout(timer); finish({ code, stdout, stderr }); });
    if (opts.input) child.stdin.end(opts.input); else child.stdin.end();
  });
}

/** Extract files into a private temp directory without blocking the event loop. */
async function writeTemp(files: LoadedFile[]): Promise<string> {
  // realpath: on macOS the temp dir is a symlink, and analyzers report resolved paths.
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "brody-analyze-")));
  const made = new Set<string>();
  let n = 0;
  for (const f of files) {
    if (f.text === undefined) continue;
    const target = path.resolve(dir, f.path);
    if (!target.startsWith(dir + path.sep)) continue; // defence in depth against traversal
    const parent = path.dirname(target);
    if (!made.has(parent)) { await fsp.mkdir(parent, { recursive: true }); made.add(parent); }
    await fsp.writeFile(target, f.text);
    if (++n % 200 === 0) await new Promise<void>((r) => setImmediate(r));
  }
  return dir;
}

function sev(s: string): Severity {
  return s as Severity;
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript syntactic diagnostics (no module resolution, no execution)
// ---------------------------------------------------------------------------
export function runTypeScriptSyntax(files: LoadedFile[], checks?: Map<string, FileChecks>): { findings: FindingDraft[]; status: AnalyzerStatus } {
  const targets = syntaxTargets(files);
  const findings: FindingDraft[] = [];
  if (files.filter((f) => f.text !== undefined && SYNTAX_PATH.test(f.path) && !f.isGenerated).length === 0) return { findings, status: { name: "typescript", status: "skipped", detail: "No TypeScript or JavaScript files.", findings: 0 } };
  for (const f of targets) {
    // Diagnostics computed beside the parse (in a worker) are reused; anything missing is computed here with the same code.
    const diags = checks?.get(f.path)?.syntax ?? syntaxDiagnostics(f.path, f.text!);
    for (const d of diags) {
      const line = d.line;
      const msg = d.message;
      findings.push({
        title: `Syntax error: ${msg.slice(0, 80)}`, category: "Correctness", severity: "High", confidence: "High", origin: "static", analyzer: "typescript",
        filePath: f.path, startLine: line, endLine: line, evidence: f.text!.split("\n").slice(Math.max(0, line - 2), line + 1).map((l, i) => `${Math.max(1, line - 1) + i}: ${l.slice(0, 200)}`).join("\n"),
        whatHappens: `The TypeScript parser reports: ${msg}`, whyItMatters: "A file that does not parse cannot be compiled or executed, and tooling such as symbol indexing is incomplete for it.", remediation: "Fix the syntax at the cited line.", verification: "verified", verificationNote: "Reported by the TypeScript compiler parser.",
      });
    }
  }
  return { findings, status: { name: "typescript", status: "ran", detail: "Syntactic diagnostics via the TypeScript compiler API (no type resolution, no code execution).", findings: findings.length, files: targets.length } };
}

// ---------------------------------------------------------------------------
// ESLint with a fixed, embedded rule set. Repository ESLint configs are never
// loaded because they are executable JavaScript.
// ---------------------------------------------------------------------------
export async function runEslint(files: LoadedFile[], checks?: Map<string, FileChecks>): Promise<{ findings: FindingDraft[]; status: AnalyzerStatus }> {
  const targets = lintTargets(files);
  if (targets.length === 0) return { findings: [], status: { name: "eslint", status: "skipped", detail: "No JavaScript or TypeScript files.", findings: 0 } };
  // Results computed in a worker are reused; only files without one need a linter here, and it is created on first need.
  let runner: LintRunner | null | undefined;
  const findings: FindingDraft[] = [];
  let linted = 0;
  for (const f of targets) {
    let res = checks?.get(f.path)?.lint;
    if (!res) {
      if (runner === undefined) runner = await createLintRunner();
      if (!runner) return { findings: [], status: { name: "eslint", status: "unavailable", detail: "@typescript-eslint/parser is not installed.", findings: 0 } };
      res = runner(f.path, f.text!);
    }
    if (!res.ok) continue;
    linted++;
    for (const m of res.messages) {
      if (!m.ruleId || m.fatal) continue;
      const line = m.line;
      const isSecurity = /implied-eval/.test(m.ruleId);
      findings.push({
        title: `ESLint ${m.ruleId}: ${m.message.slice(0, 90)}`, category: isSecurity ? "Security" : "Correctness", severity: sev(isSecurity ? "High" : m.severity === 2 ? "Medium" : "Low"), confidence: "High", origin: "static", analyzer: `eslint/${m.ruleId}`,
        filePath: f.path, startLine: line, endLine: m.endLine ?? line, evidence: f.text!.split("\n").slice(Math.max(0, line - 2), line + 1).map((l, i) => `${Math.max(1, line - 1) + i}: ${l.slice(0, 200)}`).join("\n"),
        whatHappens: m.message, whyItMatters: `ESLint rule ${m.ruleId} flags constructs that are typically bugs or unsafe patterns.`, remediation: `Address the pattern reported by ${m.ruleId} at the cited line.`, verification: "verified", verificationNote: "Reported by ESLint using a fixed embedded rule set.",
      });
    }
  }
  return { findings, status: { name: "eslint", status: "ran", detail: "ESLint Linter API with a fixed embedded rule set; repository ESLint configs are not executed.", findings: findings.length, files: linted } };
}

// ---------------------------------------------------------------------------
// Python: ast.parse (no execution) and Ruff (isolated: repository config ignored)
// ---------------------------------------------------------------------------
const PY_AST = `
import ast, json, sys
out = []
for p in sys.argv[1:]:
    try:
        with open(p, "rb") as f:
            src = f.read()
        ast.parse(src, filename=p)
    except SyntaxError as e:
        out.append({"path": p, "line": e.lineno or 1, "msg": e.msg})
    except Exception as e:
        out.append({"path": p, "line": 1, "msg": str(e)})
print(json.dumps(out))
`;

export async function runPython(files: LoadedFile[]): Promise<{ findings: FindingDraft[]; statuses: AnalyzerStatus[] }> {
  const targets = files.filter((f) => f.text !== undefined && f.language === "Python" && !f.isGenerated);
  if (targets.length === 0) return { findings: [], statuses: [{ name: "python-ast", status: "skipped", detail: "No Python files.", findings: 0 }, { name: "ruff", status: "skipped", detail: "No Python files.", findings: 0 }] };
  const dir = await writeTemp(targets);
  const findings: FindingDraft[] = [];
  const statuses: AnalyzerStatus[] = [];
  const textOf = new Map(targets.map((f) => [f.path, f.text!]));
  try {
    const py = await run(config.staticAnalysis.pythonPath, ["-I", "-c", PY_AST, ...targets.map((t) => t.path)], { cwd: dir, timeoutMs: 60000 });
    if (py.missing) statuses.push({ name: "python-ast", status: "unavailable", detail: `${config.staticAnalysis.pythonPath} was not found on PATH.`, findings: 0 });
    else {
      try {
        const errs = JSON.parse(py.stdout || "[]") as { path: string; line: number; msg: string }[];
        for (const e of errs) findings.push({ title: `Python syntax error: ${e.msg.slice(0, 80)}`, category: "Correctness", severity: "High", confidence: "High", origin: "static", analyzer: "python-ast", filePath: e.path, startLine: e.line, endLine: e.line, evidence: (textOf.get(e.path) ?? "").split("\n").slice(Math.max(0, e.line - 2), e.line + 1).map((l, i) => `${Math.max(1, e.line - 1) + i}: ${l.slice(0, 200)}`).join("\n"), whatHappens: `Python's ast module cannot parse this file: ${e.msg}`, whyItMatters: "The module fails to import, so everything that depends on it fails at startup.", remediation: "Fix the syntax error at the cited line.", verification: "verified", verificationNote: "Reported by Python's ast.parse; the code was parsed, not executed." });
        statuses.push({ name: "python-ast", status: "ran", detail: "ast.parse validation in isolated mode (code is parsed, never executed).", findings: errs.length, files: targets.length });
      } catch {
        statuses.push({ name: "python-ast", status: "error", detail: `Unexpected output: ${py.stderr.slice(0, 200)}`, findings: 0 });
      }
    }
    const ruff = await run(config.staticAnalysis.ruffPath, ["check", "--isolated", "--no-cache", "--output-format", "json", "--select", "E9,F63,F7,F82,F401,F811,F841,B006,B008,B015,B018,B023,B904,S102,S103,S301,S302,S307,S324,S501,S506,S602,S604,S605,S608,S701,PLE,RUF006", "."], { cwd: dir, timeoutMs: 90000 });
    if (ruff.missing) statuses.push({ name: "ruff", status: "unavailable", detail: `${config.staticAnalysis.ruffPath} was not found on PATH; install ruff to enable Python linting.`, findings: 0 });
    else {
      try {
        const items = JSON.parse(ruff.stdout || "[]") as { code: string; message: string; filename: string; location: { row: number }; end_location?: { row: number } }[];
        let n = 0;
        for (const it of items) {
          const rel = path.relative(dir, it.filename);
          if (!textOf.has(rel)) continue;
          // Python's own parser already reported syntax errors for this file; do not duplicate them.
          if (it.code === "invalid-syntax" && findings.some((f) => f.analyzer === "python-ast" && f.filePath === rel)) continue;
          if (["F401", "F841", "F811"].includes(it.code) && n > 200) continue;
          n++;
          const security = /^S/.test(it.code);
          const syntax = it.code === "invalid-syntax" || /^E9/.test(it.code);
          const line = it.location.row;
          findings.push({ title: `Ruff ${it.code}: ${it.message.slice(0, 90)}`, category: security ? "Security" : syntax || it.code.startsWith("B") || it.code.startsWith("F") ? "Correctness" : "Maintainability", severity: syntax ? "High" : security ? "Medium" : ["F401", "F841", "F811"].includes(it.code) ? "Low" : "Medium", confidence: "High", origin: "static", analyzer: `ruff/${it.code}`, filePath: rel, startLine: line, endLine: it.end_location?.row ?? line, evidence: textOf.get(rel)!.split("\n").slice(Math.max(0, line - 2), line + 1).map((l, i) => `${Math.max(1, line - 1) + i}: ${l.slice(0, 200)}`).join("\n"), whatHappens: it.message, whyItMatters: `Ruff rule ${it.code} identifies a likely defect, unsafe call or dead code.`, remediation: `Resolve the ${it.code} diagnostic; see the Ruff rule documentation for the recommended change.`, verification: "verified", verificationNote: "Reported by Ruff run in --isolated mode." });
        }
        statuses.push({ name: "ruff", status: "ran", detail: "Ruff in --isolated mode with a fixed rule selection; repository Ruff configuration is ignored.", findings: n, files: targets.length });
      } catch {
        statuses.push({ name: "ruff", status: "error", detail: `Ruff failed: ${(ruff.stderr || ruff.stdout).slice(0, 200)}`, findings: 0 });
      }
    }
    statuses.push({ name: "mypy", status: "skipped", detail: "Skipped for safety: mypy loads plugins named in repository configuration, which would execute untrusted code outside a sandbox.", findings: 0 });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
  return { findings, statuses };
}

// ---------------------------------------------------------------------------
// Go: gofmt -e (syntax only). `go vet` needs to compile and resolve modules,
// which can trigger downloads and code generation, so it is not run here.
// ---------------------------------------------------------------------------
export async function runGo(files: LoadedFile[]): Promise<{ findings: FindingDraft[]; statuses: AnalyzerStatus[] }> {
  const targets = files.filter((f) => f.text !== undefined && f.language === "Go" && !f.isGenerated);
  if (targets.length === 0) return { findings: [], statuses: [] };
  const vet: AnalyzerStatus = { name: "go vet", status: "skipped", detail: "Skipped for safety: go vet compiles packages and resolves modules, which requires network access and can run code generators. Run it inside a sandbox in CI.", findings: 0 };
  const dir = await writeTemp(targets);
  const findings: FindingDraft[] = [];
  try {
    const gofmtPath = config.staticAnalysis.goPath.replace(/go$/, "gofmt");
    const res = await run(gofmtPath, ["-e", "-l", "."], { cwd: dir, timeoutMs: 60000 });
    if (res.missing) return { findings, statuses: [{ name: "gofmt", status: "unavailable", detail: "gofmt was not found on PATH; Go syntax checking was skipped.", findings: 0 }, vet] };
    const textOf = new Map(targets.map((f) => [f.path, f.text!]));
    for (const m of res.stderr.matchAll(/^(.+?):(\d+):(\d+):\s*(.+)$/gm)) {
      const rel = m[1].replace(/^\.\//, "");
      if (!textOf.has(rel)) continue;
      const line = Number(m[2]);
      findings.push({ title: `Go syntax error: ${m[4].slice(0, 80)}`, category: "Correctness", severity: "High", confidence: "High", origin: "static", analyzer: "gofmt", filePath: rel, startLine: line, endLine: line, evidence: textOf.get(rel)!.split("\n").slice(Math.max(0, line - 2), line + 1).map((l, i) => `${Math.max(1, line - 1) + i}: ${l.slice(0, 200)}`).join("\n"), whatHappens: m[4], whyItMatters: "Go source that does not parse cannot be built.", remediation: "Fix the syntax error.", verification: "verified", verificationNote: "Reported by gofmt -e (syntax only)." });
    }
    return { findings, statuses: [{ name: "gofmt", status: "ran", detail: "gofmt -e syntax check.", findings: findings.length, files: targets.length }, vet] };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}
