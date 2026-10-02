/**
 * The Understanding Compiler: a GROUNDED Brody result in, an ExplanationArtifactSpec out.
 *
 * It never researches again and never reinterprets the original request. Its only inputs are a result Brody already
 * produced and verified (an Ask answer, a file / area / folder / system explanation, a finding) and the source lines that
 * result cites. A deterministic pass always produces a complete spec. When an AI provider is configured, one structured
 * call reorganises the same material into concepts, relationships, processes, metrics and comparisons; everything it
 * returns is checked: ids must resolve, numbers and identifiers must appear in the grounded material, and anything
 * unsupported is kept only as an unsupported claim that no renderer will speak or draw.
 */
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema, projectRows } from "../db/client";
import { getAIProvider, SAFETY_PREAMBLE, tryAnalyze, untrusted, UsageMeter } from "../ai";
import type { Answer } from "../ask";
import type { AreaDoc, DocReport, FileDoc, ModuleDoc, Statement } from "../docs/types";
import { getFileContents } from "../ingest/store";
import { AppError } from "../util/errors";
import { sha256 } from "../util/ids";
import { sliceLines } from "../util/text";
import { buildCorpus, isGrounded } from "./grounding";
import { splitSentences } from "./speech";
import type { AudienceLevel, Claim, Comparison, Concept, ConceptGlyph, Evidence, ExplanationArtifactSpec, MetricFact, NarrativeSection, Process, Relationship, RelationshipKind, SourceReference, VisualLayout, VisualizationHint } from "./types";

export const COMPILER_VERSION = 3;

export type ExplanationSource =
  | { kind: "question"; id: string }
  | { kind: "file"; path: string }
  | { kind: "area"; id: string }
  | { kind: "module"; path: string }
  | { kind: "system" }
  | { kind: "finding"; code: string };

export const sourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("question"), id: z.string().min(1).max(80) }),
  z.object({ kind: z.literal("file"), path: z.string().min(1).max(500) }),
  z.object({ kind: z.literal("area"), id: z.string().min(1).max(200) }),
  z.object({ kind: z.literal("module"), path: z.string().min(1).max(500) }),
  z.object({ kind: z.literal("system") }),
  z.object({ kind: z.literal("finding"), code: z.string().min(1).max(40) }),
]);

export function sourceRunId(s: ExplanationSource): string {
  switch (s.kind) {
    case "question": return `question:${s.id}`;
    case "file": return `file:${s.path}`;
    case "area": return `area:${s.id}`;
    case "module": return `module:${s.path}`;
    case "finding": return `finding:${s.code}`;
    default: return "system";
  }
}

/** A Brody result reduced to what the compiler needs: its prose, its grounded statements and the lines it cites. */
export interface GroundedResult {
  sourceRunId: string;
  kind: ExplanationSource["kind"];
  title: string;
  question?: string;
  prose: string;
  statements: { text: string; evidence: string[] }[];
  citations: { path: string; startLine: number; endLine: number; note?: string }[];
  confidence: "high" | "medium" | "low";
  insufficient: boolean;
  notes: string[];
  components: { name: string; kind: string; path?: string; line?: number }[];
  edges: { from: string; to: string; label: string }[];
  steps: { label: string; detail?: string; path?: string; line?: number }[];
}

const parseCite = (c: string) => { const m = c.match(/^(.*?):(\d+)(?:-(\d+))?$/); return m ? { path: m[1], startLine: Number(m[2]), endLine: Number(m[3] ?? m[2]) } : null; };
const fromStatements = (xs: (Statement | undefined)[]) => xs.filter((x): x is Statement => !!x && !!x.text).map((s) => ({ text: s.text, evidence: s.evidence }));

