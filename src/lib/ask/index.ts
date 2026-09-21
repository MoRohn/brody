import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema, projectRows } from "../db/client";
import type { Architecture } from "../discover/types";
import { getAIProvider, renderEvidence, SAFETY_PREAMBLE, UsageMeter, tryAnalyze, untrusted } from "../ai";
import { getFileContents } from "../ingest/store";
import { loadModel, symbolNeighborhood } from "../map";
import { queryTerms, retrieveContext, type SearchHit } from "../retrieval";
import { newId } from "../util/ids";
import { sliceLines } from "../util/text";

export interface Citation {
  path: string;
  startLine: number;
  endLine: number;
  note?: string;
  snippet?: string;
}

export interface Answer {
  question: string;
  answer: string;
  mode: "graph" | "ai" | "retrieval";
  citations: Citation[];
  confidence: "high" | "medium" | "low";
  /** True when the index did not contain enough evidence to answer. */
  insufficientEvidence: boolean;
  notes: string[];
  usage?: { inputTokens: number; outputTokens: number };
}

const AnswerSchema = z.object({
  answer: z.string(),
  insufficientEvidence: z.boolean(),
  confidence: z.enum(["high", "medium", "low"]),
  citations: z.array(z.object({ path: z.string(), startLine: z.number(), endLine: z.number(), note: z.string() })),
});

function cite(path: string, a: number, b: number, note?: string): Citation {
  return { path, startLine: a, endLine: Math.max(a, b), note };
}

/** Attach short code snippets to citations for display. */
function withSnippets(projectId: string, cites: Citation[]): Citation[] {
  const files = new Map(projectRows(schema.files, projectId).map((f) => [f.path, f]));
  const contents = getFileContents(cites.map((c) => files.get(c.path)?.hash).filter((x): x is string => !!x));
  return cites.map((c) => {
    const f = files.get(c.path);
    const text = f ? contents.get(f.hash) : undefined;
    return { ...c, snippet: text ? sliceLines(text, c.startLine, Math.min(c.endLine, c.startLine + 14)) : undefined };
  });
}

