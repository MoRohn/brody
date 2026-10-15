import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema, projectRows } from "../db/client";
import type { Assurance } from "../assurance/types";
import type { Architecture } from "../discover/types";
import type { DocReport } from "../docs/types";
import { getAIProvider, renderEvidence, SAFETY_PREAMBLE, UsageMeter, tryAnalyze, untrusted, type AIProvider, type EvidenceItem } from "../ai";
import { getFileContents } from "../ingest/store";
import { loadModel, symbolNeighborhood } from "../map";
import { queryTerms, retrieveContext, type SearchHit } from "../retrieval";
import { newId } from "../util/ids";
import { sliceLines } from "../util/text";
import { overviewFromAnalysis, renderKnowledge, type KnowledgeInput } from "./knowledge";

export interface Citation {
  path: string;
  startLine: number;
  endLine: number;
  note?: string;
  snippet?: string;
}

export interface Answer {
  /** The stored question id, so the answer can be explained (POST /api/explanations, source question:<id>). */
  id?: string;
  question: string;
  /** A follow-up rewritten to stand on its own ("Explain that more simply" → "How does X work, in simple terms?"). */
  standaloneQuestion?: string;
  answer: string;
  /** graph: exact, from the symbol graph. ai: written by the model. analysis: Brody's overview, no model. retrieval: ranked locations. */
  mode: "graph" | "ai" | "analysis" | "retrieval";
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
const FollowUpSchema = AnswerSchema.extend({ standaloneQuestion: z.string() });

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
// Question shape: broad questions and requests for plain language.
// ---------------------------------------------------------------------------
const PLAIN = /\b(?:eli\s?(?:5|10)|explain (?:it )?like|like (?:i'?m|i am) (?:five|5|ten|10|a (?:kid|child|beginner|non-?technical))|plain (?:english|language|terms|words)|simple (?:terms|words|language|english)|simply|simpler|non-?technical|lay(?:man|person| person)|beginner|no jargon|without (?:the )?jargon|for (?:my |a |an )?(?:manager|boss|ceo|cto|executive|stakeholder|investor|customer|client|grandma|grandmother|mom|dad|parent|kid|child|non-developer))\b/i;
/** Words that frame a question without naming any part of the repository: "explain like I'm five", "overview", "where should I start". */
const FRAMING = new Set(("explain describe tell give summary summarise summarize overview overall whole thing general basically big picture nutshell tl dr tldr walk through "
  + "like five ten years year old eli5 eli10 simple simply simpler plain english terms words kid child beginner layman non technical person people someone please quick brief briefly "
  + "high level really actually exactly main idea point goal purpose problem solve solves need exist exists mean means should would new developer start begin read reading "
  + "run running runs built build structure structured organised organized together everything stack tech technology architecture "
  + "repo repository project app application codebase base system software program platform product tool for").split(" "));

/** A question about the repository as a whole: nothing specific is left once the framing words and the project name are removed. */
export function isBroadQuestion(question: string, projectName = ""): boolean {
  const name = new Set(queryTerms(projectName.split("/").pop() ?? ""));
  return queryTerms(question).every((t) => name.has(t) || FRAMING.has(t));
}

/** The asker wants everyday words rather than code names: ELI5, plain English, for a manager, and so on. */
export function wantsPlainLanguage(question: string): boolean {
  return PLAIN.test(question);
}

const ASK_GUIDE = `You are answering questions about one repository inside Brody, a code-understanding tool. The people asking range from engineers to product managers, executives and complete beginners, and their answers are also turned into narrated explainer videos, so every answer must stand on its own.

You receive:
1. Brody's analysis of the repository: what it is, how it is built and runs, its functional areas, flows, data, integrations, security and privacy assessments, findings and recommendations. Locations in [brackets] are the source lines each line was derived from.
2. Source code excerpts with line numbers.
3. Sometimes exact facts from Brody's code graph, and earlier turns of the conversation.

How to answer:
- Answer the question that was asked, whatever kind it is: how it works, what it is for, who would use it, why it is built a certain way, what a part does, how good or risky it is, what to fix first, where to start reading, how to run or change it. Broad questions are answered from the analysis; specific ones from the code excerpts. Combine both whenever that helps.
- Facts about THIS repository (what it does, names, numbers, behaviour, data, services) must come from the supplied material. Never invent files, functions, features, numbers or behaviour.
- You may use general knowledge to explain concepts, define terms and give analogies (what an API, a database or a queue is), as long as you never present it as a fact about this repository.
- Match the register of the question. If the asker wants a simple, ELI5, beginner or non-technical explanation, use everyday words, short sentences and one concrete analogy that you carry through, and keep file paths and code names out of the prose (they belong in the citations). Otherwise be direct and specific, naming the files, functions, routes and tables involved.
- Judgements (quality, risk, readiness, what to fix first) are welcome when grounded in the analysis; say what they rest on.
- If only part of the question can be answered, answer that part and say plainly what the repository does not show. Set insufficientEvidence to true only when the material says nothing useful about the question at all.
- Cite the locations that support the repository-specific claims, using the paths and line ranges exactly as they appear in the excerpts or in the [brackets] of the analysis. Cite at least one location for any answer about the repository.
- Format the answer as plain text: short paragraphs, and "- " bullets or "1. " steps for lists. No Markdown headings, tables, bold or code fences. Usually 80 to 300 words; up to 450 for an overview or a walkthrough.`;

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------
interface ProjectAnalysis { architecture?: Architecture; docs?: DocReport; assurance?: Assurance }
interface EarlierTurn { question: string; answer: string }

/** Earlier turns of this conversation, named by the client by id and read back from the database (never taken from the request body). */
function earlierTurns(projectId: string, ids: string[] | undefined): EarlierTurn[] {
  if (!ids?.length) return [];
  const rows = getDb().select().from(schema.questions).where(and(eq(schema.questions.projectId, projectId), inArray(schema.questions.id, ids.slice(-6)))).all();
  return rows.sort((a, b) => a.createdAt - b.createdAt).slice(-3).map((r) => {
    const a = r.answer as unknown as Partial<Answer>;
    return { question: a.standaloneQuestion || r.question, answer: (a.answer ?? "").slice(0, 1500) };
  });
}

/** The opening lines of the README and of each entry point: what a broad question needs to see of the code itself. */
function overviewExcerpts(projectId: string, arch: Architecture | undefined): EvidenceItem[] {
  const files = projectRows(schema.files, projectId).filter((f) => !f.isExcluded && f.hasContent && !f.isBinary);
  const readme = files.filter((f) => /(^|\/)readme(\.(md|rst|txt|markdown))?$/i.test(f.path)).sort((a, b) => a.path.split("/").length - b.path.split("/").length)[0];
  const picks: { path: string; start: number; end: number; label: string }[] = [];
  if (readme) picks.push({ path: readme.path, start: 1, end: Math.min(readme.lines, 80), label: "README" });
  for (const e of (arch?.entryPoints ?? []).filter((x) => x.kind !== "test-runner").slice(0, 4)) {
    const f = files.find((x) => x.path === e.path);
    if (!f || picks.some((p) => p.path === f.path)) continue;
    const start = Math.max(1, (e.line ?? 1) - 3);
    picks.push({ path: f.path, start, end: Math.min(f.lines, start + 45), label: `entry point (${e.kind})` });
  }
  const byPath = new Map(files.map((f) => [f.path, f]));
  const contents = getFileContents(picks.map((p) => byPath.get(p.path)!.hash));
  return picks.flatMap((p) => { const text = contents.get(byPath.get(p.path)!.hash); return text ? [{ path: p.path, startLine: p.start, endLine: p.end, text: sliceLines(text, p.start, p.end), label: p.label }] : []; });
}

export async function askRepository(projectId: string, question: string, opts: { context?: string[] } = {}): Promise<Answer> {
  const db = getDb();
  const q = question.trim();
  const project = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!project) throw new Error("Project not found");
  if (project.status !== "ready") throw new Error("The project has not finished analysis yet.");
  const analysis = (project.analysis ?? {}) as ProjectAnalysis;
  const knowledge: KnowledgeInput = { projectName: project.name, docs: analysis.docs, arch: analysis.architecture, assurance: analysis.assurance, findings: projectRows(schema.findings, projectId) };
  const earlier = earlierTurns(projectId, opts.context);
  const broad = isBroadQuestion(q, project.name);
  const provider = getAIProvider();

  const graph = graphAnswer(projectId, q);
  let answer: Answer | undefined = graph;
  // The graph's exact answer stands on its own, unless it found nothing or the asker wants it in plain language.
  if (provider && (!graph || graph.insufficientEvidence || wantsPlainLanguage(q))) {
    answer = await modelAnswer(projectId, q, { provider, knowledge, earlier, broad, graph });
  } else if (!graph) {
    answer = await answerWithoutModel(projectId, q, knowledge, broad, "No AI provider is configured, so no answer was written for this exact question.");
  }
  const id = newId("q");
  answer = { ...answer!, id };
  db.insert(schema.questions).values({ id, projectId, question: q, answer: answer as unknown as Record<string, unknown>, createdAt: Date.now() }).run();
  return answer;
}

async function modelAnswer(projectId: string, q: string, o: { provider: AIProvider; knowledge: KnowledgeInput; earlier: EarlierTurn[]; broad: boolean; graph?: Answer }): Promise<Answer> {
  // A short follow-up ("why?", "simpler please") is searched together with the question it follows.
  const terms = queryTerms(q);
  const retrievalQuery = o.earlier.length && terms.length < 3 ? `${q} ${o.earlier[o.earlier.length - 1].question}` : q;
  const ctx = await retrieveContext(projectId, retrievalQuery, { charBudget: 32000, maxItems: 14 });
  const focusTerms = queryTerms(retrievalQuery);
  const relevant = relevantHits(ctx.hits, focusTerms);
  const wide = o.broad || relevant.length === 0;
  const relevantPaths = new Set(relevant.map((h) => h.path).filter(Boolean));
  const retrieved = [...ctx.evidence].sort((a, b) => Number(relevantPaths.has(b.path)) - Number(relevantPaths.has(a.path)));
  // A broad question sees the README and entry points first; a specific one sees its matches first.
  const ordered = wide ? [...overviewExcerpts(projectId, o.knowledge.arch), ...retrieved] : [...retrieved, ...overviewExcerpts(projectId, o.knowledge.arch).slice(0, 1)];
  // Drop an excerpt whose lines an earlier one already shows.
  const items = ordered.filter((e, i) => !ordered.slice(0, i).some((x) => x.path === e.path && x.startLine <= e.startLine && x.endLine >= e.endLine));
  const ev = renderEvidence(items, 32000);
  const brief = renderKnowledge(o.knowledge, { budget: wide ? 30000 : 20000, focus: focusTerms });
  const related = relevant.filter((h) => h.kind === "finding" || h.kind === "doc").slice(0, 8).map((h) => `- ${h.title}: ${h.snippet ?? ""}`).join("\n");
  const followUp = o.earlier.length > 0;
  const schemaFor = followUp ? FollowUpSchema : AnswerSchema;
  const meter = new UsageMeter();
  const res = await tryAnalyze(o.provider, meter, {
    task: "ask",
    system: `${SAFETY_PREAMBLE}\n\n${ASK_GUIDE}`,
    prompt: [
      `Question (from the user, not from the repository): ${q}`,
      followUp ? `Earlier in this conversation (use it to understand what "it", "that" or "more" refers to; it is context, not evidence):\n${untrusted(o.earlier.map((t) => `Q: ${t.question}\nA: ${t.answer}`).join("\n\n"))}` : "",
      o.graph && !o.graph.insufficientEvidence ? `Exact facts from Brody's code graph for this question (reliable; restate them in the asker's terms):\n${untrusted(o.graph.answer)}` : "",
      `Brody's analysis of the repository (derived from the code; the [bracketed] locations can be cited):\n${untrusted(brief || "No analysis summary is available for this repository.")}`,
      related ? `Analysis notes that mention the question's words:\n${untrusted(related)}` : "",
      `Source code excerpts:\n${ev.text}`,
      followUp ? `Also return standaloneQuestion: the question rewritten so it makes sense without the earlier conversation (for example "Explain that more simply" becomes "How does ${o.knowledge.projectName} work, in simple terms?"). Keep the asker's intent and level.` : "",
    ].filter(Boolean).join("\n\n"),
    schema: schemaFor,
    maxTokens: 4000,
  });
  const usage = { inputTokens: meter.usage.inputTokens, outputTokens: meter.usage.outputTokens };
  if (!res) {
    const why = `The AI request failed (${meter.failures[0]?.error ?? "unknown error"}).`;
    if (o.graph && !o.graph.insufficientEvidence) return { ...o.graph, notes: [...o.graph.notes, why] };
    return { ...(await answerWithoutModel(projectId, q, o.knowledge, o.broad, why, ctx.hits)), usage };
  }
  const graphCites = o.graph && !o.graph.insufficientEvidence ? o.graph.citations : [];
  const cites = validateCitations(projectId, [...res.citations.map((c) => cite(c.path, c.startLine, c.endLine, c.note)), ...graphCites]);
  const unique = cites.filter((c, i) => cites.findIndex((x) => x.path === c.path && x.startLine === c.startLine && x.endLine === c.endLine) === i).slice(0, 12);
  const grounded = unique.length > 0;
  const standalone = "standaloneQuestion" in res ? String(res.standaloneQuestion ?? "").trim() : "";
  return {
    question: q,
    standaloneQuestion: standalone && standalone.toLowerCase() !== q.toLowerCase() ? standalone : undefined,
    answer: grounded || res.insufficientEvidence ? res.answer : `${res.answer}\n\n(No verifiable source citation accompanied this answer, so treat it with caution.)`,
    mode: "ai",
    citations: withSnippets(projectId, unique),
    confidence: grounded ? res.confidence : "low",
    insufficientEvidence: res.insufficientEvidence,
    notes: [`Answered by ${o.provider.model} from Brody's analysis and ${ev.included.length} code excerpt(s)${o.graph && !o.graph.insufficientEvidence ? ", with exact facts from the code graph" : ""}.`, ...(grounded ? [] : ["The model provided no citation that resolves to a real file and line."])],
    usage,
  };
}

/** Without a model: the analysis overview for broad questions, ranked locations for specific ones, and a plain refusal when nothing matches. */
async function answerWithoutModel(projectId: string, q: string, k: KnowledgeInput, broad: boolean, why: string, hits?: SearchHit[]): Promise<Answer> {
  const ranked = hits ?? (await retrieveContext(projectId, q, { charBudget: 20000, maxItems: 10 })).hits;
  const overview = broad ? overviewFromAnalysis(k) : undefined;
  if (overview) {
    const cites = validateCitations(projectId, overview.evidence.map((e) => e.match(/^(.*?):(\d+)(?:-(\d+))?$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => cite(m[1], Number(m[2]), Number(m[3] ?? m[2]), "repository overview"))).slice(0, 8);
    return { question: q, answer: overview.text, mode: "analysis", citations: withSnippets(projectId, cites), confidence: cites.length ? "medium" : "low", insufficientEvidence: false, notes: [why, "This is Brody's overview of the repository, assembled from its analysis."] };
  }
  const relevant = relevantHits(ranked, queryTerms(q));
  if (relevant.length) return retrievalOnly(projectId, q, ranked, `${why} These are the most relevant repository locations.`);
  return { question: q, answer: "Nothing in the indexed repository matches this question, so it cannot be answered from the repository. Without an AI provider, Ask answers exact questions about named files, functions, routes and tables, and broad ones such as \"How does this project work?\".", mode: "retrieval", citations: [], confidence: "low", insufficientEvidence: true, notes: [why, "No files, symbols, findings or documentation matched the question's words."] };
}

/**
 * Keep only hits whose text covers a meaningful share of the question's words. Each word counts once whichever form
 * matches (queryTerms adds stems: "services" and "service"), and a long natural-language question needs at most four
 * of its words in one hit, since no single excerpt restates a whole sentence-length question.
 */
export function relevantHits(hits: SearchHit[], terms: string[]): SearchHit[] {
  if (terms.length === 0) return hits.slice(0, 8);
  const groups: string[][] = [];
  for (const t of [...terms].sort((a, b) => b.length - a.length)) {
    const g = groups.find((x) => x.some((u) => Math.min(u.length, t.length) >= 4 && (u.startsWith(t) || t.startsWith(u))));
    if (g) g.push(t); else groups.push([t]);
  }
  const need = groups.length === 1 ? 1 : Math.min(4, Math.max(2, Math.ceil(groups.length * 0.5)));
  return hits.filter((h) => {
    const text = `${h.title} ${h.path ?? ""} ${h.snippet ?? ""}`.toLowerCase();
    return groups.filter((g) => g.some((t) => text.includes(t))).length >= need || h.signals.semantic >= 0.55;
  });
}

function retrievalOnly(projectId: string, question: string, hits: SearchHit[], note: string): Answer {
  const relevant = relevantHits(hits, queryTerms(question)).filter((h) => h.path).slice(0, 8);
  const cites = relevant.map((h) => cite(h.path!, h.line ?? 1, h.endLine ?? h.line ?? 1, h.title));
  return { question, answer: relevant.length ? `Most relevant locations found:\n${relevant.map((h) => `- ${h.title}${h.path ? ` (${h.path}${h.line ? `:${h.line}` : ""})` : ""}`).join("\n")}` : "Nothing in the index matches this question.", mode: "retrieval", citations: withSnippets(projectId, cites), confidence: "low", insufficientEvidence: relevant.length === 0, notes: [note] };
}

const HIDDEN_AREAS = new Set(["Documentation", "Testing", "Configuration"]);

/**
 * Suggested questions this repository can actually answer: the plain-language overview first, then its real areas,
 * routes, tables and most-used code, so every suggestion exercises a different way of answering.
 */
export function suggestedQuestions(projectId: string): string[] {
  const project = getDb().select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!project) return [];
  const name = project.name.split("/").pop() || "this repository";
  const { architecture: arch, docs } = (project.analysis ?? {}) as ProjectAnalysis;
  const out = [`ELI5: how does ${name} work?`, `What does ${name} do, and who is it for?`];
  const area = (docs?.areas ?? arch?.areas ?? []).find((a) => !HIDDEN_AREAS.has(a.name));
  if (area) out.push(`How does the ${area.name} part work?`);
  // The richest traced request that changes something, skipping well-known and catch-all plumbing.
  const VERB: Record<string, number> = { POST: 4, PUT: 3, PATCH: 3, DELETE: 2, GET: 1 };
  const api = (arch?.routes ?? []).filter((r) => r.kind === "api" && VERB[r.method] && !/^\/\.|[*]/.test(r.path));
  const steps = (r: (typeof api)[number]) => arch!.flows.find((f) => f.name === `${r.method} ${r.path}`)?.steps.length ?? 0;
  const route = [...api].sort((a, b) => VERB[b.method] - VERB[a.method] || steps(b) - steps(a))[0];
  if (route) out.push(`What happens after ${route.method} ${route.path}?`);
  // The central table: the model with the most fields and links, not a bare schema namespace.
  const table = (arch?.models ?? []).filter((m) => /^[A-Za-z_]\w*$/.test(m.name) && m.kind !== "schema").sort((a, b) => b.fields.length + 3 * b.references.length - (a.fields.length + 3 * a.references.length))[0];
  if (table) out.push(`What writes to the ${table.name} table?`);
  try {
    // A widely used piece of domain code: a compound name (createOrder, OrderService), not a utility such as map or join.
    const sym = loadModel(projectId).symbols.filter((x) => ["function", "class", "method"].includes(x.kind) && x.name.length >= 6 && /^[A-Za-z_][\w$]*$/.test(x.name) && /[a-z][A-Z]|[a-z]_[a-z]/.test(x.name) && !/(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec)\./.test(x.filePath)).sort((a, b) => b.importance - a.importance)[0];
    if (sym) out.push(`Which components depend on ${sym.name}?`);
  } catch { /* the code map is optional for suggestions */ }
  out.push("What are the biggest risks, and what should we fix first?", "Where should a new developer start reading?");
  return out;
}

/** The latest questions, oldest first, so they read as a conversation that continues at the bottom. */
export function recentQuestions(projectId: string, limit = 20) {
  return getDb().select().from(schema.questions).where(eq(schema.questions.projectId, projectId)).orderBy(desc(schema.questions.createdAt)).limit(limit).all().reverse();
}
