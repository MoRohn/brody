import { eq } from "drizzle-orm";
import { runEslint, runGo, runPython, runTypeScriptSyntax, type AnalyzerStatus } from "../analysis/analyzers";
import { scanText } from "../analysis/rules";
import { structuralFindings } from "../analysis/structural";
import { config } from "../config";
import { getDb, schema } from "../db/client";
import type { Architecture } from "../discover/types";
import { loadProjectFiles } from "../graph/build";
import { UsageMeter, type AIProvider } from "../ai";
import { newId } from "../util/ids";
import { runAiReview } from "./ai";
import { assignCodes, dedupe, verifyDeterministic, verifyWithAI } from "./verify";
import type { FindingDraft } from "./types";
import { pushAll } from "../util/arrays";

export * from "./types";

export interface StaticReviewResult {
  drafts: FindingDraft[];
  analyzers: AnalyzerStatus[];
}

/** Deterministic analysis: pattern rules, language analyzers, structural checks. Never uses AI. */
export async function runStaticReview(projectId: string, arch: Architecture): Promise<StaticReviewResult> {
  const db = getDb();
  const files = loadProjectFiles(projectId).filter((f) => !f.isExcluded);
  const symbols = db.select().from(schema.symbols).where(eq(schema.symbols.projectId, projectId)).all();
  const drafts: FindingDraft[] = [];
  const analyzers: AnalyzerStatus[] = [];

  let ruleHits = 0;
  for (const f of files) {
    if (!f.text || f.classification === "lockfile" || f.classification === "docs" || f.isGenerated) continue;
    const found = scanText(f.path, f.language, f.text, f.isTest);
    ruleHits += found.length;
    pushAll(drafts, found);
  }
  analyzers.push({ name: "brody-rules", status: "ran", detail: "Built-in deterministic pattern rules (security, reliability, performance, operations).", findings: ruleHits, files: files.length });

  const structural = structuralFindings(files, symbols, arch);
  pushAll(drafts, structural);
  analyzers.push({ name: "brody-structure", status: "ran", detail: "Structural checks over the repository model (size, complexity, tests, operations, dependencies, secrets).", findings: structural.length });

  if (config.staticAnalysis.enabled) {
    const tsr = runTypeScriptSyntax(files);
    pushAll(drafts, tsr.findings);
    analyzers.push(tsr.status);
    const es = await runEslint(files);
    pushAll(drafts, es.findings);
    analyzers.push(es.status);
    const py = await runPython(files);
    pushAll(drafts, py.findings);
    pushAll(analyzers, py.statuses);
    const go = await runGo(files);
    pushAll(drafts, go.findings);
    pushAll(analyzers, go.statuses);
  } else {
    analyzers.push({ name: "language-analyzers", status: "skipped", detail: "Disabled by STATIC_ANALYSIS=off.", findings: 0 });
  }
  return { drafts: dedupe(drafts), analyzers };
}

export interface FullReviewResult {
  findings: number;
  verified: number;
  needsVerification: number;
  rejected: number;
  ai: { ran: boolean; passes: { key: string; label: string; calls: number; findings: number; failed: number }[]; reviewedFiles: number; failures: { task: string; error: string }[] };
  analyzers: AnalyzerStatus[];
}

/** Full review: static + AI candidates -> verification -> dedupe -> persisted findings with stable codes. */
export async function runReview(opts: {
  projectId: string;
  arch: Architecture;
  provider: AIProvider | null;
  meter: UsageMeter;
  onProgress?: (msg: string) => void;
  onStage?: (stage: "static" | "ai" | "verify") => void;
  isCancelled?: () => boolean;
}): Promise<FullReviewResult> {
  const { projectId, arch, provider, meter } = opts;
  const db = getDb();
  opts.onStage?.("static");
  const stat = await runStaticReview(projectId, arch);
  opts.onProgress?.(`Static analysis produced ${stat.drafts.length} findings across ${stat.analyzers.filter((a) => a.status === "ran").length} analyzers`);

  const files = loadProjectFiles(projectId).filter((f) => !f.isExcluded);
  const filesByPath = new Map(files.map((f) => [f.path, f]));
  const symbols = db.select().from(schema.symbols).where(eq(schema.symbols.projectId, projectId)).all();
  const rels = db.select().from(schema.relationships).where(eq(schema.relationships.projectId, projectId)).all();
  const ctx = { filesByPath, symbols, rels };

  let aiDrafts: FindingDraft[] = [];
  let passes: { key: string; label: string; calls: number; findings: number; failed: number }[] = [];
  let reviewedFiles = 0;
  if (provider && !opts.isCancelled?.()) {
    opts.onStage?.("ai");
    const ai = await runAiReview({ provider, meter, projectId, files, arch, onProgress: opts.onProgress, isCancelled: opts.isCancelled });
    aiDrafts = ai.drafts;
    passes = ai.passes;
    reviewedFiles = ai.reviewedFiles.length;
  }

  opts.onStage?.("verify");
  // Deterministic verification: drops AI findings that cite missing files or quote code that is not there.
  let candidates: FindingDraft[] = [];
  let droppedUngrounded = 0;
  for (const d of aiDrafts) {
    const v = verifyDeterministic(d, ctx);
    if (v) candidates.push(v);
    else droppedUngrounded++;
  }
  if (droppedUngrounded) opts.onProgress?.(`Dropped ${droppedUngrounded} AI candidate(s) whose cited code could not be found in the repository`);
  if (provider && candidates.length && !opts.isCancelled?.()) candidates = await verifyWithAI({ provider, meter, candidates, ctx, isCancelled: opts.isCancelled });
  const rejected = candidates.filter((c) => c.verification === "rejected").length + droppedUngrounded;
  candidates = candidates.filter((c) => c.verification !== "rejected");
  // AI findings that were never checked by the AI verifier stay flagged "needs verification".
  const merged = dedupe([...stat.drafts, ...candidates]);
  const coded = assignCodes(merged);

  // Area assignment for filtering.
  db.transaction((tx) => {
    tx.delete(schema.findings).where(eq(schema.findings.projectId, projectId)).run();
    const rows = coded.map((f) => ({
      id: newId("fnd"), projectId, code: f.code, title: f.title, category: f.category, severity: f.severity, confidence: f.confidence, origin: f.origin, analyzer: f.analyzer ?? null,
      filePath: f.filePath ?? null, startLine: f.startLine ?? null, endLine: f.endLine ?? null, evidence: f.evidence ?? null, whatHappens: f.whatHappens, whyItMatters: f.whyItMatters,
      businessImpact: f.businessImpact ?? null, remediation: f.remediation, patch: f.patch ?? null, relatedComponents: f.relatedComponents ?? [], verification: f.verification ?? "needs_verification",
      verificationNote: f.verificationNote ?? null, area: (f.filePath ? filesByPath.get(f.filePath)?.area : null) ?? null,
    }));
    for (let i = 0; i < rows.length; i += 100) tx.insert(schema.findings).values(rows.slice(i, i + 100)).run();
  });

  return {
    findings: coded.length,
    verified: coded.filter((f) => f.verification === "verified").length,
    needsVerification: coded.filter((f) => f.verification !== "verified").length,
    rejected,
    ai: { ran: !!provider, passes, reviewedFiles, failures: meter.failures },
    analyzers: stat.analyzers,
  };
}