/** Load the stored, already-verified result an explanation is built from. */
export function loadGroundedResult(projectId: string, source: ExplanationSource): GroundedResult {
  const db = getDb();
  const project = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!project) throw new AppError("project_not_found", "That project does not exist.", 404);
  const analysis = (project.analysis ?? {}) as { docs?: DocReport };
  const docs = analysis.docs;
  const rid = sourceRunId(source);
  const base = { sourceRunId: rid, kind: source.kind, notes: [], components: [], edges: [], steps: [], insufficient: false } as const;

  if (source.kind === "question") {
    const row = db.select().from(schema.questions).where(and(eq(schema.questions.projectId, projectId), eq(schema.questions.id, source.id))).get();
    if (!row) throw new AppError("not_found", "That question was not found in this project.", 404);
    const a = row.answer as unknown as Answer;
    return { ...base, notes: a.notes ?? [], components: [], edges: [], steps: [], title: row.question, question: row.question, prose: a.answer, statements: splitSentences(a.answer.replace(/\n+-\s+/g, ". ").replace(/\n+/g, " ")).map((t) => ({ text: t, evidence: [] })), citations: a.citations.map((c) => ({ path: c.path, startLine: c.startLine, endLine: c.endLine, note: c.note })), confidence: a.confidence, insufficient: a.insufficientEvidence };
  }
  if (!docs) throw new AppError("no_documentation", "This project has no generated documentation yet.", 409, "Re-run the analysis, then try again.");
  if (source.kind === "file") {
    const f = docs.files.find((x) => x.path === source.path);
    if (!f) throw new AppError("not_found", `No explanation exists for ${source.path}.`, 404);
    return fileResult(rid, f);
  }
  if (source.kind === "area") {
    const a = docs.areas.find((x) => x.id === source.id || x.name === source.id);
    if (!a) throw new AppError("not_found", "That functional area was not found.", 404);
    return areaResult(rid, a);
  }
  if (source.kind === "module") {
    const m = (docs.modules ?? []).find((x) => x.path === source.path);
    if (!m) throw new AppError("not_found", `No folder explanation exists for ${source.path}.`, 404);
    return moduleResult(rid, m);
  }
  if (source.kind === "finding") {
    const f = projectRows(schema.findings, projectId).find((x) => x.code === source.code);
    if (!f) throw new AppError("not_found", `Finding ${source.code} was not found.`, 404);
    const ev = f.filePath && f.startLine ? [`${f.filePath}:${f.startLine}-${f.endLine ?? f.startLine}`] : [];
    return { ...base, title: `${f.code}: ${f.title}`, prose: [f.whatHappens, f.whyItMatters, f.businessImpact ?? "", f.remediation].filter(Boolean).join(" "), statements: [f.whatHappens, f.whyItMatters, f.businessImpact ?? "", `Fix: ${f.remediation}`].filter(Boolean).map((t) => ({ text: t, evidence: ev })), citations: ev.map((e) => parseCite(e)!).filter(Boolean), confidence: f.confidence === "high" ? "high" : f.confidence === "low" ? "low" : "medium", notes: [`${f.severity} ${f.category} finding, ${f.verification.replace("_", " ")}.`], components: f.filePath ? [{ name: f.filePath.split("/").pop()!, kind: "file", path: f.filePath, line: f.startLine ?? 1 }] : [], edges: [], steps: [] };
  }
  // Whole system.
  const brief = docs.brief;
  const statements = [
    ...(brief ? [{ text: brief.summary, evidence: [] as string[] }] : []),
    ...fromStatements(docs.executiveSummary.slice(0, 4)),
    ...[docs.architectureOverview, docs.dataArchitecture, docs.risks].flatMap((s) => fromStatements(s.paragraphs.slice(0, 2))),
    ...docs.runtimeFlow.steps.slice(0, 4).map((s) => ({ text: `${s.label}: ${s.detail}`, evidence: s.evidence })),
    ...docs.areas.slice(0, 6).map((a) => ({ text: `${a.name}: ${a.purpose}`, evidence: a.evidence.slice(0, 3) })),
  ];
  return { ...base, title: brief?.headline ?? docs.title, prose: statements.map((s) => s.text).join(" "), statements, citations: statements.flatMap((s) => s.evidence).map(parseCite).filter((x): x is NonNullable<typeof x> => !!x), confidence: "medium", notes: [], components: docs.areas.slice(0, 8).map((a) => ({ name: a.name, kind: "area" })), edges: docs.areas.slice(0, 8).flatMap((a) => a.dependencies.slice(0, 3).map((d) => ({ from: a.name, to: d, label: "uses" }))), steps: docs.runtimeFlow.steps.slice(0, 8).map((s) => ({ label: s.label, detail: s.detail })) };
}

function fileResult(rid: string, f: FileDoc): GroundedResult {
  const ev = f.evidence;
  const st = [f.purpose, ...f.responsibilities, f.howItOperates, f.dataIn ? `Input: ${f.dataIn}` : "", f.dataOut ? `Output: ${f.dataOut}` : "", ...f.engineeringNotes].filter(Boolean).map((t) => ({ text: t, evidence: ev.slice(0, 4) }));
  return { sourceRunId: rid, kind: "file", title: `How ${f.path} works`, prose: st.map((s) => s.text).join(" "), statements: st, citations: ev.map(parseCite).filter((x): x is NonNullable<typeof x> => !!x), confidence: f.origin === "ai" ? "high" : "medium", insufficient: false, notes: [], components: [{ name: f.path.split("/").pop()!, kind: "file", path: f.path }, ...f.keySymbols.slice(0, 5).map((k) => ({ name: k, kind: "function", path: f.path })), ...f.dependsOn.slice(0, 4).map((d) => ({ name: d.split("/").pop()!, kind: "file", path: d })), ...f.calledBy.slice(0, 3).map((d) => ({ name: d.split("/").pop()!, kind: "file", path: d }))], edges: [...f.dependsOn.slice(0, 4).map((d) => ({ from: f.path.split("/").pop()!, to: d.split("/").pop()!, label: "depends on" })), ...f.calledBy.slice(0, 3).map((d) => ({ from: d.split("/").pop()!, to: f.path.split("/").pop()!, label: "calls" }))], steps: [] };
}

function areaResult(rid: string, a: AreaDoc): GroundedResult {
  const ev = a.evidence;
  const st = [a.purpose, a.businessFunction, a.processing, a.inputs ? `Inputs: ${a.inputs}` : "", a.outputs ? `Outputs: ${a.outputs}` : "", ...a.failureModes.map((x) => `Failure mode: ${x}`), a.relationships].filter(Boolean).map((t) => ({ text: t, evidence: ev.slice(0, 4) }));
  return { sourceRunId: rid, kind: "area", title: `How ${a.name} works`, prose: st.map((s) => s.text).join(" "), statements: st, citations: ev.map(parseCite).filter((x): x is NonNullable<typeof x> => !!x), confidence: a.origin === "ai" ? "high" : "medium", insufficient: false, notes: [], components: a.components.slice(0, 8).map((c) => ({ name: c.name, kind: c.kind, path: c.path, line: c.line })), edges: a.dependencies.slice(0, 5).map((d) => ({ from: a.name, to: d, label: "uses" })), steps: [] };
}

function moduleResult(rid: string, m: ModuleDoc): GroundedResult {
  const ev = m.evidence;
  const st = [m.purpose, m.howFilesWork, m.dataIn ? `Input: ${m.dataIn}` : "", m.dataOut ? `Output: ${m.dataOut}` : "", ...m.keyFiles.map((k) => `${k.path}: ${k.why}`)].filter(Boolean).map((t) => ({ text: t, evidence: ev.slice(0, 4) }));
  return { sourceRunId: rid, kind: "module", title: `How ${m.title || m.path} fits together`, prose: st.map((s) => s.text).join(" "), statements: st, citations: ev.map(parseCite).filter((x): x is NonNullable<typeof x> => !!x), confidence: m.origin === "ai" ? "high" : "medium", insufficient: false, notes: [], components: m.files.slice(0, 8).map((f) => ({ name: f.path.split("/").pop()!, kind: "file", path: f.path })), edges: m.internalLinks.slice(0, 10).map((l) => ({ from: l.from.split("/").pop()!, to: l.to.split("/").pop()!, label: "imports" })), steps: [] };
}

