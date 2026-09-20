import type { LoadedFile } from "../graph/build";
import type { SymbolRow } from "../db/schema";
import { SENSITIVE_ENV, SERVICE_SIGNATURES } from "./catalog";
import type { DependencyInfo, EntryPoint, EnvVar, ExternalService, ModelField, ModelInfo, ModelRelation, RouteInfo, Evidence, AIComponent, InfraInfo } from "./types";

function lineAt(src: string, idx: number): number {
  let n = 1;
  for (let i = 0; i < idx; i++) if (src.charCodeAt(i) === 10) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Dependencies from manifests
// ---------------------------------------------------------------------------
export function detectDependencies(files: LoadedFile[]): DependencyInfo[] {
  const out: DependencyInfo[] = [];
  const seen = new Set<string>();
  const add = (d: DependencyInfo) => {
    const k = `${d.ecosystem}:${d.name}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(d);
  };
  for (const f of files) {
    if (!f.text || f.isTest) continue; // manifests inside fixtures and test data describe other projects
    const name = f.name.toLowerCase();
    try {
      if (name === "package.json") {
        const json = JSON.parse(f.text);
        for (const [k, v] of Object.entries<string>(json.dependencies ?? {})) add({ name: k, version: v, manifest: f.path, dev: false, ecosystem: "npm", usedBy: 0 });
        for (const [k, v] of Object.entries<string>(json.devDependencies ?? {})) add({ name: k, version: v, manifest: f.path, dev: true, ecosystem: "npm", usedBy: 0 });
        for (const [k, v] of Object.entries<string>(json.peerDependencies ?? {})) add({ name: k, version: v, manifest: f.path, dev: true, ecosystem: "npm", usedBy: 0 });
      } else if (/^requirements.*\.txt$/.test(name)) {
        for (const line of f.text.split("\n")) {
          const m = line.trim().match(/^([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*([=<>!~]=?\s*[^\s;#]+)?/);
          if (m && !line.trim().startsWith("#") && !line.trim().startsWith("-")) add({ name: m[1], version: m[2]?.trim(), manifest: f.path, dev: /dev|test/.test(name), ecosystem: "pypi", usedBy: 0 });
        }
      } else if (name === "pyproject.toml") {
        const depsSection = f.text.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
        if (depsSection) for (const m of depsSection[1].matchAll(/["']([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*([^"']*)["']/g)) add({ name: m[1], version: m[2]?.trim() || undefined, manifest: f.path, dev: false, ecosystem: "pypi", usedBy: 0 });
        const poetry = f.text.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?:\n\[|$)/);
        if (poetry) for (const m of poetry[1].matchAll(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/gm)) if (m[1] !== "python") add({ name: m[1], version: m[2].replace(/["{}]/g, "").slice(0, 40), manifest: f.path, dev: false, ecosystem: "pypi", usedBy: 0 });
        const optional = f.text.match(/\[project\.optional-dependencies\]([\s\S]*?)(?:\n\[(?!project)|$)/);
        if (optional) for (const m of optional[1].matchAll(/["']([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*([^"']*)["']/g)) add({ name: m[1], version: m[2]?.trim() || undefined, manifest: f.path, dev: true, ecosystem: "pypi", usedBy: 0 });
        const dg = f.text.match(/\[dependency-groups\]([\s\S]*?)(?:\n\[|$)/) ?? f.text.match(/\[tool\.poetry\.(?:dev-dependencies|group\.dev\.dependencies)\]([\s\S]*?)(?:\n\[|$)/);
        if (dg) for (const m of dg[1].matchAll(/["']?([A-Za-z][A-Za-z0-9_.-]+)["']?\s*(?:=|>=|==|~=|<)/g)) add({ name: m[1], manifest: f.path, dev: true, ecosystem: "pypi", usedBy: 0 });
      } else if (name === "go.mod") {
        for (const m of f.text.matchAll(/^\s*([a-z0-9.\-/_]+\.[a-z]+\/[^\s]+)\s+(v[^\s]+)(\s*\/\/\s*indirect)?/gm)) add({ name: m[1], version: m[2], manifest: f.path, dev: !!m[3], ecosystem: "go", usedBy: 0 });
      } else if (name === "cargo.toml") {
        const sec = f.text.match(/\[dependencies\]([\s\S]*?)(?:\n\[|$)/);
        if (sec) for (const m of sec[1].matchAll(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/gm)) add({ name: m[1], version: m[2].replace(/[{}"]/g, "").slice(0, 40), manifest: f.path, dev: false, ecosystem: "cargo", usedBy: 0 });
        const dev = f.text.match(/\[dev-dependencies\]([\s\S]*?)(?:\n\[|$)/);
        if (dev) for (const m of dev[1].matchAll(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/gm)) add({ name: m[1], version: m[2].replace(/[{}"]/g, "").slice(0, 40), manifest: f.path, dev: true, ecosystem: "cargo", usedBy: 0 });
      } else if (name === "pom.xml") {
        for (const m of f.text.matchAll(/<dependency>[\s\S]*?<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>(?:\s*<version>([^<]+)<\/version>)?([\s\S]*?)<\/dependency>/g)) add({ name: `${m[1]}:${m[2]}`, version: m[3], manifest: f.path, dev: /<scope>test<\/scope>/.test(m[4]), ecosystem: "maven", usedBy: 0 });
      } else if (name === "build.gradle" || name === "build.gradle.kts") {
        for (const m of f.text.matchAll(/(implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly)\s*\(?\s*["']([^"':]+):([^"':]+)(?::([^"']+))?["']/g)) add({ name: `${m[2]}:${m[3]}`, version: m[4], manifest: f.path, dev: /^test/.test(m[1]), ecosystem: "gradle", usedBy: 0 });
      } else if (name === "gemfile") {
        for (const m of f.text.matchAll(/^\s*gem\s+["']([^"']+)["'](?:\s*,\s*["']([^"']+)["'])?/gm)) add({ name: m[1], version: m[2], manifest: f.path, dev: false, ecosystem: "rubygems", usedBy: 0 });
      } else if (name === "composer.json") {
        const json = JSON.parse(f.text);
        for (const [k, v] of Object.entries<string>(json.require ?? {})) if (k !== "php") add({ name: k, version: v, manifest: f.path, dev: false, ecosystem: "composer", usedBy: 0 });
        for (const [k, v] of Object.entries<string>(json["require-dev"] ?? {})) add({ name: k, version: v, manifest: f.path, dev: true, ecosystem: "composer", usedBy: 0 });
      } else if (/\.csproj$/.test(name) || name === "directory.packages.props") {
        for (const m of f.text.matchAll(/<PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]+)")?/g)) add({ name: m[1], version: m[2], manifest: f.path, dev: /test|xunit|nunit|moq/i.test(m[1]), ecosystem: "nuget", usedBy: 0 });
      } else if (name === "pubspec.yaml") {
        const sec = f.text.match(/^dependencies:\n([\s\S]*?)(?:\n\S|$)/m);
        if (sec) for (const m of sec[1].matchAll(/^\s{2}([a-z_0-9]+):\s*(.*)$/gm)) add({ name: m[1], version: m[2] || undefined, manifest: f.path, dev: false, ecosystem: "pub", usedBy: 0 });
      }
    } catch {
      // Malformed manifest: skip silently; the file is still listed as a manifest.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// External services
// ---------------------------------------------------------------------------
export function detectExternalServices(files: LoadedFile[], deps: DependencyInfo[], envVars: EnvVar[], externalRels: { pkg: string; path: string; line?: number }[]): ExternalService[] {
  const found = new Map<string, ExternalService>();
  const get = (sig: (typeof SERVICE_SIGNATURES)[number]): ExternalService => {
    let s = found.get(sig.name);
    if (!s) {
      s = { name: sig.name, category: sig.category, evidence: [], via: [], purpose: sig.purpose, failureImpact: sig.failureImpact };
      found.set(sig.name, s);
    }
    return s;
  };
  const addEv = (s: ExternalService, ev: Evidence, via: string) => {
    if (s.evidence.length < 12 && !s.evidence.some((e) => e.path === ev.path && e.line === ev.line)) s.evidence.push(ev);
    if (!s.via.includes(via)) s.via.push(via);
  };
  for (const sig of SERVICE_SIGNATURES) {
    for (const d of deps) if (sig.packages.some((p) => p.toLowerCase() === d.name.toLowerCase() || d.name.toLowerCase().startsWith(p.toLowerCase() + "/"))) addEv(get(sig), { path: d.manifest }, `dependency ${d.name}`);
    for (const r of externalRels) if (sig.packages.some((p) => r.pkg.toLowerCase() === p.toLowerCase() || r.pkg.toLowerCase().startsWith(p.toLowerCase() + "/"))) addEv(get(sig), { path: r.path, line: r.line }, `import ${r.pkg}`);
    for (const e of envVars) if (sig.envPrefixes.some((p) => (p.endsWith("_") ? e.name.startsWith(p) : e.name === p || e.name.startsWith(p)))) for (const f of e.files.slice(0, 3)) addEv(get(sig), f, `env ${e.name}`);
  }
  // URL hosts inside source
  for (const f of files) {
    if (!f.text || f.isTest || f.classification === "docs" || f.classification === "lockfile") continue;
    const hostHits: { sig: (typeof SERVICE_SIGNATURES)[number]; host: string; idx: number }[] = [];
    for (const sig of SERVICE_SIGNATURES) {
      for (const host of sig.hosts) {
        if (!host) continue;
        // Only an actual URL counts, not a bare word.
        const m = f.text.match(new RegExp(`(?:https?|wss?)://[\\w.-]*${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
        if (m && m.index !== undefined) hostHits.push({ sig, host, idx: m.index });
      }
    }
    // A file naming the hosts of many different services is a catalog or data table, not an integration.
    if (new Set(hostHits.map((h) => h.sig.name)).size > 3) continue;
    for (const h of hostHits) addEv(get(h.sig), { path: f.path, line: lineAt(f.text, h.idx) }, `url ${h.host}`);
  }
  // Remove framework-only detections that are libraries rather than services when no runtime evidence.
  return [...found.values()].filter((s) => s.evidence.length > 0).sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Environment variables & configuration
