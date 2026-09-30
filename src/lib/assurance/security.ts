import type { FindingRow } from "../db/schema";
import type { Architecture } from "../discover/types";
import { classifyFinding, OWASP } from "./taxonomy";
import type { Control, FindingRef, OwaspRow, Rating, SecurityAssessment } from "./types";

const SEV = ["Critical", "High", "Medium", "Low", "Informational"] as const;
const sevIdx = (s: string) => SEV.indexOf(s as (typeof SEV)[number]);
const loc = (f: FindingRow) => (f.filePath ? `${f.filePath}${f.startLine ? `:${f.startLine}` : ""}` : "repository-wide");

export function findingRef(f: FindingRow): FindingRef {
  const c = classifyFinding(f);
  return { code: f.code, title: f.title, severity: f.severity, category: f.category, origin: f.origin, verification: f.verification, location: loc(f), cwe: c.cwe, owasp: c.owasp };
}

/** Findings that bear on security: the Security category, privacy issues and dependency hygiene, plus anything OWASP classifies. */
export const isSecurityRelevant = (f: FindingRow) => f.category === "Security" || f.category === "Privacy" || f.category === "Dependencies" || !!classifyFinding(f).owasp;

const SENSITIVE_PATH = /(admin|auth|login|signin|signup|register|password|reset|token|session|payment|checkout|billing|charge|refund|webhook|upload|import|export|user|account|order|invoice|secret|key)/i;

export interface SecurityInput {
  arch: Architecture;
  findings: FindingRow[];
  controls: Control[];
  pipeline?: { analyzers?: { name: string; status: string }[]; ai?: { ran: boolean; reviewedFiles?: number } } | null;
  formal?: { status?: string } | null;
}

