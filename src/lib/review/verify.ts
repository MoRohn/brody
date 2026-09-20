import { z } from "zod";
import { config } from "../config";
import type { SymbolRow, RelationshipRow } from "../db/schema";
import type { LoadedFile } from "../graph/build";
import { renderEvidence, SAFETY_PREAMBLE, tryAnalyze, untrusted, UsageMeter, type AIProvider } from "../ai";
import { mapLimit } from "../util/concurrency";
import { sliceLines } from "../util/text";
import { applyUnifiedDiff } from "./patch";
import { CATEGORY_PREFIX, SEVERITY_ORDER, type Category, type FindingDraft, type Severity } from "./types";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

export interface VerifyContext {
  filesByPath: Map<string, LoadedFile>;
  symbols: SymbolRow[];
  rels: RelationshipRow[];
}

/**
 * Deterministic verification of an AI candidate against the real source.
 * Rejects findings that cite files or code that do not exist, re-anchors line
 * numbers to where the quoted evidence actually appears, and validates any
 * suggested patch by applying it to the real file.
 */
export function verifyDeterministic(d: FindingDraft, ctx: VerifyContext): FindingDraft | null {
  if (d.origin !== "ai") return d;
  const notes: string[] = [];
  const file = d.filePath ? ctx.filesByPath.get(d.filePath) : undefined;
  if (!file || !file.text) {
    return null; // cites a file that does not exist in the repository
  }
  const text = file.text;
  const lines = text.split("\n");
  let start = d.startLine ?? 1;
  let end = d.endLine ?? start;
  if (start > lines.length) start = Math.max(1, lines.length);
  if (end > lines.length) end = lines.length;

  // Locate the quoted evidence.
  const quote = norm(d.evidence ?? "").replace(/^\d+:\s*/, "");
  let anchored = false;
  if (quote.length >= 8) {
    const quoteLines = (d.evidence ?? "").split("\n").map((l) => norm(l.replace(/^\d+:\s?/, ""))).filter(Boolean);
    const firstNeedle = quoteLines[0] ?? quote;
    // Search near the cited range first, then anywhere in the file.
    const candidates: number[] = [];
    for (let i = 0; i < lines.length; i++) if (norm(lines[i]).includes(firstNeedle) || (firstNeedle.length > 30 && norm(lines[i]).includes(firstNeedle.slice(0, 30)))) candidates.push(i + 1);
    if (candidates.length) {
      const best = candidates.sort((a, b) => Math.abs(a - start) - Math.abs(b - start))[0];
      const span = Math.max(0, end - start);
      if (Math.abs(best - start) > 3) notes.push(`line range re-anchored from ${start} to ${best} where the quoted code appears`);
      start = best;
      end = Math.min(lines.length, best + Math.max(span, quoteLines.length - 1));
      anchored = true;
    } else if (norm(text).includes(quote)) {
      anchored = true; // multi-line quote present but first line matching failed; keep cited range
    }
  }
  if (!anchored) {
    // The model quoted code that is not in the file: treat as hallucinated evidence.
    if (d.confidence === "High" || d.severity === "Critical" || d.severity === "High") return null;
    notes.push("quoted evidence was not found verbatim in the file");
    d = { ...d, confidence: "Low" };
  }
  const real = sliceLines(text, Math.max(1, start - 1), Math.min(lines.length, end + 1));
  const evidence = real.split("\n").map((l, i) => `${Math.max(1, start - 1) + i}: ${l.slice(0, 220)}`).join("\n");

  // Reachability: are there callers of the enclosing symbol?
  const enclosing = ctx.symbols.filter((s) => s.filePath === file.path && s.startLine <= start && s.endLine >= end).sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0];
  if (enclosing) {
    const callers = ctx.rels.filter((r) => r.targetId === enclosing.id && ["CALLS", "ROUTES_TO", "USES", "INSTANTIATES"].includes(r.kind)).length;
    if (callers === 0 && !enclosing.exported && enclosing.kind !== "endpoint") notes.push(`enclosing ${enclosing.kind} ${enclosing.qualifiedName} has no known callers in the repository (possibly dead code)`);
    else if (callers > 0) notes.push(`enclosing ${enclosing.kind} ${enclosing.qualifiedName} has ${callers} known caller(s)`);
    const related = new Set(d.relatedComponents ?? []);
    related.add(enclosing.qualifiedName);
    d = { ...d, relatedComponents: [...related].slice(0, 8) };
  }
  if (file.isTest) { notes.push("finding is in a test file"); d = { ...d, severity: downgrade(d.severity) }; }

  // Patch validation.
  let patch = d.patch;
  if (patch) {
    const applied = applyUnifiedDiff(text, patch);
    if (!applied.ok) { notes.push(`suggested patch discarded: ${applied.reason}`); patch = undefined; }
    else notes.push("suggested patch applies cleanly to the current file");
  }
  return { ...d, startLine: start, endLine: end, evidence, patch, verificationNote: notes.join("; ") || undefined };
}

