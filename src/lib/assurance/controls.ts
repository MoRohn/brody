import { blankLines } from "../analysis/rules";
import type { Architecture } from "../discover/types";
import type { Control, Loc } from "./types";

/** The part of a file the control scan needs; LoadedFile satisfies it. */
export interface ScanFile { path: string; name?: string; text?: string; classification: string; isTest: boolean; isExcluded?: boolean; isGenerated?: boolean }

interface Probe {
  key: string;
  name: string;
  domain: "security" | "privacy";
  /** Dependencies whose presence is evidence of the control. */
  deps?: RegExp;
  /** Code or configuration that shows the control in use. */
  text?: RegExp;
  /** Only look for `text` in files whose path matches. */
  paths?: RegExp;
  /** Match string contents too (header names, config values). By default only code is matched, with literals blanked. */
  literal?: boolean;
  present: string;
  missing: string;
}

const PROBES: Probe[] = [
  { key: "authz", name: "Authorization (roles and permissions)", domain: "security", text: /\b(?:hasRole|hasPermission|requireRole|requireAdmin|isAdmin\s*\(|authorize\s*\(|@PreAuthorize|@RolesAllowed|@Roles\(|permission_required|user_passes_test|PermissionRequired|can\?\s*\(|ability\.can|\bcasl\b|accessControl|rbac|checkPermission|IsAuthenticatedOrReadOnly|permission_classes)/,
    present: "Role or permission checks were found in the code.", missing: "No role or permission check was found; authenticated users may all have the same access." },
  { key: "validation", name: "Input validation", domain: "security", deps: /^(zod|joi|yup|ajv|class-validator|express-validator|valibot|superstruct|@sinclair\/typebox|io-ts|pydantic|marshmallow|cerberus|voluptuous|wtforms|jsonschema|fluentvalidation|dry-validation|@hapi\/joi|validator)$/i, text: /\b(?:z\.object\(|Joi\.object\(|yup\.object\(|BaseModel\)|@IsString\(|@IsEmail\(|checkSchema\(|body\(\s*['"][\w.]+['"]\s*\)\.is)/,
    present: "A validation library or schema checks request input.", missing: "No validation library or schema was found; request bodies may reach business logic unchecked." },
  { key: "rate-limit", name: "Rate limiting and brute-force protection", domain: "security", deps: /^(express-rate-limit|rate-limiter-flexible|@upstash\/ratelimit|express-slow-down|@nestjs\/throttler|slowapi|django-ratelimit|flask-limiter|django-axes|rack-attack|limiter)$/i, text: /\b(?:rateLimit\s*\(|RateLimiter|Throttle\(|throttle_classes|@limiter\.limit|ratelimit\()/i,
    present: "Request rate limiting is configured.", missing: "No rate limiting was found; sign-in and other endpoints can be called without limit (credential stuffing, scraping, cost abuse)." },
  { key: "headers", literal: true, name: "Security headers (CSP, HSTS, framing)", domain: "security", deps: /^(helmet|@fastify\/helmet|koa-helmet|secure|django-csp|flask-talisman|secure_headers|next-safe)$/i, text: /(?:Content-Security-Policy|Strict-Transport-Security|X-Frame-Options|frame-ancestors|SecurityMiddleware|SECURE_HSTS_SECONDS)/,
    present: "Security headers are set (Content Security Policy, HSTS or framing controls).", missing: "No security headers were found; browsers get no Content Security Policy, HSTS or clickjacking protection from the application." },
  { key: "csrf", literal: true, name: "CSRF protection", domain: "security", deps: /^(csurf|csrf-csrf|@fastify\/csrf-protection|lusca|django-csrf|flask-wtf)$/i, text: /(?:csrfToken|csrf_token|CsrfViewMiddleware|CSRFProtect|antiforgery|ValidateAntiForgeryToken|protect_from_forgery(?!\s+with:\s*:null_session)|sameSite\s*:\s*['"](?:strict|lax)['"])/i,
    present: "Cross-site request forgery protection (tokens or SameSite cookies) was found.", missing: "No CSRF token or SameSite cookie setting was found. This matters when authentication uses cookies." },
  { key: "password-hashing", name: "Password hashing", domain: "security", deps: /^(bcrypt|bcryptjs|argon2|@node-rs\/argon2|@node-rs\/bcrypt|scrypt-js|passlib|bcrypt-pbkdf|django|devise|werkzeug)$/i, text: /\b(?:bcrypt\.|argon2\.|scryptSync\(|crypto\.scrypt\(|pbkdf2(?:Sync)?\(|generate_password_hash|check_password_hash|make_password\(|PasswordHasher|BCryptPasswordEncoder|password_hash\(|BCrypt::Password|hashPassword\()/,
    present: "Passwords are hashed with a password-hashing function.", missing: "No password-hashing function (bcrypt, scrypt, Argon2, PBKDF2) was found." },
  { key: "encryption", name: "Encryption of stored data", domain: "security", deps: /^(@aws-sdk\/client-kms|@google-cloud\/kms|@azure\/keyvault-keys|node-vault|libsodium-wrappers|tweetnacl|cryptography|pycryptodome|django-cryptography|django-fernet-fields|attr_encrypted|lockbox|mongoose-encryption|prisma-field-encryption|@47ng\/cloak|sequelize-encrypted)$/i, text: /\b(?:createCipheriv|crypto\.subtle\.encrypt|Fernet\(|AESGCM\(|Cipher\.getInstance|pgp_sym_encrypt|encrypt(?:Field|Value|Data|PII)\s*\(|EncryptedType|encrypts\s+:|@Encrypted)/,
    present: "Application-level encryption or a key-management service is used.", missing: "No application-level encryption or key management was found. Database or disk encryption may still exist in the hosting platform, where this analysis cannot see it." },
  { key: "logging", name: "Structured logging", domain: "security", deps: /^(pino|winston|bunyan|log4js|signale|consola|structlog|loguru|logrus|zap|zerolog|serilog|nlog|slf4j-api|logback-classic)$/i, text: /\blogging\.getLogger\(|\bLoggerFactory\.getLogger\(|\blog\/slog\b/,
    present: "A structured logging library is in use.", missing: "No structured logging library was found; security events may not be recorded in a form that can be monitored." },
  { key: "audit", name: "Audit trail of sensitive actions", domain: "security", text: /\b(?:audit[_-]?log|auditLog|AuditLog|audit_trail|auditTrail|AuditEvent|recordAudit|logAudit|paper_trail|django-simple-history|auditable)\b/i,
    present: "An audit log of sensitive actions exists.", missing: "No audit trail was found, so it would be hard to establish who changed or viewed data after an incident." },
  { key: "dependency-scanning", literal: true, name: "Dependency vulnerability scanning", domain: "security", paths: /(^|\/)(\.github|\.gitlab|\.circleci|\.azure|ci|\.buildkite)\/|dependabot|renovate|\.gitlab-ci|Jenkinsfile|package\.json$|Makefile$/i, text: /(?:dependabot|renovate|npm audit|pnpm audit|yarn audit|pip-audit|safety check|osv-scanner|snyk|trivy|grype|github\/codeql-action|bundler-audit|cargo audit|govulncheck|audit-ci|socket\.dev)/i,
    present: "Dependencies are scanned for known vulnerabilities in CI or by a bot.", missing: "No dependency vulnerability scanning (Dependabot, Renovate, npm audit, pip-audit, OSV, Snyk, Trivy) was found." },
  { key: "secret-scanning", literal: true, name: "Secret scanning", domain: "security", paths: /(^|\/)(\.github|\.gitlab|\.circleci|ci)\/|\.pre-commit-config|\.gitleaks|\.trufflehog|\.husky\/|lefthook|package\.json$/i, text: /(?:gitleaks|trufflehog|detect-secrets|git-secrets|ggshield|secretlint)/i,
    present: "Commits are scanned for leaked secrets.", missing: "No secret scanning (gitleaks, trufflehog, detect-secrets) was found in CI or pre-commit hooks." },
  { key: "log-redaction", name: "Redaction of personal data in logs", domain: "privacy", text: /(?:\bredact\s*:|redactPaths|\bmask(?:Email|Phone|Pii|Sensitive|Card)\w*\s*\(|scrub(?:Pii|Sensitive|Data)\w*\s*\(|sanitize(?:Log|Pii)\w*\s*\(|filter_parameters|SensitiveDataFilter|before_send|beforeSend\s*[:(]|sendDefaultPii\s*:\s*false|send_default_pii\s*=\s*False|redact(?:Pii|Sensitive|Secrets)\s*\()/,
    present: "Logs or error reports redact or mask personal data.", missing: "No log redaction or masking was found; personal data written to logs or error trackers is stored in clear." },
  { key: "response-filtering", literal: true, name: "Sensitive fields kept out of responses", domain: "privacy", text: /(?:exclude\s*:\s*\[[^\]]*['"](?:password|passwordHash|password_hash)['"]|select\s*:\s*false|@Exclude\(\)|@JsonIgnore|write_only\s*=\s*True|['"]?password['"]?\s*:\s*false|omit\([^)]*password|\$hidden\s*=|hidden\s*=\s*\[|toJSON\s*\(\s*\)\s*\{[^}]*delete[^}]*password|defaultScope\s*:\s*\{\s*attributes)/is,
    present: "Serialisers or queries keep secrets such as password hashes out of API responses.", missing: "No field exclusion was found for password hashes or other secrets in API responses." },
  { key: "erasure", name: "Right to erasure (account deletion)", domain: "privacy", text: /\b(?:delete(?:User|Account|Customer|Profile|Me|MyAccount|PersonalData)|destroy(?:User|Account)|remove(?:User|Account)|erase(?:User|Account|PersonalData)?|anonymi[sz]e(?:User|Account|Customer|Data)?|forget(?:Me|User)|purge(?:User|PersonalData)|right[_-]?to[_-]?(?:be[_-]?)?forgotten|gdpr[_-]?delete)\b/,
    present: "A path to delete or anonymise a person's data exists.", missing: "No account deletion or anonymisation path was found; honouring erasure requests would need manual database work." },
  { key: "export", name: "Data access and portability (DSAR)", domain: "privacy", text: /\b(?:export(?:User|Account|My|Personal|Customer)Data|downloadMyData|dataExport|subject[_-]?access|dsar|dataPortability|takeout)\b/i,
    present: "People can obtain a copy of their data.", missing: "No data export for subject access or portability requests was found." },
  { key: "consent", name: "Consent and preference records", domain: "privacy", deps: /^(vanilla-cookieconsent|react-cookie-consent|cookieconsent|@cookiehub\/|klaro|osano|onetrust)$/i, text: /\b(?:consent(?:Given|edAt|Status|Record|s)?|cookieConsent|marketingOptIn|opt_?in|optedIn|gdprConsent|acceptedTermsAt|termsAcceptedAt|privacyAcceptedAt|onetrust|cookiebot)\b/,
    present: "Consent or marketing preferences are recorded.", missing: "No consent or preference record was found (cookies, marketing, terms acceptance)." },
  { key: "retention", name: "Data retention and deletion schedule", domain: "privacy", text: /\b(?:retention(?:Days|Period|Policy)?|expireAfterSeconds|data_retention|purge(?:Old|Expired|Stale|Inactive)\w*|delete(?:Old|Expired|Stale|Inactive)\w*|cleanup(?:Old|Expired|Stale|Inactive)\w*|prune(?:Old|Expired)\w*)\b/,
    present: "Old data is deleted on a schedule or expires automatically.", missing: "No retention rule was found; personal data appears to be kept indefinitely." },
  { key: "privacy-notice", name: "Privacy notice or data-handling documentation", domain: "privacy", paths: /(^|\/)(privacy|privacy[-_]policy|privacy[-_]notice|data[-_]protection|gdpr|ropa|data[-_]handling|sub[-_]?processors)(\.(md|mdx|txt|html|rst)|\/|$)|(^|\/)(pages|app|routes|views|templates|public)\/(.*\/)?(privacy|privacy[-_]policy)(\.|\/)/i, text: /./,
    present: "A privacy notice or data-handling document is part of the repository.", missing: "No privacy notice or data-handling documentation was found in the repository (it may live elsewhere, for example on the website)." },
];

const SCANNED = new Set(["source", "config", "schema", "ci", "infra", "manifest", "docs"]);

/** Detect which controls the repository shows evidence of. Pure: no file is executed and nothing leaves the process. */
export function detectControls(files: ScanFile[], arch: Architecture): Control[] {
  const pool = files.filter((f) => !f.isExcluded && !f.isGenerated && !f.isTest && f.text && SCANNED.has(f.classification) && f.text.length < 1_500_000);
  const deps = arch.dependencies.map((d) => d.name);
  const out: Control[] = [];

  const authLibs = arch.dependencies.filter((d) => /^(next-auth|@auth\/|passport|jsonwebtoken|jose|@clerk\/|@auth0\/|express-jwt|express-session|lucia|better-auth|iron-session|django-allauth|flask-login|flask-jwt-extended|authlib|python-jose|pyjwt|djangorestframework-simplejwt|devise|omniauth|golang-jwt|spring-security|firebase-admin|@supabase\/auth)/i.test(d.name)).map((d) => d.name);
  const authServices = arch.externalServices.filter((s) => s.category === "auth").map((s) => s.name);
  const guarded = arch.routes.filter((r) => r.auth === "authenticated");
  const api = arch.routes.filter((r) => r.kind === "api");
  out.push({
    key: "authn", name: "Authentication", domain: "security",
    status: authLibs.length || authServices.length || guarded.length ? (api.length && guarded.length < api.length / 3 && !authServices.length ? "partial" : "present") : api.length ? "missing" : "na",
    detail: authLibs.length || authServices.length ? `Uses ${[...authServices, ...authLibs].slice(0, 4).join(", ")}${api.length ? `; ${guarded.length} of ${api.length} API routes show a check at their definition` : ""}.` : guarded.length ? `Custom checks guard ${guarded.length} of ${api.length} API routes.` : api.length ? "No authentication library, provider or route guard was found." : "The project exposes no API routes.",
    evidence: guarded.slice(0, 3).map((r) => ({ path: r.file, line: r.line })),
  });

  for (const p of PROBES) {
    const evidence: Loc[] = [];
    const depHits = p.deps ? deps.filter((d) => p.deps!.test(d)) : [];
    if (p.text) {
      const pathOnly = p.text.source === ".";
      for (const f of pool) {
        if (evidence.length >= 3) break;
        if (p.paths && !p.paths.test(f.path)) continue;
        if (pathOnly) { evidence.push({ path: f.path }); continue; }
        if (f.classification === "docs") continue;
        const line = matchLine(f, p.text, !!p.literal);
        if (line) evidence.push({ path: f.path, line });
      }
    }
    const found = depHits.length > 0 || evidence.length > 0;
    out.push({ key: p.key, name: p.name, domain: p.domain, status: found ? "present" : "missing", detail: found ? `${p.present}${depHits.length ? ` (${depHits.slice(0, 3).join(", ")})` : ""}` : p.missing, evidence });
  }

  const lock = files.some((f) => /^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|Pipfile\.lock|uv\.lock|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock)$/.test(f.name ?? f.path.split("/").pop() ?? ""));
  out.push({ key: "lockfile", name: "Pinned dependency versions (lock file)", domain: "security", status: lock ? "present" : arch.dependencies.length ? "missing" : "na", detail: lock ? "A lock file pins the exact version of every dependency." : "No lock file was found, so builds can pick up new, untested or compromised dependency versions.", evidence: [] });

  // Credentials in tests and fixtures are reported by the review at low severity; they do not make this control a gap.
  const testPaths = new Set(files.filter((f) => f.isTest).map((f) => f.path));
  const committed = arch.secrets.filter((x) => !testPaths.has(x.path) && !/(^|\/)(tests?|__tests__|spec|e2e|fixtures?|mocks?|__mocks__|examples?|samples?)\//i.test(x.path));
  const sensitiveEnv = arch.envVars.filter((e) => e.sensitive && e.files.length);
  out.push({ key: "secrets-management", name: "Secrets kept out of source", domain: "security", status: committed.length ? "gap" : sensitiveEnv.length ? "present" : "na", detail: committed.length ? `${committed.length} value(s) that look like credentials are committed in source.` : sensitiveEnv.length ? `Credentials are read from the environment (${sensitiveEnv.slice(0, 4).map((e) => e.name).join(", ")}).` : "No credentials are used or none were found.", evidence: (committed.length ? committed.slice(0, 3).map((s) => ({ path: s.path, line: s.line })) : sensitiveEnv.slice(0, 3).map((e) => e.files[0])) });
  return out;
}

const COMMENT = /^\s*(\/\/|#|\*|\/\*|<!--|--\s)/;
const blanked = new WeakMap<ScanFile, string[]>();

/**
 * The first line where `re` matches. Comments are skipped, and so are regular-expression literals: code that looks for
 * a control (a scanner, a linter, this module) must not count as the control itself. By default string contents are
 * blanked too, so an identifier or call has to be in the code; `literal` keeps strings for header names and config values.
 */
function matchLine(f: ScanFile, re: RegExp, literal: boolean): number | undefined {
  const raw = f.text!.split("\n");
  const code = blanked.get(f) ?? blankLines(raw);
  blanked.set(f, code);
  const isCode = f.classification === "source" || f.classification === "schema";
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].length > 2000 || COMMENT.test(raw[i])) continue;
    if (!isCode) { if (re.test(raw[i])) return i + 1; continue; }
    if (literal ? !code[i].includes("/re/") && re.test(raw[i]) : re.test(code[i])) return i + 1;
  }
  return undefined;
}