function validateCitations(projectId: string, cites: Citation[]): Citation[] {
  const files = new Map(projectRows(schema.files, projectId).map((f) => [f.path, f]));
  const out: Citation[] = [];
  for (const c of cites) {
    const f = files.get(c.path);
    if (!f || c.startLine < 1 || c.startLine > Math.max(1, f.lines)) continue;
    out.push({ ...c, endLine: Math.min(Math.max(c.startLine, c.endLine), Math.max(1, f.lines)) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deterministic handlers: exact answers from the graph, no model required.
// ---------------------------------------------------------------------------
function findSymbolByName(projectId: string, name: string) {
  const m = loadModel(projectId);
  const exact = m.symbols.filter((s) => s.name === name || s.qualifiedName === name);
  if (exact.length) return exact.sort((a, b) => b.importance - a.importance)[0];
  const ci = m.symbols.filter((s) => s.name.toLowerCase() === name.toLowerCase());
  return ci.sort((a, b) => b.importance - a.importance)[0];
}

function graphAnswer(projectId: string, question: string): Answer | undefined {
  const m = loadModel(projectId);
  const q = question.trim().replace(/[?.!]+$/, "");
  const quoted = q.match(/[`'"]([A-Za-z_][\w.$/-]*)[`'"]/)?.[1];
  const ident = (re: RegExp) => q.match(re)?.[1];

  // What writes to / reads from X (checked first so "what writes" is not read as a dependency question)
  const wrMatch = q.match(/\b(?:what|which|who)\b.*?\b(writes?|inserts?|updates?|persists?|saves?|modif(?:y|ies)|deletes?|reads?|queries|selects?)\s+(?:to\s+|into\s+|from\s+|in\s+)?(?:the\s+)?[`'"]?([A-Za-z_][\w]*)[`'"]?(?:\s+table|\s+model|\s+collection)?\s*$/i);
  if (wrMatch) {
    const isRead = /read|quer|select/i.test(wrMatch[1]);
    const target = wrMatch[2];
    const model = m.arch.models.find((x) => x.name.toLowerCase() === target.toLowerCase() || x.name.toLowerCase() === target.toLowerCase().replace(/s$/, "")) ?? m.arch.models.find((x) => x.name.toLowerCase().includes(target.toLowerCase()));
    if (model) {
      const n = symbolNeighborhood(projectId, model.symbolId)!;
      const list = isRead ? n.reads : n.writes;
      const cites = list.map((x) => x.match(/\(([^)]+?):(\d+)\)$/)).filter((x): x is RegExpMatchArray => !!x).map((x) => cite(x[1], Number(x[2]), Number(x[2]), `${isRead ? "reads" : "writes to"} ${model.name}`));
      return { question, answer: list.length ? `${isRead ? "Readers of" : "Writers to"} ${model.name} (${model.file}:${model.line}):\n${list.map((x) => `- ${x}`).join("\n")}` : `No ${isRead ? "reads from" : "writes to"} ${model.name} were detected in the indexed source. Data access through raw SQL strings or dynamic queries may not be visible to static analysis.`, mode: "graph", citations: withSnippets(projectId, [cite(model.file, model.line, model.endLine, "model definition"), ...cites.slice(0, 10)]), confidence: list.length ? "medium" : "low", insufficientEvidence: list.length === 0, notes: ["Based on heuristic detection of ORM/query calls on model names (READS_FROM / WRITES_TO relationships)."] };
    }
  }

  // Which components depend on / use / call X
  const dep = ident(/\b(?:depend(?:s|ing)?\s+on|use[sd]?|call(?:s|ed)?|import(?:s|ed)?|reference[sd]?|consum(?:e|es|ing))\s+(?:the\s+)?([A-Za-z_][\w.$]*)\s*$/i) ?? ident(/\bwho\s+(?:uses|calls|imports)\s+([A-Za-z_][\w.$]*)/i) ?? (quoted && /\b(depend|use|call|import|reference)/i.test(q) ? quoted : undefined);
  if (dep) {
    const sym = findSymbolByName(projectId, dep);
    if (sym) {
      const n = symbolNeighborhood(projectId, sym.id)!;
      if (n.calledBy.length === 0 && n.testedBy.length === 0) return { question, answer: `${sym.qualifiedName} (${sym.kind} in ${sym.filePath}:${sym.startLine}) has no known callers or dependents in the indexed repository. It may be an entry point, called dynamically, or unused.`, mode: "graph", citations: withSnippets(projectId, [cite(sym.filePath, sym.startLine, sym.endLine, "definition")]), confidence: "medium", insufficientEvidence: false, notes: ["Answered from the symbol graph; dynamic dispatch and reflection are not visible to static analysis."] };
      const lines = n.calledBy.slice(0, 20).map((c) => `- ${c.name} (${c.kind}) at ${c.path}:${c.line}`);
      return { question, answer: `${sym.qualifiedName} is used by ${n.calledBy.length} component(s):\n${lines.join("\n")}${n.testedBy.length ? `\n\nIt is exercised by tests: ${n.testedBy.join(", ")}.` : ""}`, mode: "graph", citations: withSnippets(projectId, [cite(sym.filePath, sym.startLine, sym.endLine, "definition"), ...n.calledBy.slice(0, 8).map((c) => cite(c.path, c.line, c.line, `${c.name} references ${sym.name}`))]), confidence: "high", insufficientEvidence: false, notes: ["Answered from the symbol graph built by static analysis."] };
    }
  }

  // Where is X defined
  const where = ident(/\bwhere\s+(?:is|are)\s+(?:the\s+)?([A-Za-z_][\w.$]*)\s+(?:defined|declared|implemented|located)/i) ?? ident(/\bwhere\s+is\s+(?:the\s+)?([A-Za-z_][\w.$]*)\s*$/i) ?? (quoted && /\bwhere\b.*\b(defined|declared|implemented)\b/i.test(q) ? quoted : undefined);
  if (where) {
    const matches = m.symbols.filter((s) => s.name.toLowerCase() === where.toLowerCase() || s.qualifiedName.toLowerCase() === where.toLowerCase());
    if (matches.length) {
      return { question, answer: `${where} is defined in ${matches.length} place(s):\n${matches.slice(0, 10).map((s) => `- ${s.kind} ${s.qualifiedName} at ${s.filePath}:${s.startLine}-${s.endLine}`).join("\n")}`, mode: "graph", citations: withSnippets(projectId, matches.slice(0, 6).map((s) => cite(s.filePath, s.startLine, s.endLine, `${s.kind} definition`))), confidence: "high", insufficientEvidence: false, notes: ["Answered from the symbol index."] };
    }
  }

  // What happens after METHOD /route
  const route = q.match(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s?]*)/i);
  if (route && /(happen|flow|after|trace|handle|go)/i.test(q)) {
    const method = route[1].toUpperCase();
    const p = route[2].replace(/\/$/, "") || "/";
    const norm = (x: string) => x.replace(/:\w+\*?/g, ":x");
    const flow = m.arch.flows.find((f) => f.name.toLowerCase() === `${method} ${p}`.toLowerCase());
    const r = m.arch.routes.find((x) => x.method === method && (x.path === p || norm(x.path) === norm(p)));
    if (r) {
      const steps = flow ? flow.steps.map((s, i) => `${i + 1}. ${s.label}${s.path ? ` (${s.path}:${s.line ?? 1})` : ""}`).join("\n") : "No call chain could be traced from the handler in the dependency graph.";
      return { question, answer: `${method} ${r.path} is handled by ${r.handler} in ${r.file}:${r.line} (${r.framework}${r.auth === "authenticated" ? ", authentication check present" : ""}).\n\nTraced execution:\n${steps}${flow?.models.length ? `\n\nData touched: ${flow.models.join(", ")}.` : ""}`, mode: "graph", citations: withSnippets(projectId, [cite(r.file, r.line, r.line + 10, "route handler"), ...(flow?.steps.filter((s) => s.path).slice(0, 8).map((s) => cite(s.path!, s.line ?? 1, (s.line ?? 1) + 8, s.label)) ?? [])]), confidence: flow ? "high" : "medium", insufficientEvidence: false, notes: ["Answered from route detection and the static call graph."] };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------
export async function askRepository(projectId: string, question: string): Promise<Answer> {
  const db = getDb();
  const q = question.trim();
  const project = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!project) throw new Error("Project not found");
  if (project.status !== "ready") throw new Error("The project has not finished analysis yet.");

  let answer: Answer | undefined = graphAnswer(projectId, q);
  const provider = getAIProvider();
  if (!answer || (provider && answer.mode === "graph" && answer.insufficientEvidence)) {
    const ctx = await retrieveContext(projectId, q, { charBudget: 40000, maxItems: 14 });
    // Add architecture facts that answer high-level questions.
    const arch = ((project.analysis ?? {}) as { architecture?: Architecture }).architecture;
    const facts = arch ? `Repository facts: pattern ${arch.pattern.label}; entry points ${arch.entryPoints.slice(0, 5).map((e) => `${e.path}:${e.line ?? 1}`).join(", ")}; ${arch.routes.length} routes; models ${arch.models.slice(0, 10).map((x) => `${x.name} (${x.file}:${x.line})`).join(", ")}; external services ${arch.externalServices.map((s) => s.name).join(", ")}.` : "";
    const terms = queryTerms(q);
    const relevant = relevantHits(ctx.hits, terms);
    if (ctx.evidence.length === 0 || relevant.length === 0) {
      answer = { question: q, answer: "The indexed repository does not contain anything matching this question, so it cannot be answered from the repository. Try naming a file, function, route or table.", mode: "retrieval", citations: [], confidence: "low", insufficientEvidence: true, notes: ["No files, symbols, findings or documentation matched the query terms."] };
    } else if (provider) {
      const meter = new UsageMeter();
      const ev = renderEvidence(ctx.evidence, 40000);
      const related = ctx.hits.filter((h) => h.kind === "finding" || h.kind === "doc").slice(0, 6).map((h) => `- ${h.title}: ${h.snippet ?? ""}`).join("\n");
      const res = await tryAnalyze(provider, meter, {
        task: "ask",
        system: SAFETY_PREAMBLE,
        prompt: `Answer the question about this repository using ONLY the evidence below. If the evidence does not contain the answer, set insufficientEvidence to true and say what is missing; do not use outside knowledge about how such systems usually work.\n\nQuestion (from the user, not from the repository): ${q}\n\n${untrusted(`${facts}\n\nRelated generated documentation and findings (secondary, may be incomplete):\n${related || "none"}`)}\n\n${ev.text}\n\nWrite a direct, specific answer in plain language (under 250 words). Cite the source locations that support each claim in "citations" (path plus line range taken from the excerpts, plus a short note).`,
        schema: AnswerSchema,
        maxTokens: 4000,
      });
      if (res) {
        const cites = validateCitations(projectId, res.citations.map((c) => cite(c.path, c.startLine, c.endLine, c.note)));
        const grounded = cites.length > 0;
        answer = { question: q, answer: grounded || res.insufficientEvidence ? res.answer : `${res.answer}\n\n(No verifiable source citation accompanied this answer, so treat it with caution.)`, mode: "ai", citations: withSnippets(projectId, cites), confidence: grounded ? res.confidence : "low", insufficientEvidence: res.insufficientEvidence, notes: [`Answered by ${provider.model} from ${ev.included.length} retrieved code excerpt(s).`, ...(grounded ? [] : ["The model provided no citation that resolves to a real file and line."])], usage: { inputTokens: meter.usage.inputTokens, outputTokens: meter.usage.outputTokens } };
      } else {
        answer = retrievalOnly(projectId, q, ctx.hits, `AI request failed (${meter.failures[0]?.error ?? "unknown"}); showing retrieved evidence instead.`);
      }
    } else {
      answer = retrievalOnly(projectId, q, ctx.hits, "No AI provider is configured, so no synthesized answer was written. These are the most relevant repository locations.");
    }
  }
  db.insert(schema.questions).values({ id: newId("q"), projectId, question: q, answer: answer as unknown as Record<string, unknown>, createdAt: Date.now() }).run();
  return answer;
}

/** Keep only hits whose text covers a meaningful share of the question's terms. */
export function relevantHits(hits: SearchHit[], terms: string[]): SearchHit[] {
  if (terms.length === 0) return hits.slice(0, 8);
  const need = terms.length === 1 ? 1 : Math.max(2, Math.ceil(terms.length * 0.5));
  return hits.filter((h) => {
    const text = `${h.title} ${h.path ?? ""} ${h.snippet ?? ""}`.toLowerCase();
    return terms.filter((t) => text.includes(t)).length >= need || h.signals.semantic >= 0.55;
  });
}

function retrievalOnly(projectId: string, question: string, hits: SearchHit[], note: string): Answer {
  const relevant = relevantHits(hits, queryTerms(question)).filter((h) => h.path).slice(0, 8);
  const cites = relevant.map((h) => cite(h.path!, h.line ?? 1, h.endLine ?? h.line ?? 1, h.title));
  return { question, answer: relevant.length ? `Most relevant locations found:\n${relevant.map((h) => `- ${h.title}${h.path ? ` (${h.path}${h.line ? `:${h.line}` : ""})` : ""}`).join("\n")}` : "Nothing in the index matches this question.", mode: "retrieval", citations: withSnippets(projectId, cites), confidence: "low", insufficientEvidence: relevant.length === 0, notes: [note] };
}

export function recentQuestions(projectId: string, limit = 20) {
  return getDb().select().from(schema.questions).where(and(eq(schema.questions.projectId, projectId))).orderBy(schema.questions.createdAt).limit(limit).all().reverse();
}
