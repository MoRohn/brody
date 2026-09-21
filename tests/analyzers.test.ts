import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runEslint, runGo, runPython, runTypeScriptSyntax } from "@/lib/analysis/analyzers";
import type { LoadedFile } from "@/lib/graph/build";
import { search } from "@/lib/retrieval";
import { buildSearchIndex } from "@/lib/retrieval";
import { analyze, fixtureFiles, freshDb, setAIProvider } from "./helpers";
import type { AIProvider, AnalysisRequest, AnalysisResult } from "@/lib/ai";

const lf = (path: string, language: string, text: string): LoadedFile => ({ id: path, projectId: "p", path, name: path.split("/").pop()!, directory: "", extension: path.split(".").pop()!, language, size: text.length, lines: text.split("\n").length, hash: path, classification: "source", isBinary: false, isTest: false, isGenerated: false, isVendor: false, isExcluded: false, excludeReason: null, isLarge: false, hasContent: true, duplicateOf: null, imports: [], exports: [], parseStatus: "ast", parseError: null, module: null, area: null, role: null, importance: 0, explanation: null, text }) as LoadedFile;
const has = (cmd: string) => { try { return spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0; } catch { return false; } };

describe("static analyzer adapters (deterministic, never AI)", () => {
  it("TypeScript syntax diagnostics report the real line", () => {
    const { findings, status } = runTypeScriptSyntax([lf("a.ts", "TypeScript", "export const ok = 1;\nexport function broken( {\n"), lf("b.ts", "TypeScript", "export const fine = 2;\n")]);
    expect(status.status).toBe("ran");
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.origin === "static" && f.analyzer === "typescript" && f.filePath === "a.ts")).toBe(true);
    expect(findings[0].startLine).toBeGreaterThanOrEqual(2);
  });

  it("ESLint runs an embedded rule set (repository configs are never loaded)", async () => {
    const { findings, status } = await runEslint([lf("x.js", "JavaScript", "const o = { a: 1, a: 2 };\nif (x === NaN) {}\nexport {};\n"), lf("eslint.config.js", "JavaScript", "throw new Error('repository config must never execute');\n")]);
    expect(status.status).toBe("ran");
    const rules = findings.map((f) => f.analyzer);
    expect(rules).toEqual(expect.arrayContaining(["eslint/no-dupe-keys", "eslint/use-isnan"]));
    expect(findings.every((f) => f.origin === "static")).toBe(true);
  });

  it("ESLint checks TypeScript and JSX files too, in nested folders (a universal files pattern silently skipped them)", async () => {
    const bad = "const o = { a: 1, a: 2 };\nif (x === NaN) {}\nexport {};\n";
    for (const [path, lang] of [["src/deep/a.ts", "TypeScript"], ["src/b.tsx", "TypeScript"], ["c.mts", "TypeScript"], ["src/d.jsx", "JavaScript"], ["e.cjs", "JavaScript"]] as const) {
      const { findings, status } = await runEslint([lf(path, lang, bad)]);
      expect(status.status, path).toBe("ran");
      expect(findings.map((f) => f.analyzer), path).toEqual(expect.arrayContaining(["eslint/no-dupe-keys", "eslint/use-isnan"]));
    }
    // A finding is never reported for a file the linter could not match (those come back without a rule id).
    const none = await runEslint([lf("notes.txt", "Text", bad)]);
    expect(none.status.status).toBe("skipped");
  });

  it("Python: ast.parse catches syntax errors without executing code; Ruff runs isolated when installed", async () => {
    const marker = "/tmp/brody-should-not-exist-" + Date.now();
    const { findings, statuses } = await runPython([
      lf("bad.py", "Python", "def f(:\n    pass\n"),
      lf("evil.py", "Python", `import os\nos.system("touch ${marker}")\nimport sys\n`),
      lf("pyproject.toml", "TOML", "[tool.ruff]\nselect = ['ALL']\n"),
    ]);
    expect(statuses.find((s) => s.name === "python-ast")!.status).toBe("ran");
    expect(findings.some((f) => f.analyzer === "python-ast" && f.filePath === "bad.py")).toBe(true);
    expect(statuses.find((s) => s.name === "mypy")!.status).toBe("skipped");
    const { existsSync } = await import("node:fs");
    expect(existsSync(marker)).toBe(false); // repository code was parsed, never executed
    if (has("ruff")) {
      expect(statuses.find((s) => s.name === "ruff")!.status).toBe("ran");
      expect(findings.some((f) => (f.analyzer ?? "").startsWith("ruff/"))).toBe(true);
    } else {
      expect(statuses.find((s) => s.name === "ruff")!.status).toBe("unavailable");
    }
  });

  it("reports analyzers that are unavailable or skipped instead of pretending", async () => {
    const go = await runGo([lf("main.go", "Go", "package main\nfunc main() {}\n")]);
    expect(go.statuses.find((s) => s.name === "go vet")!.status).toBe("skipped");
    expect(go.statuses.find((s) => s.name === "go vet")!.detail).toContain("sandbox");
    expect(["ran", "unavailable"]).toContain(go.statuses[0].status);
    expect((await runGo([lf("a.ts", "TypeScript", "x")])).statuses).toEqual([]);
  });
});

/** Embeds text into a tiny concept space so synonyms land close together. */
class EmbedProvider implements AIProvider {
  readonly name = "embed-mock";
  readonly model = "m";
  async analyze<T>(_r: AnalysisRequest<T>): Promise<AnalysisResult<T>> { throw new Error("not used"); }
  async embed(texts: string[]): Promise<number[][]> {
    const concepts = [["order", "purchase", "checkout", "createorder"], ["payment", "charge", "stripe", "billing"], ["route", "endpoint", "request"], ["price", "total", "tax", "cost"]];
    return texts.map((t) => { const w = t.toLowerCase(); return concepts.map((c) => c.reduce((n, k) => n + (w.includes(k) ? 1 : 0), 0)); });
  }
}

describe("semantic retrieval (optional embeddings)", () => {
  it("stores embeddings and finds conceptually related code with no shared words", async () => {
    freshDb();
    const { projectId } = await analyze(fixtureFiles(), "shop");
    setAIProvider(new EmbedProvider());
    const built = await buildSearchIndex(projectId, { embed: true });
    expect(built.embedded).toBeGreaterThan(10);
    const q = "purchase flow";
    const hits = await search(projectId, q, { kinds: ["symbol"] });
    const top = hits.filter((h) => h.signals.semantic > 0.5);
    expect(top.length).toBeGreaterThan(0);
    expect(top.some((h) => h.title === "createOrder")).toBe(true);
    // Without embeddings the same query has no lexical overlap with createOrder.
    setAIProvider(null);
    const lexicalOnly = await search(projectId, q, { kinds: ["symbol"] });
    expect(lexicalOnly.every((h) => h.signals.semantic === 0)).toBe(true);
  });
});