export function buildSecurityAssessment({ arch, findings, controls, pipeline, formal }: SecurityInput): SecurityAssessment {
  const live = findings.filter((f) => f.verification !== "rejected");
  const sec = live.filter(isSecurityRelevant).sort((a, b) => sevIdx(a.severity) - sevIdx(b.severity) || a.code.localeCompare(b.code));
  const refs = sec.map(findingRef);
  const count = (s: string) => sec.filter((f) => f.severity === s).length;
  const counts = { total: sec.length, Critical: count("Critical"), High: count("High"), Medium: count("Medium"), Low: count("Low"), Informational: count("Informational"), verified: sec.filter((f) => f.verification === "verified").length, needsVerification: sec.filter((f) => f.verification !== "verified").length, formal: sec.filter((f) => f.origin === "formal").length };

  // ---- attack surface ------------------------------------------------------------------------------------------------
  const api = arch.routes.filter((r) => r.kind === "api" && r.method !== "USE");
  const authn = controls.find((c) => c.key === "authn");
  const writes = api.filter((r) => /^(POST|PUT|PATCH|DELETE|ALL|ANY)$/i.test(r.method) && r.auth !== "authenticated");
  const surface = {
    routes: arch.routes.length, apiRoutes: api.length, authenticated: api.filter((r) => r.auth === "authenticated").length, unverifiedApi: api.filter((r) => r.auth !== "authenticated").length,
    unauthenticatedWrites: writes.slice(0, 15).map((r) => ({ method: r.method, path: r.path, location: `${r.file}:${r.line}` })),
    sensitiveRoutes: api.filter((r) => SENSITIVE_PATH.test(r.path)).slice(0, 15).map((r) => ({ method: r.method, path: r.path, location: `${r.file}:${r.line}`, why: `${r.path.match(SENSITIVE_PATH)?.[1]?.toLowerCase()} handling${r.auth === "authenticated" ? "" : ", no check visible at its definition"}` })),
    entryPoints: arch.entryPoints.length, externalServices: arch.externalServices.length,
    sensitiveEnv: arch.envVars.filter((e) => e.sensitive).map((e) => e.name).slice(0, 20),
    ports: [...new Set(arch.ports.map((p) => p.value))].slice(0, 10), secrets: arch.secrets.length,
  };

  // ---- OWASP Top 10 coverage -----------------------------------------------------------------------------------------
  const ctl = (k: string) => controls.find((c) => c.key === k);
  const missing = (k: string) => ctl(k)?.status === "missing";
  const owasp: OwaspRow[] = OWASP.map((o) => {
    const mine = refs.filter((r) => r.owasp === o.id);
    const worst = mine[0]?.severity;
    let status: OwaspRow["status"] = mine.length ? "issues" : "clear";
    let note = mine.length ? `${mine.length} finding${mine.length > 1 ? "s" : ""}, the most severe ${worst?.toLowerCase()}.` : "No issues detected by the checks that ran.";
    if (!mine.length) {
      if (o.id === "A04") { status = "limited"; note = `Design flaws are mostly beyond static analysis.${missing("rate-limit") && api.length ? " No rate limiting was found." : ""}`; }
      if (o.id === "A06") { status = "limited"; note = `${missing("dependency-scanning") ? "No dependency scanning is configured, and " : ""}known vulnerabilities (CVEs) were not looked up, because Brody works offline. Run npm audit, pip-audit or OSV-Scanner.`; }
      if (o.id === "A09" && (missing("logging") || missing("audit"))) { status = "limited"; note = `${[missing("logging") && "no structured logging", missing("audit") && "no audit trail"].filter(Boolean).join(" and ")} found; monitoring happens outside the code and cannot be assessed here.`.replace(/^./, (c) => c.toUpperCase()); }
      if (o.id === "A05" && missing("headers") && arch.routes.length) { status = "limited"; note = "No misconfiguration was found, but no security headers (CSP, HSTS, framing) are set by the application either."; }
      if (o.id === "A07" && authn?.status === "missing") { status = "limited"; note = "No authentication mechanism was found to assess."; }
    }
    return { id: o.id, name: o.name, status, findings: mine, worst, note: `${note} ${o.note}`.trim() };
  });

  // ---- rating ------------------------------------------------------------------------------------------------------------
  const confirmed = (s: string) => sec.filter((f) => f.severity === s && (f.verification === "verified" || f.origin !== "ai")).length;
  const rating: Rating = counts.Critical ? "Critical" : counts.High >= 3 || (counts.High && confirmed("High")) ? "High" : counts.High || counts.Medium >= 4 ? "Elevated" : counts.Medium || counts.Low >= 5 ? "Moderate" : "Low";
  const rationale: string[] = [];
  if (counts.Critical) rationale.push(`${counts.Critical} critical issue${counts.Critical > 1 ? "s" : ""} could lead directly to compromise or data exposure: ${sec.filter((f) => f.severity === "Critical").slice(0, 3).map((f) => `${f.code} ${f.title}`).join("; ")}.`);
  if (counts.High) rationale.push(`${counts.High} high-severity issue${counts.High > 1 ? "s" : ""} (${confirmed("High")} confirmed by a static analyzer, formal proof or verification).`);
  if (counts.Medium) rationale.push(`${counts.Medium} medium-severity issue${counts.Medium > 1 ? "s weaken" : " weakens"} defence in depth.`);
  const gaps = controls.filter((c) => c.domain === "security" && (c.status === "missing" || c.status === "gap") && ["authn", "password-hashing", "validation", "rate-limit", "headers", "secrets-management", "dependency-scanning"].includes(c.key));
  if (gaps.length) rationale.push(`Controls not found or weak: ${gaps.map((c) => c.name.charAt(0).toLowerCase() + c.name.slice(1)).join(", ")}.`);
  if (surface.unauthenticatedWrites.length) rationale.push(`${writes.length} state-changing API route${writes.length > 1 ? "s show" : " shows"} no authentication check at the definition.`);
  if (!rationale.length) rationale.push("No significant security issues were found by the checks that ran.");

  // ---- remediation plan ----------------------------------------------------------------------------------------------
  const plan: SecurityAssessment["plan"] = [];
  const grouped = new Map<string, { priority: "Now" | "Next" | "Later"; action: string; refs: string[] }>();
  for (const f of sec) {
    if (f.severity === "Informational") continue;
    const priority = f.severity === "Critical" || f.severity === "High" ? "Now" : f.severity === "Medium" ? "Next" : "Later";
    const key = `${priority}:${f.analyzer ?? f.title}`;
    const g = grouped.get(key);
    if (g) g.refs.push(f.code);
    else grouped.set(key, { priority, action: firstSentence(f.remediation), refs: [f.code] });
  }
  for (const g of grouped.values()) plan.push(g);
  const controlAction: Record<string, string> = {
    "rate-limit": "Add rate limiting to sign-in, registration, password reset and other expensive or abusable endpoints.",
    headers: "Set security headers (Content Security Policy, HSTS, X-Frame-Options or frame-ancestors, Referrer-Policy), for example with helmet.",
    "dependency-scanning": "Enable automated dependency vulnerability scanning (Dependabot or Renovate plus npm audit, pip-audit or OSV-Scanner in CI).",
    "secret-scanning": "Add secret scanning (gitleaks or trufflehog) to CI and pre-commit hooks.",
    validation: "Validate every request body, query and path parameter against a schema at the API boundary.",
    audit: "Record an audit trail of sign-ins, permission changes and access to sensitive records.",
  };
  for (const c of controls) if (c.status === "missing" && controlAction[c.key] && (c.key !== "rate-limit" && c.key !== "headers" && c.key !== "validation" || api.length)) plan.push({ priority: c.key === "dependency-scanning" || c.key === "validation" ? "Next" : "Later", action: controlAction[c.key], refs: [] });
  plan.sort((a, b) => ["Now", "Next", "Later"].indexOf(a.priority) - ["Now", "Next", "Later"].indexOf(b.priority));

  const ran = (pipeline?.analyzers ?? []).filter((a) => a.status === "ran").map((a) => a.name);
  const notes = [
    "Static review of the source: nothing was executed, and no live system, network or cloud configuration was tested.",
    pipeline?.ai?.ran ? `AI security review covered the ${pipeline.ai.reviewedFiles ?? 0} highest-risk files; each AI finding is checked against the source and labelled.` : "AI review did not run, so findings come only from deterministic analyzers and structural checks.",
    formal?.status === "ran" ? "Formal verification (Lean 4) checked the most complex functions." : "Formal verification did not run.",
    "Known-vulnerability (CVE) lookup of dependencies is not performed.",
  ];
  return { rating, rationale, counts, surface, owasp, controls: controls.filter((c) => c.domain === "security"), findings: refs, plan: plan.slice(0, 20), coverage: { staticAnalyzers: ran, aiReview: !!pipeline?.ai?.ran, aiFiles: pipeline?.ai?.reviewedFiles ?? 0, formal: formal?.status === "ran", notes } };
}

export function firstSentence(t: string, max = 220): string {
  const s = (t ?? "").replace(/\s+/g, " ").trim();
  const m = s.match(/^.+?[.!?](?=\s|$)/);
  const out = (m ? m[0] : s).trim();
  return out.length > max ? `${out.slice(0, max - 1).replace(/\s+\S*$/, "")}…` : out;
}
