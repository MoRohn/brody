/**
 * The fix-it prompt: every issue the review found, condensed and ordered, with its fix, as one Markdown document a user
 * can paste into any AI coding assistant (Claude Code, Cursor, Copilot, ChatGPT) to resolve them.
 *
 * Built deterministically from the stored findings, so it is instant, costs nothing and says exactly what Brody found:
 *  - rejected findings are never included; findings that still need verification are marked so the assistant checks
 *    them before changing anything;
 *  - findings that describe the same problem (same title, category and severity) are merged into one issue with every
 *    location, so the assistant fixes a pattern once instead of reading it ten times;
 *  - each issue carries what happens, why it matters, the fix, Brody's validated patch when there is one, and the cited
 *    evidence, so the assistant can find and confirm it;
 *  - around the issues, ground rules (confirm first, smallest change, a regression test, no unrelated edits) and the
 *    report Brody expects back.
 */
import { and, eq, ne } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import type { FindingRow } from "../db/schema";
import type { Architecture } from "../discover/types";
import { redactSecrets } from "../ingest/secrets";

export const SEVERITIES = ["Critical", "High", "Medium", "Low", "Informational"] as const;

export interface FixPromptOptions {
  /** Severities to include; default: all. */
  severities?: string[];
  categories?: string[];
  origins?: string[];
  areas?: string[];
  /** Free-text filter, the same as the Code Review search box. */
  q?: string;
  /** Include findings that still need verification (marked as such). Default true. */
  includeUnverified?: boolean;
  /** Include Brody's validated patches. Default true. */
  includePatches?: boolean;
  /** Include the cited evidence lines. Default true. */
  includeEvidence?: boolean;
}

export interface FixIssue {
  n: number;
  title: string;
  severity: string;
  category: string;
  codes: string[];
  locations: string[];
  verified: boolean;
  findings: FindingRow[];
}

export interface FixPrompt {
  markdown: string;
  fileName: string;
  issues: FixIssue[];
  stats: { findings: number; issues: number; files: number; verified: number; needsVerification: number; bySeverity: Record<string, number>; patches: number; approxTokens: number };
}

