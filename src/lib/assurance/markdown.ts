import { SENSITIVITY_LABEL } from "./pii";
import type { Control, FindingRef, PrivacyAssessment, SecurityAssessment } from "./types";

/** Report sections for the Security Assessment and the Privacy & PII Review. Each part is a titled block of Markdown. */
export interface Part { key: string; title: string; lines: string[] }

const cell = (s: string | number | null | undefined) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const at = (p: { path: string; line?: number }) => `\`${p.path}${p.line ? `:${p.line}` : ""}\``;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const CONTROL_STATUS: Record<Control["status"], string> = { present: "In place", partial: "Partial", missing: "Not found", gap: "Weakness found", na: "Not applicable" };
const SOURCE = (f: FindingRef) => (f.origin === "static" ? "Static analyzer" : f.origin === "formal" ? "Proved (Lean 4)" : "AI-inferred") + (f.verification === "verified" ? "" : ", needs verification");

function controlsTable(controls: Control[], out: string[]): void {
  out.push("| Control | Status | What was found | Evidence |", "| --- | --- | --- | --- |");
  for (const c of controls) out.push(`| ${cell(c.name)} | **${CONTROL_STATUS[c.status]}** | ${cell(c.detail)} | ${c.evidence.length ? c.evidence.slice(0, 2).map(at).join(", ") : "—"} |`);
}

function findingsTable(list: FindingRef[], out: string[], limit: number, withClass = true): void {
  if (!list.length) { out.push("_No findings in this area._"); return; }
  out.push(withClass ? "| ID | Severity | Finding | OWASP | CWE | Source | Location |\n| --- | --- | --- | --- | --- | --- | --- |" : "| ID | Severity | Finding | Source | Location |\n| --- | --- | --- | --- | --- |");
  for (const f of list.slice(0, limit)) out.push(withClass ? `| ${f.code} | ${f.severity} | ${cell(f.title)} | ${f.owasp ?? "—"} | ${f.cwe ?? "—"} | ${SOURCE(f)} | \`${cell(f.location)}\` |` : `| ${f.code} | ${f.severity} | ${cell(f.title)} | ${SOURCE(f)} | \`${cell(f.location)}\` |`);
  if (list.length > limit) out.push(`\n_${list.length - limit} more are listed in the Code Review._`);
}

