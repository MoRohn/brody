import { describe, expect, it } from "vitest";
import { scanText } from "@/lib/analysis/rules";
import { AiFindingSchema } from "@/lib/review/ai";
import { applyUnifiedDiff } from "@/lib/review/patch";
import { assignCodes, dedupe, verifyDeterministic } from "@/lib/review/verify";
import type { FindingDraft } from "@/lib/review/types";
import type { LoadedFile } from "@/lib/graph/build";

const FILE = `export function run(input: string) {
  const parsed = eval(input);
  return parsed;
}
export function safe() {
  return 1;
}
`;
const file = (over: Partial<LoadedFile> = {}): LoadedFile => ({ id: "f1", projectId: "p", path: "src/run.ts", name: "run.ts", directory: "src", extension: "ts", language: "TypeScript", size: FILE.length, lines: FILE.split("\n").length, hash: "h", classification: "source", isBinary: false, isTest: false, isGenerated: false, isVendor: false, isExcluded: false, excludeReason: null, isLarge: false, hasContent: true, duplicateOf: null, imports: [], exports: [], parseStatus: "ast", parseError: null, module: null, area: null, role: null, importance: 0, explanation: null, text: FILE, ...over }) as LoadedFile;
const ctxFor = (f: LoadedFile) => ({ filesByPath: new Map([[f.path, f]]), symbols: [], rels: [] });
const draft = (o: Partial<FindingDraft> = {}): FindingDraft => ({ title: "eval on user input", category: "Security", severity: "High", confidence: "High", origin: "ai", filePath: "src/run.ts", startLine: 2, endLine: 2, evidence: "const parsed = eval(input);", whatHappens: "w", whyItMatters: "y", remediation: "r", verification: "needs_verification", ...o });

describe("structured finding validation", () => {
  const valid = { findings: [{ title: "t", category: "Security", severity: "High", confidence: "Medium", path: "a.ts", startLine: 1, endLine: 2, evidenceQuote: "q", whatHappens: "w", whyItMatters: "y", businessImpact: "", remediation: "r", suggestedPatch: "", relatedSymbols: [] }] };
  it("accepts a well-formed response", () => { expect(AiFindingSchema.safeParse(valid).success).toBe(true); });
  it("rejects unknown severities, categories and missing fields", () => {
    expect(AiFindingSchema.safeParse({ findings: [{ ...valid.findings[0], severity: "Catastrophic" }] }).success).toBe(false);
    expect(AiFindingSchema.safeParse({ findings: [{ ...valid.findings[0], category: "Vibes" }] }).success).toBe(false);
    const { path: _p, ...noPath } = valid.findings[0];
    expect(AiFindingSchema.safeParse({ findings: [noPath] }).success).toBe(false);
  });
});

describe("evidence association and deterministic verification", () => {
  it("re-anchors line numbers to where the quoted code really is", () => {
    const v = verifyDeterministic(draft({ startLine: 6, endLine: 6 }), ctxFor(file()))!;
    expect(v.startLine).toBe(2);
    expect(v.verificationNote).toContain("re-anchored");
    expect(v.evidence).toContain("2: ");
    expect(v.evidence).toContain("eval(input)");
  });
  it("rejects findings that cite files that do not exist", () => {
    expect(verifyDeterministic(draft({ filePath: "src/missing.ts" }), ctxFor(file()))).toBeNull();
  });
  it("rejects high-severity findings whose quoted evidence is not in the file, and demotes lower ones", () => {
    expect(verifyDeterministic(draft({ evidence: "danger(userInput)" }), ctxFor(file()))).toBeNull();
    const low = verifyDeterministic(draft({ severity: "Low", confidence: "Medium", evidence: "danger(userInput)" }), ctxFor(file()))!;
    expect(low.confidence).toBe("Low");
    expect(low.verificationNote).toContain("not found verbatim");
  });
  it("downgrades findings that sit in test files", () => {
    const v = verifyDeterministic(draft(), ctxFor(file({ isTest: true })))!;
    expect(v.severity).toBe("Medium");
  });
  it("keeps a suggested patch only if it applies cleanly to the real file", () => {
    const good = `@@ -1,3 +1,3 @@\n export function run(input: string) {\n-  const parsed = eval(input);\n+  const parsed = JSON.parse(input);\n   return parsed;`;
    const bad = `@@ -1,3 +1,3 @@\n export function run(input: string) {\n-  const parsed = somethingElse(input);\n+  const parsed = JSON.parse(input);\n   return parsed;`;
    expect(verifyDeterministic(draft({ patch: good }), ctxFor(file()))!.patch).toBe(good);
    const dropped = verifyDeterministic(draft({ patch: bad }), ctxFor(file()))!;
    expect(dropped.patch).toBeUndefined();
    expect(dropped.verificationNote).toContain("patch discarded");
  });
  it("applies unified diffs with drifted line numbers and rejects mismatches", () => {
    const diff = `@@ -20,2 +20,2 @@\n-  return 1;\n+  return 2;\n }`;
    expect(applyUnifiedDiff(FILE, diff).result).toContain("return 2;");
    expect(applyUnifiedDiff(FILE, `@@ -1,1 +1,1 @@\n-nothing like this\n+x`).ok).toBe(false);
    expect(applyUnifiedDiff(FILE, "no hunks here").ok).toBe(false);
  });
});

