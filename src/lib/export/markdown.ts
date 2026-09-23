import { eq } from "drizzle-orm";
import { getDb, schema, projectRows } from "../db/client";
import type { FindingRow, ProjectRow } from "../db/schema";
import type { Architecture } from "../discover/types";
import { buildBrief } from "../docs/brief";
import type { DocReport, ExecutiveBrief, Statement } from "../docs/types";
import { areaGraph, architectureDiagramText, architectureMermaid, changeImpact, erMermaid, graphToMermaid, legendText, loadModel, moduleGraph, repositoryTree, riskGlyph, treeToText, glyphFor, type RiskLevel } from "../map";
import { formatBytes } from "../util/text";

export interface ReportData {
  project: ProjectRow;
  arch: Architecture;
  docs: DocReport;
  findings: FindingRow[];
}

export function loadReportData(projectId: string): ReportData {
  const db = getDb();
  const project = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!project) throw new Error("Project not found");
  const analysis = (project.analysis ?? {}) as { architecture?: Architecture; docs?: DocReport };
  if (!analysis.architecture || !analysis.docs) throw new Error("The analysis has not finished, so there is no report yet.");
  const findings = projectRows(schema.findings, projectId).filter((f) => f.verification !== "rejected");
  return { project, arch: analysis.architecture, docs: analysis.docs, findings };
}

const cell = (s: string | number | null | undefined) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const cite = (ev: string[]) => (ev.length ? ` _(${ev.slice(0, 3).map((e) => `\`${e}\``).join(", ")})_` : "");
const para = (s: Statement) => `${s.text}${cite(s.evidence)}${s.origin === "ai" ? "" : ""}`;
const fence = (lang: string, body: string) => "```" + lang + "\n" + body + "\n```";
/** Trim to a readable length at a word boundary. */
const short = (t: string, max: number) => {
  const s = (t ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1).replace(/\s+\S*$/, "")}…` : s;
};

/** The business brief as a deck: headline, snapshot, key points, capabilities, health, next steps. */
function briefMarkdown(out: string[], b: ExecutiveBrief): void {
  out.push(`> **${b.headline}**\n`);
  out.push(`${b.summary}${b.audience && !/^not stated/i.test(b.audience) ? ` **Who it serves.** ${b.audience}` : ""}\n`);
  out.push("### Snapshot\n");
  for (const half of [b.metrics.slice(0, 4), b.metrics.slice(4, 8)]) {
    if (!half.length) continue;
    out.push(`| ${half.map((m) => cell(m.label)).join(" | ")} |`, `| ${half.map(() => "---").join(" | ")} |`, `| ${half.map((m) => `**${cell(m.value)}**`).join(" | ")} |`, "");
  }
  if (b.keyPoints.length) { out.push("### Key points\n"); for (const k of b.keyPoints) out.push(`- **${k.title}.** ${k.detail}`); out.push(""); }
  if (b.capabilities.length) { out.push("### What it does\n"); for (const c of b.capabilities) out.push(`- ${c}`); out.push(""); }
  out.push("### Health and risk\n", `**${b.health.verdict}**\n`);
  if (b.health.strengths.length) { out.push("Strengths:\n"); for (const x of b.health.strengths) out.push(`- ${x}`); out.push(""); }
  if (b.health.concerns.length) { out.push("Concerns:\n"); for (const x of b.health.concerns) out.push(`- ${x}`); out.push(""); }
  if (b.nextSteps.length) {
    out.push("### Recommended next steps\n", "| Priority | Action | Why it matters |", "| --- | --- | --- |");
    for (const n of b.nextSteps) out.push(`| **${n.priority}** | ${cell(n.action)} | ${cell(n.why || "—")} |`);
  }
}

const SEV_ORDER = ["Critical", "High", "Medium", "Low", "Informational"];

import { SCOPES, isScope, type ReportScope } from "./scopes";
import { pushAll } from "../util/arrays";
export { SCOPES, isScope, type ReportScope };