function downgrade(s: Severity): Severity {
  const i = SEVERITY_ORDER.indexOf(s);
  return SEVERITY_ORDER[Math.min(SEVERITY_ORDER.length - 1, i + 1)];
}

const VerdictSchema = z.object({
  verdicts: z.array(z.object({
    index: z.number(),
    verdict: z.enum(["confirmed", "needs_verification", "rejected"]),
    reason: z.string(),
    adjustedSeverity: z.enum(["Critical", "High", "Medium", "Low", "Informational", "unchanged"]),
  })),
});

/** AI verification pass: a second, adversarial look at each candidate with the surrounding code and callers. */
export async function verifyWithAI(opts: {
  provider: AIProvider;
  meter: UsageMeter;
  candidates: FindingDraft[];
  ctx: VerifyContext;
  isCancelled?: () => boolean;
}): Promise<FindingDraft[]> {
  const { provider, meter, ctx } = opts;
  const budget = config.ai.contextCharBudget;
  const ranked = opts.candidates.map((c, i) => ({ c, i })).sort((a, b) => SEVERITY_ORDER.indexOf(a.c.severity) - SEVERITY_ORDER.indexOf(b.c.severity));
  const toCheck = ranked.slice(0, config.ai.maxFindingsVerified);
  const batches: typeof toCheck[] = [];
  let cur: typeof toCheck = [];
  let used = 0;
  for (const item of toCheck) {
    const size = 1800;
    if (cur.length && (used + size > budget || cur.length >= 6)) { batches.push(cur); cur = []; used = 0; }
    cur.push(item);
    used += size;
  }
  if (cur.length) batches.push(cur);
  const result = [...opts.candidates];
  await mapLimit(batches, config.ai.concurrency, async (batch) => {
    if (opts.isCancelled?.()) return;
    const blocks = batch.map(({ c }, n) => {
      const f = ctx.filesByPath.get(c.filePath ?? "");
      const start = Math.max(1, (c.startLine ?? 1) - 12);
      const end = Math.min(f?.lines ?? 1, (c.endLine ?? 1) + 20);
      const enclosing = ctx.symbols.filter((s) => s.filePath === c.filePath && s.startLine <= (c.startLine ?? 0) && s.endLine >= (c.endLine ?? 0)).sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0];
      const callers = enclosing ? ctx.rels.filter((r) => r.targetId === enclosing.id && ["CALLS", "ROUTES_TO", "USES"].includes(r.kind)).slice(0, 6).map((r) => `${r.kind} from ${r.filePath ?? "?"}:${r.line ?? "?"}`) : [];
      const ev = renderEvidence([{ path: c.filePath ?? "", startLine: start, endLine: end, text: f?.text ? sliceLines(f.text, start, end) : "" }], 6000);
      return `### Candidate ${n}\nTitle: ${c.title}\nCategory: ${c.category}; claimed severity: ${c.severity}; confidence: ${c.confidence}\nClaim: ${c.whatHappens}\nWhy it matters: ${c.whyItMatters}\nCited lines: ${c.filePath}:${c.startLine}-${c.endLine}\nKnown callers of the enclosing code: ${callers.length ? callers.join("; ") : "none found in repository index"}\n${ev.text}`;
    }).join("\n\n");
    const prompt = `You are auditing candidate code-review findings produced by another reviewer. Be sceptical: your job is to remove false positives.

For each candidate decide:
- "confirmed": the code shown definitely behaves as claimed, and the consequence follows from it.
- "needs_verification": plausible, but depends on facts not visible (untrusted input reaching the code, deployment settings, behaviour elsewhere).
- "rejected": the claim is wrong, already mitigated in the shown code, or purely speculative.
Also set adjustedSeverity if the claimed severity is too high or too low, otherwise "unchanged".
Return one verdict per candidate using its index number.

${untrusted(blocks)}`;
    const res = await tryAnalyze(provider, meter, { task: "review:verify", system: SAFETY_PREAMBLE, prompt, schema: VerdictSchema, maxTokens: 6000 });
    if (!res) return;
    for (const v of res.verdicts) {
      const item = batch[v.index];
      if (!item) continue;
      const cur = result[item.i];
      const note = `AI verification (${v.verdict}): ${v.reason.slice(0, 300)}`;
      result[item.i] = {
        ...cur,
        verification: v.verdict === "confirmed" ? "verified" : v.verdict === "rejected" ? "rejected" : "needs_verification",
        severity: v.adjustedSeverity !== "unchanged" ? (v.adjustedSeverity as Severity) : cur.severity,
        verificationNote: [cur.verificationNote, note].filter(Boolean).join("; "),
      };
    }
  });
  return result;
}