const rank = (s: string) => { const i = (SEVERITIES as readonly string[]).indexOf(s); return i < 0 ? SEVERITIES.length : i; };
const LANG: Record<string, string> = { ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", py: "python", go: "go", rb: "ruby", rs: "rust", java: "java", cs: "csharp", php: "php", sql: "sql", yaml: "yaml", yml: "yaml", json: "json", sh: "bash", md: "markdown", prisma: "prisma", graphql: "graphql", css: "css", html: "html" };
const langOf = (p: string | null) => LANG[(p ?? "").split(".").pop()?.toLowerCase() ?? ""] ?? "";
const locationOf = (f: FindingRow) => (f.filePath ? `${f.filePath}${f.startLine ? `:${f.startLine}${f.endLine && f.endLine !== f.startLine ? `-${f.endLine}` : ""}` : ""}` : "repository-wide");
/** Markdown-safe single line: no stray backticks or table pipes from repository text. */
const inline = (s: string) => s.replace(/\r?\n+/g, " ").replace(/\|/g, "\\|").trim();
/** A fenced block whose fence cannot be closed by the content. */
function fence(body: string, lang = ""): string {
  const ticks = "`".repeat(Math.max(3, ...(body.match(/`+/g) ?? []).map((m) => m.length + 1)));
  return `${ticks}${lang}\n${body.replace(/\s+$/, "")}\n${ticks}`;
}
function clip(text: string, maxLines: number): string {
  const lines = text.replace(/\r/g, "").split("\n");
  return lines.length <= maxLines ? text : `${lines.slice(0, maxLines).join("\n")}\n… (${lines.length - maxLines} more lines)`;
}

export function selectFindings(projectId: string, o: FixPromptOptions = {}): FindingRow[] {
  const rows = getDb().select().from(schema.findings).where(and(eq(schema.findings.projectId, projectId), ne(schema.findings.verification, "rejected"))).all();
  const q = o.q?.trim().toLowerCase();
  return rows.filter((f) =>
    (!o.severities?.length || o.severities.includes(f.severity)) &&
    (!o.categories?.length || o.categories.includes(f.category)) &&
    (!o.origins?.length || o.origins.includes(f.origin)) &&
    (!o.areas?.length || (f.area !== null && o.areas.includes(f.area))) &&
    (o.includeUnverified !== false || f.verification === "verified") &&
    (!q || `${f.code} ${f.title} ${f.filePath ?? ""} ${f.whatHappens} ${f.category}`.toLowerCase().includes(q)));
}

const STOP = new Set(["the", "and", "for", "with", "that", "this", "which", "when", "from", "into", "can", "cannot", "never", "not", "are", "its", "any", "all", "has", "have", "was", "but", "per", "even", "only", "without", "via", "own"]);
/** Content words of a title, crudely stemmed so "packer", "packing" and "packed" meet. */
export function titleWords(t: string): Set<string> {
  return new Set(t.toLowerCase().replace(/-/g, "").split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/(ing|ers|er|ed|es|s)$/, "")).filter((w) => w.length > 2));
}
const jaccard = (a: Set<string>, b: Set<string>) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n / Math.max(1, a.size + b.size - n); };
const overlap = (a: FindingRow, b: FindingRow) => !!a.filePath && a.filePath === b.filePath && (a.startLine ?? 0) <= (b.endLine ?? b.startLine ?? 0) && (b.startLine ?? 0) <= (a.endLine ?? a.startLine ?? 0);

/**
 * Merge findings that describe the same problem: the same title, or overlapping lines of one file described in similar
 * words (different review passes often word one problem differently). Order by severity, then by how widespread.
 */
export function condense(findings: FindingRow[]): FixIssue[] {
  const parent = findings.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const words = findings.map((f) => titleWords(f.title));
  const norm = findings.map((f) => f.title.toLowerCase().replace(/\s+/g, " ").trim());
  for (let i = 0; i < findings.length; i++) for (let j = i + 1; j < findings.length; j++) {
    const same = norm[i] === norm[j] && findings[i].category === findings[j].category;
    // 0.3 was calibrated on real review output: rewordings of one problem score 0.38 and above, distinct problems on the
    // same lines about 0.2. When in doubt, two issues stay two issues.
    if (same || (overlap(findings[i], findings[j]) && jaccard(words[i], words[j]) >= 0.3)) parent[find(j)] = find(i);
  }
  const groups = new Map<number, FindingRow[]>();
  findings.forEach((f, i) => (groups.get(find(i)) ?? groups.set(find(i), []).get(find(i))!).push(f));
  return [...groups.values()]
    // The most severe, best-verified report leads; the others follow it.
    .map((fs) => fs.sort((a, b) => rank(a.severity) - rank(b.severity) || (a.verification === "verified" ? -1 : 0) - (b.verification === "verified" ? -1 : 0) || (a.filePath ?? "").localeCompare(b.filePath ?? "") || (a.startLine ?? 0) - (b.startLine ?? 0)))
    .sort((a, b) => rank(a[0].severity) - rank(b[0].severity) || b.length - a.length || a[0].code.localeCompare(b[0].code))
    .map((fs, i) => ({ n: i + 1, title: fs[0].title, severity: fs[0].severity, category: [...new Set(fs.map((f) => f.category))].join(", "), codes: fs.map((f) => f.code), locations: [...new Set(fs.map(locationOf))], verified: fs.some((f) => f.verification === "verified"), findings: fs }));
}

export function buildFixPrompt(projectId: string, o: FixPromptOptions = {}): FixPrompt {
  const db = getDb();
  const project = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  const name = project ? `${project.owner ? `${project.owner}/` : ""}${project.name}` : "this repository";
  const arch = ((project?.analysis ?? {}) as { architecture?: Architecture }).architecture;
  const languages = Object.entries(project?.languages ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([l]) => l);
  const findings = selectFindings(projectId, o);
  const issues = condense(findings);
  const includePatches = o.includePatches !== false;
  const includeEvidence = o.includeEvidence !== false;
  const bySeverity: Record<string, number> = {};
  for (const i of issues) bySeverity[i.severity] = (bySeverity[i.severity] ?? 0) + 1;
  const files = new Set(findings.map((f) => f.filePath).filter(Boolean));
  const verified = findings.filter((f) => f.verification === "verified").length;
  const today = new Date().toISOString().slice(0, 10);

  const out: string[] = [];
  out.push(`# Fix the issues Brody found in ${name}`);
  out.push("");
  out.push(`> Generated by Brody on ${today} from ${findings.length} finding${findings.length === 1 ? "" : "s"} (${verified} verified), condensed into ${issues.length} issue${issues.length === 1 ? "" : "s"} across ${files.size} file${files.size === 1 ? "" : "s"}. Paste this whole document into your AI coding assistant with the repository open.`);
  out.push("");
  out.push("## Your task");
  out.push("");
  out.push(`You are a senior software engineer working in the repository **${name}**${languages.length ? ` (${languages.join(", ")}` : ""}${arch?.pattern?.label ? `${languages.length ? "; " : " ("}${arch.pattern.label}` : ""}${languages.length || arch?.pattern?.label ? ")" : ""}. Brody, a repository analysis tool, reviewed it with static analyzers, AI review passes${findings.some((f) => f.origin === "formal") ? " and Lean 4 proofs" : ""}, and checked each finding against the source. Fix the issues listed below.`);
  out.push("");
  out.push("## Ground rules");
  out.push("");
  out.push("1. Work through the issues in order. They are sorted by severity, then by how widespread they are.");
  out.push("2. Before you change anything, open the cited lines and confirm the issue is real and still present. If it is not, say so and move on: never invent a fix. Issues marked **Needs verification** are likely but not confirmed, so check those with extra care.");
  out.push("3. Fix the root cause with the smallest change that does it. Keep public interfaces and behaviour the same unless the fix needs otherwise, and explain any behaviour change.");
  out.push("4. When an issue lists several locations, fix every one, and look for the same pattern elsewhere.");
  out.push("5. Do not reformat files, rename things or edit unrelated code. Do not add a dependency without saying why it is needed.");
  out.push("6. Add or update a test that fails before your fix and passes after it, wherever the project has tests.");
  out.push("7. Never put secrets, keys or credentials in code. Read them from configuration.");
  out.push("8. When you finish, run the project's build, linter and tests, and fix anything you broke.");
  if (includePatches) out.push("9. A **suggested patch** has been checked to apply cleanly to the file as Brody saw it. Use it as a starting point, not as a substitute for understanding the issue.");
  out.push("");
  out.push("## Summary");
  out.push("");
  if (!issues.length) out.push("Brody found no open issues matching the chosen options. There is nothing to fix.");
  else {
    out.push("| Severity | Issues | Findings |");
    out.push("| --- | ---: | ---: |");
    for (const s of SEVERITIES) if (bySeverity[s]) out.push(`| ${s} | ${bySeverity[s]} | ${issues.filter((i) => i.severity === s).reduce((a, i) => a + i.findings.length, 0)} |`);
    out.push("");
    const perFile = new Map<string, number>();
    for (const f of findings) if (f.filePath) perFile.set(f.filePath, (perFile.get(f.filePath) ?? 0) + 1);
    const top = [...perFile].sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (top.length) out.push(`Most affected files: ${top.map(([p, n]) => `\`${p}\` (${n})`).join(", ")}.`);
    out.push("");
    out.push("| # | Severity | Issue | Category | Where |");
    out.push("| ---: | --- | --- | --- | --- |");
    for (const i of issues) out.push(`| ${i.n} | ${i.severity} | ${inline(i.title)} | ${i.category} | ${i.locations.length === 1 ? `\`${i.locations[0]}\`` : `${i.locations.length} locations`} |`);
  }
  out.push("");
  if (issues.length) {
    out.push("## Issues");
    for (const i of issues) {
      const f = i.findings[0];
      out.push("");
      out.push(`### ${i.n}. [${i.severity}] ${inline(i.title)}`);
      out.push("");
      out.push(`- **IDs:** ${i.codes.join(", ")} · **Category:** ${i.category} · **Status:** ${i.findings.every((x) => x.verification === "verified") ? "Verified" : i.verified ? "Partly verified: confirm the unverified reports" : "Needs verification: confirm before changing"} · **Source:** ${[...new Set(i.findings.map((x) => (x.origin === "static" ? `static analyzer${x.analyzer ? ` (${x.analyzer})` : ""}` : x.origin === "formal" ? "proved with Lean 4" : "AI review, checked against the source")))].join("; ")}`);
      out.push(`- **Where:** ${i.locations.slice(0, 12).map((l) => `\`${l}\``).join(", ")}${i.locations.length > 12 ? `, and ${i.locations.length - 12} more` : ""}`);
      out.push(`- **Problem:** ${inline(redactSecrets(f.whatHappens))}`);
      out.push(`- **Why it matters:** ${inline(redactSecrets(f.whyItMatters))}${f.businessImpact ? ` ${inline(redactSecrets(f.businessImpact))}` : ""}`);
      out.push(`- **Fix:** ${inline(redactSecrets(f.remediation))}`);
      // Other reports of the same problem keep their own description and fix, so condensing loses nothing.
      const others = i.findings.slice(1).filter((x) => x.title.toLowerCase() !== f.title.toLowerCase());
      if (others.length) {
        out.push(`- **Also reported as:**`);
        for (const x of others) out.push(`  - ${x.code} (${x.severity}, ${x.category}) at \`${locationOf(x)}\`: ${inline(x.title)}. Fix: ${inline(redactSecrets(x.remediation))}`);
      }
      out.push(`- **Done when:** the problem no longer occurs at ${i.locations.length > 1 ? "every listed location" : "this location"}${i.severity === "Critical" || i.severity === "High" ? ", a test proves it" : ""}, and nothing else changes behaviour.`);
      if (includeEvidence) {
        const ev = i.findings.find((x) => x.evidence?.trim());
        if (ev?.evidence) { out.push(""); out.push(`Evidence (\`${locationOf(ev)}\`):`); out.push(""); out.push(fence(clip(redactSecrets(ev.evidence), 12), langOf(ev.filePath))); }
      }
      if (includePatches) {
        const p = i.findings.find((x) => x.patch?.trim());
        if (p?.patch) { out.push(""); out.push(`Suggested patch (\`${locationOf(p)}\`):`); out.push(""); out.push(fence(clip(redactSecrets(p.patch), 40), "diff")); }
      }
    }
    out.push("");
  }
  out.push("## When you finish");
  out.push("");
  out.push("Reply with:");
  out.push("");
  out.push("1. For each issue, its number and IDs and one of: **Fixed**, **Already fixed**, **Not an issue** (with the reason), or **Needs a decision** (with the question).");
  out.push("2. The files you changed, and the tests you added or updated.");
  out.push("3. Anything you could not fix, and why.");
  out.push("");
  const markdown = out.join("\n");
  const slug = (project?.name ?? "repository").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repository";
  return {
    markdown,
    fileName: `${slug}-fix-prompt.md`,
    issues,
    stats: { findings: findings.length, issues: issues.length, files: files.size, verified, needsVerification: findings.length - verified, bySeverity, patches: issues.filter((i) => i.findings.some((x) => x.patch)).length, approxTokens: Math.round(markdown.length / 4) },
  };
}