export function securityParts(a: SecurityAssessment, concise = false): Part[] {
  const parts: Part[] = [];
  const part = (key: string, title: string, fn: (out: string[]) => void) => { const lines: string[] = []; fn(lines); parts.push({ key, title, lines }); };

  part("sa-summary", "Security Posture Summary", (out) => {
    out.push(`> **Overall security risk: ${a.rating}**\n`);
    for (const r of a.rationale) out.push(`- ${r}`);
    const c = a.counts;
    out.push("", "| Critical | High | Medium | Low | Informational | Verified | Needs verification |", "| --- | --- | --- | --- | --- | --- | --- |", `| **${c.Critical}** | **${c.High}** | **${c.Medium}** | **${c.Low}** | **${c.Informational}** | ${c.verified} | ${c.needsVerification} |`, "");
    out.push("_The rating follows the most severe confirmed issues: **Critical** when any critical issue exists, **High** for confirmed high-severity issues, **Elevated** for unconfirmed high or several medium issues, **Moderate** for medium or many low issues, and **Low** otherwise. It is a triage aid, not a certification._");
  });

  part("sa-surface", "Attack Surface", (out) => {
    const s = a.surface;
    out.push("| Exposure | Count | Notes |", "| --- | --- | --- |");
    out.push(`| HTTP routes | ${s.routes} | ${s.apiRoutes} API routes, ${s.authenticated} with an authentication check visible at the definition |`);
    out.push(`| API routes without a visible check | ${s.unverifiedApi} | The check may live in shared middleware; confirm each one is meant to be public |`);
    out.push(`| State-changing routes without a visible check | ${s.unauthenticatedWrites.length} | POST, PUT, PATCH or DELETE |`);
    out.push(`| Entry points | ${s.entryPoints} | Servers, workers, CLIs and scheduled jobs |`);
    out.push(`| External services | ${s.externalServices} | Each is a trust boundary and a place data leaves the system |`);
    out.push(`| Sensitive configuration | ${s.sensitiveEnv.length} | ${cell(s.sensitiveEnv.slice(0, 8).join(", ") || "none")} (names only) |`);
    out.push(`| Committed secrets | ${s.secrets} | ${s.secrets ? "Rotate and remove from history" : "None found by pattern matching"} |`);
    if (s.ports.length) out.push(`| Network ports | ${s.ports.length} | ${cell(s.ports.join(", "))} |`);
    if (s.unauthenticatedWrites.length) {
      out.push("\n**State-changing routes with no authentication check at the definition:**\n", "| Method | Route | Location |", "| --- | --- | --- |");
      for (const r of s.unauthenticatedWrites.slice(0, concise ? 8 : 15)) out.push(`| ${r.method} | \`${cell(r.path)}\` | \`${r.location}\` |`);
    }
    if (s.sensitiveRoutes.length && !concise) {
      out.push("\n**Sensitive routes (authentication, payments, accounts, uploads, webhooks):**\n", "| Method | Route | Why it is sensitive | Location |", "| --- | --- | --- | --- |");
      for (const r of s.sensitiveRoutes) out.push(`| ${r.method} | \`${cell(r.path)}\` | ${cell(r.why)} | \`${r.location}\` |`);
    }
  });

  part("sa-owasp", "OWASP Top 10 (2021) Coverage", (out) => {
    out.push("| Category | Status | Findings | Assessment |", "| --- | --- | --- | --- |");
    for (const o of a.owasp) out.push(`| **${o.id}** ${cell(o.name)} | ${o.status === "issues" ? `**Issues found** (${o.worst})` : o.status === "clear" ? "No issues detected" : "Limited coverage"} | ${o.findings.length ? o.findings.slice(0, 5).map((f) => f.code).join(", ") + (o.findings.length > 5 ? ` +${o.findings.length - 5}` : "") : "—"} | ${cell(o.note)} |`);
    out.push("\n_\"No issues detected\" means the checks that ran found nothing, not that the category is proven safe._");
  });

  part("sa-controls", "Security Controls", (out) => controlsTable(a.controls, out));

  part("sa-findings", "Security Findings", (out) => {
    out.push(`${plural(a.findings.length, "finding")} bear on security (the Security, Privacy and Dependencies categories and anything mapped to OWASP). Full evidence, impact and patches for each are in the Code Review.\n`);
    findingsTable(a.findings.filter((f) => !concise || f.severity !== "Informational"), out, concise ? 15 : 80);
  });

  part("sa-plan", "Remediation Plan", (out) => {
    if (!a.plan.length) { out.push("_Nothing needs remediation._"); return; }
    out.push("| Priority | Action | Findings |", "| --- | --- | --- |");
    for (const p of a.plan.slice(0, concise ? 8 : 20)) out.push(`| **${p.priority}** | ${cell(p.action)} | ${p.refs.length ? p.refs.slice(0, 6).join(", ") + (p.refs.length > 6 ? ` +${p.refs.length - 6}` : "") : "control gap"} |`);
    out.push("\n_Now: before the next release or exposure to untrusted users. Next: within the current planning cycle. Later: scheduled hardening._");
  });

  part("sa-method", "Scope, Method and Limitations", (out) => {
    out.push(`**Analyzers that ran:** ${a.coverage.staticAnalyzers.join(", ") || "none"}${a.coverage.aiReview ? `; AI security review of ${a.coverage.aiFiles} files` : ""}${a.coverage.formal ? "; formal verification (Lean 4)" : ""}.\n`);
    for (const n of a.coverage.notes) out.push(`- ${n}`);
    out.push("- Authentication applied by a gateway, reverse proxy or framework-wide middleware may not be visible at each route, so \"no visible check\" needs confirmation.", "- A penetration test, a dependency CVE scan and a review of cloud and network configuration complement this assessment.");
  });
  return parts;
}