export function buildMarkdown(projectId: string, opts: { scope?: ReportScope; detail?: "concise" | "full"; deck?: boolean } = {}): string {
  const scope = opts.scope ?? "full";
  // The main report is condensed; every other scope, including the Complete Technical Report, keeps full detail.
  const concise = (opts.detail ?? (scope === "full" ? "concise" : "full")) === "concise";
  const { project, arch, docs, findings } = loadReportData(projectId);
  const brief = docs.brief ?? buildBrief(docs, arch, findings, project.name);
  const m = loadModel(projectId);
  const out: string[] = [];
  const built = new Map<string, { title: string; lines: string[] }>();
  /** Build one numbered section; the heading is added at assembly so scoped reports number sequentially. */
  const sec = (key: string, title: string, fn: () => void) => {
    const start = out.length;
    fn();
    built.set(key, { title, lines: out.splice(start) });
  };
  out.push(`# ${SCOPES[scope].title}`);
  out.push(`\n**${project.name}**${project.sourceUrl ? ` — ${project.sourceUrl}` : ""}${project.branch ? ` @ \`${project.branch}\`` : ""}${project.commit ? ` (\`${project.commit.slice(0, 10)}\`)` : ""}  `);
  out.push(`Generated ${new Date(docs.generatedAt).toISOString()} · ${docs.meta.aiUsed ? `AI-assisted (${docs.meta.provider ?? "provider"}, ${docs.meta.model ?? "model"})` : "deterministic (no AI provider)"}  `);
  out.push(`Statements are backed by repository evidence in the form \`path:line-range\`. Findings are labelled **static analyzer** (deterministic), **proved (Lean 4)** (a machine-checked counterexample) or **AI-inferred**, and **needs verification** where evidence is incomplete.\n`);

  if (concise) out.push(`_This is the condensed report. The **Complete Technical Report** contains every finding, file, symbol and map in full._\n`);

  sec("exec", "Executive Summary", () => {
    if (opts.deck) out.push("_The executive summary is presented as slides at the front of this document._\n");
    else briefMarkdown(out, brief);
    out.push(opts.deck ? "### Summary evidence\n" : "\n### Summary evidence\n");
    out.push("_The in-depth summary that the executive summary above was distilled from. Each statement links to the code that supports it._\n");
    for (const s of docs.executiveSummary) out.push(`${para(s)}\n`);
  });
  sec("glance", "System at a Glance", () => {  out.push("| Area | Description |\n| --- | --- |");
  for (const r of docs.atAGlance) out.push(`| ${cell(r.area)} | ${cell(r.description)} |`);
  });
  sec("arch", "Architecture Overview", () => {  for (const s of docs.architectureOverview.paragraphs) out.push(`${para(s)}\n`);
  if (arch.layers.length) out.push(`**Layers:** ${arch.layers.map((l) => `${l.name} (${l.files} files)`).join(" · ")}\n`);
  });
  sec("runtime", "Primary Runtime Flow", () => {  for (const s of docs.runtimeFlow.narrative) out.push(`${para(s)}\n`);
  docs.runtimeFlow.steps.forEach((s, i) => out.push(`${i + 1}. **${s.label}** — ${s.detail}${cite(s.evidence)}`));
  });
  sec("areas", "Major Functional Areas", () => {  out.push("_Each area is a capability delivered by several files working together. This is the macro view; folders are covered next and single files further below._\n");
  if (concise) {
    out.push("| Area | What it does | Files | Used by |\n| --- | --- | --- | --- |");
    for (const a of docs.areas) out.push(`| **${cell(a.name)}** | ${cell(short(a.purpose, 150))} | ${a.files.length} | ${cell(a.relationships.replace(/^Used by /, "").replace(/\.$/, "")) || "—"} |`);
    const mods = (docs.modules ?? []).slice(0, 14);
    if (mods.length) {
      out.push("\n**Folders:**\n", "| Folder | Files | What it is for |\n| --- | --- | --- |");
      for (const md of mods) out.push(`| \`${md.path}/\` | ${md.fileCount} | ${cell(short(md.purpose.replace(/^\S+ groups \d+ files? \([^)]*\): /, ""), 130))} |`);
    }
  } else for (const a of docs.areas) {
    out.push(`\n### ${a.name}\n`);
    out.push(`- **Purpose:** ${a.purpose}`);
    out.push(`- **Business function:** ${a.businessFunction}`);
    out.push(`- **Primary components:** ${a.components.slice(0, 8).map((c) => `\`${c.name}\` (${c.kind}, ${c.path}:${c.line})`).join("; ") || "none extracted"}`);
    out.push(`- **Inputs:** ${a.inputs}`);
    out.push(`- **Processing:** ${a.processing}`);
    out.push(`- **Outputs:** ${a.outputs}`);
    out.push(`- **Dependencies:** ${a.dependencies.join(", ") || "none"}`);
    out.push(`- **Failure modes:** ${a.failureModes.join("; ") || "none identified"}`);
    out.push(`- **Important relationships:** ${a.relationships}`);
    out.push(`- **Source of explanation:** ${a.origin === "ai" ? "AI-authored from indexed evidence" : "deterministic, derived from the repository graph"}${cite(a.evidence)}`);
  }
    if (!concise) {
    const mods = docs.modules ?? [];
    out.push("\n### Folders and modules (groups of files)\n");
      out.push("_These entries explain a folder as one unit: what it is for and how its files work together. Each file is explained on its own under File & Component Explanations._\n");
    if (mods.length === 0) { out.push("No folders containing several source files were found."); } else
    for (const m of mods.slice(0, 60)) {
      out.push(`\n#### \`${m.path}/\`\n`);
      out.push(`- **Purpose:** ${m.purpose}`);
      out.push(`- **How the files work together:** ${m.howFilesWork}`);
      out.push(`- **Files (${m.fileCount}, ${m.lines.toLocaleString()} lines):** ${m.files.slice(0, 10).map((f) => `\`${f.path.slice(m.path.length + 1)}\``).join(", ")}${m.fileCount > 10 ? `, and ${m.fileCount - 10} more` : ""}`);
      if (m.keyFiles.length) out.push(`- **Key files:** ${m.keyFiles.map((k) => `\`${k.path.slice(m.path.length + 1)}\` (${k.why})`).join("; ")}`);
      out.push(`- **What the rest of the system uses:** ${m.publicSurface.length ? m.publicSurface.slice(0, 6).map((p) => `\`${p.name}\` (${p.path}:${p.line})`).join("; ") : "no symbol is used from outside"}`);
      out.push(`- **Depends on:** ${[...m.dependsOn, ...m.externalPackages].join(", ") || "nothing outside"} · **Used by:** ${m.usedBy.join(", ") || "no other folder"}`);
      out.push(`- **Data in:** ${m.dataIn} · **Data out:** ${m.dataOut}`);
      if (m.findings.total) out.push(`- **Review findings:** ${m.findings.total} (${m.findings.top.join("; ")})`);
      if (m.tests.length) out.push(`- **Tests:** ${m.tests.join(", ")}`);
      out.push(`- **Source of explanation:** ${m.origin === "ai" ? "AI-authored from the file summaries and dependency graph" : "deterministic, derived from the dependency graph"}${cite(m.evidence)}`);
    }
  }
  });
  sec("flows", "Data Flow", () => {  if (docs.flows.length === 0) out.push("No end-to-end flows could be traced through the dependency graph.");
  for (const f of docs.flows.slice(0, 15)) {
    out.push(`\n### ${f.name}\n`);
    out.push(fence("text", f.steps.map((s) => s.label).join("\n   ↓\n")));
    out.push(`${f.narrative}${cite(f.evidence)}`);
    if (f.models.length || f.externals.length) out.push(`\nData touched: ${f.models.join(", ") || "none"}; external: ${f.externals.join(", ") || "none"}.`);
  }
  });
  sec("api", "API Architecture", () => {  for (const s of docs.apiArchitecture.paragraphs) out.push(`${para(s)}\n`);
  out.push(apiTable(arch, concise ? 40 : 200));
  });
  sec("data", "Data Architecture", () => {  for (const s of docs.dataArchitecture.paragraphs) out.push(`${para(s)}\n`);
  });
  sec("integrations", "External Integrations", () => {  if (docs.integrations.length === 0) out.push("No external services were detected.");
  else {
    out.push("| Service | Category | Where used | Why | If unavailable |\n| --- | --- | --- | --- | --- |");
    for (const i of docs.integrations) out.push(`| ${cell(i.name)} | ${cell(i.category)} | ${cell(i.where.slice(0, 3).map((w) => `\`${w}\``).join(", "))} | ${cell(i.why)} | ${cell(i.ifUnavailable)} |`);
  }
  });
  sec("infra", "Infrastructure & Deployment", () => {  for (const s of docs.infrastructure.paragraphs) out.push(`${para(s)}\n`);
  if (arch.envVars.length) {
    out.push("\n**Configuration (variable names only; values are never exported):**\n");
    out.push("| Variable | Sensitive | Read in | Declared in |\n| --- | --- | --- | --- |");
    for (const e of arch.envVars.slice(0, 60)) out.push(`| \`${e.name}\` | ${e.sensitive ? "yes" : "no"} | ${cell(e.files.slice(0, 2).map((f) => `${f.path}:${f.line}`).join(", "))} | ${cell(e.declaredIn.join(", "))} |`);
  }
  });
  sec("testing", "Testing Strategy", () => {  for (const s of docs.testing.paragraphs) out.push(`${para(s)}\n`);
  });
  sec("security", "Security Model", () => {  for (const s of docs.securityModel.paragraphs) out.push(`${para(s)}\n`);
  for (const b of docs.securityModel.bullets ?? []) out.push(`- ${para(b)}`);
  });
  sec("review", "Code Review", () => {  out.push(reviewSummary(findings, project, concise));
  const sorted = [...findings].sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity) || a.code.localeCompare(b.code));
  if (concise) {
    // A scannable table of every finding, and full detail only for the few that matter most.
    out.push("| ID | Severity | Finding | Where | Fix |\n| --- | --- | --- | --- | --- |");
    for (const f of sorted.slice(0, 40)) out.push(`| ${f.code} | ${f.severity} | ${cell(short(f.title, 90))} | ${cell(f.filePath ? `${f.filePath}${f.startLine ? `:${f.startLine}` : ""}` : "repository-wide")} | ${cell(short(f.remediation, 110))} |`);
    if (sorted.length > 40) out.push(`\n_${sorted.length - 40} more lower-priority findings are in the Complete Technical Report._`);
    const top = sorted.filter((f) => f.severity === "Critical" || f.severity === "High").slice(0, 5);
    if (top.length) {
      out.push("\n**The most important findings in brief:**\n");
      for (const f of top) out.push(`- **${f.code} ${f.title}.** ${short(f.businessImpact || f.whyItMatters, 220)} _Fix:_ ${short(f.remediation, 160)}`);
    }
  } else {
    for (const f of sorted.slice(0, 120)) out.push(findingMarkdown(f));
    if (sorted.length > 120) out.push(`\n_${sorted.length - 120} additional lower-priority findings are available in the JSON export._`);
  }
  });
  sec("risks", "Engineering Risks", () => {  for (const s of docs.risks.paragraphs) out.push(`${para(s)}\n`);
  for (const b of docs.risks.bullets ?? []) out.push(`- ${para(b)}`);
  if (docs.conflicts.length) {
    out.push("\n**Contradictions detected while synthesising this report:**\n");
    for (const c of docs.conflicts) out.push(`- **${c.subject}** — ${c.claims.join(" vs. ")}. Resolution (${c.preferred}): ${c.resolution}${cite(c.evidence)}`);
  }
  });
  sec("files", "File & Component Explanations", () => {  out.push("_Each entry explains one file on its own. How groups of files work together is in Major Functional Areas and Folder & Module Explanations._\n");
  if (concise) {
    out.push("| File | Role | What it does |\n| --- | --- | --- |");
    for (const f of docs.files.slice(0, 15)) out.push(`| \`${f.path}\` | ${cell(f.role)} | ${cell(short(f.purpose.replace(/^\S+ is (?:an? )?/, "").replace(/ Its documentation says:.*$/, ""), 150))} |`);
    if (docs.files.length > 15) out.push(`\n_The ${Math.min(15, docs.files.length)} most important of ${docs.files.length} documented files. The Complete Technical Report explains every file._`);
  } else for (const f of docs.files.slice(0, 120)) {
    out.push(`\n#### \`${f.path}\`\n`);
    out.push(`**Purpose.** ${f.purpose}\n`);
    if (f.responsibilities.length) out.push(`**Responsibilities:** ${f.responsibilities.join("; ")}\n`);
    if (f.keySymbols.length) out.push(`**Key symbols:** ${f.keySymbols.map((k) => `\`${k}\``).join(", ")}\n`);
    out.push(`**How it operates.** ${f.howItOperates}\n`);
    out.push(`**Called by:** ${f.calledBy.join(", ") || "no indexed importers"} · **Depends on:** ${f.dependsOn.join(", ") || "nothing indexed"}\n`);
    out.push(`**Data in:** ${f.dataIn} · **Data out:** ${f.dataOut}\n`);
    if (f.engineeringNotes.length) out.push(`**Engineering notes:** ${f.engineeringNotes.join(" ")}\n`);
  }
  });
  sec("symbols", "Detailed Symbol Explanations", () => {  if (concise) {
    out.push("| Symbol | Kind | Purpose | Used by |\n| --- | --- | --- | --- |");
    for (const s of docs.symbols.slice(0, 15)) out.push(`| \`${cell(s.name)}\` | ${s.kind} | ${cell(short(s.purpose, 130))} | ${s.usedBy.length ? `${s.usedBy.length} caller${s.usedBy.length === 1 ? "" : "s"}` : "none known"} |`);
    if (docs.symbols.length > 15) out.push(`\n_The 15 most important of ${docs.symbols.length} documented symbols. The Complete Technical Report explains every one._`);
  } else for (const s of docs.symbols.slice(0, 150)) {
    out.push(`\n#### \`${s.name}\` (${s.kind})\n`);
    out.push(`_${s.path}:${s.startLine}-${s.endLine}_ · \`${s.signature.slice(0, 140)}\`\n`);
    out.push(`- **Purpose:** ${s.purpose}`);
    out.push(`- **Inputs:** ${s.inputs}`);
    out.push(`- **Process:** ${s.process}`);
    out.push(`- **Outputs:** ${s.outputs}`);
    out.push(`- **Dependencies:** ${s.dependencies.join(", ") || "none indexed"}`);
    out.push(`- **Used by:** ${s.usedBy.join(", ") || "no known call sites"}`);
    if (s.businessMeaning) out.push(`- **Business meaning:** ${s.businessMeaning}`);
    out.push(`- **Important behavior:** ${s.importantBehavior}`);
  }
  });
  sec("recs", "Recommendations", () => {  docs.recommendations.forEach((r, i) => out.push(`${i + 1}. ${para(r)}`));
  });
  sec("codemap", "Detailed Code Map", () => {  out.push(codeMapMarkdown(projectId, project, arch, docs, findings, m, concise));
  });
  sec("legend", "Legend", () => {  out.push(fence("text", legendText()));
  });
  sec("qa", "Questions and answers", () => {
    const rows = getDb().select().from(schema.questions).where(eq(schema.questions.projectId, projectId)).orderBy(schema.questions.createdAt).all();
    if (rows.length === 0) out.push("_No questions have been asked of this repository yet._");
    for (const q of rows) {
      const a = q.answer as { answer?: string; mode?: string; confidence?: string; insufficientEvidence?: boolean; citations?: { path: string; startLine: number; endLine: number; note?: string }[]; notes?: string[] };
      out.push(`\n### ${q.question}\n`);
      out.push(`_${new Date(q.createdAt).toISOString()} · ${a.mode === "graph" ? "answered from the code graph" : a.mode === "ai" ? "AI answer" : "retrieval only"} · confidence ${a.confidence ?? "n/a"}${a.insufficientEvidence ? " · insufficient evidence" : ""}_\n`);
      out.push(`${a.answer ?? ""}\n`);
      if (a.citations?.length) out.push("**Evidence**\n", ...a.citations.map((c) => `- \`${c.path}:${c.startLine}${c.endLine !== c.startLine ? `-${c.endLine}` : ""}\`${c.note ? ` ${c.note}` : ""}`));
      if (a.notes?.length) out.push(`\n_${a.notes.join(" ")}_`);
    }
  });

  // Assemble the requested sections in order, numbering them sequentially.
  let n = 0;
  for (const key of SCOPES[scope].sections) {
    const sct = built.get(key);
    if (!sct) continue;
    n++;
    out.push(`\n## ${n}. ${sct.title}\n`);
    pushAll(out, sct.lines);
  }
  out.push("");
  return out.join("\n");
}

