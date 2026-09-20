/**
 * Lightweight secret detection. Findings are used to redact model-bound
 * context and to raise a security finding. Values are never persisted.
 */
export interface SecretMatch {
  kind: string;
  line: number;
  /** Redacted preview safe to display. */
  preview: string;
}

const PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "AWS Access Key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "GitHub Token", re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { kind: "GitHub Fine-grained Token", re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  { kind: "Anthropic API Key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "OpenAI API Key", re: /\bsk-(proj-)?[A-Za-z0-9_-]{32,}\b/g },
  { kind: "Stripe Key", re: /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{16,}\b/g },
  { kind: "Slack Token", re: /\bxox[abpors]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "Google API Key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "Twilio Key", re: /\bSK[0-9a-fA-F]{32}\b/g },
  { kind: "SendGrid Key", re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
  { kind: "Private Key", re: /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY( BLOCK)?-----/g },
  { kind: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: "Connection String", re: /\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis|amqp|mssql):\/\/[^\s:@/]+:[^\s@/]+@[^\s'"]+/gi },
  { kind: "Password Assignment", re: /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*['"][^'"\s]{8,}['"]/gi },
  { kind: "Bearer Token", re: /\bBearer\s+[A-Za-z0-9._-]{24,}\b/g },
];

const PLACEHOLDER = /(example|placeholder|your[_-]?|xxx|change[-_]?me|dummy|sample|redacted|<[^>]+>|\$\{|process\.env|os\.environ|getenv|\{\{)/i;
const TEMPLATE_FILE = /\.(example|sample|template|dist|tmpl)$|(^|\/)\.env\.(example|sample|template|dist)$/i;
const LOCAL_HOST = /@(localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal|db|postgres|redis|mysql|mongo)(:\d+)?([/?\s'"]|$)/i;

function redact(value: string): string {
  if (value.length <= 8) return "****";
  return value.slice(0, 4) + "…" + "*".repeat(Math.min(8, value.length - 6)) + value.slice(-2);
}

export function detectSecrets(text: string, filePath = ""): SecretMatch[] {
  if (TEMPLATE_FILE.test(filePath)) return [];
  if (/\.(md|mdx|txt|lock)$/i.test(filePath) && !/env/i.test(filePath)) return scan(text).filter((m) => m.kind !== "Password Assignment");
  return scan(text);
}

function scan(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (line.length > 2000) return;
    for (const { kind, re } of PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line))) {
        if (PLACEHOLDER.test(m[0]) || PLACEHOLDER.test(line)) continue;
        if (kind === "OpenAI API Key" && /sk-ant-/.test(m[0])) continue;
        if (kind === "Connection String" && LOCAL_HOST.test(m[0] + " ")) continue;
        matches.push({ kind, line: i + 1, preview: redact(m[0]) });
      }
    }
  });
  return matches;
}

/** Replace likely secret values so they never reach a model or a log. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const { re } of PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, (match) => {
      if (PLACEHOLDER.test(match)) return match;
      return "[REDACTED_SECRET]";
    });
  }
  return out;
}
