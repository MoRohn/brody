import { eq } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import type { FindingRow } from "../db/schema";
import { areaGraph, type GraphNode } from "../map";
import { layoutMap } from "../map/layout";
import { buildBrief } from "../docs/brief";
import { loadReportData } from "../export/markdown";
import { SCOPES } from "../export/scopes";
import { exposureFor, firstSentence, humanizeFlow, isExecutiveWording, issueFor, plainText, roleText, themeFor } from "./lexicon";

/**
 * The executive deck's content: a compact, business-level snapshot derived from the SAME stored analysis the report reads
 * (the brief, functional areas, findings, architecture and code-map lanes). Nothing here is analysed a second time; the
 * deck is a different view of the same facts, and every slide points back to the report section that holds the detail.
 * It is stored with the project by the "Building executive deck" stage, and laid out and rendered at export time.
 */
export type Risk = "none" | "low" | "medium" | "high" | "critical";
/** good: on track, watch: sound with gaps, act: needs attention. */
export type Status = "good" | "watch" | "act";
/** One line of the summary: a short figure, what it measures, and a sentence of evidence. */
export interface OverviewPoint { value: string; label: string; detail: string; status?: Status }
export interface Sev { critical: number; high: number; medium: number; low: number }

export interface DeckContent {
  version: 3;
  generatedAt: number;
  origin: "deterministic" | "ai";
  project: { name: string; source?: string; branch?: string; commit?: string };
  headline: string;
  summary: string;
  kpis: { label: string; value: string; note?: string }[];
  /** The one-page summary: what it means for the business, what it means for the team that builds it, and the first move. */
  overview: { business: OverviewPoint[]; engineering: OverviewPoint[]; firstMove: string };
  keyPoints: { title: string; detail: string }[];
  capabilities: { name: string; line: string; files: number; risk: Risk; role: string; usedBy: number }[];
  architecture: {
    pattern: string;
    lanes: { id: string; label: string; hint: string; areas: { name: string; files: number; risk: Risk }[] }[];
    links: { from: string; to: string; weight: number }[];
    foundation: { name: string; files: number }[];
  };
  tech: { languages: { name: string; share: number; files: number }[]; frameworks: string[]; stores: string[]; platform: string[]; footprint: { label: string; value: string }[] };
  flows: { name: string; path: string[]; externals: string[] }[];
  data: { models: number; relations: number; stores: string[]; entities: { name: string; fields: number; links: number }[] };
  integrations: { name: string; category: string; purpose: string; ifDown: string }[];
  scorecard: { key: string; name: string; status: Status; sev: Sev; evidence: string }[];
  quality: {
    total: number;
    level: Status;
    verdict: string;
    strengths: string[];
    severity: { label: string; count: number }[];
    themes: { theme: string; sev: Sev; exposure: string }[];
    areaRisk: { area: string; sev: Sev }[];
    priorities: { ref: string; severity: string; issue: string; exposure: string; area: string; count: number }[];
  };
  testing: { files: number; frameworks: string[]; coverage: { area: string; tested: number; total: number }[]; untestedCritical: number; readiness: { label: string; ok: boolean }[] };
  actions: { priority: "Now" | "Next" | "Later"; action: string; why: string; ref: string }[];
  coverage: { filesAnalysed: number; filesExcluded: number; sourceFiles: number; aiUsed: boolean; model?: string; confidence: string; sections: { ai: number; deterministic: number } };
  refs: { key: string; n: number; title: string }[];
}

/** Titles of the report's numbered sections, in the order the full report numbers them. */
const SECTION_TITLES: Record<string, string> = {
  exec: "Executive Summary", glance: "System at a Glance", arch: "Architecture Overview", runtime: "Primary Runtime Flow", areas: "Major Functional Areas",
  flows: "Data Flow", api: "API Architecture", data: "Data Architecture", integrations: "External Integrations", infra: "Infrastructure & Deployment",
  testing: "Testing Strategy", security: "Security Model", review: "Code Review", risks: "Engineering Risks", files: "File & Component Explanations",
  symbols: "Detailed Symbol Explanations", recs: "Recommendations", codemap: "Detailed Code Map", legend: "Legend",
};
export const reportRefs = (): DeckContent["refs"] => SCOPES.full.sections.map((key, i) => ({ key, n: i + 1, title: SECTION_TITLES[key] ?? key }));