const STOPWORDS = new Set(["the", "a", "an", "of", "in", "on", "to", "for", "and", "or", "with", "by", "is", "are", "no", "not", "from", "via", "at", "as"]);
const titleTokens = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w)));
function similarity(a: string, b: string): number {
  const A = titleTokens(a), B = titleTokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Merge duplicate findings. Two static findings are duplicates only when they
 * carry the same title; an AI finding duplicates another finding when it covers
 * the same lines or is worded very similarly nearby. Adjacent but distinct
 * problems are never collapsed.
 */
export function dedupe(drafts: FindingDraft[]): FindingDraft[] {
  const sorted = [...drafts].sort((a, b) => (a.origin === "static" ? 0 : 1) - (b.origin === "static" ? 0 : 1) || SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const kept: FindingDraft[] = [];
  for (const d of sorted) {
    const dup = kept.find((k) => {
      if (k.filePath !== d.filePath) return false;
      if (!k.startLine || !d.startLine) return k.title === d.title && k.category === d.category;
      const exact = d.startLine <= (k.endLine ?? k.startLine) && (d.endLine ?? d.startLine) >= k.startLine;
      const near = d.startLine <= (k.endLine ?? k.startLine) + 5 && (d.endLine ?? d.startLine) >= k.startLine - 5;
      const sim = similarity(k.title, d.title);
      if (k.origin === "static" && d.origin === "static") return k.title === d.title && exact;
      if (k.category === d.category) return exact || (near && sim >= 0.3);
      return exact && sim >= 0.4;
    });
    if (dup) {
      // Enrich the kept finding with a suggested patch or business impact from the duplicate.
      if (!dup.patch && d.patch) dup.patch = d.patch;
      if (!dup.businessImpact && d.businessImpact) dup.businessImpact = d.businessImpact;
      if (d.origin !== dup.origin) dup.verificationNote = [dup.verificationNote, `Also reported by ${d.origin === "ai" ? "AI review" : d.analyzer}.`].filter(Boolean).join(" ");
      continue;
    }
    kept.push({ ...d });
  }
  return kept;
}

export function assignCodes(drafts: FindingDraft[]): (FindingDraft & { code: string })[] {
  const sorted = [...drafts].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || (a.filePath ?? "").localeCompare(b.filePath ?? "") || (a.startLine ?? 0) - (b.startLine ?? 0));
  const counters = new Map<Category, number>();
  return sorted.map((d) => {
    const n = (counters.get(d.category) ?? 0) + 1;
    counters.set(d.category, n);
    return { ...d, code: `${CATEGORY_PREFIX[d.category]}-${String(n).padStart(3, "0")}` };
  });
}
