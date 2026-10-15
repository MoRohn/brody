/**
 * What Brody already knows about a repository, rendered as one compact, citable brief for the Ask model.
 *
 * Code excerpts alone cannot answer "how does it work", "who is it for", "is it safe" or "where should I start": those
 * answers live in the analysis (summary, architecture, areas, flows, data, integrations, assessments, findings). Every
 * line here keeps the source locations it was derived from in [brackets], so an answer drawn from it still cites code.
 */
import type { Assurance } from "../assurance/types";
import type { FindingRow } from "../db/schema";
import type { Architecture, Evidence } from "../discover/types";
import type { DocReport, DocSection, Statement } from "../docs/types";

export interface KnowledgeInput {
  projectName: string;
  docs?: DocReport;
  arch?: Architecture;
  assurance?: Assurance;
  findings: Pick<FindingRow, "code" | "severity" | "title" | "category" | "filePath" | "startLine" | "endLine" | "verification" | "businessImpact">[];
}

const SEV = ["Critical", "High", "Medium", "Low", "Informational"];
const HIDDEN_AREAS = new Set(["Documentation", "Testing", "Configuration"]);

/** "src/a.ts:10-42" stays; a bare path gains ":1" so the model has a line to cite. */
function ref(e: string | Evidence): string {
  if (typeof e !== "string") return `${e.path}:${e.line ?? 1}${e.endLine && e.endLine !== e.line ? `-${e.endLine}` : ""}`;
  return /:\d+(-\d+)?$/.test(e) ? e : `${e}:1`;
}
function refs(xs: (string | Evidence)[] | undefined, max = 3): string {
  const out = [...new Set((xs ?? []).filter((x) => (typeof x === "string" ? !!x.trim() : !!x.path)).map(ref))].slice(0, max);
  return out.length ? ` [${out.join("; ")}]` : "";
}
const clip = (t: string, max: number) => { const s = (t ?? "").replace(/\s+/g, " ").trim(); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };
const stmt = (s: Statement, max = 400) => `- ${clip(s.text, max)}${refs(s.evidence)}`;
const section = (s: DocSection | undefined, max = 4) => (s ? [...s.paragraphs.slice(0, max), ...(s.bullets ?? []).slice(0, max)].filter((x) => x.text).map((x) => stmt(x)) : []);

/** How many of the focus words a piece of text mentions; used to put the parts a question is about first. */
function overlap(text: string, focus: string[]): number {
  if (!focus.length) return 0;
  const t = text.toLowerCase();
  return focus.filter((w) => t.includes(w)).length;
}
const byFocus = <T>(xs: T[], focus: string[], text: (x: T) => string): T[] => (focus.length ? [...xs].map((x, i) => ({ x, i, s: overlap(text(x), focus) })).sort((a, b) => b.s - a.s || a.i - b.i).map((y) => y.x) : xs);

/**
 * Render the brief within a character budget. Sections come in priority order (what a broad question needs first) and
 * lists inside them are ordered by the question's focus words, so a long repository still shows the relevant parts.
 */