// ---------------------------------------------------------------------------------------------------------------------
// Deterministic spec
// ---------------------------------------------------------------------------------------------------------------------

/** Common system nouns and how to draw them. Matching is on whole words, singular or plural. */
const GLYPHS: [RegExp, ConceptGlyph, Concept["kind"]][] = [
  [/\b(dgx|node|machine|server|host|cluster)s?\b/i, "machine", "component"],
  [/\bgpus?\b|\b(a100|h100|h200|b200)s?\b/i, "gpu", "resource"],
  [/\bpods?\b|\bcontainers?\b/i, "pod", "component"],
  [/\bschedul(er|ing)\b/i, "scheduler", "component"],
  [/\b(database|table|store|cache)s?\b/i, "database", "data"],
  [/\b(queue|topic|stream)s?\b/i, "queue", "data"],
  [/\b(user|client|caller|browser)s?\b/i, "user", "actor"],
  [/\b(service|api|server|worker|endpoint|handler)s?\b/i, "service", "component"],
  [/\b(config|configmap|manifest|setting)s?\b/i, "config", "data"],
];

function glyphFor(name: string, kind?: string): { glyph: ConceptGlyph; kind: Concept["kind"] } {
  if (kind === "file") return { glyph: "file", kind: "component" };
  if (kind === "function" || kind === "method") return { glyph: "function", kind: "component" };
  for (const [re, glyph, k] of GLYPHS) if (re.test(name)) return { glyph, kind: k };
  return { glyph: "generic", kind: "idea" };
}

const ACRONYMS = new Set(["dgx", "gpu", "api", "cpu", "tpu", "a100", "h100", "h200", "b200"]);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "x";

export interface CompileContext { projectId: string; audience?: AudienceLevel; now?: number }

/** Source references with the cited lines attached, deduplicated by location. */
export function buildSources(projectId: string, result: GroundedResult): SourceReference[] {
  const files = new Map(projectRows(schema.files, projectId).map((f) => [f.path, f]));
  const cites = [...result.citations, ...result.statements.flatMap((s) => s.evidence.map(parseCite).filter((x): x is NonNullable<typeof x> => !!x))];
  const seen = new Map<string, SourceReference>();
  const contents = getFileContents(cites.map((c) => files.get(c.path)?.hash).filter((x): x is string => !!x));
  for (const c of cites) {
    const f = files.get(c.path);
    if (!f) continue;
    const start = Math.max(1, Math.min(c.startLine, f.lines || c.startLine));
    const end = Math.max(start, Math.min(c.endLine, f.lines || c.endLine));
    const key = `${c.path}:${start}-${end}`;
    if (seen.has(key)) continue;
    const text = contents.get(f.hash);
    seen.set(key, { id: `s${seen.size + 1}`, kind: "code", label: key, path: c.path, startLine: start, endLine: end, snippet: text ? sliceLines(text, start, Math.min(end, start + 24)) : undefined, note: (c as { note?: string }).note });
  }
  return [...seen.values()];
}

function sourcesFor(sentence: string, evidence: string[], sources: SourceReference[], fallbackAll: boolean): string[] {
  const direct = evidence.map(parseCite).filter((x): x is NonNullable<typeof x> => !!x).flatMap((c) => sources.filter((s) => s.path === c.path && (s.startLine ?? 0) <= c.endLine && (s.endLine ?? 0) >= c.startLine).map((s) => s.id));
  if (direct.length) return [...new Set(direct)];
  const lower = sentence.toLowerCase();
  // Link a sentence to the sources whose file name, note words or code it mentions.
  const matched = sources.filter((s) => {
    const base = (s.path ?? "").split("/").pop()!.toLowerCase();
    const stem = base.replace(/\.[a-z0-9]+$/, "");
    if (base && lower.includes(base)) return true;
    if (stem.length > 3 && lower.includes(stem)) return true;
    const noteWords = (s.note ?? "").toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 4);
    if (noteWords.some((w) => lower.includes(w))) return true;
    const ids = (s.snippet ?? "").match(/[A-Za-z_][\w./-]{4,}/g) ?? [];
    return ids.some((id) => lower.includes(id.toLowerCase()) && /[_./]|[a-z][A-Z]/.test(id));
  }).map((s) => s.id);
  if (matched.length) return matched;
  return fallbackAll ? sources.map((s) => s.id) : [];
}