export function privacyParts(p: PrivacyAssessment, concise = false): Part[] {
  const parts: Part[] = [];
  const part = (key: string, title: string, fn: (out: string[]) => void) => { const lines: string[] = []; fn(lines); parts.push({ key, title, lines }); };

  part("pr-summary", "PII Status Summary", (out) => {
    out.push(`> **Personal data status: ${p.status}**\n`);
    for (const r of p.rationale) out.push(`- ${r}`);
    const c = p.counts;
    out.push("", "| PII fields | Data models | Special category | High sensitivity | Sensitive and unprotected | Third parties | Findings |", "| --- | --- | --- | --- | --- | --- | --- |", `| **${c.fields}** | **${c.models}** | **${c.special}** | **${c.high}** | **${c.unprotectedSensitive}** | **${c.recipients}** | **${c.findings}** |`, "");
    out.push("_Status levels: **High exposure** (a high or critical privacy issue, or sensitive data stored unprotected with no encryption in the code), **Needs attention** (medium issues or missing core privacy controls), **Controls in place**, **Limited personal data** and **No personal data detected**._");
  });

  part("pr-inventory", "Personal Data Inventory", (out) => {
    if (!p.fields.length) { out.push("_No data-model field was recognised as personal data._"); return; }
    out.push("_Detected from data-model and schema field names. No stored values were read._\n");
    out.push("| Data element | Category | Sensitivity | Protection seen in the name | Location |", "| --- | --- | --- | --- | --- |");
    const rows = concise ? p.fields.filter((f) => f.sensitivity !== "low").slice(0, 25) : p.fields.slice(0, 200);
    for (const f of rows) out.push(`| \`${cell(f.model)}.${cell(f.field)}\` | ${f.categoryLabel} | ${SENSITIVITY_LABEL[f.sensitivity]} | ${f.protection === "none" ? "None visible" : f.protection === "tokenised" ? "Tokenised or masked" : f.protection === "hashed" ? "Hashed" : "Encrypted"} | ${at(f)} |`);
    if (p.fields.length > rows.length) out.push(`\n_${p.fields.length - rows.length} more field(s) are listed in the Privacy & PII Review report._`);
    if (!concise && p.models.length) {
      out.push("\n**Records holding personal data:**\n", "| Model | Personal-data fields | Most sensitive | Data subjects | Location |", "| --- | --- | --- | --- | --- |");
      for (const m of p.models) out.push(`| ${cell(m.name)} | ${m.fields} | ${SENSITIVITY_LABEL[m.highest]} | ${cell(m.subjects)} | ${at(m)} |`);
    }
  });

  part("pr-sharing", "Data Subjects, Flows and Third Parties", (out) => {
    out.push(`**Data subjects:** ${p.subjects.join(", ") || "none identified"}.\n`);
    if (p.recipients.length) {
      out.push("| Third party | Category | Personal data it is likely to receive | Evidence |", "| --- | --- | --- | --- |");
      for (const r of p.recipients) out.push(`| ${cell(r.name)} | ${cell(r.category)} | ${cell(r.why)} | ${r.evidence.slice(0, 2).map(at).join(", ") || "—"} |`);
    } else out.push("_No third-party service that typically receives personal data was detected._");
    if (p.flows.length && !concise) {
      out.push("\n**Traced flows that touch personal data:**\n");
      for (const f of p.flows) out.push(`- **${f.name}**: ${f.models.join(", ")}${f.externals.length ? ` → ${f.externals.join(", ")}` : ""}`);
    }
  });

  part("pr-controls", "Privacy Controls", (out) => controlsTable(p.controls, out));

  part("pr-findings", "Privacy Findings", (out) => {
    out.push("_Privacy findings, and high-severity security findings (injection, access control, stored secrets) that would expose personal data._\n");
    findingsTable(p.findings, out, concise ? 12 : 60);
  });

  part("pr-regimes", "Regulatory Considerations", (out) => {
    if (!p.regimes.length) { out.push("_No regulatory indicators were found._"); return; }
    out.push("| Regime | Why it may apply |", "| --- | --- |");
    for (const r of p.regimes) out.push(`| **${cell(r.name)}** | ${cell(r.why)} |`);
    out.push("\n_These are indicators from the code, not legal advice. Whether a law applies depends on where the organisation and its users are, its size and its role; confirm with your privacy or legal team._");
  });

  part("pr-recs", "Privacy Recommendations", (out) => {
    if (!p.recommendations.length) { out.push("_No recommendations._"); return; }
    out.push("| Priority | Action | Why |", "| --- | --- | --- |");
    for (const r of p.recommendations.slice(0, concise ? 6 : 20)) out.push(`| **${r.priority}** | ${cell(r.action)} | ${cell(r.why)} |`);
  });

  part("pr-method", "Method and Limitations", (out) => {
    out.push("- Personal data is recognised from field names in ORM models, schemas, migrations and typed records, and classified by category and sensitivity. Values in databases are never read.",
      "- Controls are recognised from dependencies, configuration and code patterns. A control implemented outside this repository (an API gateway, the database platform, a data-loss-prevention tool) will show as not found.",
      "- Personal data written into source files is detected by pattern (consumer e-mail domains, Luhn-valid card numbers, labelled Social Security numbers) outside tests; values are masked in every report.",
      "- This review supports, but does not replace, a data protection impact assessment (DPIA) or a legal review.");
  });
  return parts;
}

/** A group of parts as one report section, with each part as a subsection. */
export function asSubsections(parts: Part[], keys?: string[]): string[] {
  const out: string[] = [];
  for (const p of parts) {
    if (keys && !keys.includes(p.key)) continue;
    out.push(`\n### ${p.title}\n`, ...p.lines);
  }
  return out;
}