export function renderKnowledge(k: KnowledgeInput, opts: { budget?: number; focus?: string[] } = {}): string {
  const budget = opts.budget ?? 28000;
  const focus = (opts.focus ?? []).filter((w) => w.length >= 3);
  const { docs, arch, assurance } = k;
  const parts: { title: string; lines: string[] }[] = [];
  const add = (title: string, lines: (string | false | undefined)[]) => { const l = lines.filter((x): x is string => !!x && !!x.trim()); if (l.length) parts.push({ title, lines: l }); };

  const brief = docs?.brief;
  add("What it is", [
    `Repository name: ${k.projectName}`,
    brief?.headline && `Headline: ${clip(brief.headline, 300)}`,
    brief?.summary && `Summary: ${clip(brief.summary, 900)}`,
    brief?.audience && `Audience: ${clip(brief.audience, 200)}`,
    ...(docs?.executiveSummary ?? []).slice(0, 6).map((s) => stmt(s, 500)),
    ...(brief?.keyPoints ?? []).map((p) => `- ${p.title}: ${clip(p.detail, 300)}`),
  ]);
  if (brief?.capabilities.length) add("What it can do", brief.capabilities.map((c) => `- ${clip(c, 220)}`));
  if (docs?.atAGlance.length) add("At a glance", docs.atAGlance.map((g) => `- ${g.area}: ${clip(g.description, 260)}${refs(g.evidence)}`));

  if (arch) {
    const langs = arch.stack.languages.slice(0, 5).map((l) => `${l.name} (${l.files} files)`).join(", ");
    add("How it is built", [
      `Application type: ${arch.applicationType}`,
      `Architecture pattern: ${arch.pattern.label} (${arch.pattern.confidence} confidence)${arch.pattern.reasoning.length ? `: ${clip(arch.pattern.reasoning.slice(0, 3).join(" "), 400)}` : ""}`,
      langs && `Languages: ${langs}`,
      arch.stack.frameworks.length > 0 && `Frameworks and libraries: ${arch.stack.frameworks.slice(0, 14).map((f) => `${f.name} (${f.category})`).join(", ")}`,
      arch.stack.databases.length > 0 && `Databases: ${arch.stack.databases.join(", ")}`,
      arch.stack.infrastructure.length > 0 && `Infrastructure: ${arch.stack.infrastructure.join(", ")}`,
      arch.layers.length > 0 && `Layers: ${arch.layers.slice(0, 8).map((l) => `${l.name} (${l.files} files): ${clip(l.description, 120)}`).join("; ")}`,
      `Size: ${Object.entries(arch.stats).filter(([, v]) => typeof v === "number").slice(0, 8).map(([key, v]) => `${key} ${v}`).join(", ")}`,
    ]);
  }
  add("Architecture overview", section(docs?.architectureOverview, 5));

  if (docs?.runtimeFlow) add("How it runs, step by step", [
    ...docs.runtimeFlow.narrative.slice(0, 4).map((s) => stmt(s)),
    ...docs.runtimeFlow.steps.slice(0, 10).map((s, i) => `${i + 1}. ${clip(s.label, 120)}: ${clip(s.detail, 240)}${refs(s.evidence, 2)}`),
  ]);
  if (arch?.entryPoints.length) add("Entry points (where execution starts)", arch.entryPoints.slice(0, 8).map((e) => `- ${e.kind}: ${e.symbolName ? `${e.symbolName} in ` : ""}${e.path} (${clip(e.reason, 140)})${refs([{ path: e.path, line: e.line }])}`));

  const areas = byFocus((docs?.areas ?? []).filter((a) => !HIDDEN_AREAS.has(a.name)), focus, (a) => `${a.name} ${a.purpose} ${a.businessFunction} ${a.files.join(" ")}`);
  if (areas.length) add("Functional areas", areas.slice(0, 12).map((a) => `- ${a.name}: ${clip(a.purpose, 320)}${a.businessFunction ? ` Business role: ${clip(a.businessFunction, 200)}` : ""}${a.inputs ? ` In: ${clip(a.inputs, 120)}.` : ""}${a.outputs ? ` Out: ${clip(a.outputs, 120)}.` : ""}${a.dependencies.length ? ` Uses: ${a.dependencies.slice(0, 5).join(", ")}.` : ""}${refs(a.evidence)}`));

  const flows = byFocus(docs?.flows ?? [], focus, (f) => `${f.name} ${f.trigger} ${f.narrative}`);
  if (flows.length) add("Key flows", flows.slice(0, 8).map((f) => `- ${f.name} (trigger: ${clip(f.trigger, 100)}): ${clip(f.narrative || f.steps.map((s) => s.label).join(" → "), 420)}${f.models.length ? ` Data: ${f.models.slice(0, 5).join(", ")}.` : ""}${f.externals.length ? ` External: ${f.externals.slice(0, 4).join(", ")}.` : ""}${refs(f.evidence)}`));

  const modules = byFocus((docs?.modules ?? []).filter((m) => m.kind === "folder" && m.depth <= 2), focus, (m) => `${m.path} ${m.purpose}`);
  if (modules.length) add("Main folders", modules.slice(0, 14).map((m) => `- ${m.path || "(root)"}/ (${m.fileCount} files): ${clip(m.purpose, 260)}${m.keyFiles.length ? ` Key files: ${m.keyFiles.slice(0, 3).map((f) => f.path).join(", ")}.` : ""}${refs(m.evidence, 2)}`));

  if (arch) {
    const routes = byFocus(arch.routes, focus, (r) => `${r.method} ${r.path} ${r.handler} ${r.file}`);
    add("API and pages", [
      ...section(docs?.apiArchitecture, 3),
      routes.length > 0 && `${arch.routes.filter((r) => r.kind === "api").length} API routes, ${arch.routes.filter((r) => r.kind === "page").length} pages, ${arch.routes.filter((r) => r.auth === "authenticated").length} with an authentication check.`,
      ...routes.slice(0, 25).map((r) => `- ${r.method} ${r.path} → ${r.handler} (${r.kind}, ${r.auth})${refs([{ path: r.file, line: r.line }])}`),
    ]);
    const models = byFocus(arch.models, focus, (m) => `${m.name} ${m.fields.join(" ")}`);
    add("Data", [
      ...section(docs?.dataArchitecture, 3),
      ...models.slice(0, 16).map((m) => `- ${m.kind} ${m.name}: ${m.fields.slice(0, 10).join(", ")}${m.fields.length > 10 ? ", …" : ""}${m.references.length ? ` (links to ${m.references.slice(0, 4).join(", ")})` : ""}${refs([{ path: m.file, line: m.line, endLine: m.endLine }])}`),
    ]);
  }
  if (docs?.integrations.length) add("External services and integrations", docs.integrations.slice(0, 12).map((i) => `- ${i.name} (${i.category}): ${clip(i.why, 220)}${i.ifUnavailable ? ` If unavailable: ${clip(i.ifUnavailable, 160)}` : ""}${refs(i.where, 2)}`));
  else if (arch?.externalServices.length) add("External services and integrations", arch.externalServices.slice(0, 12).map((s) => `- ${s.name} (${s.category}): ${clip(s.purpose, 200)}${refs(s.evidence, 2)}`));
  if (arch?.ai.length) add("AI and LLM components", arch.ai.slice(0, 10).map((a) => `- ${a.kind}: ${clip(a.detail, 180)}${refs([{ path: a.path, line: a.line }])}`));

  add("Configuration and deployment", [
    ...section(docs?.infrastructure, 3),
    arch && arch.envVars.length > 0 && `Environment variables: ${arch.envVars.slice(0, 24).map((e) => `${e.name}${e.sensitive ? " (secret)" : ""}`).join(", ")}`,
    arch && arch.ports.length > 0 && `Ports: ${arch.ports.slice(0, 6).map((p) => p.value).join(", ")}`,
    arch && arch.infra.length > 0 && `Infrastructure files: ${arch.infra.slice(0, 8).map((i) => `${i.kind} ${i.path}`).join(", ")}`,
    arch && arch.featureFlags.length > 0 && `Feature flags: ${arch.featureFlags.slice(0, 10).map((f) => f.name).join(", ")}`,
  ]);
  add("Testing", [
    ...section(docs?.testing, 2),
    arch && `${arch.tests.files.length} test files${arch.tests.frameworks.length ? ` using ${arch.tests.frameworks.join(", ")}` : ""}.`,
    arch && arch.tests.untestedCritical.length > 0 && `Untested critical code: ${arch.tests.untestedCritical.slice(0, 6).map((u) => `${u.path} (${clip(u.reason, 80)})`).join("; ")}`,
  ]);

  if (brief?.health) add("Overall health", [
    `Verdict: ${clip(brief.health.verdict, 300)}`,
    ...brief.health.strengths.map((s) => `- Strength: ${clip(s, 200)}`),
    ...brief.health.concerns.map((s) => `- Concern: ${clip(s, 220)}`),
  ]);
  if (assurance) {
    const s = assurance.security, p = assurance.privacy;
    add("Security assessment", [
      `Risk rating: ${s.rating}. ${clip(s.rationale.join(" "), 500)}`,
      `Findings: ${SEV.map((x) => `${s.counts[x as keyof typeof s.counts] ?? 0} ${x}`).join(", ")}.`,
      ...s.controls.filter((c) => c.status !== "na").slice(0, 10).map((c) => `- Control "${c.name}": ${c.status}. ${clip(c.detail, 160)}`),
      ...s.plan.slice(0, 5).map((x) => `- Plan (${x.priority}): ${clip(x.action, 200)}`),
    ]);
    add("Privacy (personal data) assessment", [
      `Status: ${p.status}. ${clip(p.rationale.join(" "), 400)}`,
      p.subjects.length > 0 && `Whose data: ${p.subjects.slice(0, 6).join(", ")}`,
      p.fields.length > 0 && `Personal data fields: ${p.fields.slice(0, 14).map((f) => `${f.model}.${f.field} (${f.categoryLabel}, ${f.sensitivity})`).join(", ")}`,
      p.recipients.length > 0 && `Shared with: ${p.recipients.slice(0, 6).map((r) => `${r.name} (${clip(r.why, 80)})`).join("; ")}`,
      p.regimes.length > 0 && `Regulations that may apply: ${p.regimes.slice(0, 4).map((r) => r.name).join(", ")}`,
    ]);
  }
  add("Security model", section(docs?.securityModel, 3));

  const live = k.findings.filter((f) => f.verification !== "rejected").sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity));
  if (live.length) {
    const top = byFocus(live, focus, (f) => `${f.title} ${f.category} ${f.filePath ?? ""}`).slice(0, 14);
    add("Findings from Brody's code review", [
      `${live.length} findings: ${SEV.map((s) => `${live.filter((f) => f.severity === s).length} ${s}`).join(", ")}.`,
      ...top.map((f) => `- ${f.code} [${f.severity}, ${f.category}] ${clip(f.title, 160)}${f.businessImpact ? `: ${clip(f.businessImpact, 160)}` : ""}${f.filePath ? refs([{ path: f.filePath, line: f.startLine ?? 1, endLine: f.endLine ?? undefined }]) : ""}`),
    ]);
  }
  add("Engineering risks", section(docs?.risks, 4));
  if (brief?.nextSteps.length) add("Recommended next steps", brief.nextSteps.map((n) => `- ${n.priority}: ${clip(n.action, 200)}${n.why ? ` (${clip(n.why, 160)})` : ""}`));
  else if (docs?.recommendations.length) add("Recommended next steps", docs.recommendations.slice(0, 6).map((r) => stmt(r, 260)));

  // Fill the budget section by section; a section that does not fit is cut at a line boundary rather than dropped.
  const out: string[] = [];
  let used = 0;
  for (const p of parts) {
    const head = `## ${p.title}`;
    if (used + head.length + 80 > budget) break;
    out.push(head);
    used += head.length + 1;
    for (const l of p.lines) {
      if (used + l.length + 1 > budget) break;
      out.push(l);
      used += l.length + 1;
    }
  }
  return out.join("\n");
}