const RELATION_VERB = /\b(requests?|asks? for|uses?|calls?|reads?|writes?|sends?|allocates?|assigns?|gives?|holds?|owns?|runs? on|contains?|schedules?|places?|binds?|waits? (?:on|for)|blocks?|depends? on|needs?)\b/i;
const RISK = /\b(problem|issue|risk|fail|fails|failure|waste|wasted|idle|under-?utili[sz]|contention|block|blocks|blocked|starv|leak|slow|bottleneck|cannot|can't|never|stuck|unused|fragment)/i;
const FIX = /\b(fix|fixes|solve|solution|instead|improv|better|should|recommend|dynamic|share|sharing|slice|slicing|mig|time-?slic|bin-?pack|reclaim|enable)/i;
const SEQUENCE = /^(first|then|next|after|finally|once|when)\b|\b(then|next|afterwards)\b/i;

export function baselineSpec(result: GroundedResult, ctx: CompileContext): ExplanationArtifactSpec {
  const sources = buildSources(ctx.projectId, result);
  const claims: Claim[] = [];
  const evidence: Evidence[] = sources.map((s, i) => ({ id: `e${i + 1}`, sourceId: s.id, quote: s.snippet?.split("\n").find((l) => l.trim())?.trim().slice(0, 160), note: s.note }));
  const evOf = (sid: string) => evidence.find((e) => e.sourceId === sid)!.id;
  const fallbackAll = result.kind === "question" && !result.insufficient;
  for (const st of result.statements) {
    for (const sentence of splitSentences(st.text)) {
      if (sentence.length < 12 || /^\(?no verifiable source/i.test(sentence)) continue;
      const sids = sourcesFor(sentence, st.evidence, sources, fallbackAll);
      claims.push({ id: `c${claims.length + 1}`, text: sentence, sourceIds: sids, evidenceIds: sids.map(evOf), confidence: sids.length ? result.confidence : "low", origin: "grounded-result", supported: sids.length > 0 });
    }
  }

  // Concepts: components the result names, then system nouns found in its claims.
  const concepts: Concept[] = [];
  const addConcept = (name: string, kind?: string, claimIds: string[] = []) => {
    const n = name.trim();
    if (!n || n.length > 60) return undefined;
    const existing = concepts.find((c) => c.name.toLowerCase() === n.toLowerCase());
    if (existing) { existing.claimIds = [...new Set([...existing.claimIds, ...claimIds])]; return existing; }
    const g = glyphFor(n, kind);
    const c: Concept = { id: `k-${slug(n)}`, name: n, definition: "", kind: g.kind, glyph: g.glyph, claimIds };
    if (concepts.some((x) => x.id === c.id)) c.id += `-${concepts.length}`;
    concepts.push(c);
    return c;
  };
  for (const comp of result.components.slice(0, 8)) addConcept(comp.name, comp.kind);
  for (const cl of claims) {
    for (const [re] of GLYPHS) {
      const m = cl.text.match(re);
      if (!m) continue;
      const w = m[0].replace(/(?<=\w{3})s$/i, "");
      // Keep acronyms as acronyms (DGX, GPU, API); capitalise ordinary words.
      addConcept(/[A-Z]/.test(w) ? w : ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1), undefined, [cl.id]);
    }
    for (const m of cl.text.matchAll(/`([^`]{2,40})`/g)) {
      const id = m[1];
      const kind = /^[\w./-]+\.[a-z]{1,5}$/i.test(id) && !/[:=\s]/.test(id) ? "file" : /[:=]|\.(com|io|org)\//.test(id) ? "config" : "function";
      const c = addConcept(id, kind === "config" ? undefined : kind, [cl.id]);
      if (c && kind === "config") { c.glyph = "config"; c.kind = "data"; }
    }
  }
  for (const c of concepts) {
    const def = claims.find((cl) => cl.supported && cl.text.toLowerCase().includes(c.name.toLowerCase()));
    c.definition = def?.text ?? "";
    if (!c.claimIds.length && def) c.claimIds = [def.id];
  }
  // A GPU concept sits inside a machine concept when both exist.
  const gpu = concepts.find((c) => c.glyph === "gpu");
  const machine = concepts.find((c) => c.glyph === "machine");
  if (gpu && machine) {
    gpu.parentId = machine.id;
    const n = claims.map((c) => c.text.match(/\b(\d+|eight|four|sixteen)\s+(?:\w+\s+)?gpus?\b/i)?.[1]).find(Boolean);
    const words: Record<string, number> = { four: 4, eight: 8, sixteen: 16 };
    if (n) gpu.count = Math.min(16, Number(n) || words[n.toLowerCase()] || 1);
  }

  // Relationships: two concepts in one claim, joined by the words between them.
  const relationships: Relationship[] = [];
  for (const e of result.edges) {
    const a = concepts.find((c) => c.name === e.from), b = concepts.find((c) => c.name === e.to);
    if (a && b && a !== b) relationships.push({ id: `r${relationships.length + 1}`, from: a.id, to: b.id, label: e.label, kind: "depends_on", claimIds: [] });
  }
  for (const cl of claims.filter((c) => c.supported)) {
    const present = concepts.map((c) => ({ c, at: cl.text.toLowerCase().indexOf(c.name.toLowerCase()) })).filter((x) => x.at >= 0).sort((x, y) => x.at - y.at);
    for (let i = 0; i + 1 < present.length && relationships.length < 12; i++) {
      const a = present[i], b = present[i + 1];
      if (a.c.id === b.c.id || relationships.some((r) => r.from === a.c.id && r.to === b.c.id)) continue;
      const between = cl.text.slice(a.at + a.c.name.length, b.at).replace(/[^A-Za-z ]/g, " ").trim().split(/\s+/).filter(Boolean).join(" ");
      // Only a short phrase with a real relation verb links two concepts; anything else is just two words in one sentence.
      if (!between || between.split(" ").length > 3 || !RELATION_VERB.test(between) || !/^[a-z]/i.test(between) || /^s\b/.test(between)) continue;
      relationships.push({ id: `r${relationships.length + 1}`, from: a.c.id, to: b.c.id, label: between, kind: relKind(between), claimIds: [cl.id] });
    }
  }

  // Process: the result's own steps, otherwise claims phrased as a sequence.
  const processes: Process[] = [];
  if (result.steps.length >= 2) processes.push({ id: "p1", name: "Flow", steps: result.steps.map((s, i) => ({ id: `p1.s${i + 1}`, label: s.label.slice(0, 80), detail: s.detail, claimIds: [] })), claimIds: [] });
  else {
    const seq = claims.filter((c) => c.supported && SEQUENCE.test(c.text));
    if (seq.length >= 2) processes.push({ id: "p1", name: "How it happens", steps: seq.slice(0, 6).map((c, i) => ({ id: `p1.s${i + 1}`, label: c.text.slice(0, 90), claimIds: [c.id] })), claimIds: seq.map((c) => c.id) });
  }

  // Metrics: percentages and measured quantities stated by claims.
  const metrics: MetricFact[] = [];
  for (const cl of claims.filter((c) => c.supported)) {
    for (const m of cl.text.matchAll(/(\d+(?:\.\d+)?)\s?(%|percent)/gi)) {
      if (metrics.length >= 4) break;
      const value = Number(m[1]);
      const before = cl.text.slice(0, m.index).split(/[,;.]/).pop()!.trim().split(/\s+/).slice(-4).join(" ");
      metrics.push({ id: `m${metrics.length + 1}`, label: before || "share", value, unit: "%", display: `${m[1]}%`, claimIds: [cl.id] });
    }
  }

  const supported = claims.filter((c) => c.supported);
  const problem = supported.filter((c) => RISK.test(c.text));
  const fix = supported.filter((c) => FIX.test(c.text) && !problem.includes(c));
  const rest = supported.filter((c) => !problem.includes(c) && !fix.includes(c));
  const sections: NarrativeSection[] = [];
  const pushSection = (title: string, objective: string, cs: Claim[], visual: VisualLayout) => {
    if (!cs.length) return;
    const conceptIds = concepts.filter((k) => cs.some((c) => c.text.toLowerCase().includes(k.name.toLowerCase()))).map((k) => k.id);
    sections.push({ id: `n${sections.length + 1}`, title, objective, claimIds: cs.map((c) => c.id), conceptIds, visual });
  };
  const archVisual: VisualLayout = concepts.length >= 3 ? "architecture" : metrics.length ? "metric" : "statement";
  pushSection("The setup", "Name the parts involved and how they connect.", rest.slice(0, 4), archVisual);
  pushSection("What goes wrong", "Show where the problem appears.", problem.slice(0, 4), concepts.some((c) => c.glyph === "gpu") ? "contention" : metrics.length ? "metric" : archVisual);
  if (processes.length) pushSection("Step by step", "Walk through the sequence.", supported.filter((c) => processes[0].claimIds.includes(c.id)).slice(0, 5), "process");
  pushSection("The fix", "Show what changes and why it helps.", fix.slice(0, 4), fix.length && problem.length ? "comparison" : archVisual);
  if (!sections.length) pushSection("The answer", "State the result.", supported.slice(0, 4), "statement");

  const comparisons: Comparison[] = [];
  if (problem.length && fix.length) comparisons.push({ id: "cmp1", title: "Before and after", before: { label: "Today", points: problem.slice(0, 3).map((c) => shorten(c.text)) }, after: { label: "With the fix", points: fix.slice(0, 3).map((c) => shorten(c.text)) }, claimIds: [...problem.slice(0, 3), ...fix.slice(0, 3)].map((c) => c.id) });

  const hints: VisualizationHint[] = sections.map((s, i) => ({ id: `v${i + 1}`, kind: s.visual, subjectIds: s.conceptIds, sectionId: s.id }));
  const summary = supported[0]?.text ?? result.prose.slice(0, 240);
  const now = ctx.now ?? Date.now();
  const spec: ExplanationArtifactSpec = {
    id: "", sourceRunId: result.sourceRunId, projectId: ctx.projectId, version: 1,
    title: shorten(result.title, 90), summary,
    audience: { level: ctx.audience ?? "intermediate" },
    objectives: sections.map((s) => s.objective),
    concepts, claims, evidence, relationships, processes, metrics, comparisons,
    codeReferences: sources.filter((s) => s.snippet).slice(0, 4).map((s, i) => ({ id: `code${i + 1}`, sourceId: s.id, path: s.path!, startLine: s.startLine!, endLine: Math.min(s.endLine!, s.startLine! + 14), code: (s.snippet ?? "").split("\n").slice(0, 15).join("\n"), caption: s.note ?? s.label, claimIds: claims.filter((c) => c.sourceIds.includes(s.id)).map((c) => c.id).slice(0, 4) })),
    examples: [], uncertainties: [
      ...(result.insufficient ? [{ id: "u1", text: "The repository did not contain enough evidence to answer every part of this question.", claimIds: [] }] : []),
      ...claims.filter((c) => !c.supported).slice(0, 3).map((c, i) => ({ id: `u${i + 2}`, text: `Not traced to a source: ${shorten(c.text)}`, claimIds: [c.id] })),
    ],
    caveats: result.notes.slice(0, 3),
    sources,
    narrative: { hook: result.question ?? result.title, sections, conclusion: supported[supported.length - 1]?.text ?? summary },
    visualizationHints: hints,
    provenance: [{ id: "pv1", stage: "compile", at: now, by: "deterministic", inputHash: sha256(JSON.stringify(result)).slice(0, 16), note: `Compiled from ${result.sourceRunId} (${result.statements.length} statements, ${sources.length} sources).` }],
    confidence: 0,
  };
  spec.confidence = specConfidence(spec);
  return spec;
}

function relKind(words: string): RelationshipKind {
  const w = words.toLowerCase();
  if (/request|ask/.test(w)) return "requests";
  if (/alloc|assign|bind|give/.test(w)) return "allocates";
  if (/block|wait|hold/.test(w)) return "blocks";
  if (/call|invoke/.test(w)) return "calls";
  if (/read|query/.test(w)) return "reads";
  if (/writ|store|save/.test(w)) return "writes";
  if (/contain|inside|has/.test(w)) return "contains";
  if (/send|flow|pass/.test(w)) return "flows_to";
  return "uses";
}

const shorten = (s: string, n = 110) => (s.length <= n ? s : `${s.slice(0, s.lastIndexOf(" ", n - 1) > 40 ? s.lastIndexOf(" ", n - 1) : n - 1)}…`);

export function specConfidence(spec: ExplanationArtifactSpec): number {
  if (!spec.claims.length) return 0;
  const w = { high: 1, medium: 0.75, low: 0.4 } as const;
  return Math.round((spec.claims.reduce((a, c) => a + (c.supported ? w[c.confidence] : 0), 0) / spec.claims.length) * 100) / 100;
}

/** Everything the explanation may state: claim texts, concept definitions and the cited source lines. */
export function specCorpus(spec: ExplanationArtifactSpec) {
  return buildCorpus([
    spec.title,
    ...spec.claims.filter((c) => c.supported).map((c) => c.text),
    ...spec.concepts.map((c) => `${c.name} ${c.definition}`),
    ...spec.sources.map((s) => `${s.label} ${s.path ?? ""} ${s.note ?? ""} ${s.snippet ?? ""}`),
    ...spec.evidence.map((e) => e.quote ?? ""),
  ]);
}

// ---------------------------------------------------------------------------------------------------------------------
// AI structuring
// ---------------------------------------------------------------------------------------------------------------------
const GLYPH_ENUM = ["machine", "gpu", "pod", "service", "scheduler", "database", "queue", "user", "file", "function", "external", "config", "generic"] as const;
const LAYOUT_ENUM = ["architecture", "process", "comparison", "metric", "code", "timeline", "equation", "statement", "contention"] as const;
const REL_ENUM = ["calls", "uses", "requests", "contains", "allocates", "blocks", "produces", "depends_on", "flows_to", "contends_with", "reads", "writes"] as const;

/** Coerce a model's string onto a closed set: providers do not always enforce enums in structured output. */
export function oneOf<T extends string>(v: string, allowed: readonly T[], fallback: T): T {
  const x = v.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (allowed as readonly string[]).includes(x) ? (x as T) : fallback;
}
const KIND_ENUM = ["component", "resource", "actor", "data", "idea", "metric"] as const;

// Enumerated fields are plain strings, coerced with oneOf(). No array bounds and no nullable fields: both inflate a provider's compiled output grammar (Anthropic refuses large
// ones). Limits are enforced in applyStructure instead; "" and 0 mean "none".
export const StructureSchema = z.object({
  title: z.string(),
  summary: z.string(),
  objectives: z.array(z.string()),
  claims: z.array(z.object({ id: z.string(), text: z.string(), basedOn: z.array(z.string()), confidence: z.string() })),
  concepts: z.array(z.object({ id: z.string(), name: z.string(), definition: z.string(), kind: z.string(), glyph: z.string(), parentId: z.string(), count: z.number(), claimIds: z.array(z.string()) })),
  relationships: z.array(z.object({ from: z.string(), to: z.string(), label: z.string(), kind: z.string(), claimIds: z.array(z.string()) })),
  processes: z.array(z.object({ name: z.string(), claimIds: z.array(z.string()), steps: z.array(z.object({ label: z.string(), actor: z.string(), claimIds: z.array(z.string()) })) })),
  metrics: z.array(z.object({ label: z.string(), value: z.number(), unit: z.string(), display: z.string(), claimIds: z.array(z.string()) })),
  comparisons: z.array(z.object({ title: z.string(), beforeLabel: z.string(), before: z.array(z.string()), afterLabel: z.string(), after: z.array(z.string()), claimIds: z.array(z.string()) })),
  examples: z.array(z.object({ title: z.string(), description: z.string(), claimIds: z.array(z.string()) })),
  uncertainties: z.array(z.object({ text: z.string(), claimIds: z.array(z.string()) })),
  sections: z.array(z.object({ title: z.string(), objective: z.string(), claimIds: z.array(z.string()), conceptIds: z.array(z.string()), visual: z.string() })),
  hook: z.string(),
  conclusion: z.string(),
});
export type Structure = z.infer<typeof StructureSchema>;

/** The structure is requested in two parts: one combined schema compiles to an output grammar some providers refuse. */
export const PartsSchema = StructureSchema.pick({ claims: true, concepts: true, relationships: true, metrics: true, uncertainties: true });
export const StorySchema = StructureSchema.pick({ title: true, summary: true, objectives: true, sections: true, comparisons: true, processes: true, examples: true, hook: true, conclusion: true });

function groundedMaterial(result: GroundedResult, base: ExplanationArtifactSpec): string {
  const claims = base.claims.map((c) => `${c.id} [${c.supported ? c.sourceIds.join(",") : "UNSUPPORTED"}] ${c.text}`).join("\n");
  const sources = base.sources.map((s) => `${s.id} ${s.label}${s.note ? ` (${s.note})` : ""}\n${(s.snippet ?? "").split("\n").slice(0, 14).map((l, i) => `${(s.startLine ?? 1) + i}: ${l}`).join("\n")}`).join("\n\n");
  return `Result type: ${result.kind}. Title: ${result.title}

Grounded claims (id, the source ids that support it, text):
${untrusted(claims)}

Sources (id, location, the cited lines):
${untrusted(sources)}`;
}

function partsPrompt(result: GroundedResult, base: ExplanationArtifactSpec): string {
  return `Reorganise a VERIFIED result from a repository analysis tool into the parts an explainer video will draw. You are not answering anything new: every fact must come from the claims and sources below.

${groundedMaterial(result, base)}

Produce:
- claims: atomic restatements that make the explanation easier to follow. Each lists in basedOn the claim ids (c1, c2, ...) or source ids (s1, ...) it restates. Use new ids a1, a2, ... Do not add facts, numbers, names or identifiers that are not in the claims or sources.
- concepts: the 4 to 12 things a viewer must see (components, resources, actors, data). Pick a glyph for each. Use parentId for containment (a GPU inside a machine; "" when none) and count for identical instances (8 GPUs; 0 when not counted). Use ids k1, k2, ...
- relationships between concept ids, with a short verb label (under 24 characters).
- metrics: only numbers stated in the claims or sources, with the claim ids that state them; unit "" when none.
- uncertainties: anything the claims mark as unknown or unsupported.
Never cite an UNSUPPORTED claim.`;
}

function storyPrompt(result: GroundedResult, base: ExplanationArtifactSpec, parts: z.infer<typeof PartsSchema>): string {
  const concepts = parts.concepts.map((k) => `${k.id}: ${k.name} (${k.glyph}${k.parentId ? `, inside ${k.parentId}` : ""}${k.count ? `, x${k.count}` : ""})`).join("\n");
  const added = parts.claims.map((c) => `${c.id}: ${c.text}`).join("\n");
  return `Plan the teaching order of an explainer video about a VERIFIED repository analysis result. Every fact must come from the claims below.

${groundedMaterial(result, base)}

Restated claims you may also use:
${untrusted(added || "none")}

Concepts the animation will draw:
${untrusted(concepts || "none")}

Produce:
- sections: 3 to 6 narrative sections for a ${base.audience.level} viewer, in teaching order (setup, mechanism, consequence, fix or takeaway). Each lists the claim ids (c*/a*) it explains, the concept ids it shows, and the visual layout that fits best: architecture (parts and links), contention (resources fought over), process (steps), comparison (before/after), metric (one number), code (source lines), timeline, equation, statement (one sentence).
- processes: ordered steps (actor "" when none), if the result describes a sequence.
- comparisons: a before/after or problem/fix contrast, if the result contains both sides.
- examples, if the claims contain one.
- title (under 90 characters), summary (two sentences), objectives (2 to 4).
- hook: one sentence that states the question or the surprising fact. conclusion: one sentence that lands the idea.
Use claim ids only from the lists above. Never cite an UNSUPPORTED claim.`;
}

/** Apply a model's structure to the deterministic spec, keeping only what verifies. */
export function applyStructure(base: ExplanationArtifactSpec, raw: Structure, model: string, now = Date.now()): { spec: ExplanationArtifactSpec; dropped: string[] } {
  const dropped: string[] = [];
  const s: Structure = { ...raw, objectives: raw.objectives.slice(0, 5), claims: raw.claims.slice(0, 30), concepts: raw.concepts.slice(0, 14), relationships: raw.relationships.slice(0, 16), processes: raw.processes.slice(0, 2).map((p) => ({ ...p, steps: p.steps.slice(0, 8) })), metrics: raw.metrics.slice(0, 5), comparisons: raw.comparisons.slice(0, 2).map((c) => ({ ...c, before: c.before.slice(0, 4), after: c.after.slice(0, 4) })), examples: raw.examples.slice(0, 3), uncertainties: raw.uncertainties.slice(0, 4), sections: raw.sections.slice(0, 8) };
  const spec: ExplanationArtifactSpec = JSON.parse(JSON.stringify(base));
  const corpus = specCorpus(base);
  const claimById = new Map(spec.claims.map((c) => [c.id, c]));
  const sourceIds = new Set(spec.sources.map((x) => x.id));
  // Restated claims.
  for (const c of s.claims) {
    if (!/^a\d+$/.test(c.id) || claimById.has(c.id)) { dropped.push(`claim ${c.id}: invalid id`); continue; }
    const bases = c.basedOn.filter((b) => claimById.get(b)?.supported || sourceIds.has(b));
    const sids = [...new Set(bases.flatMap((b) => (sourceIds.has(b) ? [b] : claimById.get(b)!.sourceIds)))];
    const g = isGrounded(c.text, corpus);
    const supported = sids.length > 0 && g.ok;
    if (!supported) dropped.push(`claim ${c.id}: ${sids.length ? `introduces ${g.missing.join(", ")}` : "rests on no supported claim or source"}`);
    const claim: Claim = { id: c.id, text: c.text, sourceIds: sids, evidenceIds: sids.map((sid) => spec.evidence.find((e) => e.sourceId === sid)?.id).filter((x): x is string => !!x), confidence: supported ? oneOf(c.confidence, ["high", "medium", "low"] as const, "medium") : "low", origin: "ai-restructured", supported };
    spec.claims.push(claim);
    claimById.set(claim.id, claim);
  }
  const validClaims = (ids: string[]) => ids.filter((id) => claimById.get(id)?.supported);
  // Concepts: names must be grounded words.
  const concepts: Concept[] = [];
  for (const k of s.concepts) {
    const g = isGrounded(k.name, corpus);
    const words = k.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    if (!g.ok || (words.length && !words.some((w) => corpus.text.includes(w)))) { dropped.push(`concept ${k.name}: not named in the grounded material`); continue; }
    concepts.push({ id: k.id, name: k.name.slice(0, 48), definition: isGrounded(k.definition, corpus).ok ? k.definition : "", kind: oneOf(k.kind, KIND_ENUM, "component"), glyph: oneOf(k.glyph, GLYPH_ENUM, glyphFor(k.name).glyph), parentId: k.parentId || undefined, count: k.count > 1 ? Math.round(k.count) : undefined, claimIds: validClaims(k.claimIds) });
  }
  const conceptIds = new Set(concepts.map((k) => k.id));
  for (const k of concepts) {
    if (k.parentId && !conceptIds.has(k.parentId)) k.parentId = undefined;
    // A count must be stated somewhere.
    if (k.count && !corpus.numbers.has(String(k.count))) { dropped.push(`concept ${k.name}: count ${k.count} is not stated`); k.count = undefined; }
    // More than 16 instances cannot be drawn legibly as cells, so a larger stated count is drawn as 16.
    if (k.count && k.count > 16) k.count = 16;
  }
  if (concepts.length >= 2) spec.concepts = concepts;
  const known = new Set(spec.concepts.map((k) => k.id));
  const rels = s.relationships.filter((r) => known.has(r.from) && known.has(r.to) && r.from !== r.to).map((r, i) => ({ id: `r${i + 1}`, from: r.from, to: r.to, label: r.label.slice(0, 40), kind: oneOf(r.kind, REL_ENUM, relKind(r.label)), claimIds: validClaims(r.claimIds) }));
  if (rels.length || concepts.length >= 2) spec.relationships = rels;
  const procs = s.processes.map((p, i) => ({ id: `p${i + 1}`, name: p.name, claimIds: validClaims(p.claimIds), steps: p.steps.filter((st) => isGrounded(st.label, corpus).ok).map((st, j) => ({ id: `p${i + 1}.s${j + 1}`, label: st.label.slice(0, 80), actor: st.actor || undefined, claimIds: validClaims(st.claimIds) })) })).filter((p) => p.steps.length >= 2);
  if (procs.length) spec.processes = procs;
  const metrics = s.metrics.filter((m) => {
    const ok = corpus.numbers.has(String(m.value)) && validClaims(m.claimIds).length > 0;
    if (!ok) dropped.push(`metric ${m.label}: ${m.value} is not stated by its claims`);
    return ok;
  }).map((m, i) => ({ id: `m${i + 1}`, label: m.label.slice(0, 40), value: m.value, unit: m.unit || undefined, display: m.display.slice(0, 12), claimIds: validClaims(m.claimIds) }));
  if (metrics.length) spec.metrics = metrics;
  const comps = s.comparisons.map((c, i) => ({ id: `cmp${i + 1}`, title: c.title, before: { label: c.beforeLabel, points: c.before.filter((p) => isGrounded(p, corpus).ok) }, after: { label: c.afterLabel, points: c.after.filter((p) => isGrounded(p, corpus).ok) }, claimIds: validClaims(c.claimIds) })).filter((c) => c.before.points.length && c.after.points.length && c.claimIds.length);
  if (comps.length) spec.comparisons = comps;
  spec.examples = s.examples.filter((e) => isGrounded(`${e.title} ${e.description}`, corpus).ok).map((e, i) => ({ id: `x${i + 1}`, title: e.title, description: e.description, claimIds: validClaims(e.claimIds) }));
  spec.uncertainties = [...(spec.uncertainties ?? []), ...s.uncertainties.map((u, i) => ({ id: `ua${i + 1}`, text: u.text, claimIds: u.claimIds.filter((id) => claimById.has(id)) }))];
  const sections = s.sections.map((x, i) => ({ id: `n${i + 1}`, title: isGrounded(x.title, corpus, { properNouns: false }).ok ? x.title.slice(0, 60) : `Part ${i + 1}`, objective: x.objective, claimIds: validClaims(x.claimIds), conceptIds: x.conceptIds.filter((id) => known.has(id)), visual: oneOf(x.visual, LAYOUT_ENUM, "statement") })).filter((x) => x.claimIds.length > 0);
  if (sections.length) {
    spec.narrative = { hook: isGrounded(s.hook, corpus).ok ? s.hook : base.narrative.hook, sections, conclusion: isGrounded(s.conclusion, corpus).ok ? s.conclusion : base.narrative.conclusion };
    spec.visualizationHints = sections.map((x, i) => ({ id: `v${i + 1}`, kind: x.visual, subjectIds: x.conceptIds, sectionId: x.id }));
  }
  if (s.title.trim() && isGrounded(s.title, corpus, { properNouns: false }).ok) spec.title = s.title.slice(0, 90);
  if (isGrounded(s.summary, corpus).ok) spec.summary = s.summary;
  spec.objectives = s.objectives.length ? s.objectives : spec.objectives;
  spec.provenance.push({ id: `pv${spec.provenance.length + 1}`, stage: "structure", at: now, by: model, inputHash: sha256(JSON.stringify(base.claims)).slice(0, 16), note: `${s.claims.length} restated claims, ${concepts.length} concepts; ${dropped.length} item(s) dropped by the grounding guard.` });
  spec.confidence = specConfidence(spec);
  return { spec, dropped };
}

export interface CompileOutcome { spec: ExplanationArtifactSpec; result: GroundedResult; ai: { used: boolean; model?: string; dropped: string[]; error?: string; usage?: { inputTokens: number; outputTokens: number } } }

export async function compileExplanation(projectId: string, source: ExplanationSource, opts: { audience?: AudienceLevel; useAI?: boolean } = {}): Promise<CompileOutcome> {
  const result = loadGroundedResult(projectId, source);
  const base = baselineSpec(result, { projectId, audience: opts.audience });
  const provider = opts.useAI === false ? null : getAIProvider();
  if (!provider || base.claims.filter((c) => c.supported).length === 0) return { spec: base, result, ai: { used: false, dropped: [] } };
  const meter = new UsageMeter();
  const parts = await tryAnalyze(provider, meter, { task: "explainer-structure", system: SAFETY_PREAMBLE, prompt: partsPrompt(result, base), schema: PartsSchema, maxTokens: 6000 });
  const story = parts ? await tryAnalyze(provider, meter, { task: "explainer-structure:story", system: SAFETY_PREAMBLE, prompt: storyPrompt(result, base, parts), schema: StorySchema, maxTokens: 6000 }) : undefined;
  if (!parts || !story) return { spec: base, result, ai: { used: false, dropped: [], error: meter.failures[0]?.error } };
  const { spec, dropped } = applyStructure(base, { ...parts, ...story }, provider.model);
  return { spec, result, ai: { used: true, model: provider.model, dropped, usage: { inputTokens: meter.usage.inputTokens, outputTokens: meter.usage.outputTokens } } };
}