function apiTable(arch: Architecture, limit = 200): string {
  if (!arch.routes.length) return "_No HTTP routes detected._\n";
  const rows = arch.routes.slice(0, limit).map((r) => `| ${cell(r.method)} | \`${cell(r.path)}\` | ${cell(r.handler)} | ${r.auth === "authenticated" ? "Authenticated" : r.auth === "public" ? "Public" : "Not visible"} | ${cell(r.kind)} · ${cell(r.framework)} | \`${r.file}:${r.line}\` |`);
  return ["| Method | Route | Handler | Authentication | Kind | Location |", "| --- | --- | --- | --- | --- | --- |", ...rows].join("\n") + "\n";
}

function reviewSummary(findings: FindingRow[], project: ProjectRow, concise = false): string {
  const by = (k: (f: FindingRow) => string) => { const m = new Map<string, number>(); for (const f of findings) m.set(k(f), (m.get(k(f)) ?? 0) + 1); return m; };
  const sev = by((f) => f.severity);
  const cat = by((f) => f.category);
  const pipeline = ((project.analysis ?? {}) as { pipeline?: { analyzers?: { name: string; status: string; detail: string; findings: number }[]; ai?: { ran: boolean } } }).pipeline;
  const lines = [
    `${findings.length} finding(s): ${SEV_ORDER.map((s) => `${sev.get(s) ?? 0} ${s.toLowerCase()}`).join(", ")}. ${findings.filter((f) => f.origin === "static").length} from static analyzers, ${findings.filter((f) => f.origin === "formal").length ? `${findings.filter((f) => f.origin === "formal").length} proved by formal verification, ` : ""}${findings.filter((f) => f.origin === "ai").length} AI-inferred (${findings.filter((f) => f.origin === "ai" && f.verification !== "verified").length} need verification).\n`,
    `By category: ${[...cat.entries()].map(([k, v]) => `${k} ${v}`).join(" · ")}\n`,
  ];
  if (pipeline?.analyzers?.length && !concise) {
    lines.push("**Analyzers run:**\n", "| Analyzer | Status | Findings | Detail |", "| --- | --- | --- | --- |", ...pipeline.analyzers.map((a) => `| ${cell(a.name)} | ${cell(a.status)} | ${a.findings} | ${cell(a.detail)} |`), "");
    if (!pipeline.ai?.ran) lines.push("_AI review did not run because no provider was configured; only deterministic findings are shown._\n");
  }
  return lines.join("\n");
}

