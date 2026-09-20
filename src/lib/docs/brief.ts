import type { FindingRow } from "../db/schema";
import type { Architecture } from "../discover/types";
import type { DocReport, ExecutiveBrief } from "./types";

const SEV = ["Critical", "High", "Medium", "Low", "Informational"];
const list = (xs: string[], max = 3) => (xs.length <= max ? xs.join(", ") : `${xs.slice(0, max).join(", ")} and ${xs.length - max} more`);
const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;
/** First sentence, trimmed to a readable length. */
const firstSentence = (t: string, max = 140) => {
  const s = t.replace(/\s+/g, " ").replace(/\s*\((?:Stated|stated)[^)]*\)\.?/g, "").trim();
  const m = s.match(/^.+?[.!?](?=\s|$)/);
  const out = (m ? m[0] : s).trim();
  return out.length > max ? `${out.slice(0, max - 1).replace(/\s+\S*$/, "")}…` : out;
};
/** Strip file paths and code-style tokens so business text reads as prose. */
const plain = (t: string) => t.replace(/\b[A-Z]{2,4}-\d{3}:?\s*/g, "").replace(/`[^`]*`/g, "").replace(/\b[\w./-]+\.(?:ts|tsx|js|jsx|py|go|java|rb|rs|sql|json|ya?ml)(?::\d+(?:-\d+)?)?\b/g, "the code").replace(/\s{2,}/g, " ").replace(/\s+([.,;])/g, "$1").trim();

export function briefMetrics(arch: Architecture, findings: Pick<FindingRow, "severity" | "verification">[]): { label: string; value: string }[] {
  const live = findings.filter((f) => f.verification !== "rejected");
  const sev = (s: string) => live.filter((f) => f.severity === s).length;
  const crit = sev("Critical") + sev("High");
  const langs = arch.stack.languages.slice(0, 3).map((l) => l.name);
  return [
    { label: "Source files", value: (arch.stats.sourceFiles ?? arch.stats.files ?? 0).toLocaleString() },
    { label: "Lines of code", value: (arch.stats.lines ?? 0).toLocaleString() },
    { label: "Main languages", value: langs.join(", ") || "not detected" },
    { label: "Functional areas", value: String(arch.areas.filter((a) => !["Documentation", "Testing", "Configuration"].includes(a.name)).length) },
    { label: "API routes", value: String(arch.routes.filter((r) => r.kind === "api").length) },
    { label: "Data models", value: String(arch.models.length) },
    { label: "External services", value: String(arch.externalServices.length) },
    { label: "Critical or high findings", value: String(crit) },
  ];
}

/**
 * The business brief assembled purely from the analysis. It is the fallback when no AI is configured, the grounding
 * for the AI rewrite, and the source of every number even when an AI writes the words.
 */
export function buildBrief(docs: Pick<DocReport, "executiveSummary" | "areas" | "recommendations" | "risks">, arch: Architecture, findings: FindingRow[], projectName: string): ExecutiveBrief {
  const live = findings.filter((f) => f.verification !== "rejected");
  const bySev = (s: string) => live.filter((f) => f.severity === s).length;
  const serious = live.filter((f) => f.severity === "Critical" || f.severity === "High").sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity));
  const frameworks = arch.stack.frameworks.filter((f) => ["frontend-framework", "backend-framework", "api-framework", "ui-library"].includes(f.category)).map((f) => f.name);
  const shownAreas = docs.areas.filter((a) => !["Documentation", "Testing", "Configuration"].includes(a.name));
  const purpose = docs.executiveSummary[0] ? firstSentence(plain(docs.executiveSummary[0].text)) : "";

  const headline = purpose || `${projectName} is a ${arch.applicationType} written mainly in ${list(arch.stack.languages.slice(0, 2).map((l) => l.name), 2) || "an unrecognised language"}.`;
  const summary = [
    `${projectName} is a ${arch.applicationType}${frameworks.length ? ` built with ${list(frameworks, 3)}` : ""}, organised into ${plural(shownAreas.length, "functional area")}.`,
    arch.routes.length ? `It exposes ${plural(arch.routes.filter((r) => r.kind === "api").length, "API route")} and stores ${plural(arch.models.length, "data model")}.` : arch.models.length ? `It stores ${plural(arch.models.length, "data model")}.` : "",
    arch.externalServices.length ? `It depends on ${list(arch.externalServices.map((s) => s.name), 4)}.` : "It has no external service dependencies.",
  ].filter(Boolean).join(" ");

  const capabilities = shownAreas.slice(0, 7).map((a) => `${a.name}: ${firstSentence(plain(a.purpose), 110)}`);

  const critical = bySev("Critical");
  const high = bySev("High");
  const verdict = critical > 0 ? `Needs attention before it can be trusted in production: ${plural(critical, "critical issue")} and ${plural(high, "high-severity issue")} were found.`
    : high > 0 ? `Generally sound, with ${plural(high, "high-severity issue")} worth fixing soon.`
    : live.length > 0 ? `No critical or high-severity issues were found; ${plural(live.length, "lower-priority finding")} remain.`
    : "No issues were found by the analysis.";
  const strengths: string[] = [];
  if (arch.tests.files.length) strengths.push(`Automated tests exist (${plural(arch.tests.files.length, "test file")}${arch.tests.frameworks.length ? `, ${list(arch.tests.frameworks, 2)}` : ""}).`);
  if (arch.secrets.length === 0) strengths.push("No hard-coded credentials were detected.");
  if (arch.pattern.confidence !== "low") strengths.push(`A clear structure: ${arch.pattern.label}.`);
  if (arch.envVars.length) strengths.push("Configuration is read from environment variables.");
  const concerns: string[] = serious.slice(0, 4).map((f) => `${plain(f.title)}${f.businessImpact ? `: ${firstSentence(plain(f.businessImpact), 110)}` : ""}`);
  if (arch.secrets.length) concerns.push(`${plural(arch.secrets.length, "possible hard-coded credential")} found in the code.`);
  if (arch.tests.files.length === 0) concerns.push("No automated tests were found.");

  // Recommendations lead with a finding code ("SEC-001: Rotate…"); the finding supplies the business reason. Duplicates collapse once codes are removed.
  const seen = new Set<string>();
  const nextSteps: ExecutiveBrief["nextSteps"] = [];
  for (const r of docs.recommendations) {
    const code = r.text.match(/^([A-Z]{2,4}-\d{3}):/)?.[1];
    const action = firstSentence(plain(r.text), 150);
    const key = action.toLowerCase();
    if (!action || seen.has(key)) continue;
    seen.add(key);
    const f = code ? live.find((x) => x.code === code) : undefined;
    const i = nextSteps.length;
    nextSteps.push({ action, why: f?.businessImpact ? firstSentence(plain(f.businessImpact), 140) : "", priority: i < 2 ? "Now" : i < 4 ? "Next" : "Later" });
    if (nextSteps.length === 5) break;
  }

  const keyPoints = [
    { title: "What it is", detail: headline },
    { title: "How it is built", detail: `${arch.pattern.label}${frameworks.length ? `, using ${list(frameworks, 3)}` : ""}. ${plural(arch.stats.sourceFiles ?? 0, "source file")} across ${list(arch.stack.languages.slice(0, 3).map((l) => l.name), 3)}.` },
    { title: "What it does", detail: capabilities.length ? `${capabilities.length} capabilities, led by ${list(shownAreas.slice(0, 3).map((a) => a.name), 3)}.` : "No distinct capabilities were identified." },
    { title: "Where the risk is", detail: verdict },
    ...(nextSteps.length ? [{ title: "What to do next", detail: nextSteps[0].action }] : []),
  ];

  return { headline, summary, audience: "", keyPoints, capabilities, health: { verdict, strengths: strengths.slice(0, 4), concerns: concerns.slice(0, 5) }, nextSteps, metrics: briefMetrics(arch, findings), origin: "deterministic" };
}