describe("dedupe, codes and ordering", () => {
  it("does not merge different static problems that sit on adjacent lines", () => {
    const a = draft({ origin: "static", analyzer: "brody-rules/eval", title: "Dynamic code evaluation", startLine: 20, endLine: 20 });
    const b = draft({ origin: "static", analyzer: "brody-structure", title: "2 routes have no auth", startLine: 19, endLine: 19 });
    expect(dedupe([a, b])).toHaveLength(2);
  });
  it("merges an AI restatement into the static finding and keeps its patch", () => {
    const s = draft({ origin: "static", analyzer: "brody-rules/eval", title: "Dynamic code evaluation with eval()" });
    const ai = draft({ origin: "ai", title: "eval called on user input allows code evaluation", patch: "@@ -1 +1 @@\n-a\n+b" });
    const out = dedupe([ai, s]);
    expect(out).toHaveLength(1);
    expect(out[0].origin).toBe("static");
    expect(out[0].patch).toBeDefined();
    expect(out[0].verificationNote).toContain("Also reported by AI review");
  });
  it("assigns stable per-category codes ordered by severity", () => {
    const coded = assignCodes([draft({ severity: "Low", title: "l" }), draft({ severity: "Critical", title: "c", startLine: 5 }), draft({ category: "Reliability", severity: "Medium", title: "m" })]);
    expect(coded.map((c) => c.code)).toEqual(["SEC-001", "REL-001", "SEC-002"]);
    expect(coded[0].severity).toBe("Critical");
  });
});

describe("deterministic rule engine", () => {
  const scan = (lang: string, text: string, path = "src/x.ts") => scanText(path, lang, text, false).map((f) => f.analyzer);
  it("flags real problems", () => {
    expect(scan("TypeScript", "const v = eval(req.body.x);")).toContain("brody-rules/eval");
    expect(scan("TypeScript", "db.query(`SELECT * FROM t WHERE id = ${id}`);")).toContain("brody-rules/sql-concat");
    expect(scan("TypeScript", "const a = { rejectUnauthorized: false };")).toContain("brody-rules/tls-verify-off");
    expect(scan("TypeScript", "try {\n  go();\n} catch (e) {\n}\n")).toContain("brody-rules/empty-catch");
    expect(scan("Python", "try:\n    x()\nexcept:\n    pass\n", "a.py")).toContain("brody-rules/python-bare-except");
    expect(scan("Python", "import subprocess\nsubprocess.run(cmd, shell=True)\n", "a.py")).toContain("brody-rules/python-shell");
    expect(scan("TypeScript", "const p = req.query.path; fs.readFile(req.query.path, cb);")).toContain("brody-rules/path-join-user");
  });
  it("does not flag comments, safe calls or literal-only patterns", () => {
    expect(scan("TypeScript", "// eval(x) is dangerous, never call it")).not.toContain("brody-rules/eval");
    expect(scan("TypeScript", "const r = /a+/.exec(text);")).not.toContain("brody-rules/child-process-exec");
    expect(scan("TypeScript", "db.query('SELECT id FROM t WHERE id = $1', [id]);")).not.toContain("brody-rules/sql-concat");
    expect(scan("Python", "yaml.safe_load(data)", "a.py")).not.toContain("brody-rules/pickle-load");
  });
  it("reports cited line numbers and verified-by-pattern provenance", () => {
    const f = scanText("a.ts", "TypeScript", "const a = 1;\nconst b = eval(x);\n", false)[0];
    expect(f.startLine).toBe(2);
    expect(f.origin).toBe("static");
    expect(f.evidence).toContain("eval(x)");
    expect(f.verificationNote).toContain("Deterministic pattern match");
  });
});
