import { config } from "../config";
import type { RelationshipRow, SymbolRow } from "../db/schema";
import type { LoadedFile } from "../graph/build";
import type { FindingDraft } from "../review/types";
import { sliceLines } from "../util/text";

const FUNCTION_KINDS = new Set(["function", "method", "endpoint", "hook", "job", "event_handler"]);
/** Claims about logic are what Lean can settle; claims about injection or configuration are not. */
const FORMAL_CATEGORIES = new Set(["Correctness", "Reliability", "Data", "Security"]);
const MAX_LINES = 200;
const DYNAMIC_CODE = /\beval\s*\(|\bnew\s+Function\s*\(|\bexec(Sync)?\s*\(|\bspawn\s*\(|\bvm\.run/;

/** Names that suggest arithmetic, limits, state or access decisions: where a wrong branch is costly and provable. */
const RISKY_NAME = /(price|amount|total|sum|balance|discount|tax|fee|rate|quantity|qty|stock|inventory|refund|payment|charge|invoice|currency|percent|ratio|limit|offset|page|index|range|bound|clamp|retry|backoff|timeout|expir|ttl|interval|round|convert|score|permission|role|auth|access|allow|grant|quota|valid|check|verify|parse|merge|schedule|state|transition|status|version|compare|sort)/i;
const ARITHMETIC = /[-+*/%](?!=)|[<>]=?|Math\.\w+|parseInt|parseFloat|toFixed|\bround\b|\bfloor\b|\bceil\b|\babs\b|\bmin\b|\bmax\b/g;
const IO_CALL = /\bawait\b|fetch\(|\.query\(|\.execute\(|\.save\(|\.findOne\(|axios|requests\.|http\.|\.send\(/g;

export interface FormalCandidate {
  /** Index of the draft in the list handed to formal verification. */
  index: number;
  draft: FindingDraft;
}

export interface FormalTargetPlan {
  file: LoadedFile;
  symbol: SymbolRow;
  complexity: number;
  score: number;
  reasons: string[];
  candidates: FormalCandidate[];
  /** Functions this one calls, included so the model can be faithful to them. */
  helpers: { symbol: SymbolRow; text: string }[];
  /** Lines from the project's tests that mention the function: the closest thing to a written specification. */
  testLines: { path: string; text: string }[];
  /** Repair rounds and properties grow with complexity: harder code gets a deeper check. */
  rounds: number;
  propertyRange: [number, number];
}

const complexityOf = (s: SymbolRow): number => Number((s.meta as { complexity?: number } | null)?.complexity ?? 1) || 1;

/**
 * Choose the functions worth a formal model: complex, arithmetic- or decision-heavy code on important paths, and every
 * function an AI review claim points into. Functions with open claims come first so every such claim gets a verdict.
 */
export function selectFormalTargets(opts: { files: Map<string, LoadedFile>; symbols: SymbolRow[]; rels: RelationshipRow[]; candidates: FindingDraft[]; max?: number }): FormalTargetPlan[] {
  const max = opts.max ?? config.formal.maxTargets;
  const fns = opts.symbols.filter((s) => FUNCTION_KINDS.has(s.kind));
  const byId = new Map(opts.symbols.map((s) => [s.id, s]));
  const eligible = (s: SymbolRow) => {
    const f = opts.files.get(s.filePath);
    const lines = s.endLine - s.startLine + 1;
    return !!f?.text && !f.isTest && !f.isGenerated && !f.isExcluded && f.classification === "source" && lines >= 3 && lines <= MAX_LINES;
  };

  // Route each logic claim to the smallest function that contains it.
  const claimsBySymbol = new Map<string, FormalCandidate[]>();
  opts.candidates.forEach((d, index) => {
    if (d.origin !== "ai" || !FORMAL_CATEGORIES.has(d.category) || !d.filePath || !d.startLine) return;
    // Dynamic code execution cannot be modelled: whatever Lean proves about a stand-in evaluator says nothing about eval.
    if (DYNAMIC_CODE.test(d.evidence ?? "")) return;
    const enclosing = fns.filter((s) => s.filePath === d.filePath && s.startLine <= d.startLine! && s.endLine >= (d.endLine ?? d.startLine!)).sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0];
    if (!enclosing || !eligible(enclosing)) return;
    const list = claimsBySymbol.get(enclosing.id) ?? [];
    list.push({ index, draft: d });
    claimsBySymbol.set(enclosing.id, list);
  });

  const scored = fns.filter(eligible).map((s) => {
    const f = opts.files.get(s.filePath)!;
    const body = sliceLines(f.text!, s.startLine, s.endLine);
    const lines = s.endLine - s.startLine + 1;
    const c = complexityOf(s);
    const arith = (body.match(ARITHMETIC) ?? []).length / lines;
    const io = (body.match(IO_CALL) ?? []).length;
    const claims = claimsBySymbol.get(s.id) ?? [];
    const reasons: string[] = [];
    let score = Math.min(c, 40) / 10;
    if (c >= 8) reasons.push(`cyclomatic complexity ${c}`);
    if (arith >= 0.6) { score += Math.min(1.5, arith); reasons.push("arithmetic and comparison heavy"); }
    if (RISKY_NAME.test(s.name) || RISKY_NAME.test(s.filePath)) { score += 0.6; reasons.push("decides amounts, limits, state or access"); }
    score += (f.importance ?? 0) + (s.importance ?? 0);
    if (claims.length) { score += 3 + Math.min(2, claims.length); reasons.push(`${claims.length} open review claim${claims.length === 1 ? "" : "s"} to settle`); }
    if (io > 3) score -= 0.5;
    if (lines < 5 && !claims.length) score -= 1;
    return { s, f, c, score, reasons, claims };
  });

  // A function only earns a model on its own merits if it has real decision logic; claims always qualify.
  const chosen = scored.filter((x) => x.claims.length || (x.c >= 4 && x.score >= 1)).sort((a, b) => Number(b.claims.length > 0) - Number(a.claims.length > 0) || b.score - a.score).slice(0, max);

  return chosen.map(({ s, f, c, score, reasons, claims }) => {
    const helpers = opts.rels
      .filter((r) => r.sourceId === s.id && r.kind === "CALLS" && r.targetType === "symbol")
      .map((r) => byId.get(r.targetId))
      .filter((h): h is SymbolRow => !!h && FUNCTION_KINDS.has(h.kind) && h.endLine - h.startLine < 60 && !!opts.files.get(h.filePath)?.text)
      .filter((h, i, all) => all.findIndex((x) => x.id === h.id) === i)
      .slice(0, 3)
      .map((h) => ({ symbol: h, text: sliceLines(opts.files.get(h.filePath)!.text!, h.startLine, h.endLine) }));
    const testLines = testMentions(opts.files, s.name, f.path);
    const rounds = Math.max(1, Math.min(config.formal.maxRepairRounds, 1 + Math.floor(c / 10) + (claims.length ? 1 : 0)));
    const propertyRange: [number, number] = c < 6 ? [2, 3] : c < 15 ? [3, 5] : [4, 6];
    return { file: f, symbol: s, complexity: c, score, reasons: reasons.length ? reasons : ["important function with branching logic"], candidates: claims, helpers, testLines, rounds, propertyRange };
  });
}

/** Assertions in test files that name the function. */
function testMentions(files: Map<string, LoadedFile>, name: string, path: string): { path: string; text: string }[] {
  if (name.length < 3) return [];
  const out: { path: string; text: string }[] = [];
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  const stem = path.replace(/^.*\//, "").replace(/\.[^.]+$/, "");
  for (const f of files.values()) {
    if (!f.isTest || !f.text || !(f.text.includes(name) || f.path.includes(stem))) continue;
    const lines = f.text.split("\n");
    const hits: string[] = [];
    lines.forEach((l, i) => { if (re.test(l) && hits.length < 20) hits.push(`${i + 1}: ${l.slice(0, 200)}`); });
    if (hits.length) out.push({ path: f.path, text: hits.join("\n") });
    if (out.length >= 2) break;
  }
  return out;
}