/**
 * The repository overview Brody can give without a model: the brief, its key points and capabilities, with the
 * locations they rest on. Used for broad questions when no AI provider is configured or the model call fails.
 */
export function overviewFromAnalysis(k: KnowledgeInput): { text: string; evidence: string[] } | undefined {
  const { docs, arch } = k;
  const brief = docs?.brief;
  if (!docs || !brief) return undefined;
  const lines = [brief.headline, "", brief.summary];
  if (brief.keyPoints.length) lines.push("", ...brief.keyPoints.filter((p) => p.title !== "What it is").map((p) => `- ${p.title}: ${p.detail}`));
  if (brief.capabilities.length) lines.push("", "What it can do:", ...brief.capabilities.slice(0, 6).map((c) => `- ${c}`));
  if (docs.runtimeFlow.steps.length) lines.push("", "How a typical run goes:", ...docs.runtimeFlow.steps.slice(0, 5).map((s, i) => `${i + 1}. ${s.label}: ${s.detail}`));
  const evidence = [
    ...docs.executiveSummary.flatMap((s) => s.evidence),
    ...docs.runtimeFlow.steps.flatMap((s) => s.evidence),
    ...docs.areas.filter((a) => !HIDDEN_AREAS.has(a.name)).flatMap((a) => a.evidence.slice(0, 1)),
    ...(arch?.entryPoints ?? []).slice(0, 3).map((e) => ref({ path: e.path, line: e.line })),
  ].filter(Boolean).map((e) => ref(e));
  return { text: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(), evidence: [...new Set(evidence)] };
}