const SEV_KEYS = ["critical", "high", "medium", "low"] as const;
const SEV_ORDER = ["Critical", "High", "Medium", "Low", "Informational"];
const emptySev = (): Sev => ({ critical: 0, high: 0, medium: 0, low: 0 });
const weight = (s: Sev) => s.critical * 10 + s.high * 5 + s.medium * 2 + s.low;
const bump = (s: Sev, severity: string) => { const k = severity.toLowerCase(); if ((SEV_KEYS as readonly string[]).includes(k)) s[k as keyof Sev]++; };
const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;
const sentence = (t: string) => (t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}` : t);

/** "receipt_queue" and "OrderItem" both become "Receipt queue" / "Order item". */
export const humanName = (s: string): string => sentence(s.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().trim());

const CATEGORY_LABEL: Record<string, string> = { payments: "Payments", database: "Data storage", cache: "Caching", email: "Email", queue: "Background work", ai: "Intelligent features", "developer-platform": "Developer platform", auth: "Sign-in", storage: "File storage", search: "Search", messaging: "Messaging", observability: "Monitoring", analytics: "Analytics", sms: "Text messages" };
const categoryLabel = (c: string) => CATEGORY_LABEL[c] ?? sentence(c.replace(/[-_]+/g, " "));

const SUPPORT_AREAS = new Set(["Documentation", "Testing", "Configuration"]);

export function buildDeckContent(projectId: string): DeckContent {
  const { project, arch, docs, findings } = loadReportData(projectId);
  const brief = docs.brief ?? buildBrief(docs, arch, findings, project.name);
  const areaOfFile = new Map<string, string>();
  for (const a of arch.areas) for (const p of a.files) areaOfFile.set(p, a.name);

  // ---- risk, computed once and shared by every slide that talks about it ------------------------------------------------
  const live = findings.filter((f) => f.verification !== "rejected");
  const riskByArea = new Map<string, Sev>();
  const total = emptySev();
  for (const f of live) {
    bump(total, f.severity);
    const area = (f.filePath && areaOfFile.get(f.filePath)) || "Across the system";
    const s = riskByArea.get(area) ?? emptySev();
    bump(s, f.severity);
    riskByArea.set(area, s);
  }
  const areaRisk = (name: string): Risk => { const s = riskByArea.get(name); return !s ? "none" : s.critical ? "critical" : s.high ? "high" : s.medium ? "medium" : s.low ? "low" : "none"; };

  // Findings of the same kind are one issue to an executive, however many places they occur.
  interface Group { issue: string; action: string; count: number; top: FindingRow; areas: Set<string>; theme: string }
  const groups = new Map<string, Group>();
  const sevIdx = (f: FindingRow) => { const i = SEV_ORDER.indexOf(f.severity); return i < 0 ? 9 : i; };
  for (const f of [...live].sort((a, b) => sevIdx(a) - sevIdx(b))) {
    if (sevIdx(f) > 3) continue;
    const { issue, action } = issueFor(f);
    const g = groups.get(issue);
    const area = (f.filePath && areaOfFile.get(f.filePath)) || "Across the system";
    if (g) { g.count++; g.areas.add(area); } else groups.set(issue, { issue, action, count: 1, top: f, areas: new Set([area]), theme: themeFor(f.category) });
  }
  const ranked = [...groups.values()].sort((a, b) => sevIdx(a.top) - sevIdx(b.top) || b.count - a.count);
  const priorities = ranked.slice(0, 6).map((g) => ({ ref: g.top.code, severity: g.top.severity, issue: g.issue, exposure: exposureFor(g.top), area: [...g.areas].slice(0, 2).join(", "), count: g.count }));

  const themeMap = new Map<string, { sev: Sev; top?: FindingRow }>();
  for (const f of live) {
    const t = themeFor(f.category);
    const e = themeMap.get(t) ?? { sev: emptySev() };
    bump(e.sev, f.severity);
    if (!e.top || sevIdx(f) < sevIdx(e.top)) e.top = f;
    themeMap.set(t, e);
  }
  const themes = [...themeMap.entries()].sort((a, b) => weight(b[1].sev) - weight(a[1].sev)).slice(0, 6).map(([theme, e]) => ({ theme, sev: e.sev, exposure: e.top ? exposureFor(e.top) : "" }));

  // Next steps: the most serious tier is "Now", the next "Next", everything else "Later".
  const tiers = [...new Set(ranked.map((g) => sevIdx(g.top)))].sort((a, b) => a - b);
  const actions = ranked.slice(0, 9).map((g) => {
    const tier = tiers.indexOf(sevIdx(g.top));
    return { priority: (tier === 0 ? "Now" : tier === 1 ? "Next" : "Later") as "Now" | "Next" | "Later", action: g.action, why: exposureFor(g.top), ref: g.top.code };
  });
  const perTier: Record<string, number> = {};
  const capped = actions.filter((a) => (perTier[a.priority] = (perTier[a.priority] ?? 0) + 1) <= 3);

  // ---- capabilities ------------------------------------------------------------------------------------------------------
  const purposeOf = new Map(docs.areas.map((a) => [a.name, a.purpose]));
  // Several areas can share a role; give each its own sentence rather than repeating the generic one.
  const usedLines = new Set<string>();
  const uniqueRoleLine = (a: { name: string; role: string }, _i: number, _all: unknown[]): string => {
    const generic = roleText(a.role);
    if (!usedLines.has(generic)) { usedLines.add(generic); return generic; }
    return `Supports ${a.name.toLowerCase()} across the system.`;
  };
  const capabilities = arch.areas
    .filter((a) => !SUPPORT_AREAS.has(a.name) && a.role !== "docs")
    .sort((a, b) => b.files.length - a.files.length)
    .slice(0, 8)
    .map((a, i, all) => {
      // With AI the brief already words each capability for a business reader; without it, say what kind of capability this is.
      const fromBrief = brief.origin === "ai" ? brief.capabilities.find((c) => c.startsWith(`${a.name}:`))?.slice(a.name.length + 1).trim() : undefined;
      const purpose = plainText(purposeOf.get(a.name) ?? a.description);
      return { name: a.name, line: firstSentence(fromBrief || (isExecutiveWording(purpose) ? purpose : uniqueRoleLine(a, i, all)), 110), files: a.files.length, risk: areaRisk(a.name), role: a.role, usedBy: a.usedBy.length };
    });

  // ---- architecture, from the same layered layout the Code Map uses ----------------------------------------------------
  const graph = areaGraph(projectId);
  const layout = layoutMap(graph, { mode: "area" });
  const nodeById = new Map<string, GraphNode>(graph.nodes.map((n) => [n.id, n]));
  const laneOf = new Map(layout.nodes.map((n) => [n.id, n.lane]));
  const lanes = layout.bands.filter((b) => !b.foundation).map((b) => ({
    id: b.id, label: b.label, hint: b.hint,
    areas: layout.nodes.filter((n) => n.lane === b.id).map((n) => nodeById.get(n.id)!).filter(Boolean)
      .sort((a, b2) => b2.size - a.size).map((n) => ({ name: n.type === "external" ? n.label : n.label, files: n.size, risk: (n.risk as Risk) ?? "none" })),
  }));
  const linkWeights = new Map<string, number>();
  for (const e of layout.edges) {
    const a = laneOf.get(e.source), b = laneOf.get(e.target);
    if (!a || !b || a === b || a === "foundation" || b === "foundation") continue;
    linkWeights.set(`${a}>${b}`, (linkWeights.get(`${a}>${b}`) ?? 0) + e.weight);
  }
  const links = [...linkWeights.entries()].map(([k, w]) => { const [from, to] = k.split(">"); return { from, to, weight: w }; });
  const foundation = layout.nodes.filter((n) => n.foundation).map((n) => nodeById.get(n.id)!).filter(Boolean).map((n) => ({ name: n.label, files: n.size }));

  // ---- technology ---------------------------------------------------------------------------------------------------------
  const langTotal = arch.stack.languages.reduce((a, l) => a + l.bytes, 0) || 1;
  const topLang = arch.stack.languages.slice(0, 5).map((l) => ({ name: l.name, share: l.bytes / langTotal, files: l.files }));
  const restShare = 1 - topLang.reduce((a, l) => a + l.share, 0);
  if (restShare > 0.005) topLang.push({ name: "Other", share: restShare, files: arch.stack.languages.slice(5).reduce((a, l) => a + l.files, 0) });
  const frameworks = [...new Set(arch.stack.frameworks.filter((f) => !["testing", "language", "build-tool"].includes(f.category)).map((f) => f.name))].slice(0, 8);
  const stats = arch.stats;
  const tech: DeckContent["tech"] = {
    languages: topLang, frameworks, stores: arch.stack.databases.slice(0, 5), platform: arch.stack.infrastructure.slice(0, 5),
    footprint: [
      { label: "Source files", value: (stats.sourceFiles ?? stats.files ?? 0).toLocaleString() },
      { label: "Lines of code", value: (stats.lines ?? 0).toLocaleString() },
      { label: "Automated test files", value: String(arch.tests.files.length) },
      { label: "Third-party components", value: String(stats.dependencies ?? arch.dependencies.length) },
      { label: "Configuration settings", value: String(arch.envVars.length) },
      { label: "Entry points", value: String(arch.entryPoints.filter((e) => e.kind !== "test-runner").length) },
    ],
  };

  // ---- how work moves: the areas a request passes through, then the outside systems it reaches ------------------------
  const seenFlow = new Set<string>();
  const flows: DeckContent["flows"] = [];
  const candidates = [...arch.flows].filter((f) => !/health|ping|status|ready/i.test(f.trigger)).sort((a, b) => b.steps.length - a.steps.length);
  for (const f of candidates) {
    const path: string[] = [];
    for (const s of f.steps) {
      const area = (s.path && areaOfFile.get(s.path)) || undefined;
      if (area && !path.includes(area)) path.push(area);
    }
    const name = humanizeFlow(f.name, f.trigger, f.kind);
    if (path.length < 2 || seenFlow.has(name)) continue;
    seenFlow.add(name);
    // The outside systems a request reaches: those the flow names, plus those whose integration code sits in files the request touches.
    const stepFiles = new Set(f.steps.map((s) => s.path).filter((p): p is string => !!p));
    const ext = [...new Set([...f.externals, ...arch.externalServices.filter((e) => e.evidence.some((ev) => stepFiles.has(ev.path))).map((e) => e.name)])];
    flows.push({ name, path: path.slice(0, 4), externals: ext.slice(0, 2) });
    if (flows.length === 4) break;
  }

  // ---- data and integrations ------------------------------------------------------------------------------------------------
  const relations = arch.models.reduce((a, m) => a + (m.relations?.length ?? m.references.length), 0);
  const entities = [...arch.models].sort((a, b) => (b.relations?.length ?? b.references.length) - (a.relations?.length ?? a.references.length) || b.fields.length - a.fields.length).slice(0, 6)
    .map((m) => ({ name: humanName(m.name), fields: m.fields.length, links: m.relations?.length ?? m.references.length }));
  const integrations = docs.integrations.slice(0, 8).map((i) => ({ name: i.name, category: categoryLabel(i.category), purpose: sentence(firstSentence(i.why, 80)), ifDown: sentence(firstSentence(i.ifUnavailable, 90)) }));

  // Operational readiness: each check is "no finding of that kind", so it always agrees with the report.
  const has = (issue: string) => live.some((f) => issueFor(f).issue === issue);
  const readiness = [
    { label: "Automated tests exist", ok: arch.tests.files.length > 0 },
    { label: "The most relied-upon code is tested", ok: arch.tests.untestedCritical.length === 0 && !has("Too little automated testing") },
    { label: "Tests and builds run automatically", ok: !has("No automated build and test routine") },
    { label: "The system can report that it is healthy", ok: !has("No way to confirm the system is healthy") },
    { label: "Settings are documented", ok: !has("Settings are not documented") },
    { label: "No credentials found in the code", ok: arch.secrets.length === 0 && !has("Credentials exposed in the code") },
  ];

  const apiRoutes = arch.routes.filter((r) => r.kind === "api");
  const kpiNote = (label: string): string | undefined => {
    switch (label) {
      case "Source files": return `${plural(arch.stack.languages.length, "language")}`;
      case "Lines of code": { const n = arch.stats.sourceFiles || 1; return `about ${Math.round((arch.stats.lines ?? 0) / n).toLocaleString()} per file`; }
      case "Main languages": return topLang[0] ? `${Math.round(topLang[0].share * 100)}% ${topLang[0].name}` : undefined;
      case "Functional areas": return "distinct capabilities";
      case "API routes": { const n = apiRoutes.filter((r) => r.auth === "authenticated").length; return n ? `${n} check who is calling` : undefined; }
      case "Data models": return relations ? plural(relations, "relationship") : undefined;
      case "External services": return arch.externalServices.slice(0, 2).map((e) => e.name).join(", ") || undefined;
      case "Critical or high findings": return `of ${plural(live.length, "finding")} in total`;
      default: return undefined;
    }
  };

  const coverage = Object.entries(arch.tests.coverageByArea).filter(([, v]) => v.total > 0).map(([area, v]) => ({ area, tested: v.tested, total: v.total })).sort((a, b) => b.total - a.total).slice(0, 8);

  // ---- health scorecard: six dimensions an executive asks about, each rated from the same findings the report lists -------
  const DIMENSIONS: { key: string; name: string; categories: string[] }[] = [
    { key: "security", name: "Security and data protection", categories: ["Security"] },
    { key: "reliability", name: "Reliability", categories: ["Reliability", "Correctness", "Data"] },
    { key: "quality", name: "Quality assurance", categories: ["Testing"] },
    { key: "maintain", name: "Maintainability", categories: ["Maintainability", "Architecture", "API Design"] },
    { key: "ops", name: "Operational readiness", categories: ["Operations", "Performance"] },
    { key: "delivery", name: "Third-party and delivery", categories: ["Dependencies"] },
  ];
  // The same rule the report's executive summary uses: a critical issue needs attention, a high one is worth fixing soon.
  const statusOf = (s: Sev): Status => (s.critical > 0 ? "act" : s.high > 0 || s.medium >= 3 ? "watch" : "good");
  const scorecard = DIMENSIONS.map((d) => {
    const mine = live.filter((f) => d.categories.includes(f.category));
    const sev = emptySev();
    for (const f of mine) bump(sev, f.severity);
    let status = statusOf(sev);
    const top = [...mine].sort((a, b) => sevIdx(a) - sevIdx(b))[0];
    let evidence = top ? exposureFor(top) : "No significant issues were found.";
    if (d.key === "quality") {
      if (arch.tests.files.length === 0) { status = "act"; evidence = "No automated tests were found."; }
      else if (arch.tests.untestedCritical.length > 0 && status === "good") { status = "watch"; evidence = `${plural(arch.tests.untestedCritical.length, "important file")} not covered by tests.`; }
    }
    return { key: d.key, name: d.name, status, sev, evidence };
  });
  const level: Status = statusOf(total);

  // ---- the one-page summary: the same facts, framed for the business and for engineering -------------------------------------
  const seriousCount = total.critical + total.high;
  const nameList = (xs: string[]) => xs.join(", ").replace(/, ([^,]*)$/, " and $1");
  const topIssue = priorities[0];
  const areaTotal = brief.metrics.find((m) => m.label === "Functional areas")?.value ?? String(capabilities.length);
  const worst = scorecard.filter((d) => d.status === "act"), watching = scorecard.filter((d) => d.status === "watch");
  const onTrack = scorecard.filter((d) => d.status === "good").length;
  const missing = readiness.filter((r) => !r.ok).map((r) => r.label);
  const firstAction = capped.find((a) => a.priority === "Now") ?? capped[0];
  const overview: DeckContent["overview"] = {
    business: [
      { value: areaTotal, label: "Capabilities it delivers", detail: capabilities.length ? `Led by ${nameList(capabilities.slice(0, 3).map((a) => a.name))}.` : "No distinct capabilities were identified." },
      integrations.length
        ? { value: String(integrations.length), label: integrations.length === 1 ? "Outside service it relies on" : "Outside services it relies on", detail: `${nameList(integrations.slice(0, 3).map((i) => i.name))}. If ${integrations[0].name} is unavailable: ${integrations[0].ifDown.replace(/\.$/, "").replace(/^(\w)/, (m) => m.toLowerCase())}.` }
        : { value: "0", label: "Outside services it relies on", detail: "It runs on its own, so a partner outage cannot stop it." },
      seriousCount
        ? { value: String(seriousCount), label: seriousCount === 1 ? "Serious issue to resolve" : "Serious issues to resolve", detail: topIssue ? `Biggest: ${topIssue.issue.charAt(0).toLowerCase()}${topIssue.issue.slice(1)}. ${topIssue.exposure}` : `${total.critical} critical and ${total.high} high.`, status: total.critical ? "act" : "watch" }
        : { value: "0", label: "Serious issues", detail: live.length ? `${plural(live.length, "smaller finding")} to tidy up over time.` : "Nothing serious was found.", status: "good" },
    ],
    engineering: [
      { value: (stats.sourceFiles ?? 0).toLocaleString(), label: "Source files to maintain", detail: `${sentence(arch.pattern.label)}${frameworks.length ? `, built with ${nameList(frameworks.slice(0, 3))}` : ""}; ${(stats.lines ?? 0).toLocaleString()} lines, mostly ${topLang[0]?.name ?? "one language"}.` },
      { value: `${onTrack} of ${scorecard.length}`, label: "Health checks on track", detail: worst.length ? `Needs attention: ${nameList(worst.map((d) => d.name.toLowerCase()))}.${watching.length ? ` To watch: ${nameList(watching.map((d) => d.name.toLowerCase()))}.` : ""}` : watching.length ? `To watch: ${nameList(watching.map((d) => d.name.toLowerCase()))}.` : "No area needs attention.", status: worst.length ? "act" : watching.length ? "watch" : "good" },
      { value: `${readiness.length - missing.length} of ${readiness.length}`, label: "Delivery basics in place", detail: missing.length ? `Not yet in place: ${missing.slice(0, 2).map((m) => m.charAt(0).toLowerCase() + m.slice(1)).join("; ")}${missing.length > 2 ? `; ${missing.length - 2} more` : ""}.` : `${plural(arch.tests.files.length, "automated test file")}, and the checks that keep releases safe are in place.`, status: missing.length > 2 ? "act" : missing.length ? "watch" : "good" },
    ],
    firstMove: firstAction ? `${firstAction.action}.` : "Nothing is urgent; keep the current routine and revisit after the next major change.",
  };

  return {
    version: 3,
    generatedAt: Date.now(),
    origin: brief.origin,
    project: { name: project.name, source: project.sourceUrl ?? undefined, branch: project.branch ?? undefined, commit: project.commit ? project.commit.slice(0, 10) : undefined },
    headline: firstSentence(brief.headline.replace(new RegExp(`^${project.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*`), ""), 170),
    summary: plainText(brief.summary),
    kpis: brief.metrics.map((m) => ({ label: m.label, value: m.value, note: kpiNote(m.label) })),
    overview,
    keyPoints: [
      { title: "How it is built", detail: `${sentence(arch.pattern.label)}${frameworks.length ? `, built with ${frameworks.slice(0, 3).join(", ").replace(/, ([^,]*)$/, " and $1")}` : ""}. ${(stats.sourceFiles ?? 0).toLocaleString()} source files, mostly ${topLang[0]?.name ?? "one language"}.` },
      { title: "What it does", detail: `${brief.metrics.find((m) => m.label === "Functional areas")?.value ?? capabilities.length} functional areas, led by ${capabilities.slice(0, 3).map((a) => a.name).join(", ").replace(/, ([^,]*)$/, " and $1") || "its main capabilities"}.` },
      { title: "Where the risk is", detail: plainText(brief.health.verdict) },
    ],
    capabilities,
    architecture: { pattern: sentence(arch.pattern.label), lanes, links, foundation },
    tech, flows,
    data: { models: arch.models.length, relations, stores: arch.stack.databases.slice(0, 4), entities },
    integrations,
    scorecard,
    quality: {
      total: live.length, level, verdict: plainText(brief.health.verdict), strengths: brief.health.strengths.map((s) => plainText(s)).slice(0, 4),
      severity: [{ label: "Critical", count: total.critical }, { label: "High", count: total.high }, { label: "Medium", count: total.medium }, { label: "Low", count: total.low }],
      themes, areaRisk: [...riskByArea.entries()].sort((a, b) => weight(b[1]) - weight(a[1])).slice(0, 6).map(([area, sev]) => ({ area, sev })), priorities,
    },
    testing: { files: arch.tests.files.length, frameworks: arch.tests.frameworks.slice(0, 4), coverage, untestedCritical: arch.tests.untestedCritical.length, readiness },
    actions: capped,
    coverage: { filesAnalysed: stats.files ?? project.fileCount, filesExcluded: stats.excluded ?? 0, sourceFiles: stats.sourceFiles ?? 0, aiUsed: docs.meta.aiUsed, model: docs.meta.model, confidence: arch.pattern.confidence, sections: { ai: docs.meta.aiSections, deterministic: docs.meta.deterministicSections } },
    refs: reportRefs(),
  };
}

/** The stored deck content, built (and saved) on first use for projects analysed before the deck existed. */
export function ensureDeckContent(projectId: string): DeckContent {
  const db = getDb();
  const p = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  const stored = (p?.analysis as { deck?: DeckContent } | null)?.deck;
  if (stored?.version === 3) return stored;
  const deck = buildDeckContent(projectId);
  saveDeckContent(projectId, deck);
  return deck;
}

export function saveDeckContent(projectId: string, deck: DeckContent): void {
  const db = getDb();
  const cur = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!cur) return;
  db.update(schema.projects).set({ analysis: { ...(cur.analysis ?? {}), deck } }).where(eq(schema.projects.id, projectId)).run();
}

