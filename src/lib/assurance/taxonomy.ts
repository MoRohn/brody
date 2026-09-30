/** OWASP Top 10 (2021) and CWE classification of findings, so the security assessment speaks the industry's language. */

export const OWASP: { id: string; name: string; note: string }[] = [
  { id: "A01", name: "Broken Access Control", note: "Missing or inconsistent authorization, path traversal, open redirects, CSRF and over-permissive CORS." },
  { id: "A02", name: "Cryptographic Failures", note: "Weak hashing, predictable randomness, disabled TLS verification and sensitive data stored or sent in clear." },
  { id: "A03", name: "Injection", note: "SQL, command, code and template injection, and cross-site scripting." },
  { id: "A04", name: "Insecure Design", note: "Missing controls by design, such as rate limiting, abuse protection and safe defaults. Static analysis sees only part of this." },
  { id: "A05", name: "Security Misconfiguration", note: "Debug mode, permissive CORS, insecure cookies, missing security headers." },
  { id: "A06", name: "Vulnerable and Outdated Components", note: "Unpinned or unlocked dependencies. Known CVEs are not looked up: Brody works offline, so run npm audit, pip-audit or OSV-Scanner for that." },
  { id: "A07", name: "Identification and Authentication Failures", note: "Hard-coded or committed credentials, forgeable tokens, weak session handling, unauthenticated endpoints." },
  { id: "A08", name: "Software and Data Integrity Failures", note: "Unsafe deserialization and unverified code or data sources." },
  { id: "A09", name: "Security Logging and Monitoring Failures", note: "Swallowed errors in security paths, missing audit trails, personal data or secrets written to logs." },
  { id: "A10", name: "Server-Side Request Forgery", note: "Outbound requests to URLs that come from users." },
];

/** Built-in rules and structural checks, by analyzer id suffix. */
const RULE_MAP: Record<string, { owasp: string; cwe: string }> = {
  "eval": { owasp: "A03", cwe: "CWE-95" },
  "new-function": { owasp: "A03", cwe: "CWE-95" },
  "child-process-exec": { owasp: "A03", cwe: "CWE-78" },
  "python-shell": { owasp: "A03", cwe: "CWE-78" },
  "sql-concat": { owasp: "A03", cwe: "CWE-89" },
  "innerhtml": { owasp: "A03", cwe: "CWE-79" },
  "rails-html-safe": { owasp: "A03", cwe: "CWE-79" },
  "php-extract": { owasp: "A03", cwe: "CWE-94" },
  "pickle-load": { owasp: "A08", cwe: "CWE-502" },
  "tls-verify-off": { owasp: "A02", cwe: "CWE-295" },
  "weak-hash": { owasp: "A02", cwe: "CWE-328" },
  "weak-random": { owasp: "A02", cwe: "CWE-338" },
  "http-plain": { owasp: "A02", cwe: "CWE-319" },
  "cors-wildcard": { owasp: "A05", cwe: "CWE-942" },
  "debug-on": { owasp: "A05", cwe: "CWE-489" },
  "cookie-insecure": { owasp: "A05", cwe: "CWE-614" },
  "csrf-disabled": { owasp: "A01", cwe: "CWE-352" },
  "jwt-none": { owasp: "A07", cwe: "CWE-347" },
  "hardcoded-password": { owasp: "A07", cwe: "CWE-798" },
  "path-join-user": { owasp: "A01", cwe: "CWE-22" },
  "open-redirect": { owasp: "A01", cwe: "CWE-601" },
  "ssrf": { owasp: "A10", cwe: "CWE-918" },
  "pii-logging": { owasp: "A09", cwe: "CWE-532" },
  "pii-in-url": { owasp: "A04", cwe: "CWE-598" },
};

