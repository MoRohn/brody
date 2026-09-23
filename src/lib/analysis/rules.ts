import type { Category, Confidence, FindingDraft, Severity } from "../review/types";

/** A deterministic pattern rule. Rules only fire on matched source text. */
export interface Rule {
  id: string;
  title: string;
  category: Category;
  severity: Severity;
  confidence: Confidence;
  languages: string[] | "*";
  pattern: RegExp;
  /** Match against code only: string, template and regex literal contents and trailing comments are blanked first. */
  codeOnly?: boolean;
  /** With codeOnly: a comment inside the matched source lines means the construct is deliberate (an explained empty catch). */
  commentExcuses?: boolean;
  /** Report at most one occurrence per file (the message notes how many more there are). */
  perFile?: boolean;
  /** Skip files whose path matches (CLI scripts, tooling). */
  skipPaths?: RegExp;
  /** Return true to suppress the match (e.g. surrounded by a safe context). */
  suppress?: (line: string, context: string) => boolean;
  whatHappens: string;
  whyItMatters: string;
  businessImpact?: string;
  remediation: string;
}

const JS = ["TypeScript", "JavaScript"];

export const RULES: Rule[] = [
  { id: "eval", codeOnly: true, title: "Dynamic code evaluation with eval()", category: "Security", severity: "High", confidence: "High", languages: [...JS, "Python", "Ruby", "PHP"], pattern: /(?<![.\w])eval\s*\(\s*(?!['"`][^'"`]*['"`]\s*\))/,
    whatHappens: "The code passes a runtime value to eval(), which executes it as program code.", whyItMatters: "If any part of that value is influenced by a user or an external system, an attacker can run arbitrary code with the application's privileges.", businessImpact: "Potential full compromise of the server or user session, with exposure of customer data.", remediation: "Replace eval() with a safe parser (JSON.parse, ast.literal_eval) or an explicit dispatch table of permitted operations." },
  { id: "new-function", codeOnly: true, title: "Dynamic code construction with new Function()", category: "Security", severity: "High", confidence: "Medium", languages: JS, pattern: /new\s+Function\s*\(/,
    whatHappens: "A function body is assembled from a string at runtime.", whyItMatters: "This has the same injection risk as eval() whenever the string contains untrusted data.", remediation: "Use static functions or a lookup table of allowed handlers instead of compiling strings." },
  { id: "child-process-exec", codeOnly: true, title: "Shell command executed with interpolated input", category: "Security", severity: "High", confidence: "Medium", languages: JS, pattern: /(?:(?<![.\w])|\b(?:child_process|cp|childProcess|shell|sh)\.)(?:exec|execSync)\s*\(\s*(?:`[^`]*\$\{|[^,)]*\+\s*\w|[a-zA-Z_]\w*\s*[,)])/,
    whatHappens: "A shell command string is built from a variable or template and passed to exec/execSync, which runs it through a shell.", whyItMatters: "Shell metacharacters in the interpolated value can inject additional commands (command injection).", businessImpact: "Attackers may execute commands on the host, read secrets or pivot into internal systems.", remediation: "Use execFile/spawn with an argument array and no shell, and validate any user-supplied values against an allow-list." },
  { id: "python-shell", codeOnly: true, title: "Shell execution with shell=True or os.system", category: "Security", severity: "High", confidence: "Medium", languages: ["Python"], pattern: /(?:subprocess\.\w+\([^)]*shell\s*=\s*True|os\.system\s*\(|os\.popen\s*\()/,
    whatHappens: "A command is run through the system shell.", whyItMatters: "If any argument contains user-controlled text the shell interprets metacharacters, enabling command injection.", remediation: "Pass an argument list to subprocess.run without shell=True, and validate inputs." },
  { id: "pickle-load", codeOnly: true, title: "Unsafe deserialization with pickle/marshal/yaml.load", category: "Security", severity: "High", confidence: "Medium", languages: ["Python"], pattern: /\b(?:pickle|cPickle|marshal|dill|shelve)\.loads?\(|yaml\.load\((?![^)]*Loader\s*=\s*(?:yaml\.)?(?:Safe|CSafe))/,
    whatHappens: "Data is deserialised with a format that can instantiate arbitrary objects.", whyItMatters: "Deserialising untrusted bytes can run attacker-chosen code.", remediation: "Use JSON or yaml.safe_load, and never unpickle data from untrusted sources." },
  { id: "sql-concat", title: "SQL query assembled by string concatenation or interpolation", category: "Security", severity: "High", confidence: "Medium", languages: "*", pattern: /(?:query|execute|exec|raw|prepare|\.run|\.all|\.get)\s*\(\s*(?:`[^`]*\b(?:select|insert|update|delete)\b[^`]*\$\{|f?["'][^"']*\b(?:select|insert|update|delete)\b[^"']*["']\s*(?:\+|%|\.format)|f["'][^"']*\b(?:select|insert|update|delete)\b[^"']*\{)/i,
    whatHappens: "A SQL statement is built by embedding variables directly into the query string.", whyItMatters: "Any embedded value that originates from a request can alter the query structure (SQL injection).", businessImpact: "Attackers can read, modify or delete stored customer data.", remediation: "Use parameterised queries or the ORM's bound-parameter API, never string interpolation." },
  { id: "tls-verify-off", title: "TLS certificate verification disabled", category: "Security", severity: "High", confidence: "High", languages: "*", pattern: /(?:rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true|CURLOPT_SSL_VERIFYPEER\s*,\s*(?:false|0)|ServerCertificateValidationCallback\s*=.*true)/,
    whatHappens: "Certificate validation is switched off for outbound HTTPS connections.", whyItMatters: "Connections become vulnerable to man-in-the-middle interception, exposing credentials and data in transit.", remediation: "Remove the override; if a private CA is required, add it to the trust store instead." },
  { id: "weak-hash", title: "Weak hash algorithm (MD5/SHA-1)", category: "Security", severity: "Medium", confidence: "Medium", languages: "*", pattern: /(?:createHash\(\s*['"](?:md5|sha1)['"]|hashlib\.(?:md5|sha1)\(|MessageDigest\.getInstance\(\s*"(?:MD5|SHA-?1)"|md5\.New\(\)|sha1\.New\(\)|MD5\.Create\(\)|SHA1\.Create\(\)|Digest::(?:MD5|SHA1))/i,
    whatHappens: "MD5 or SHA-1 is used to compute a digest.", whyItMatters: "Both algorithms are collision-prone; if used for passwords, signatures or integrity checks they provide weak protection.", remediation: "Use SHA-256 or better for integrity, and bcrypt/scrypt/argon2 for passwords." },
  { id: "weak-random", perFile: true, title: "Non-cryptographic randomness used for a secret", category: "Security", severity: "Medium", confidence: "Low", languages: [...JS, "Python"], pattern: /(?:(?:token|secret|password|nonce|session|apikey|api_key|otp|salt|key)\w*\s*[:=][^;\n]*Math\.random\(|Math\.random\(\)[^;\n]*(?:token|secret|password|nonce|session)|(?:token|secret|password|nonce|session|otp|salt)\w*\s*=[^\n]*random\.(?:random|randint|choice)\()/i,
    whatHappens: "A token or secret-like value is derived from a predictable random number generator.", whyItMatters: "Attackers who observe a few outputs can predict later values.", remediation: "Use crypto.randomBytes/crypto.randomUUID or Python's secrets module." },
  { id: "innerhtml", codeOnly: true, title: "Unescaped HTML injection sink (innerHTML / dangerouslySetInnerHTML)", category: "Security", severity: "Medium", confidence: "Medium", languages: [...JS, "HTML", "Vue", "Svelte"], pattern: /(?:\.innerHTML\s*=(?!\s*['"`]\s*['"`]\s*;?$)|dangerouslySetInnerHTML|v-html\s*=|\{@html\b|document\.write\s*\()/,
    whatHappens: "HTML is written into the page without escaping.", whyItMatters: "If the string contains user-controlled content it can execute script in the visitor's browser (cross-site scripting).", businessImpact: "Session theft and account takeover for affected users.", remediation: "Render text through the framework's escaping, or sanitise with a vetted library such as DOMPurify before injecting HTML." },
  { id: "cors-wildcard", title: "CORS allows every origin", category: "Security", severity: "Medium", confidence: "Medium", languages: "*", pattern: /(?:Access-Control-Allow-Origin['"]?\s*[:,]\s*['"]\*['"]|origin\s*:\s*['"]\*['"]|allow_origins\s*=\s*\[\s*['"]\*['"]|AllowAnyOrigin\(\)|cors\(\s*\))/i,
    whatHappens: "The server permits cross-origin requests from any website.", whyItMatters: "If cookies or tokens grant access, any malicious page can call the API on behalf of a signed-in user.", remediation: "Restrict allowed origins to the known front-end hosts." },
  { id: "debug-on", codeOnly: true, title: "Debug mode enabled in application code", category: "Operations", severity: "Medium", confidence: "Medium", languages: ["Python", ...JS, "Ruby", "PHP"], pattern: /(?:\bDEBUG\s*=\s*True\b|app\.run\([^)]*debug\s*=\s*True|\bdebug\s*:\s*true\b(?=[^\n]*(?:express|app|server))|config\.consider_all_requests_local\s*=\s*true)/,
    whatHappens: "Debug mode is hard-coded on.", whyItMatters: "Debug mode can expose stack traces, environment data and interactive consoles in production.", remediation: "Drive debug flags from environment configuration and default them to off." },
  { id: "jwt-none", title: "JWT signature verification bypass", category: "Security", severity: "High", confidence: "Medium", languages: "*", pattern: /(?:algorithms\s*[:=]\s*\[\s*['"]none['"]|verify_signature['"]?\s*[:=]\s*False|jwt\.decode\([^)]*verify\s*=\s*False|ignoreExpiration\s*:\s*true)/i,
    whatHappens: "Token verification is configured to skip signature or expiry validation.", whyItMatters: "Forged or expired tokens would be accepted as valid.", remediation: "Always verify signature and expiry with a fixed, explicit algorithm allow-list." },
  { id: "hardcoded-password", title: "Hard-coded credential in source", category: "Security", severity: "High", confidence: "Medium", languages: "*", pattern: /(?:password|passwd|secret|api[_-]?key|auth[_-]?token)\s*[:=]\s*['"](?!\s*['"])(?![^'"]*(?:example|placeholder|changeme|your|xxx|test|dummy|env|\$\{|<|\{\{))[^'"\s]{8,}['"]/i,
    suppress: (l) => /process\.env|os\.environ|getenv|process\.argv|\.env\b/.test(l),
    whatHappens: "A credential-like literal is embedded in source code.", whyItMatters: "Anyone with repository access, or any leak of the code, obtains the credential.", businessImpact: "Unauthorised access to the protected system until the secret is rotated.", remediation: "Move the value to environment configuration or a secrets manager and rotate the exposed credential." },
  { id: "path-join-user", title: "Filesystem path built from request input", category: "Security", severity: "Medium", confidence: "Low", languages: "*", pattern: /(?:readFile(?:Sync)?|createReadStream|sendFile|open|writeFile(?:Sync)?|unlink(?:Sync)?)\s*\([^)\n]*(?:req\.(?:params|query|body)|request\.(?:args|form|GET|POST)|params\[|r\.URL\.Query)/,
    whatHappens: "A file path is composed directly from request parameters.", whyItMatters: "Without normalisation and a base-directory check, '../' sequences let callers read or overwrite arbitrary files (path traversal).", remediation: "Resolve the path, verify it stays inside an allowed base directory, and reject anything else." },
  { id: "open-redirect", title: "Redirect target taken from request input", category: "Security", severity: "Medium", confidence: "Low", languages: "*", pattern: /(?:res\.redirect|redirect|Redirect|sendRedirect|HttpResponseRedirect)\s*\(\s*(?:req\.(?:query|body|params)|request\.(?:args|GET|POST|form)|params\[)/,
    whatHappens: "The redirect destination comes directly from a request parameter.", whyItMatters: "Attackers can craft links on the trusted domain that forward victims to phishing sites.", remediation: "Validate the target against an allow-list of internal paths or hosts." },
  { id: "ssrf", title: "Outbound request URL derived from request input", category: "Security", severity: "Medium", confidence: "Low", languages: "*", pattern: /(?:fetch|axios(?:\.\w+)?|got|requests\.(?:get|post|put|head)|http\.Get|urlopen|HttpClient\.\w+Async|RestTemplate\.\w+)\s*\(\s*(?:req\.(?:query|body|params)|request\.(?:args|GET|POST|form|json)|params\[|body\[|input\.)/,
    whatHappens: "The server fetches a URL that the caller controls.", whyItMatters: "Attackers can make the server reach internal services or cloud metadata endpoints (server-side request forgery).", remediation: "Allow-list destination hosts, block private/link-local ranges and disable redirects." },
  { id: "empty-catch", codeOnly: true, commentExcuses: true, title: "Exception swallowed by an empty catch/except block", category: "Reliability", severity: "Low", confidence: "High", languages: [...JS, "Java", "C#", "PHP"], pattern: /catch\s*(?:\([^)]*\))?\s*\{\s*\}/gs,
    whatHappens: "An error is caught and discarded with no logging or handling.", whyItMatters: "Failures become invisible, so partial or corrupted state can persist unnoticed and debugging becomes guesswork.", remediation: "Log the error with context, handle the specific failure, or rethrow." },
  { id: "python-bare-except", codeOnly: true, title: "Bare except clause hides all errors", category: "Reliability", severity: "Low", confidence: "High", languages: ["Python"], pattern: /^\s*except\s*:\s*(?:pass\s*)?$/,
    whatHappens: "All exceptions, including KeyboardInterrupt and SystemExit, are caught without discrimination.", whyItMatters: "Programming errors and shutdown signals are masked, leaving the process in unpredictable states.", remediation: "Catch specific exception types and log them." },
  { id: "python-except-pass", codeOnly: true, title: "Exception swallowed with pass", category: "Reliability", severity: "Low", confidence: "Medium", languages: ["Python"], pattern: /except\s+[\w.,() ]+(?:\s+as\s+\w+)?\s*:\s*pass\b/,
    whatHappens: "An exception is caught and silently ignored.", whyItMatters: "Errors disappear without a trace, hiding data-loss and state-corruption bugs.", remediation: "Log the exception or handle it explicitly." },
  { id: "unhandled-promise", perFile: true, codeOnly: true, title: "Promise chain without rejection handling", category: "Reliability", severity: "Low", confidence: "Low", languages: JS, pattern: /\.then\([^)]*\)\s*;?\s*$/,
    suppress: (l, ctx) => /\.catch\(|await |return |void /.test(l) || /\.catch\(/.test(ctx),
    whatHappens: "A promise is chained with then() and no catch() or await is visible.", whyItMatters: "A rejection becomes an unhandled promise rejection, which can crash Node.js processes or silently drop work.", remediation: "Use async/await inside try/catch or append a catch() handler." },
  { id: "todo-fixme", perFile: true, title: "Unresolved TODO/FIXME marker", category: "Maintainability", severity: "Informational", confidence: "High", languages: "*", pattern: /(?:\/\/|#|\/\*|<!--)\s*(?:TODO|FIXME|HACK|XXX)\b[:\s]/,
    whatHappens: "A comment records unfinished or known-problematic work.", whyItMatters: "Deferred work accumulates as technical debt unless tracked.", remediation: "Convert the marker to a tracked issue or resolve it." },
  { id: "console-log", skipPaths: /(^|\/)(scripts?|bin|cli|tools?|migrations?|drizzle|config|setup)(\/|\.)|\.(mts|cjs)$|\.config\.[a-z]+$/, perFile: true, title: "Debug output left in code", category: "Operations", severity: "Informational", confidence: "Medium", languages: JS, pattern: /console\.(?:log|debug)\(/,
    whatHappens: "console.log/debug calls are present in non-test code.", whyItMatters: "Unstructured output pollutes logs and can leak sensitive values.", remediation: "Route through a structured logger with levels and redaction." },
  { id: "sync-io", skipPaths: /(^|\/)(scripts?|bin|cli|tools?|migrations?|drizzle|config|setup)(\/|\.)|\.(mts|cjs)$|\.config\.[a-z]+$/, perFile: true, title: "Blocking synchronous I/O in server code", category: "Performance", severity: "Low", confidence: "Low", languages: JS, pattern: /\b(?:readFileSync|writeFileSync|readdirSync|statSync|existsSync|execSync|spawnSync)\(/,
    suppress: (_l, ctx) => /^(?:\s*(?:\/\/|\*)|.*(?:scripts?|migrat|config|setup|build|cli|bin)\/)/.test(ctx),
    whatHappens: "A synchronous filesystem or process call runs on the event loop.", whyItMatters: "While it runs, the Node.js process cannot serve any other request, degrading latency under load.", remediation: "Use the async fs.promises / child_process equivalents in request paths." },
  { id: "loop-await", perFile: true, codeOnly: true, title: "Sequential await inside a loop", category: "Performance", severity: "Low", confidence: "Low", languages: JS, pattern: /for\s*\((?![^)]*\b(?:attempt|retr|tries)\w*)[^)]*\)\s*\{[^}]*\bawait\b[^}]*(?:fetch|query|find|get|save|create|update|delete|axios|request)\w*\(/s,
    whatHappens: "Iterations wait for each asynchronous call in turn.", whyItMatters: "Total time grows linearly with the number of items, and database/network calls in a loop are a classic N+1 pattern.", remediation: "Batch the operation or run independent calls with Promise.all and bounded concurrency." },
  { id: "select-star", perFile: true, title: "SELECT * returns every column", category: "Performance", severity: "Informational", confidence: "Medium", languages: "*", pattern: /select\s+\*\s+from/i,
    whatHappens: "A query selects all columns of a table.", whyItMatters: "It transfers unused data and makes the code brittle when columns are added.", remediation: "List only the required columns." },
  { id: "float-money", perFile: true, title: "Floating-point arithmetic on money-like values", category: "Correctness", severity: "Low", confidence: "Low", languages: "*", pattern: /(?:price|amount|total|balance|cost|fee|tax|salary|payment)\w*\s*[:=]\s*(?:parseFloat|Number|float|double)\(|(?:price|amount|total|balance|cost)\w*\s*\*\s*(?:0?\.\d+|1\.\d+)/i,
    whatHappens: "Monetary quantities appear to be handled as binary floating-point numbers.", whyItMatters: "Rounding error accumulates and can produce off-by-a-cent discrepancies in totals.", remediation: "Represent money as integer minor units or a decimal type." },
  { id: "http-plain", perFile: true, title: "Plain HTTP URL used for an external call", category: "Security", severity: "Low", confidence: "Low", languages: "*", pattern: /['"`]http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal|[\w-]+:\d+|.*\$\{|\$[A-Za-z_]|www\.w3\.org|schemas\.|json-schema\.org|example\.)[^'"`\s]+['"`]/,
    whatHappens: "An unencrypted http:// endpoint is referenced.", whyItMatters: "Traffic can be read or altered in transit.", remediation: "Use https:// endpoints." },
  { id: "cookie-insecure", codeOnly: true, title: "Cookie set without Secure/HttpOnly protections", category: "Security", severity: "Medium", confidence: "Low", languages: "*", pattern: /(?:secure\s*:\s*false|httpOnly\s*:\s*false|httponly\s*=\s*False|SESSION_COOKIE_SECURE\s*=\s*False|samesite\s*[:=]\s*['"]none['"])/i,
    whatHappens: "Cookie flags that protect session cookies are explicitly disabled.", whyItMatters: "Cookies become readable by scripts or sendable over plain HTTP, increasing session theft risk.", remediation: "Enable Secure, HttpOnly and an appropriate SameSite policy." },
  { id: "csrf-disabled", codeOnly: true, title: "CSRF protection disabled", category: "Security", severity: "Medium", confidence: "Medium", languages: "*", pattern: /(?:@csrf_exempt|csrf\(\)\.disable\(\)|\.csrf\(\s*(?:csrf\s*->\s*csrf\.)?disable|WTF_CSRF_ENABLED\s*=\s*False|skip_before_action\s*:verify_authenticity_token|protect_from_forgery\s+with:\s*:null_session|\[IgnoreAntiforgeryToken\])/,
    whatHappens: "Cross-site request forgery checks are turned off for an endpoint or globally.", whyItMatters: "A malicious site can trigger state-changing requests using a victim's browser session.", remediation: "Enable CSRF tokens or use SameSite cookies with custom header verification for cookie-authenticated endpoints." },
  { id: "go-unchecked-err", codeOnly: true, title: "Go error value discarded", category: "Reliability", severity: "Low", confidence: "Medium", languages: ["Go"], pattern: /^\s*_\s*(?:,\s*_\s*)?=\s*\w+(?:\.\w+)*\(/,
    whatHappens: "The error return of a call is assigned to the blank identifier.", whyItMatters: "Failures are ignored, potentially leaving partial state.", remediation: "Check and handle or wrap the returned error." },
  { id: "java-printstack", codeOnly: true, title: "Stack trace printed instead of logged", category: "Operations", severity: "Informational", confidence: "High", languages: ["Java", "Kotlin"], pattern: /\.printStackTrace\(\)/,
    whatHappens: "Exceptions are printed to standard error.", whyItMatters: "Output bypasses the logging pipeline, losing context and structure.", remediation: "Log through the application logger with the exception attached." },
  { id: "dotnet-async-void", codeOnly: true, title: "async void method", category: "Reliability", severity: "Low", confidence: "Medium", languages: ["C#"], pattern: /\basync\s+void\s+(?!.*(?:_Click|_Changed|EventHandler|Handler|OnPropertyChanged))\w+\s*\(/,
    whatHappens: "An asynchronous method returns void instead of Task.", whyItMatters: "Exceptions cannot be observed by callers and can crash the process.", remediation: "Return Task and await it." },
  { id: "rails-html-safe", codeOnly: true, title: "html_safe / raw disables output escaping", category: "Security", severity: "Medium", confidence: "Medium", languages: ["Ruby"], pattern: /\.html_safe\b|\braw\s*\(?\s*[@\w]/,
    whatHappens: "Rails output escaping is bypassed for a value.", whyItMatters: "If the value contains user input it enables cross-site scripting.", remediation: "Remove html_safe/raw or sanitise the content first." },
  { id: "php-extract", codeOnly: true, title: "PHP variable injection / dangerous sink", category: "Security", severity: "Medium", confidence: "Medium", languages: ["PHP"], pattern: /\b(?:extract\s*\(\s*\$_(?:GET|POST|REQUEST)|(?:include|require)(?:_once)?\s*\(?\s*\$_(?:GET|POST|REQUEST)|unserialize\s*\(\s*\$_(?:GET|POST|REQUEST|COOKIE)|shell_exec\s*\(|passthru\s*\(|system\s*\(\s*\$)/,
    whatHappens: "Request data flows into a dangerous PHP function.", whyItMatters: "This can lead to file inclusion, object injection or command execution.", remediation: "Never pass request data to these functions; validate against allow-lists." },
  { id: "rust-unsafe", codeOnly: true, title: "unsafe block", category: "Correctness", severity: "Informational", confidence: "High", languages: ["Rust"], pattern: /\bunsafe\s*\{/,
    whatHappens: "Memory-safety guarantees are suspended inside an unsafe block.", whyItMatters: "Bugs in unsafe code can cause undefined behaviour.", remediation: "Document the safety invariants and keep unsafe surface minimal." },
  { id: "rust-unwrap", codeOnly: true, title: "unwrap()/expect() can panic at runtime", category: "Reliability", severity: "Low", confidence: "Low", languages: ["Rust"], pattern: /\.unwrap\(\)/,
    suppress: (_l, ctx) => /test|examples?\/|benches?\//.test(ctx),
    whatHappens: "A Result/Option is unwrapped without handling the failure case.", whyItMatters: "Unexpected input causes a panic that terminates the thread or process.", remediation: "Propagate the error with ? or handle it explicitly." },
];

/**
 * Blank the contents of string, template and regex literals and drop trailing // comments so code
 * rules only see code. Deliberately simple and line based, except that a template literal may span lines (an embedded
 * script or HTML page): `blankLines` carries that state, so the middle lines of a template are blanked too.
 */
export function blankLiterals(line: string): string {
  return blankLine(line, false).out;
}

/** Blank a whole file, carrying the open-template state from line to line. */
export function blankLines(lines: string[]): string[] {
  let inTemplate = false;
  return lines.map((l) => { const r = blankLine(l, inTemplate); inTemplate = r.inTemplate; return r.out; });
}

/** Skip the rest of a template literal from `i`; returns where it closed, or -1 if it runs past the end of the line. */
function templateEnd(line: string, i: number, emit: (s: string) => void): number {
  while (i < line.length && line[i] !== "`") {
    if (line[i] === "\\") { i += 2; continue; }
    // Interpolations inside template literals are code: keep them so injection patterns still match.
    if (line[i] === "$" && line[i + 1] === "{") {
      let depth = 0;
      while (i < line.length) { emit(line[i]); if (line[i] === "{") depth++; else if (line[i] === "}" && --depth === 0) { i++; break; } i++; }
      continue;
    }
    i++;
  }
  return i < line.length ? i : -1;
}

function blankLine(line: string, startInTemplate: boolean): { out: string; inTemplate: boolean } {
  let out = "";
  let i = 0;
  let prev = "";
  if (startInTemplate) {
    const end = templateEnd(line, 0, (s) => { out += s; });
    if (end < 0) return { out, inTemplate: true };
    out += "`";
    i = end + 1;
    prev = "`";
  }
  while (i < line.length) {
    const c = line[i];
    if (c === "/" && line[i + 1] === "/" && !/:$/.test(prev)) break;
    if (c === "`") {
      out += c;
      const end = templateEnd(line, i + 1, (s) => { out += s; });
      if (end < 0) return { out, inTemplate: true };
      out += c;
      i = end + 1;
      prev = c;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      out += q;
      i++;
      while (i < line.length && line[i] !== q) {
        if (line[i] === "\\") { i += 2; continue; }
        i++;
      }
      out += q;
      i++;
      prev = q;
      continue;
    }
    if (c === "/" && line[i + 1] !== "/" && line[i + 1] !== "*" && /(^|[=(:,;{}[!&|?+\-*%<>~^]|\breturn|\btypeof)\s*$/.test(out)) {
      let j = i + 1;
      let inClass = false;
      while (j < line.length && (line[j] !== "/" || inClass)) { if (line[j] === "\\") j++; else if (line[j] === "[") inClass = true; else if (line[j] === "]") inClass = false; j++; }
      if (j < line.length) { out += "/re/"; i = j + 1; while (i < line.length && /[a-z]/.test(line[i])) i++; prev = "/"; continue; }
    }
    out += c;
    if (c.trim()) prev = c;
    i++;
  }
  return { out, inTemplate: false };
}

/** `brody-ignore` (optionally `brody-ignore: rule-id, other-id`) on the line or the line above silences a finding on purpose. */
function ignored(lines: string[], i: number, ruleId: string): boolean {
  for (const l of [lines[i], lines[i - 1]]) {
    const m = l?.match(/brody-ignore(?::\s*([\w,\s-]+))?/);
    if (m && (!m[1] || m[1].split(",").map((x) => x.trim()).includes(ruleId))) return true;
  }
  return false;
}

export function scanText(path: string, language: string, text: string, isTest: boolean): FindingDraft[] {
  const out: FindingDraft[] = [];
  // Test code and fixtures deliberately contain bad patterns; they are not the review target.
  if (isTest) return out;
  const lines = text.split("\n");
  if (lines.length > 20000) return out;
  // Blanking literals and classifying comment lines are per-line facts, so compute each once and share it across every rule.
  let blanked: string[] | undefined;
  const codeLine = (i: number) => (blanked ??= blankLines(lines))[i];
  const commentLine: (boolean | undefined)[] = new Array(lines.length);
  const isComment = (i: number) => (commentLine[i] ??= /^(\/\/|#|\*|\/\*|<!--)/.test(lines[i].trim()));
  let blankedText: string | undefined;
  for (const rule of RULES) {
    if (rule.languages !== "*" && !rule.languages.includes(language)) continue;
    if (rule.skipPaths?.test(path)) continue;
    let hits = 0;
    let extra = 0;
    const emit = (f: FindingDraft) => { if (rule.perFile && hits > 0) { extra++; return; } out.push(f); hits++; };
    if (rule.pattern.flags.includes("s")) {
      const src = rule.codeOnly ? (blankedText ??= lines.map((_, i) => codeLine(i)).join("\n")) : text;
      const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes("g") ? rule.pattern.flags : rule.pattern.flags + "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        if (m[0] === "") re.lastIndex++; // an empty match would never advance
        if (hits >= 5) break;
        const line = src.slice(0, m.index).split("\n").length;
        const endLine = Math.min(lines.length, line + Math.max(0, m[0].split("\n").length - 1));
        if (ignored(lines, line - 1, rule.id)) continue;
        const matched = lines.slice(line - 1, endLine).join("\n");
        if (rule.commentExcuses && /\/\/|\/\*/.test(matched.slice(Math.max(0, matched.indexOf("catch"))))) continue;
        emit(toFinding(rule, path, line, lines, endLine));
      }
    } else {
      for (let i = 0; i < lines.length; i++) {
        if (hits >= 5) break;
        const raw = lines[i];
        if (raw.length > 1200) continue;
        if (rule.id !== "todo-fixme" && isComment(i)) continue;
        const subject = rule.codeOnly ? codeLine(i) : raw;
        if (!rule.pattern.test(subject)) continue;
        const ctx = lines.slice(Math.max(0, i - 2), i + 4).join("\n");
        if (rule.suppress?.(raw, ctx) || ignored(lines, i, rule.id)) continue;
        emit(toFinding(rule, path, i + 1, lines, i + 1));
      }
    }
    if (extra > 0 && out.length) { const last = [...out].reverse().find((f) => f.analyzer === `brody-rules/${rule.id}`); if (last) last.whatHappens += ` ${extra} more occurrence${extra > 1 ? "s" : ""} in this file.`; }
  }
  return out;
}

function toFinding(rule: Rule, path: string, line: number, lines: string[], endLine: number): FindingDraft {
  const evidenceLines = lines.slice(Math.max(0, line - 2), Math.min(lines.length, endLine + 1));
  return {
    title: rule.title,
    category: rule.category,
    severity: rule.severity,
    confidence: rule.confidence,
    origin: "static",
    analyzer: `brody-rules/${rule.id}`,
    filePath: path,
    startLine: line,
    endLine,
    evidence: evidenceLines.map((l, i) => `${Math.max(1, line - 1) + i}: ${l.slice(0, 200)}`).join("\n"),
    whatHappens: rule.whatHappens,
    whyItMatters: rule.whyItMatters,
    businessImpact: rule.businessImpact,
    remediation: rule.remediation,
    verification: "verified",
    verificationNote: "Deterministic pattern match on the cited lines. A match shows the construct exists; whether it is reachable with untrusted input still needs human judgement.",
  };
}
