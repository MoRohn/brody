import { RULES } from "../analysis/rules";
import type { Category } from "../review/types";

/**
 * The deck speaks to executives: capabilities, exposure, cost of delay, next steps. Nothing that names a file, function,
 * query or library. This module is the single place where the report's technical findings and flows are put into that
 * language, so the wording is consistent, reviewable and testable (tests/deck.test.ts checks that every built-in rule has
 * an entry and that no technical token reaches a slide).
 */

/** Strip file paths, code and identifiers so a sentence reads as prose. */
export function plainText(t: string | null | undefined): string {
  return (t ?? "")
    .replace(/\b[A-Z]{2,4}-\d{3}:?\s*/g, "")
    .replace(/`[^`]*`/g, "")
    .replace(/\b[\w./-]+\.(?:ts|tsx|js|jsx|mjs|py|go|java|rb|rs|sql|json|ya?ml|md|env)(?::\d+(?:-\d+)?)?\b/g, "the code")
    .replace(/\b(?:src|app|lib|tests?|scripts|worker|packages)\/[\w./-]+/g, "the code")
    .replace(/\b[\w$]+\([^)]*\)/g, "")
    .replace(/\s*\((?:Stated|stated)[^)]*\)\.?/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
}

/** The first sentence, cut at a word boundary. */
export function firstSentence(t: string, max = 140): string {
  const s = plainText(t).replace(/\s+/g, " ").trim();
  const m = s.match(/^.+?[.!?](?=\s|$)/);
  const out = (m ? m[0] : s).trim();
  return out.length > max ? `${out.slice(0, max - 1).replace(/\s+\S*$/, "")}…` : out;
}

export interface Issue { issue: string; action: string }

const R = (issue: string, action: string): Issue => ({ issue, action });
const RULE_TEXT: Record<string, Issue> = {
  "eval": R("A shortcut that runs text as code", "Remove the shortcut that lets text be run as code"),
  "new-function": R("A shortcut that runs text as code", "Remove the shortcut that lets text be run as code"),
  "child-process-exec": R("System commands built from untrusted input", "Stop building system commands from user-supplied text"),
  "python-shell": R("System commands built from untrusted input", "Stop building system commands from user-supplied text"),
  "pickle-load": R("Unsafe handling of received data", "Use safe data formats when reading outside data"),
  "sql-concat": R("Database queries open to tampering", "Use safe, parameterised database queries"),
  "tls-verify-off": R("Secure connections are not verified", "Turn certificate checking back on"),
  "weak-hash": R("Outdated data-protection method", "Move to a current data-protection standard"),
  "weak-random": R("Predictable security tokens", "Generate security tokens from a secure source"),
  "innerhtml": R("Pages open to script injection", "Escape content before it is shown on a page"),
  "cors-wildcard": R("Any website may call the system", "Limit which sites may call the system"),
  "debug-on": R("Debug mode left on", "Switch off debug mode outside development"),
  "jwt-none": R("Sign-in tokens can be forged", "Always verify sign-in tokens"),
  "hardcoded-password": R("Credentials stored in the code", "Move credentials to a secrets manager and rotate them"),
  "path-join-user": R("Files reachable through user input", "Check file locations that come from users"),
  "open-redirect": R("Users can be sent to unsafe sites", "Only redirect to approved destinations"),
  "ssrf": R("The system can be tricked into reaching internal services", "Restrict where the system may connect"),
  "empty-catch": R("Errors are silently ignored", "Report and handle errors instead of ignoring them"),
  "python-bare-except": R("Errors are silently ignored", "Report and handle errors instead of ignoring them"),
  "python-except-pass": R("Errors are silently ignored", "Report and handle errors instead of ignoring them"),
  "unhandled-promise": R("Failures can go unnoticed", "Make sure background failures are reported"),
  "todo-fixme": R("Unfinished work left in the code", "Review and close out outstanding to-do items"),
  "console-log": R("Debug output left in production code", "Replace debug output with proper logging"),
  "sync-io": R("Operations that can slow the system", "Move slow operations off the main path"),
  "loop-await": R("Work done one step at a time that could run together", "Run independent work in parallel"),
  "select-star": R("Inefficient data retrieval", "Request only the data that is needed"),
  "float-money": R("Rounding errors in money calculations", "Use exact arithmetic for money"),
  "http-plain": R("Unencrypted connections", "Use encrypted connections everywhere"),
  "cookie-insecure": R("Session cookies not fully protected", "Harden session cookie settings"),
  "csrf-disabled": R("Requests can be forged on a user's behalf", "Enable protection against forged requests"),
  "go-unchecked-err": R("Errors are not checked", "Check and handle every error"),
  "java-printstack": R("Error details written to the wrong place", "Send errors to the logging system"),
  "dotnet-async-void": R("Failures can go unnoticed", "Make sure background failures are reported"),
  "rails-html-safe": R("Pages open to script injection", "Escape content before it is shown on a page"),
  "php-extract": R("Outside data can overwrite internal settings", "Read outside data explicitly and safely"),
  "rust-unsafe": R("Low-level code that bypasses safety checks", "Review and minimise unsafe code"),
  "rust-unwrap": R("Failures can stop the system abruptly", "Handle failures gracefully"),
};

/** The structural checks share one analyzer name, so they are recognised by what they report. */
const TITLE_TEXT: [RegExp, Issue][] = [
  [/secret|credential|token|password/i, R("Credentials exposed in the code", "Rotate exposed credentials and keep them in a secrets manager")],
  [/no automated tests|test-to-source|have no tests|has no tests/i, R("Too little automated testing", "Add automated tests around the most relied-upon code")],
  [/authentication|auth check/i, R("Some access points may be unprotected", "Confirm every access point checks who is calling")],
  [/health ?check|readiness/i, R("No way to confirm the system is healthy", "Add a health check that monitoring can use")],
  [/CI|pipeline|continuous/i, R("No automated build and test routine", "Run tests and builds automatically on every change")],
  [/environment variables|\.env/i, R("Settings are not documented", "Document the settings the system needs")],
  [/README|documentation/i, R("Missing basic documentation", "Add an overview so new people can get started")],
  [/not locked|lock ?file|no version constraint|latest|pinned/i, R("Software components are not pinned", "Pin component versions so builds are repeatable")],
  [/duplicate/i, R("Copy-pasted code", "Consolidate duplicated code")],
  [/complexity|very large file|very long|large file/i, R("Code that is hard to change safely", "Break the largest, most complex code into smaller parts")],
];

/** Fallbacks by category when nothing more specific is known. */
const CATEGORY_TEXT: Record<string, Issue> = {
  Security: R("A security weakness", "Fix the security weakness"),
  Reliability: R("A reliability risk", "Make the affected behaviour more robust"),
  Correctness: R("A likely defect", "Correct the defect"),
  Performance: R("A performance risk", "Improve the slow path"),
  Maintainability: R("Code that is hard to maintain", "Simplify the hardest-to-maintain code"),
  "API Design": R("An inconsistency in how the system is used by others", "Make the interface consistent"),
  Data: R("A data-handling risk", "Tighten how data is stored and changed"),
  Testing: R("A gap in automated testing", "Add automated tests"),
  Operations: R("An operational gap", "Close the operational gap"),
  Architecture: R("A structural weakness", "Address the structural weakness"),
  Dependencies: R("A risk in third-party components", "Update or replace risky components"),
};

export interface FindingLike { analyzer?: string | null; title: string; category: string; businessImpact?: string | null; whyItMatters?: string | null }

/** A finding in executive terms: what the issue is, and what fixing it means. */
export function issueFor(f: FindingLike): Issue {
  const rule = f.analyzer?.startsWith("brody-rules/") ? f.analyzer.slice("brody-rules/".length) : undefined;
  if (rule && RULE_TEXT[rule]) return RULE_TEXT[rule];
  if (f.analyzer === "brody-structure") for (const [re, t] of TITLE_TEXT) if (re.test(f.title)) return t;
  if (f.analyzer === "typescript" || f.analyzer === "python-ast" || f.analyzer === "gofmt") return R("Code that cannot be built or run", "Repair the code that fails to build");
  if (f.analyzer?.startsWith("eslint/") || f.analyzer?.startsWith("ruff/")) return R("A likely defect in the code", "Correct the likely defects");
  for (const [re, t] of TITLE_TEXT) if (re.test(f.title)) return t;
  return CATEGORY_TEXT[f.category] ?? R("An issue worth reviewing", "Review the issue");
}

/** What could go wrong, in a sentence. Uses the finding's own business impact, then its "why it matters". */
export function exposureFor(f: FindingLike): string {
  // The finding's own business impact is already written for this reader; otherwise use the wording kept here, and only then
  // the technical explanation, trimmed.
  const own = firstSentence(f.businessImpact ?? "", 150);
  if (own) return own;
  const known = EXPOSURE[issueFor(f).issue];
  if (known) return known;
  return EXPOSURE_BY_CATEGORY[f.category] ?? (firstSentence(f.whyItMatters ?? "", 150) || "May affect the reliability or safety of the system.");
}

const EXPOSURE: Record<string, string> = {
  "Too little automated testing": "Changes are more likely to break things without anyone noticing until customers do.",
  "Errors are silently ignored": "Problems can go unnoticed and quietly affect customers until they are large.",
  "Failures can go unnoticed": "Problems can go unnoticed and quietly affect customers until they are large.",
  "No way to confirm the system is healthy": "Outages may only be discovered when customers report them.",
  "No automated build and test routine": "Mistakes can reach customers because nothing checks each change automatically.",
  "Settings are not documented": "Setting the system up in a new environment is slow and error-prone.",
  "Missing basic documentation": "New people take longer to become productive.",
  "Software components are not pinned": "Builds can change unexpectedly, causing surprise failures.",
  "Copy-pasted code": "The same fix has to be made in several places, which raises cost and the chance of error.",
  "Code that is hard to change safely": "Changes to this code are slower, costlier and riskier.",
  "Some access points may be unprotected": "Customer or business data could be reached without signing in.",
  "Unfinished work left in the code": "Known gaps may ship to customers if they are not tracked.",
  "Debug output left in production code": "Sensitive information may end up in logs.",
  "Operations that can slow the system": "Customers may see slower responses under load.",
  "Work done one step at a time that could run together": "Customers may see slower responses under load.",
  "Inefficient data retrieval": "Higher running costs and slower responses as data grows.",
  "Rounding errors in money calculations": "Amounts charged or reported can be slightly wrong.",
  "Debug mode left on": "Internal details may be exposed to outsiders.",
};
const EXPOSURE_BY_CATEGORY: Record<string, string> = {
  Testing: "Changes are more likely to break things without anyone noticing.",
  Operations: "Problems are harder to prevent, detect and recover from.",
  Dependencies: "Builds and security depend on software the team does not control.",
  Maintainability: "Changes take longer and cost more over time.",
  Performance: "Customers may see slower responses under load.",
  Reliability: "Failures may go unnoticed and affect customers.",
};

export const THEME: Record<string, string> = {
  Security: "Security and data protection",
  Reliability: "Reliability and resilience",
  Correctness: "Correctness",
  Performance: "Performance",
  Maintainability: "Maintainability and technical debt",
  "API Design": "Ease of integration",
  Data: "Data integrity",
  Testing: "Quality assurance",
  Operations: "Operational readiness",
  Architecture: "Structure",
  Dependencies: "Third-party components",
};
export const themeFor = (category: Category | string): string => THEME[category] ?? category;

/** Every built-in rule has executive wording (checked by a test, so a new rule cannot ship without it). */
export const RULES_WITH_WORDING = (): string[] => RULES.map((r) => r.id).filter((id) => !RULE_TEXT[id]);

const ROLE_TEXT: Record<string, string> = {
  api: "Lets screens and other systems ask the platform to do things",
  ui: "What people see and use",
  service: "The business rules and workflows",
  data: "Stores and retrieves the information the business depends on",
  schema: "Defines how information is structured",
  job: "Work that runs in the background or on a schedule",
  infra: "Builds, deploys and runs the system",
  config: "Settings that adapt the system to each environment",
  test: "Automated checks that protect quality",
  util: "Shared building blocks used across the system",
  entry: "Where the system starts running",
  ai: "Intelligent features",
  docs: "Documentation",
};
export const roleText = (role: string): string => ROLE_TEXT[role] ?? "Supporting capability";

/** Words that mark a description as written for engineers; such text is replaced by the plainer role wording. */
const ENGINEER_WORDS = /\b(http|rpc|endpoints?|schemas?|migrations?|middleware|orm|sql|api|handlers?|controllers?|repositor(?:y|ies)|modules?|config(?:uration)?|quer(?:y|ies)|ci|cd|dockerfile|orchestration|pipelines?|helpers?|hooks?|components?|client-side|state)\b|code under|supports the|top-level/i;
export const isExecutiveWording = (t: string): boolean => t.length > 0 && !ENGINEER_WORDS.test(t) && !TECHNICAL_TOKENS.some((re) => re.test(t));

const SINGULAR = (w: string) => (w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.endsWith("ses") ? w.slice(0, -2) : w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const SPECIAL: [RegExp, string][] = [
  [/login|signin|sign-in|authenticate/, "Sign in"], [/logout|signout|sign-out/, "Sign out"], [/register|signup|sign-up/, "Sign up"],
  [/checkout/, "Check out"], [/pay(ment)?s?$/, "Take a payment"], [/calc(ulate)?/, "Run a calculation"], [/search/, "Search"], [/upload/, "Upload a file"],
  [/health|status|ping|ready/, "Check system health"], [/webhook/, "Receive updates from a partner"],
];

/** "POST /api/orders" becomes "Create an order". Non-route flows are named plainly. */
export function humanizeFlow(name: string, trigger: string, kind?: string): string {
  const m = (trigger || name).match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/i);
  if (!m) {
    const byKind: Record<string, string> = { startup: "System start-up", job: "Scheduled background work", event: "Reacting to events", pipeline: "Background processing pipeline", request: "Handling a request" };
    if (kind && byKind[kind]) return byKind[kind];
    const t = plainText(name).replace(/[_-]+/g, " ").trim();
    return t && !/\bthe code\b/.test(t) ? `${t.charAt(0).toUpperCase()}${t.slice(1)}` : "Background processing";
  }
  const method = m[1].toUpperCase();
  const segs = m[2].split("?")[0].split("/").filter((s) => s && !/^(api|v\d+|rest)$/i.test(s));
  const statics = segs.filter((s) => !/^[:{[]/.test(s));
  const last = (statics[statics.length - 1] ?? "").toLowerCase();
  const endsWithParam = segs.length > 0 && /^[:{[]/.test(segs[segs.length - 1]);
  for (const [re, label] of SPECIAL) if (re.test(last)) return label;
  const noun = last.replace(/[-_]+/g, " ") || "record";
  const one = SINGULAR(noun);
  const article = /^[aeiou]/.test(one) && !/^(us|uni|eu|one|ut)/.test(one) ? "an" : "a";
  if (method === "GET") return endsWithParam ? `View ${article} ${one}` : `List ${noun}`;
  if (method === "POST") return `Create ${article} ${one}`;
  if (method === "PUT" || method === "PATCH") return `Update ${article} ${one}`;
  if (method === "DELETE") return `Remove ${article} ${one}`;
  return `Handle ${noun}`;
}

/** Patterns that must never appear on a slide; used by the tests as the lexicon guard. */
export const TECHNICAL_TOKENS: RegExp[] = [
  /`/, /\b[\w-]+\/[\w-]+\.[a-z]{1,4}\b/i, /\.(?:tsx?|jsx?|py|go|java|rb|rs|sql|json|ya?ml)\b/i, /\b\w+\(\)/, /\b(?:src|lib|app)\//,
  /\b[a-z]+[A-Z][a-z]+[A-Z]?\w*\b/, /::/, /=>/, /\bGET \/|\bPOST \/|\bPUT \/|\bDELETE \//, /https?:\/\//,
];