// ---------------------------------------------------------------------------
const ENV_PATTERNS: RegExp[] = [
  /process\.env\.([A-Z][A-Z0-9_]+)/g,
  /process\.env\[["']([A-Z][A-Z0-9_]+)["']\]/g,
  /import\.meta\.env\.([A-Z][A-Z0-9_]+)/g,
  /os\.environ(?:\.get)?\(?\[?["']([A-Z][A-Z0-9_]+)["']/g,
  /os\.getenv\(\s*["']([A-Z][A-Z0-9_]+)["']/g,
  /environ\.get\(\s*["']([A-Z][A-Z0-9_]+)["']/g,
  /os\.Getenv\(\s*"([A-Z][A-Z0-9_]+)"/g,
  /os\.LookupEnv\(\s*"([A-Z][A-Z0-9_]+)"/g,
  /viper\.Get(?:String|Int|Bool)?\(\s*"([A-Z][A-Z0-9_]+)"/g,
  /System\.getenv\(\s*"([A-Z][A-Z0-9_]+)"/g,
  /Environment\.GetEnvironmentVariable\(\s*"([A-Z][A-Z0-9_]+)"/g,
  /ENV(?:\.fetch)?\(?\[?["']([A-Z][A-Z0-9_]+)["']/g,
  /env::var\(\s*"([A-Z][A-Z0-9_]+)"/g,
  /\$_ENV\[["']([A-Z][A-Z0-9_]+)["']\]/g,
  /\benv\(\s*["']([A-Z][A-Z0-9_]+)["']/g,
  /getenv\(\s*["']([A-Z][A-Z0-9_]+)["']/g,
  /Deno\.env\.get\(\s*["']([A-Z][A-Z0-9_]+)["']/g,
  /\$\{\{?\s*secrets\.([A-Z][A-Z0-9_]+)\s*\}?\}/g,
  /\$\{([A-Z][A-Z0-9_]{2,})(?::-[^}]*)?\}/g,
];

export function detectEnvVars(files: LoadedFile[]): { envVars: EnvVar[]; ports: { value: string; path: string; line?: number }[]; featureFlags: { name: string; path: string; line?: number }[]; configFiles: string[] } {
  const vars = new Map<string, EnvVar>();
  const ports: { value: string; path: string; line?: number }[] = [];
  const featureFlags: { name: string; path: string; line?: number }[] = [];
  const configFiles: string[] = [];
  const get = (name: string) => {
    let v = vars.get(name);
    if (!v) {
      v = { name, files: [], declaredIn: [], sensitive: SENSITIVE_ENV.test(name) };
      vars.set(name, v);
    }
    return v;
  };
  for (const f of files) {
    if (!f.text || f.isTest) continue;
    if (f.classification === "config" || f.classification === "manifest" || f.classification === "infra" || f.classification === "ci") configFiles.push(f.path);
    const isEnvFile = f.language === "Dotenv";
    if (isEnvFile) {
      for (const m of f.text.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]+)\s*=/gm)) {
        const v = get(m[1]);
        if (!v.declaredIn.includes(f.path)) v.declaredIn.push(f.path);
      }
      continue;
    }
    if (/docker-compose|compose\.ya?ml/.test(f.path)) {
      for (const m of f.text.matchAll(/^\s+-?\s*([A-Z][A-Z0-9_]+)\s*[:=]/gm)) {
        const v = get(m[1]);
        if (!v.declaredIn.includes(f.path)) v.declaredIn.push(f.path);
      }
      for (const m of f.text.matchAll(/^\s+-\s*["']?(\d{2,5}):(\d{2,5})["']?/gm)) ports.push({ value: `${m[1]}:${m[2]}`, path: f.path, line: lineAt(f.text, m.index ?? 0) });
    }
    if (f.language === "Dockerfile") {
      for (const m of f.text.matchAll(/^\s*(?:ENV|ARG)\s+([A-Z][A-Z0-9_]+)/gm)) { const v = get(m[1]); if (!v.declaredIn.includes(f.path)) v.declaredIn.push(f.path); }
      for (const m of f.text.matchAll(/^\s*EXPOSE\s+(\d+)/gm)) ports.push({ value: m[1], path: f.path, line: lineAt(f.text, m.index ?? 0) });
    }
    if (f.classification === "source" || f.classification === "config" || f.classification === "ci" || f.classification === "infra" || f.classification === "schema") {
      for (const re of ENV_PATTERNS) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(f.text))) {
          const v = get(m[1]);
          if (v.files.length < 20 && !v.files.some((e) => e.path === f.path)) v.files.push({ path: f.path, line: lineAt(f.text, m.index) });
        }
      }
      for (const m of f.text.matchAll(/\.listen\(\s*(\d{2,5})|PORT\s*(?:\|\||\?\?|or|=)\s*["']?(\d{2,5})|port\s*[:=]\s*(\d{2,5})\b|:(\d{4,5})["']\s*[,)]/g)) {
        const val = m[1] ?? m[2] ?? m[3] ?? m[4];
        if (val && ports.length < 30) ports.push({ value: val, path: f.path, line: lineAt(f.text, m.index ?? 0) });
      }
      for (const m of f.text.matchAll(/(?:FEATURE_[A-Z0-9_]+|ENABLE_[A-Z0-9_]+|[A-Z0-9_]+_ENABLED|flags?\.(?:isEnabled|enabled|get|check)\(\s*["']([A-Za-z0-9_.-]+)["']|useFlag\(\s*["']([A-Za-z0-9_.-]+)["']|flag\(["']([A-Za-z0-9_.-]+)["'])/g)) {
        const name = m[1] ?? m[2] ?? m[3] ?? m[0];
        if (featureFlags.length < 60 && !featureFlags.some((x) => x.name === name)) featureFlags.push({ name, path: f.path, line: lineAt(f.text, m.index ?? 0) });
      }
    }
  }
  return { envVars: [...vars.values()].sort((a, b) => a.name.localeCompare(b.name)), ports: dedupePorts(ports), featureFlags, configFiles };
}

function dedupePorts(ports: { value: string; path: string; line?: number }[]): { value: string; path: string; line?: number }[] {
  const seen = new Set<string>();
  return ports.filter((p) => {
    const k = `${p.value}@${p.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const AUTH_HINTS = /\b(getServerSession|getSession|auth\(\)|currentUser|requireAuth|requireUser|withAuth|authenticate\w*|authorize\w*|isAuthenticated|ensureLoggedIn|verifyToken|checkAuth|jwt\.verify|jwtVerify|getToken|passport\.authenticate|login_required|permission_classes|IsAuthenticated|@auth|Depends\(get_current_user|Depends\(current_user|\[Authorize\]|@PreAuthorize|@Secured|before_action\s*:authenticate|UseGuards|AuthGuard|clerkMiddleware)\b|\[Authorize/i;


/** Split the top-level arguments of a call whose "(" is at openIdx, respecting nesting and string literals. */
export function callArgs(text: string, openIdx: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let cur = "";
  let str: string | null = null;
  const limit = Math.min(text.length, openIdx + 12000);
  for (let i = openIdx; i < limit; i++) {
    const c = text[i];
    if (str) {
      cur += c;
      if (c === "\\") cur += text[++i] ?? "";
      else if (c === str) str = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { str = c; cur += c; continue; }
    if (c === "(" || c === "[" || c === "{") { depth++; if (depth > 1) cur += c; continue; }
    if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) { if (cur.trim()) args.push(cur.trim()); return args; }
      cur += c;
      continue;
    }
    if (c === "," && depth === 1) { args.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  return args;
}

const AUTH_MIDDLEWARE = /\b\w*(auth|jwt|login|protect|permission|passport|isAdmin|requireRole)\w*\b/i;
const PUBLIC_PATH = /(login|signin|sign-in|register|signup|sign-up|webhook|health|status|ping|callback|public|oauth|forgot|reset|logout)/i;
const isInlineFn = (a: string) => /^(async\s*)?(\([^)]*\)\s*(=>|:\s*[\w<>\[\]| ]+=>)|function\b|[A-Za-z_$][\w$]*\s*=>)/.test(a);

export function detectRoutes(files: LoadedFile[], symbols: SymbolRow[]): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const symbolsByFile = new Map<string, SymbolRow[]>();
  for (const s of symbols) {
    const l = symbolsByFile.get(s.filePath) ?? [];
    l.push(s);
    symbolsByFile.set(s.filePath, l);
  }
  const findSym = (path: string, name: string) => symbolsByFile.get(path)?.find((s) => s.name === name) ?? symbols.find((s) => s.name === name && s.exported);
  const enclosing = (path: string, line: number) => {
    const list = symbolsByFile.get(path) ?? [];
    let best: SymbolRow | undefined;
    for (const s of list) if (s.startLine <= line && s.endLine >= line && (!best || s.endLine - s.startLine < best.endLine - best.startLine)) best = s;
    return best;
  };
  const authFor = (text: string, line: number, filePath: string): RouteInfo["auth"] => {
    const lines = text.split("\n");
    const window = lines.slice(Math.max(0, line - 8), line + 3).join("\n");
    if (AUTH_HINTS.test(window)) return "authenticated";
    if (/(middleware|proxy)\.(ts|js|py)$/.test(filePath)) return "unknown";
    return "unknown";
  };
  const push = (r: RouteInfo) => {
    if (routes.some((x) => x.method === r.method && x.path === r.path && x.file === r.file && x.line === r.line)) return;
    routes.push(r);
  };

  for (const f of files) {
    if (!f.text || f.isTest || f.isExcluded) continue;
    const t = f.text;
    const lang = f.language;

    // Next.js App Router file conventions
    const appRoute = f.path.match(/(?:^|\/)app\/(.*?)route\.(ts|js|tsx|jsx)$/);
    if (appRoute) {
      const p = "/" + appRoute[1].replace(/\/$/, "").replace(/\([^)]*\)\//g, "").replace(/\[\.\.\.(\w+)\]/g, ":$1*").replace(/\[(\w+)\]/g, ":$1");
      for (const m of t.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)) push({ method: m[1], path: p === "/" ? "/" : p.replace(/\/$/, ""), handler: `${m[1]} (route handler)`, file: f.path, line: lineAt(t, m.index ?? 0), framework: "Next.js", auth: authFor(t, lineAt(t, m.index ?? 0), f.path), symbolId: findSym(f.path, m[1])?.id, kind: "api" });
    }
    const appPage = f.path.match(/(?:^|\/)app\/(.*?)page\.(tsx|jsx|js|ts|mdx)$/);
    if (appPage) {
      const p = "/" + appPage[1].replace(/\/$/, "").replace(/\([^)]*\)\//g, "").replace(/\[\.\.\.(\w+)\]/g, ":$1*").replace(/\[(\w+)\]/g, ":$1");
      const def = symbolsByFile.get(f.path)?.find((s) => s.kind === "component" || s.name === "default" || s.kind === "function");
      push({ method: "GET", path: p === "/" ? "/" : p.replace(/\/$/, ""), handler: def?.name ?? "page", file: f.path, line: def?.startLine ?? 1, framework: "Next.js", auth: authFor(t, def?.startLine ?? 1, f.path), symbolId: def?.id, kind: "page" });
    }
    const pagesApi = f.path.match(/(?:^|\/)pages\/api\/(.*)\.(ts|js)$/);
    if (pagesApi) {
      const p = "/api/" + pagesApi[1].replace(/\/index$/, "").replace(/\[\.\.\.(\w+)\]/g, ":$1*").replace(/\[(\w+)\]/g, ":$1");
      const def = symbolsByFile.get(f.path)?.find((s) => s.exported && (s.kind === "function" || s.name === "default"));
      push({ method: "ANY", path: p, handler: def?.name ?? "handler", file: f.path, line: def?.startLine ?? 1, framework: "Next.js", auth: authFor(t, def?.startLine ?? 1, f.path), symbolId: def?.id, kind: "api" });
    }
    const pagesPage = f.path.match(/(?:^|\/)pages\/(?!api\/)(.*)\.(tsx|jsx|js|ts|mdx)$/);
    if (pagesPage && !/^_(app|document|error)$/.test(pagesPage[1])) {
      const p = "/" + pagesPage[1].replace(/\/?index$/, "").replace(/\[\.\.\.(\w+)\]/g, ":$1*").replace(/\[(\w+)\]/g, ":$1");
      const def = symbolsByFile.get(f.path)?.find((s) => s.kind === "component");
      push({ method: "GET", path: p || "/", handler: def?.name ?? "page", file: f.path, line: def?.startLine ?? 1, framework: "Next.js", auth: "unknown", symbolId: def?.id, kind: "page" });
    }
    // SvelteKit / Remix / Nuxt file routes
    const svelteRoute = f.path.match(/(?:^|\/)routes\/(.*?)\+(page|server)\.(svelte|ts|js)$/);
    if (svelteRoute) {
      const p = "/" + svelteRoute[1].replace(/\/$/, "").replace(/\[(\w+)\]/g, ":$1");
      if (svelteRoute[2] === "page") push({ method: "GET", path: p || "/", handler: "page", file: f.path, line: 1, framework: "SvelteKit", auth: "unknown", kind: "page" });
      else for (const m of t.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)) push({ method: m[1], path: p || "/", handler: m[1], file: f.path, line: lineAt(t, m.index ?? 0), framework: "SvelteKit", auth: "unknown", kind: "api" });
    }

    if (lang === "TypeScript" || lang === "JavaScript") {
      // Express / Koa-router / Fastify / Hono style: app.get('/path', ...middleware, handler)
      // Router-level auth: router.use(requireAuth) applies to routes declared after it in the same file.
      const routerAuthFrom = new Map<string, number>();
      for (const m of t.matchAll(/\b(\w+)\.use\(\s*([A-Za-z_$][\w$.]*(?:\([^)]*\))?)\s*\)/g)) if (AUTH_MIDDLEWARE.test(m[2])) routerAuthFrom.set(m[1], m.index ?? 0);
      for (const m of t.matchAll(/\b(\w+)\.(get|post|put|patch|delete|del|all|options|head)\(\s*(['"`])([^'"`]*)\3/g)) {
        const obj = m[1];
        if (!/^(app|router|server|api|fastify|hono|r|route|routes|v\d+|admin|public|private|koa|instance)$/i.test(obj) && !/(Router|App)$/i.test(obj)) continue;
        const openIdx = t.indexOf("(", (m.index ?? 0) + obj.length);
        const args = callArgs(t, openIdx).slice(1);
        const handlerArg = args[args.length - 1] ?? "";
        const middleware = args.slice(0, -1);
        const inline = isInlineFn(handlerArg);
        const handlerName = inline || !handlerArg ? "(inline handler)" : handlerArg.split(".").pop()!.replace(/[^\w$]/g, "");
        const line = lineAt(t, m.index ?? 0);
        const method = m[2] === "del" ? "DELETE" : m[2].toUpperCase();
        const routePath = m[4];
        const guarded = middleware.some((a) => AUTH_MIDDLEWARE.test(a)) || (routerAuthFrom.has(obj) && (routerAuthFrom.get(obj) ?? 0) < (m.index ?? 0)) || (!inline && args.length === 1 && AUTH_MIDDLEWARE.test(handlerArg) && false);
        const handlerSym = inline ? symbolsByFile.get(f.path)?.find((s) => s.kind === "endpoint" && s.name === `${method} ${routePath}`) : findSym(f.path, handlerName);
        push({ method, path: routePath, handler: inline ? `${method} ${routePath} (inline)` : handlerName, file: f.path, line, framework: /fastify/i.test(obj) ? "Fastify" : /hono/i.test(obj) ? "Hono" : "Express-style", auth: guarded ? "authenticated" : PUBLIC_PATH.test(routePath) ? "public" : "unknown", symbolId: handlerSym?.id ?? enclosing(f.path, line)?.id, kind: "api" });
      }
      // NestJS decorators
      const controller = t.match(/@Controller\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/);
      if (controller) {
        const prefix = "/" + (controller[1] ?? "").replace(/^\/+/, "");
        for (const m of t.matchAll(/@(Get|Post|Put|Patch|Delete|All|Options|Head)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)[\s\S]{0,200}?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/g)) {
          const line = lineAt(t, m.index ?? 0);
          push({ method: m[1].toUpperCase(), path: (prefix.replace(/\/$/, "") + "/" + (m[2] ?? "").replace(/^\/+/, "")).replace(/\/$/, "") || "/", handler: m[3], file: f.path, line, framework: "NestJS", auth: /@UseGuards/.test(t.slice(Math.max(0, (m.index ?? 0) - 300), (m.index ?? 0) + 50)) || /@UseGuards\([^)]*\)\s*(?:@\w+\([^)]*\)\s*)*export class/.test(t) ? "authenticated" : "unknown", symbolId: findSym(f.path, m[3])?.id, kind: "api" });
        }
      }
      // tRPC procedures
      for (const m of t.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*(?:protectedProcedure|publicProcedure|procedure|t\.procedure|router\.\w+)\b[\s\S]{0,300}?\.(query|mutation|subscription)\(/g)) {
        const line = lineAt(t, m.index ?? 0);
        push({ method: m[2].toUpperCase(), path: m[1], handler: m[1], file: f.path, line, framework: "tRPC", auth: /protectedProcedure/.test(m[0]) ? "authenticated" : "public", symbolId: enclosing(f.path, line)?.id, kind: "api" });
      }
      // GraphQL resolvers
      for (const m of t.matchAll(/@(Query|Mutation|Subscription)\(\s*\)[\s\S]{0,200}?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/g)) {
        const line = lineAt(t, m.index ?? 0);
        push({ method: m[1].toUpperCase(), path: m[2], handler: m[2], file: f.path, line, framework: "GraphQL", auth: "unknown", symbolId: findSym(f.path, m[2])?.id, kind: "graphql" });
      }
      // WebSocket
      for (const m of t.matchAll(/\.(on|of)\(\s*['"`](connection|connect)['"`]/g)) push({ method: "WS", path: "/", handler: "(connection handler)", file: f.path, line: lineAt(t, m.index ?? 0), framework: "WebSocket", auth: "unknown", kind: "websocket" });
    }

    if (lang === "Python") {
      for (const m of t.matchAll(/@(\w+)\.(get|post|put|patch|delete|route|api_route|websocket|head|options)\(\s*(['"])([^'"]*)\3([^)]*)\)\s*(?:@[\s\S]*?)?\n\s*(?:async\s+)?def\s+(\w+)/g)) {
        const line = lineAt(t, m.index ?? 0);
        let method = m[2].toUpperCase();
        if (m[2] === "route" || m[2] === "api_route") {
          const mm = m[5].match(/methods\s*=\s*\[([^\]]*)\]/);
          method = mm ? mm[1].replace(/['"\s]/g, "").toUpperCase() : "GET";
        }
        const prefixMatch = t.match(new RegExp(`${m[1]}\\s*=\\s*(?:APIRouter|Blueprint)\\([^)]*prefix\\s*=\\s*['"]([^'"]*)['"]`));
        const prefix = prefixMatch?.[1] ?? "";
        const before = t.slice(Math.max(0, (m.index ?? 0) - 300), m.index ?? 0);
        const window = before.slice(before.lastIndexOf("\n\n") + 1) + m[0];
        push({ method, path: prefix + m[4], handler: m[6], file: f.path, line, framework: m[2] === "route" ? "Flask" : "FastAPI", auth: /Depends\((get_current|current_user|require|auth|verify|oauth2|jwt|Security)|login_required|@jwt_required|@auth\.|@requires_auth|@permission/i.test(window) ? "authenticated" : "unknown", symbolId: findSym(f.path, m[6])?.id, kind: m[2] === "websocket" ? "websocket" : "api" });
      }
      // Django urls
      if (/urlpatterns/.test(t)) for (const m of t.matchAll(/\b(?:path|re_path|url)\(\s*r?(['"])([^'"]*)\1\s*,\s*([\w.]+)(?:\.as_view\(\))?/g)) {
        const line = lineAt(t, m.index ?? 0);
        const handler = m[3].split(".").pop()!;
        push({ method: "ANY", path: "/" + m[2].replace(/^\^/, "").replace(/\$$/, ""), handler, file: f.path, line, framework: "Django", auth: "unknown", symbolId: findSym(f.path, handler)?.id, kind: /include\(/.test(m[0]) ? "api" : "api" });
      }
      // DRF viewsets / APIView
      for (const m of t.matchAll(/class\s+(\w+)\((?:[\w.]*\b(APIView|ViewSet|ModelViewSet|GenericAPIView|ListAPIView|RetrieveAPIView|CreateAPIView|View)\b[^)]*)\)/g)) {
        const line = lineAt(t, m.index ?? 0);
        const window = t.slice(m.index ?? 0, (m.index ?? 0) + 800);
        push({ method: "ANY", path: `(${m[2]}) ${m[1]}`, handler: m[1], file: f.path, line, framework: "Django", auth: /permission_classes\s*=\s*[\[(][^\])]*(IsAuthenticated|IsAdminUser|LoginRequired)|login_required|LoginRequiredMixin/.test(window) ? "authenticated" : "unknown", symbolId: findSym(f.path, m[1])?.id, kind: "api" });
      }
    }

    if (lang === "Go") {
      for (const m of t.matchAll(/\b(\w+)\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Get|Post|Put|Patch|Delete|Handle|HandleFunc|Any|Route|Mount)\(\s*"([^"]*)"\s*,\s*([^)]*?)\)/g)) {
        const line = lineAt(t, m.index ?? 0);
        const handlerExpr = m[4].trim();
        const handler = handlerExpr.split(/[.(]/).filter(Boolean).pop()?.replace(/[^A-Za-z0-9_]/g, "") || "(inline)";
        let method = m[2].toUpperCase();
        if (method === "HANDLE" || method === "HANDLEFUNC" || method === "ROUTE" || method === "MOUNT") {
          const mm = m[3].match(/^(GET|POST|PUT|PATCH|DELETE)\s+/);
          method = mm ? mm[1] : "ANY";
        }
        push({ method, path: m[3].replace(/^(GET|POST|PUT|PATCH|DELETE)\s+/, ""), handler, file: f.path, line, framework: "Go HTTP", auth: /auth|Auth|jwt|JWT|middleware/.test(t.slice(Math.max(0, (m.index ?? 0) - 300), m.index ?? 0)) ? "authenticated" : "unknown", symbolId: findSym(f.path, handler)?.id, kind: "api" });
      }
    }

    if (lang === "Java" || lang === "Kotlin") {
      const base = t.match(/@RequestMapping\(\s*(?:value\s*=\s*|path\s*=\s*)?["']([^"']*)["']/)?.[1] ?? "";
      for (const m of t.matchAll(/@(Get|Post|Put|Patch|Delete|Request)Mapping\(\s*(?:value\s*=\s*|path\s*=\s*)?(?:["']([^"']*)["'])?[^)]*\)[\s\S]{0,300}?\b(\w+)\s*\(/g)) {
        const line = lineAt(t, m.index ?? 0);
        if (m[1] === "Request" && (m.index ?? 0) < 400 && !/(public|private|protected)\s+[\w<>\[\], ]+\s+\w+\s*\(/.test(m[0])) continue;
        push({ method: m[1] === "Request" ? "ANY" : m[1].toUpperCase(), path: (base + "/" + (m[2] ?? "")).replace(/\/+/g, "/").replace(/\/$/, "") || "/", handler: m[3], file: f.path, line, framework: "Spring", auth: /@PreAuthorize|@Secured|@RolesAllowed|@AuthenticationPrincipal/.test(t.slice(Math.max(0, (m.index ?? 0) - 200), (m.index ?? 0) + 400)) ? "authenticated" : "unknown", symbolId: findSym(f.path, m[3])?.id, kind: "api" });
      }
    }

    if (lang === "C#") {
      const base = t.match(/\[Route\(\s*"([^"]*)"\s*\)\]/)?.[1]?.replace("[controller]", (f.name.replace(/Controller\.cs$/, "") || "").toLowerCase()) ?? "";
      for (const m of t.matchAll(/\[Http(Get|Post|Put|Patch|Delete)(?:\(\s*"([^"]*)"\s*\))?\][\s\S]{0,300}?\b(\w+)\s*\(/g)) {
        const line = lineAt(t, m.index ?? 0);
        push({ method: m[1].toUpperCase(), path: ("/" + base + "/" + (m[2] ?? "")).replace(/\/+/g, "/").replace(/\/$/, "") || "/", handler: m[3], file: f.path, line, framework: "ASP.NET Core", auth: /\[Authorize/.test(t.slice(Math.max(0, (m.index ?? 0) - 200), (m.index ?? 0) + 200)) || /\[Authorize[^\]]*\]\s*public class/.test(t) ? "authenticated" : /\[AllowAnonymous\]/.test(t.slice(Math.max(0, (m.index ?? 0) - 200), m.index ?? 0)) ? "public" : "unknown", symbolId: findSym(f.path, m[3])?.id, kind: "api" });
      }
      for (const m of t.matchAll(/\b(?:app|group|endpoints)\.Map(Get|Post|Put|Patch|Delete)\(\s*"([^"]*)"\s*,\s*([^)]*?)\)/g)) {
        const line = lineAt(t, m.index ?? 0);
        const handler = m[3].trim().split(/[\s(=>]/)[0] || "(lambda)";
        push({ method: m[1].toUpperCase(), path: m[2], handler, file: f.path, line, framework: "ASP.NET Minimal API", auth: /RequireAuthorization/.test(t.slice(m.index ?? 0, (m.index ?? 0) + 300)) ? "authenticated" : "unknown", symbolId: findSym(f.path, handler)?.id, kind: "api" });
      }
    }

    if (lang === "Ruby" && /routes\.rb$/.test(f.path)) {
      for (const m of t.matchAll(/^\s*(get|post|put|patch|delete|match)\s+['"]([^'"]+)['"](?:\s*,\s*to:\s*['"]([^'"]+)['"])?/gm)) push({ method: m[1] === "match" ? "ANY" : m[1].toUpperCase(), path: m[2], handler: m[3] ?? "(controller action)", file: f.path, line: lineAt(t, m.index ?? 0), framework: "Rails", auth: "unknown", kind: "api" });
      for (const m of t.matchAll(/^\s*resources?\s+:(\w+)/gm)) push({ method: "REST", path: `/${m[1]}`, handler: `${m[1]}#index/show/create/update/destroy`, file: f.path, line: lineAt(t, m.index ?? 0), framework: "Rails", auth: "unknown", kind: "api" });
    }
    if (lang === "PHP") {
      for (const m of t.matchAll(/Route::(get|post|put|patch|delete|any|match|resource|apiResource)\(\s*['"]([^'"]+)['"]\s*,\s*([^)]*?)\)/g)) {
        const handler = m[3].replace(/[\[\]'"\s]/g, "").split(",").pop()?.split("::").pop() || "(closure)";
        push({ method: /resource/i.test(m[1]) ? "REST" : m[1].toUpperCase(), path: m[2], handler, file: f.path, line: lineAt(t, m.index ?? 0), framework: "Laravel", auth: /->middleware\(\s*['"]auth/.test(t.slice(m.index ?? 0, (m.index ?? 0) + 300)) ? "authenticated" : "unknown", symbolId: findSym(f.path, handler)?.id, kind: "api" });
      }
      for (const m of t.matchAll(/#\[Route\(\s*['"]([^'"]+)['"][^\]]*(?:methods:\s*\[([^\]]*)\])?[^\]]*\)\]\s*public function (\w+)/g)) push({ method: m[2] ? m[2].replace(/['"\s]/g, "").toUpperCase() : "ANY", path: m[1], handler: m[3], file: f.path, line: lineAt(t, m.index ?? 0), framework: "Symfony", auth: "unknown", symbolId: findSym(f.path, m[3])?.id, kind: "api" });
    }
    if (lang === "Rust") {
      for (const m of t.matchAll(/#\[(get|post|put|patch|delete)\(\s*"([^"]*)"\s*\)\]\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g)) push({ method: m[1].toUpperCase(), path: m[2], handler: m[3], file: f.path, line: lineAt(t, m.index ?? 0), framework: "Actix/Rocket", auth: "unknown", symbolId: findSym(f.path, m[3])?.id, kind: "api" });
      for (const m of t.matchAll(/\.route\(\s*"([^"]*)"\s*,\s*(get|post|put|patch|delete)\((\w+)\)/g)) push({ method: m[2].toUpperCase(), path: m[1], handler: m[3], file: f.path, line: lineAt(t, m.index ?? 0), framework: "Axum", auth: "unknown", symbolId: findSym(f.path, m[3])?.id, kind: "api" });
    }
  }
  return routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

// ---------------------------------------------------------------------------
// Data models
// ---------------------------------------------------------------------------
export function detectModels(files: LoadedFile[], symbols: SymbolRow[]): ModelInfo[] {
  const models: ModelInfo[] = [];
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const s of symbols) {
    if (s.kind !== "model" && s.kind !== "table" && s.kind !== "schema") continue;
    const f = byPath.get(s.filePath);
    if (!f || f.isTest) continue;
    const meta = (s.meta ?? {}) as Record<string, unknown>;
    let fields = (meta.fields as string[] | undefined) ?? [];
    let references = (meta.references as string[] | undefined) ?? [];
    let orm: string | undefined = f?.language === "Prisma" ? "Prisma" : f?.language === "SQL" ? "SQL" : undefined;
    if (f?.text && fields.length === 0) {
      const body = f.text.split("\n").slice(s.startLine - 1, s.endLine).join("\n");
      if (f.language === "Python") {
        fields = [...body.matchAll(/^\s{4}(\w+)\s*(?::\s*[^=\n]+)?=\s*(?:models\.|Column\(|db\.Column\(|Field\(|mapped_column\(|relationship\()/gm)].map((m) => m[1]);
        if (fields.length === 0) fields = [...body.matchAll(/^\s{4}(\w+)\s*:\s*[A-Za-z]/gm)].map((m) => m[1]);
        references = [...body.matchAll(/(?:ForeignKey|relationship|ManyToManyField|OneToOneField)\(\s*['"]?([A-Za-z_.]+)['"]?/g)].map((m) => m[1].split(".").pop()!);
        orm = /models\.Model/.test(body) ? "Django ORM" : /Column\(|mapped_column|declarative/.test(body) ? "SQLAlchemy" : /BaseModel/.test(body) ? "Pydantic" : orm;
      } else if (f.language === "TypeScript" || f.language === "JavaScript") {
        if (/sqliteTable|pgTable|mysqlTable/.test(body)) { fields = [...body.matchAll(/^\s+(\w+)\s*:\s*(?:text|integer|real|blob|varchar|serial|uuid|boolean|timestamp|json|jsonb|numeric|bigint|date|int|smallint|doublePrecision|customType)\(/gm)].map((m) => m[1]); orm = "Drizzle"; references = [...body.matchAll(/references\(\s*\(\)\s*=>\s*(\w+)\./g)].map((m) => m[1]); }
        else if (/new Schema\(|mongoose\.Schema/.test(body)) { fields = [...body.matchAll(/^\s+(\w+)\s*:\s*\{?\s*(?:type\s*:\s*)?(?:String|Number|Boolean|Date|Schema|\[|ObjectId|Mixed|Buffer|Map)/gm)].map((m) => m[1]); orm = "Mongoose"; references = [...body.matchAll(/ref\s*:\s*['"](\w+)['"]/g)].map((m) => m[1]); }
        else if (/@Entity/.test(body) || /@Column|@PrimaryGeneratedColumn/.test(body)) { fields = [...body.matchAll(/@(?:Column|PrimaryGeneratedColumn|PrimaryColumn|CreateDateColumn|UpdateDateColumn|OneToMany|ManyToOne|ManyToMany|OneToOne)\([^)]*\)\s*\n?\s*(\w+)/g)].map((m) => m[1]); orm = "TypeORM"; references = [...body.matchAll(/@(?:OneToMany|ManyToOne|ManyToMany|OneToOne)\(\s*\(\)\s*=>\s*(\w+)/g)].map((m) => m[1]); }
        else if (/sequelize\.define|\.define\(/.test(body)) { fields = [...body.matchAll(/^\s+(\w+)\s*:\s*\{?\s*(?:type\s*:\s*)?DataTypes/gm)].map((m) => m[1]); orm = "Sequelize"; }
        else { fields = [...body.matchAll(/^\s+(\w+)\s*[?:]/gm)].map((m) => m[1]).slice(0, 60); }
      } else if (f.language === "Go") {
        fields = [...body.matchAll(/^\s+(\w+)\s+[\w.*\[\]]+/gm)].map((m) => m[1]).filter((x) => x !== "type");
        orm = /gorm:/.test(body) ? "GORM" : /bson:/.test(body) ? "MongoDB" : /db:/.test(body) ? "sqlx" : orm;
      } else if (f.language === "Java" || f.language === "Kotlin") {
        fields = [...body.matchAll(/^\s+(?:private|protected|public)?\s*(?:final\s+)?[\w<>\[\], ]+\s+(\w+)\s*(?:=|;)/gm)].map((m) => m[1]);
        references = [...body.matchAll(/@(?:OneToMany|ManyToOne|ManyToMany|OneToOne)[\s\S]{0,120}?\b(?:private|protected|public)?\s*(?:List<|Set<)?(\w+)>?\s+\w+/g)].map((m) => m[1]);
        orm = "JPA";
      } else if (f.language === "C#") {
        fields = [...body.matchAll(/public\s+(?:virtual\s+)?[\w<>\[\]?, ]+\s+(\w+)\s*\{\s*get;/g)].map((m) => m[1]);
        references = [...body.matchAll(/public\s+virtual\s+(?:ICollection<|List<)?(\w+)>?\s+\w+/g)].map((m) => m[1]);
        orm = "Entity Framework";
      } else if (f.language === "Ruby") {
        references = [...body.matchAll(/\b(?:has_many|belongs_to|has_one|has_and_belongs_to_many)\s+:(\w+)/g)].map((m) => m[1]);
        orm = "ActiveRecord";
      }
    }
    models.push({ name: s.name, file: s.filePath, line: s.startLine, endLine: s.endLine, kind: s.kind, fields: [...new Set(fields)].slice(0, 80), references: [...new Set(references)].filter((r) => r !== s.name), symbolId: s.id, orm });
  }
  return enrichRelations(mergeTableAndOrm(models), byPath);
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------
export function detectEntryPoints(files: LoadedFile[], symbols: SymbolRow[], deps: DependencyInfo[]): EntryPoint[] {
  const out: EntryPoint[] = [];
  const KIND_RANK: EntryPoint["kind"][] = ["web-server", "worker", "scheduled", "cli", "frontend", "application", "container", "script", "test-runner", "library"];
  /** One entry per file: keep the most specific kind (a web server outranks a bare library main). */
  const add = (e: EntryPoint) => {
    const i = out.findIndex((x) => x.path === e.path);
    if (i < 0) { out.push(e); return; }
    if (KIND_RANK.indexOf(e.kind) < KIND_RANK.indexOf(out[i].kind)) out[i] = { ...e, line: e.line ?? out[i].line };
    else if (out[i].line === undefined && e.line !== undefined) out[i] = { ...out[i], line: e.line };
  };
  const byPath = new Map(files.map((f) => [f.path, f]));
  const pkg = files.find((f) => f.name === "package.json" && !f.path.includes("/"))
    ?? files.find((f) => f.name === "package.json");
  if (pkg?.text) {
    try {
      const json = JSON.parse(pkg.text);
      const base = pkg.path.includes("/") ? pkg.path.slice(0, pkg.path.lastIndexOf("/") + 1) : "";
      for (const key of ["main", "module"]) if (typeof json[key] === "string" && byPath.has(base + json[key].replace(/^\.\//, ""))) add({ path: base + json[key].replace(/^\.\//, ""), kind: "library", reason: `package.json "${key}"` });
      if (json.bin) for (const v of Object.values<string>(typeof json.bin === "string" ? { cli: json.bin } : json.bin)) if (byPath.has(base + v.replace(/^\.\//, ""))) add({ path: base + v.replace(/^\.\//, ""), kind: "cli", reason: "package.json bin" });
      for (const [name, script] of Object.entries<string>(json.scripts ?? {})) {
        if (!/^(start|dev|serve|worker|build)$/.test(name)) continue;
        const m = script.match(/(?:node|tsx|ts-node|bun|deno run|nodemon)\s+(?:--\S+\s+)*(\S+\.[cm]?[jt]sx?)/);
        if (m && byPath.has(base + m[1].replace(/^\.\//, ""))) add({ path: base + m[1].replace(/^\.\//, ""), kind: name === "worker" ? "worker" : "application", reason: `package.json script "${name}"` });
        if (/\bnext\b/.test(script)) {
          const layout = files.find((f) => /(^|\/)app\/layout\.(tsx|jsx|js|ts)$/.test(f.path)) ?? files.find((f) => /(^|\/)pages\/_app\.(tsx|jsx|js|ts)$/.test(f.path));
          if (layout) add({ path: layout.path, kind: "frontend", reason: `Next.js root layout (package.json script "${name}")` });
        }
        if (/\bvite\b/.test(script)) {
          const idx = files.find((f) => /(^|\/)index\.html$/.test(f.path) && !f.path.includes("public/"));
          if (idx) add({ path: idx.path, kind: "frontend", reason: `Vite entry (package.json script "${name}")` });
        }
      }
    } catch { /* ignore */ }
  }
  for (const f of files) {
    if (!f.text || f.isExcluded || f.isTest) continue;
    const t = f.text;
    if (f.language === "Python") {
      if (/if\s+__name__\s*==\s*['"]__main__['"]/.test(t)) add({ path: f.path, kind: /uvicorn\.run|app\.run\(|serve\(|runserver/.test(t) ? "web-server" : /argparse|click|typer/.test(t) ? "cli" : "script", reason: "__main__ guard", line: lineAt(t, t.search(/if\s+__name__/)) });
      if (/^(manage|wsgi|asgi|main|app|server|run)\.py$/.test(f.name) && !f.path.split("/").some((p) => /tests?/.test(p))) add({ path: f.path, kind: /wsgi|asgi/.test(f.name) ? "web-server" : f.name === "manage.py" ? "cli" : "application", reason: `conventional ${f.name}` });
      if (/\b(FastAPI|Flask|Sanic|Starlette|Quart)\(/.test(t)) add({ path: f.path, kind: "web-server", reason: "web application instance created", line: lineAt(t, t.search(/\b(FastAPI|Flask|Sanic|Starlette|Quart)\(/)) });
      if (/\bCelery\(/.test(t)) add({ path: f.path, kind: "worker", reason: "Celery application instance", line: lineAt(t, t.search(/\bCelery\(/)) });
    }
    if (f.language === "Go" && /^package main\b/m.test(t) && /func main\(\)/.test(t)) add({ path: f.path, kind: /http\.ListenAndServe|\.Run\(|\.Listen\(|ListenAndServe/.test(t) ? "web-server" : /cobra|flag\.Parse/.test(t) ? "cli" : "application", reason: "package main with func main()", line: lineAt(t, t.search(/func main\(\)/)), symbolName: "main", symbolId: symbols.find((s) => s.filePath === f.path && s.name === "main")?.id });
    if (f.language === "Java" && /public\s+static\s+void\s+main\s*\(/.test(t)) add({ path: f.path, kind: /SpringApplication\.run/.test(t) ? "web-server" : "application", reason: "public static void main", line: lineAt(t, t.search(/public\s+static\s+void\s+main/)) });
    if (f.language === "Kotlin" && /fun\s+main\s*\(/.test(t)) add({ path: f.path, kind: /runApplication|embeddedServer/.test(t) ? "web-server" : "application", reason: "fun main()", line: lineAt(t, t.search(/fun\s+main/)) });
    if (f.language === "C#" && (/static\s+(?:async\s+)?(?:void|int|Task(?:<int>)?)\s+Main\s*\(/.test(t) || (f.name === "Program.cs" && /WebApplication\.CreateBuilder|CreateHostBuilder|Host\.CreateDefaultBuilder/.test(t)))) add({ path: f.path, kind: /WebApplication|WebHost|Kestrel/.test(t) ? "web-server" : "application", reason: f.name === "Program.cs" ? "Program.cs host builder" : "static Main", line: 1 });
    if (f.language === "Rust" && /fn\s+main\s*\(/.test(t) && /src\/(main|bin\/[^/]+)\.rs$/.test(f.path)) add({ path: f.path, kind: /HttpServer|axum::Server|serve\(/.test(t) ? "web-server" : /clap|structopt/.test(t) ? "cli" : "application", reason: "fn main()", line: lineAt(t, t.search(/fn\s+main/)) });
    if (f.language === "Ruby" && /config\.ru$/.test(f.path)) add({ path: f.path, kind: "web-server", reason: "Rack config.ru" });
    if (f.language === "PHP" && /(^|\/)public\/index\.php$/.test(f.path)) add({ path: f.path, kind: "web-server", reason: "public/index.php front controller" });
    if ((f.language === "TypeScript" || f.language === "JavaScript") && !f.path.includes("node_modules")) {
      if (/\.(listen|serve)\(\s*(?:\{[^}]*\}|\d+|PORT|port|process\.env|config)/.test(t) || /createServer\(/.test(t) || /Bun\.serve\(|Deno\.serve\(|serve\(\{\s*fetch/.test(t)) add({ path: f.path, kind: "web-server", reason: "server listen/serve call", line: lineAt(t, t.search(/\.(listen|serve)\(|createServer\(|Bun\.serve|Deno\.serve/)) });
      if (/^#!\/usr\/bin\/env node/m.test(t) || /new Command\(\)|yargs\(|\.parseAsync\(|program\.parse\(/.test(t)) add({ path: f.path, kind: "cli", reason: "CLI entry (shebang or argument parser)", line: 1 });
      if (/new Worker\(|\.process\(\s*['"]|worker\.run\(|createWorker\(|new Queue\(/.test(t) && /bullmq|bull|bee-queue|graphile|pg-boss|inngest|temporal/i.test(t)) add({ path: f.path, kind: "worker", reason: "queue worker registration", line: lineAt(t, t.search(/new Worker\(|\.process\(|createWorker\(/)) });
      if (/\bcron\.schedule\(|new CronJob\(|schedule\.scheduleJob\(/.test(t)) add({ path: f.path, kind: "scheduled", reason: "scheduled job registration", line: lineAt(t, t.search(/cron\.schedule\(|new CronJob\(|scheduleJob\(/)) });
      else if (/\bsetInterval\(/.test(t) && /(^|\/)(worker|workers|scheduler|cron|jobs?)\.(ts|js|mts|mjs)$/.test(f.path)) add({ path: f.path, kind: "worker", reason: "polling loop (setInterval) in a worker module", line: lineAt(t, t.search(/setInterval\(/)) });
      if (/(^|\/)(instrumentation|proxy|middleware)\.(ts|js)$/.test(f.path)) add({ path: f.path, kind: "application", reason: "Next.js instrumentation/middleware boundary", line: 1 });
      if (/(^|\/)src\/(index|main)\.(tsx|jsx)$/.test(f.path) && /createRoot|ReactDOM\.render|hydrateRoot|createApp\(/.test(t)) add({ path: f.path, kind: "frontend", reason: "client bootstrap (createRoot/createApp)", line: 1 });
      if (/(^|\/)src\/(index|main|app|server)\.(ts|js|mts|cts)$/.test(f.path) && !out.some((e) => e.path === f.path)) add({ path: f.path, kind: "application", reason: "conventional entry file name" });
    }
    if (f.language === "Dockerfile") {
      const cmd = t.match(/^\s*(CMD|ENTRYPOINT)\s+(.+)$/m);
      if (cmd) add({ path: f.path, kind: "container", reason: `${cmd[1]} ${cmd[2].slice(0, 80)}`, line: lineAt(t, cmd.index ?? 0) });
    }
    if (/(^|\/)Procfile$/.test(f.path)) for (const m of t.matchAll(/^(\w+):\s*(.+)$/gm)) add({ path: f.path, kind: m[1] === "web" ? "web-server" : "worker", reason: `Procfile ${m[1]}: ${m[2].slice(0, 60)}` });
    if (/(^|\/)\.github\/workflows\/.*\.ya?ml$/.test(f.path) && /schedule:\s*\n\s*-\s*cron/.test(t)) add({ path: f.path, kind: "scheduled", reason: "GitHub Actions cron schedule" });
  }
  // Test runner entry
  const testFw = deps.find((d) => /^(jest|vitest|mocha|pytest|@playwright\/test|cypress)$/.test(d.name));
  if (testFw) {
    const cfg = files.find((f) => new RegExp(`^(?:.*/)?(?:${testFw.name.replace("@playwright/test", "playwright")}|jest|vitest)\\.config\\.[cm]?[jt]s$`).test(f.path)) ?? files.find((f) => /pytest\.ini|pyproject\.toml|setup\.cfg/.test(f.name));
    if (cfg) add({ path: cfg.path, kind: "test-runner", reason: `${testFw.name} configuration` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Infra & AI components
// ---------------------------------------------------------------------------
export function detectInfra(files: LoadedFile[]): InfraInfo[] {
  const out: InfraInfo[] = [];
  for (const f of files) {
    if (f.isExcluded) continue;
    const p = f.path;
    const n = f.name.toLowerCase();
    if (f.language === "Dockerfile") out.push({ path: p, kind: "Docker", detail: f.text?.match(/^FROM\s+(.+)$/m)?.[1]?.slice(0, 80) ? `FROM ${f.text.match(/^FROM\s+(.+)$/m)![1].slice(0, 80)}` : "Dockerfile" });
    else if (/docker-compose.*\.ya?ml$|^compose\.ya?ml$/.test(n)) out.push({ path: p, kind: "Docker Compose", detail: `${(f.text?.match(/^  [\w.-]+:\s*$/gm) ?? []).length} services` });
    else if (/\.tf$|\.tfvars$/.test(n)) out.push({ path: p, kind: "Terraform", detail: [...(f.text?.matchAll(/^resource\s+"([^"]+)"/gm) ?? [])].map((m) => m[1]).slice(0, 5).join(", ") || "terraform" });
    else if (/^\.github\/workflows\//.test(p)) out.push({ path: p, kind: "GitHub Actions", detail: f.text?.match(/^name:\s*(.+)$/m)?.[1] ?? "workflow" });
    else if (/^\.gitlab-ci\.yml$/.test(p)) out.push({ path: p, kind: "GitLab CI", detail: "pipeline" });
    else if (/^\.circleci\//.test(p)) out.push({ path: p, kind: "CircleCI", detail: "pipeline" });
    else if (/^jenkinsfile$/.test(n)) out.push({ path: p, kind: "Jenkins", detail: "pipeline" });
    else if (/(^|\/)(k8s|kubernetes|helm|charts)\//.test(p) || (f.language === "YAML" && /^kind:\s*(Deployment|Service|Ingress|StatefulSet|CronJob|Job|ConfigMap)/m.test(f.text ?? ""))) out.push({ path: p, kind: "Kubernetes", detail: f.text?.match(/^kind:\s*(\w+)/m)?.[1] ?? "manifest" });
    else if (/^vercel\.(json|ts)$/.test(n)) out.push({ path: p, kind: "Vercel", detail: "project configuration" });
    else if (/^netlify\.toml$/.test(n)) out.push({ path: p, kind: "Netlify", detail: "site configuration" });
    else if (/^fly\.toml$/.test(n)) out.push({ path: p, kind: "Fly.io", detail: "app configuration" });
    else if (/^render\.ya?ml$/.test(n)) out.push({ path: p, kind: "Render", detail: "blueprint" });
    else if (/^serverless\.ya?ml$/.test(n)) out.push({ path: p, kind: "Serverless Framework", detail: "service" });
    else if (/^procfile$/.test(n)) out.push({ path: p, kind: "Procfile", detail: "process types" });
    else if (/^(cdk|pulumi)\.(json|ya?ml)$/.test(n)) out.push({ path: p, kind: n.startsWith("cdk") ? "AWS CDK" : "Pulumi", detail: "infrastructure as code" });
    else if (/nginx\.conf$|\.nginx$/.test(n)) out.push({ path: p, kind: "Nginx", detail: "reverse proxy" });
    else if (/^(ansible|playbook).*\.ya?ml$/.test(n)) out.push({ path: p, kind: "Ansible", detail: "playbook" });
  }
  return out;
}

export function detectAIComponents(files: LoadedFile[]): AIComponent[] {
  const out: AIComponent[] = [];
  for (const f of files) {
    if (!f.text || f.isExcluded || f.isTest || f.classification !== "source") continue;
    const t = f.text;
    const checks: { re: RegExp; kind: AIComponent["kind"]; detail: string }[] = [
      { re: /new Anthropic\(|Anthropic\(|anthropic\.messages|client\.messages\.(create|stream|parse)/, kind: "provider", detail: "Anthropic client usage" },
      { re: /new OpenAI\(|OpenAI\(|openai\.(chat|ChatCompletion|Completion|embeddings)|chat\.completions\.create/, kind: "provider", detail: "OpenAI client usage" },
      { re: /generateText\(|streamText\(|generateObject\(|streamObject\(|useChat\(/, kind: "provider", detail: "Vercel AI SDK usage" },
      { re: /GenerativeModel\(|genai\./, kind: "provider", detail: "Google generative AI usage" },
      { re: /embeddings\.create|embed(Many|Query|Documents)?\(|Embeddings\(|text-embedding/, kind: "embedding", detail: "embedding generation" },
      { re: /pgvector|vector\(\d+\)|<->|cosine_distance|similarity_search|\.similaritySearch|VectorStore|Pinecone\(|QdrantClient|chromadb|Weaviate/, kind: "vector-store", detail: "vector similarity retrieval" },
      { re: /system_prompt|systemPrompt|SYSTEM_PROMPT|PROMPT_TEMPLATE|PromptTemplate|ChatPromptTemplate|role:\s*['"]system['"]|"role":\s*"system"/, kind: "prompt", detail: "prompt definition" },
      { re: /tool_use|tools:\s*\[|@tool\b|Tool\(|function_call|tool_choice|toolRunner|StructuredTool/, kind: "tool", detail: "model tool definitions" },
      { re: /AgentExecutor|create_react_agent|createAgent|Agent\(|StateGraph|langgraph|CrewAI|AutoGen|Swarm\(/, kind: "agent", detail: "agent orchestration" },
      { re: /LLMChain|RunnableSequence|\.pipe\(\s*(model|llm)|RetrievalQA|ConversationChain/, kind: "orchestration", detail: "LLM chain orchestration" },
    ];
    for (const c of checks) {
      const idx = t.search(c.re);
      if (idx >= 0) out.push({ path: f.path, line: lineAt(t, idx), kind: c.kind, detail: c.detail });
    }
  }
  return out;
}

const singular = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/ies$/, "y").replace(/(ses|xes|zes|ches|shes)$/, (m) => m.slice(0, -2)).replace(/s$/, "");

/**
 * A SQL table and an ORM class that describe the same entity (users / User) are
 * reported once: the ORM model is kept (code reads and writes it) and the table's
 * columns and foreign keys are folded in.
 */
function mergeTableAndOrm(models: ModelInfo[]): ModelInfo[] {
  const tables = models.filter((m) => m.orm === "SQL" || m.kind === "table");
  const orm = models.filter((m) => !(m.orm === "SQL" || m.kind === "table"));
  const consumed = new Set<ModelInfo>();
  for (const t of tables) {
    const match = orm.find((o) => singular(o.name) === singular(t.name));
    if (!match) continue;
    consumed.add(t);
    match.fields = [...new Set([...match.fields, ...t.fields])].slice(0, 80);
    match.references = [...new Set([...match.references, ...t.references.map((r) => orm.find((o) => singular(o.name) === singular(r))?.name ?? r)])].filter((r) => r !== match.name);
    match.orm = `${match.orm ?? "ORM"} + SQL table ${t.name} (${t.file}:${t.line})`;
  }
  const out = models.filter((m) => !consumed.has(m));
  // Re-point foreign keys of unmerged tables at merged ORM names.
  for (const m of out) m.references = [...new Set(m.references.map((r) => out.find((o) => singular(o.name) === singular(r))?.name ?? r))].filter((r) => r !== m.name);
  return out;
}


// ---------------------------------------------------------------------------
// Model fields with types, and relationships between models
// ---------------------------------------------------------------------------
const MANY = /\b(?:List|list|Set|set|Sequence|Iterable|Iterator|Collection|Array|ICollection|IList|Vec|slice)\b|\[\]|\bmany\b/;
const OPTIONAL = /\bOptional\b|\|\s*None\b|\bNone\s*\||\?\s*$|\bNullable\b|\bnull\b|\bundefined\b|\*\w/;

/** Typed fields of a model body, per language. Names only when a language does not declare types. */
export function parseTypedFields(language: string | null | undefined, body: string): ModelField[] {
  const out: ModelField[] = [];
  const push = (name: string, type: string) => { if (name && !out.some((f) => f.name === name)) out.push({ name, type: type.replace(/\s+/g, " ").trim().slice(0, 80) }); };
  const lines = body.split("\n").slice(1);
  if (language === "Python") {
    for (const l of lines) {
      const ann = l.match(/^\s{4}(\w+)\s*:\s*([^=#\n]+?)\s*(?:=.*)?(?:#.*)?$/);
      if (ann && !/^\s{4}(?:def|class|return|if|for|while|with|try|import)\b/.test(l) && !/^(?:self|cls)$/.test(ann[1])) { push(ann[1], ann[2]); continue; }
      const asg = l.match(/^\s{4}(\w+)\s*=\s*(?:\w+\.)*(\w+)\(\s*(?:['"]?([A-Za-z_][\w.]*)['"]?)?/);
      if (asg && /^(?:Column|mapped_column|relationship|ForeignKey|Field|\w+Field)$/.test(asg[2])) push(asg[1], asg[2] === "relationship" || asg[2] === "ForeignKey" ? (asg[3] ?? asg[2]).split(".").pop()! : asg[3] && /^[A-Z]/.test(asg[3]) ? asg[3] : asg[2]);
    }
  } else if (language === "TypeScript" || language === "JavaScript") {
    for (const l of lines) {
      const m = l.match(/^\s+(?:readonly\s+|public\s+|private\s+|protected\s+)*(\w+)(\?)?\s*:\s*([^;=,{]+?)\s*[;,]?\s*(?:\/\/.*)?$/);
      if (m && !/^(?:return|case|default)$/.test(m[1])) push(m[1], `${m[3]}${m[2] ? " | undefined" : ""}`);
    }
  } else if (language === "Go") {
    for (const l of lines) { const m = l.match(/^\s+(\w+)\s+([\w.*\[\]]+)/); if (m && m[1] !== "type") push(m[1], m[2]); }
  } else if (language === "Java" || language === "Kotlin") {
    for (const l of lines) { const m = l.match(/^\s*(?:private|protected|public)?\s*(?:final\s+)?([\w<>\[\],. ?]+?)\s+(\w+)\s*(?:=[^;]*)?;/); if (m) push(m[2], m[1]); const k = l.match(/^\s*(?:val|var)\s+(\w+)\s*:\s*([^=,)]+)/); if (k) push(k[1], k[2]); }
  } else if (language === "C#") {
    for (const l of lines) { const m = l.match(/public\s+(?:virtual\s+)?([\w<>\[\]?,. ]+?)\s+(\w+)\s*\{\s*get;/); if (m) push(m[2], m[1]); }
  } else if (language === "JSON") {
    for (const m of body.matchAll(/"(\w+)"\s*:\s*\{([^{}]*)\}/g)) {
      const ref = m[2].match(/"\$ref"\s*:\s*"[^"]*?(\w+)"/);
      const type = m[2].match(/"type"\s*:\s*"(\w+)"/);
      push(m[1], ref ? ref[1] : type ? type[1] : "object");
    }
  }
  return out;
}

/** Turn a type expression into the model names it mentions. */
function mentionedNames(type: string): string[] {
  return [...new Set(type.match(/[A-Za-z_]\w*/g) ?? [])];
}

/** Give every model a unique id, typed fields, and relations found in field types, foreign keys and schema $refs. */
function enrichRelations(models: ModelInfo[], byPath: Map<string, LoadedFile>): ModelInfo[] {
  for (const m of models) m.id = `${m.file}#${m.name}`;
  const byName = new Map<string, ModelInfo[]>();
  for (const m of models) { const l = byName.get(m.name) ?? []; l.push(m); byName.set(m.name, l); }
  const dir = (p: string) => p.slice(0, p.lastIndexOf("/") + 1);
  /** When several models share a name, prefer one in the same file, then the same folder, then the same language. */
  const resolve = (name: string, from: ModelInfo): ModelInfo | undefined => {
    const c = byName.get(name);
    if (!c) return undefined;
    return c.find((x) => x.file === from.file && x !== from) ?? c.find((x) => dir(x.file) === dir(from.file) && x !== from) ?? c.find((x) => x !== from && byPath.get(x.file)?.language === byPath.get(from.file)?.language) ?? c.find((x) => x !== from);
  };
  for (const m of models) {
    const f = byPath.get(m.file);
    const body = f?.text ? f.text.split("\n").slice(m.line - 1, m.endLine).join("\n") : "";
    const typed = body ? parseTypedFields(f?.language, body) : [];
    const relations: ModelRelation[] = [];
    const addRel = (target: ModelInfo | undefined, via: string, cardinality: ModelRelation["cardinality"], source: ModelRelation["source"]) => {
      if (!target || target === m) return;
      if (relations.some((r) => r.target === target.id && r.via === via)) return;
      relations.push({ target: target.id!, targetName: target.name, via, cardinality, source });
    };
    for (const tf of typed) {
      for (const n of mentionedNames(tf.type)) {
        const t = n !== m.name || byName.get(n)!.length > 1 ? resolve(n, m) : undefined;
        if (!t) continue;
        addRel(t, tf.name, MANY.test(tf.type) ? "many" : OPTIONAL.test(tf.type) ? "optional" : "one", f?.language === "JSON" ? "schema-ref" : "type-reference");
        tf.relation = true;
      }
    }
    for (const r of m.references) addRel(resolve(r, m), "foreign key", "one", "foreign-key");
    // Keep declared field order; add names the language-specific parser found that have no type.
    const known = new Set(typed.map((t) => t.name));
    const fieldTypes = [...typed, ...m.fields.filter((n) => !known.has(n)).map((n) => ({ name: n, type: "" }))];
    m.fieldTypes = fieldTypes.slice(0, 80);
    if (typed.length && m.fields.length < typed.length) m.fields = fieldTypes.map((t) => t.name).slice(0, 80);
    m.relations = relations;
    m.references = [...new Set([...m.references, ...relations.map((r) => r.targetName)])].filter((r) => r !== m.name);
  }
  return models;
}