function findingMarkdown(f: FindingRow): string {
  const loc = f.filePath ? `${f.filePath}${f.startLine ? `:${f.startLine}${f.endLine && f.endLine !== f.startLine ? `-${f.endLine}` : ""}` : ""}` : "repository-wide";
  const lines = [
    `\n#### ${f.code} — ${f.title}\n`,
    `| Severity | Confidence | Category | Source | Status | Location |\n| --- | --- | --- | --- | --- | --- |\n| ${f.severity} | ${f.confidence} | ${f.category} | ${f.origin === "static" ? `Static analyzer (${f.analyzer ?? "n/a"})` : f.origin === "formal" ? "Proved (Lean 4)" : "AI-inferred"} | ${f.verification === "verified" ? "Verified" : "Needs verification"} | \`${loc}\` |\n`,
  ];
  if (f.evidence) lines.push("**Evidence**\n", fence("", f.evidence));
  lines.push(`**What happens.** ${f.whatHappens}\n`, `**Why it matters.** ${f.whyItMatters}\n`);
  if (f.businessImpact) lines.push(`**Business impact.** ${f.businessImpact}\n`);
  lines.push(`**Recommended remediation.** ${f.remediation}\n`);
  if (f.patch) lines.push("**Suggested patch** (validated against the current file)\n", fence("diff", f.patch));
  if (f.relatedComponents.length) lines.push(`**Related components:** ${f.relatedComponents.map((c) => `\`${c}\``).join(", ")}\n`);
  if (f.verificationNote) lines.push(`_Verification: ${f.verificationNote}_\n`);
  return lines.join("\n");
}

function codeMapMarkdown(projectId: string, project: ProjectRow, arch: Architecture, docs: DocReport, findings: FindingRow[], m: ReturnType<typeof loadModel>, concise = false): string {
  const out: string[] = [];
  const sub = (n: number, t: string) => out.push(`\n### ${n}. ${t}\n`);
  sub(1, "Repository Tree");
  out.push(fence("text", treeToText(repositoryTree(projectId), { name: project.name, depth: concise ? 2 : 3, maxChildren: concise ? 10 : 16 })));

  sub(2, "Functional Component Map");
  out.push(fence("text", architectureDiagramText(projectId)));
  const ag = areaGraph(projectId);
  out.push("\n**Functional-area dependencies:**\n");
  const areaLines = ag.edges.filter((e) => !e.target.startsWith("ext:")).sort((a, b) => b.weight - a.weight).slice(0, concise ? 10 : 30).map((e) => `- ${e.source} → ${e.target} (${e.weight} reference${e.weight > 1 ? "s" : ""})`);
  out.push(areaLines.join("\n") || "_No cross-area dependencies detected._");
  if (!concise) out.push("\n" + fence("mermaid", architectureMermaid(projectId)));

  sub(3, "Runtime / Data Flow Map");
  for (const f of docs.flows.slice(0, concise ? 4 : 8)) out.push(fence("text", `${f.name}\n` + f.steps.map((s) => `  ${glyphFor(s.kind === "model" ? "model" : s.kind === "endpoint" ? "api" : s.kind === "service" ? "service" : "util")} ${s.label}${s.path ? `  (${s.path}:${s.line ?? 1})` : ""}`).join("\n    ↓\n")));
  if (!docs.flows.length) out.push("_No flows traced._");

  sub(4, "Dependency Map");
  const mg = moduleGraph(projectId, { limit: 35 });
  if (concise) {
    out.push(`The ${Math.min(12, mg.nodes.length)} most important of ${mg.totalNodes} source files (the interactive map in the application shows all of them):\n`);
    for (const n of mg.nodes.slice(0, 12)) out.push(`- \`${n.label}\``);
  } else {
    out.push(`Top ${mg.nodes.length} of ${mg.totalNodes} source files by importance (drill down by area in the application).\n`);
    out.push(fence("mermaid", graphToMermaid(mg, "LR", { grouped: true })));
  }

  sub(5, "API Map");
  out.push(apiTable(arch));

  sub(6, "Data Model Map");
  if (arch.models.length) {
    out.push("| Model | Type | Fields | Points to | Location |\n| --- | --- | --- | --- | --- |");
    for (const md of arch.models.slice(0, concise ? 20 : 60)) {
      const fields = (md.fieldTypes?.length ? md.fieldTypes.map((f) => (f.type ? `${f.name}: ${f.type}` : f.name)) : md.fields).slice(0, concise ? 6 : 10);
      const points = md.relations?.length ? md.relations.map((r) => `${r.via} → ${r.targetName} [${r.cardinality === "many" ? "*" : r.cardinality === "optional" ? "0..1" : "1"}]`).join("; ") : md.references.join(", ");
      out.push(`| ${cell(md.name)} | ${cell(md.orm ?? md.kind)} | ${cell(fields.join(", "))} | ${cell(points || "—")} | \`${md.file}:${md.line}\` |`);
    }
    if (arch.models.length > (concise ? 20 : 60)) out.push(`\n_${arch.models.length - (concise ? 20 : 60)} more models are listed in the application._`);
    const er = concise ? undefined : erMermaid(projectId);
    if (er) out.push("\n" + fence("mermaid", er));
  } else out.push("_No data models detected._");

  sub(7, "Test Map");
  if (arch.tests.files.length) {
    out.push("| Test file | Kind | Framework | Exercises |\n| --- | --- | --- | --- |");
    for (const t of arch.tests.files.slice(0, concise ? 15 : 60)) out.push(`| \`${t.path}\` | ${t.kind} | ${cell(t.framework ?? "")} | ${cell(t.targets.slice(0, 4).join(", ") || "not resolved")} |`);
  } else out.push("_No tests found._");
  if (arch.tests.untestedCritical.length) out.push(`\n**Important components with no tests:**\n\n${arch.tests.untestedCritical.slice(0, 10).map((u) => `- \`${u.path}\` — ${u.reason}`).join("\n")}`);

  sub(8, "External Integration Map");
  if (arch.externalServices.length) {
    out.push(fence("text", arch.externalServices.map((s) => `${glyphFor("external")} ${s.name} (${s.category})\n     ⇠ ${s.evidence.slice(0, 3).map((e) => `${e.path}${e.line ? `:${e.line}` : ""}`).join(", ")}`).join("\n")));
  } else out.push("_No external services detected._");

  sub(9, "High-Risk Component Map");
  const risky = m.files.filter((f) => f.classification === "source" && !f.isTest && m.fileRisk.has(f.path)).map((f) => ({ f, risk: m.fileRisk.get(f.path)! as RiskLevel, n: findings.filter((x) => x.filePath === f.path).length })).sort((a, b) => ["none", "low", "medium", "high", "critical"].indexOf(b.risk) - ["none", "low", "medium", "high", "critical"].indexOf(a.risk) || b.f.importance - a.f.importance).slice(0, concise ? 8 : 20);
  if (risky.length) {
    out.push("| Risk | File | Role | Importance | Findings |\n| --- | --- | --- | --- | --- |");
    for (const r of risky) out.push(`| ${riskGlyph(r.risk)} ${r.risk} | \`${r.f.path}\` | ${r.f.role ?? ""} | ${r.f.importance.toFixed(2)} | ${r.n} |`);
  } else out.push("_No files carry findings above informational severity._");

  sub(10, "Change Impact Relationships");
  const tops = m.symbols.filter((s) => ["function", "method", "service", "class", "component", "hook"].includes(s.kind) && s.inboundCount > 0 && !m.filesByPath.get(s.filePath)?.isTest).sort((a, b) => b.importance - a.importance).slice(0, concise ? 2 : 6);
  if (tops.length) {
    for (const s of tops) {
      const imp = changeImpact(projectId, { type: "symbol", id: s.id });
      if (!imp) continue;
      out.push(`**${s.qualifiedName}** (${s.filePath}:${s.startLine}) — ${imp.summary}`);
      if (imp.chains.length) out.push(fence("text", imp.chains.map((c) => c.join("\n   ↓ used by\n")).join("\n\n")));
    }
  } else out.push("_Not enough cross-symbol relationships to derive impact chains._");

  sub(11, "Legend");
  out.push(fence("text", legendText()));
  void formatBytes;
  return out.join("\n");
}