/** Keyword fallbacks for AI findings, structural checks and linters, most specific first. */
const KEYWORDS: [RegExp, { owasp: string; cwe: string }][] = [
  [/sql injection|injectable|sql.*(interpolat|concatenat)/i, { owasp: "A03", cwe: "CWE-89" }],
  [/command injection|shell|os\.system|exec\(/i, { owasp: "A03", cwe: "CWE-78" }],
  [/\beval\b|code injection|arbitrary code|remote code/i, { owasp: "A03", cwe: "CWE-94" }],
  [/xss|cross-site scripting|script injection|innerhtml|unescaped html/i, { owasp: "A03", cwe: "CWE-79" }],
  [/template injection|ssti/i, { owasp: "A03", cwe: "CWE-1336" }],
  [/ssrf|server-side request/i, { owasp: "A10", cwe: "CWE-918" }],
  [/path traversal|directory traversal|\.\.\//i, { owasp: "A01", cwe: "CWE-22" }],
  [/open redirect/i, { owasp: "A01", cwe: "CWE-601" }],
  [/csrf|cross-site request forgery/i, { owasp: "A01", cwe: "CWE-352" }],
  [/idor|insecure direct object|another user'?s|other users'?|ownership|authoriz|access control|permission|privilege/i, { owasp: "A01", cwe: "CWE-862" }],
  [/deserializ|pickle|unmarshal/i, { owasp: "A08", cwe: "CWE-502" }],
  [/plaintext password|password.*(plain|clear)|unhashed/i, { owasp: "A02", cwe: "CWE-256" }],
  [/without (field-level )?(encryption|protection)|unencrypted|stored in clear|cleartext/i, { owasp: "A02", cwe: "CWE-311" }],
  [/secret|credential|api key|hard-coded|hardcoded/i, { owasp: "A07", cwe: "CWE-798" }],
  [/token.*(forg|predict|guess|base64|unsigned)|forg(e|ed|eable) token|session fixation|jwt/i, { owasp: "A07", cwe: "CWE-287" }],
  [/authentication|unauthenticated|sign-?in|login/i, { owasp: "A07", cwe: "CWE-306" }],
  [/md5|sha-?1|weak hash|weak crypt|cipher|encryption/i, { owasp: "A02", cwe: "CWE-327" }],
  [/random/i, { owasp: "A02", cwe: "CWE-338" }],
  [/tls|certificate|https/i, { owasp: "A02", cwe: "CWE-295" }],
  [/personal data.*log|log.*(personal|pii|email|password)/i, { owasp: "A09", cwe: "CWE-532" }],
  [/rate limit|brute.?force|throttl/i, { owasp: "A04", cwe: "CWE-307" }],
  [/cors|debug|cookie|header/i, { owasp: "A05", cwe: "CWE-16" }],
  [/dependenc|lock ?file|version|package/i, { owasp: "A06", cwe: "CWE-1104" }],
];

export interface Classified { owasp?: string; cwe?: string }

export function classifyFinding(f: { analyzer?: string | null; title: string; category: string; whatHappens?: string | null }): Classified {
  const rule = f.analyzer?.startsWith("brody-rules/") ? f.analyzer.slice("brody-rules/".length) : undefined;
  if (rule && RULE_MAP[rule]) return RULE_MAP[rule];
  if (f.analyzer?.startsWith("eslint/security") || f.analyzer === "eslint/no-eval" || f.analyzer === "eslint/no-implied-eval") return { owasp: "A03", cwe: "CWE-95" };
  if (f.analyzer?.startsWith("ruff/S")) {
    const code = f.analyzer.slice("ruff/".length);
    if (/^S60[2-7]/.test(code)) return { owasp: "A03", cwe: "CWE-78" };
    if (/^S608/.test(code)) return { owasp: "A03", cwe: "CWE-89" };
    if (/^S30[1-2]|^S506/.test(code)) return { owasp: "A08", cwe: "CWE-502" };
    if (/^S10[5-7]/.test(code)) return { owasp: "A07", cwe: "CWE-798" };
    if (/^S324|^S30[3-5]/.test(code)) return { owasp: "A02", cwe: "CWE-327" };
    if (/^S501/.test(code)) return { owasp: "A02", cwe: "CWE-295" };
  }
  if (f.category === "Dependencies") return { owasp: "A06", cwe: "CWE-1104" };
  if (f.category !== "Security" && f.category !== "Privacy") return {};
  const text = `${f.title} ${f.whatHappens ?? ""}`;
  for (const [re, c] of KEYWORDS) if (re.test(f.title)) return c;
  for (const [re, c] of KEYWORDS) if (re.test(text)) return c;
  return f.category === "Security" ? { owasp: "A04" } : {};
}
