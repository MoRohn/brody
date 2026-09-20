import { eq, and } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import type { RelationshipRow, SymbolRow } from "../db/schema";
import { loadProjectFiles, type LoadedFile } from "../graph/build";
import { detectSecrets } from "../ingest/secrets";
import { newId } from "../util/ids";
import { AREA_HINTS, FRAMEWORK_SIGNATURES } from "./catalog";
import { detectAIComponents, detectDependencies, detectEntryPoints, detectEnvVars, detectExternalServices, detectInfra, detectModels, detectRoutes } from "./detect";
import type { Architecture, DataFlow, FlowStep, FunctionalArea, TestInfo } from "./types";

export * from "./types";

const ROLE_ORDER = ["entry", "api", "ui", "service", "data", "ai", "job", "infra", "config", "test", "docs", "util", "schema", "unknown"];

function humanizeDir(dir: string): string {
  return dir.split("/").pop()!.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function assignRole(f: LoadedFile, symbols: SymbolRow[], routes: Set<string>, entries: Set<string>): string {
  if (entries.has(f.path)) return "entry";
  if (f.isTest || f.classification === "test") return "test";
  if (f.classification === "docs") return "docs";
  if (f.classification === "infra" || f.classification === "ci") return "infra";
  if (f.classification === "schema") return "schema";
  if (f.classification === "config" || f.classification === "manifest" || f.classification === "lockfile") return "config";
  if (routes.has(f.path)) return "api";
  const kinds = new Set(symbols.map((s) => s.kind));
  if (kinds.has("endpoint") || /(^|\/)(api|routes?|controllers?|handlers?|endpoints?|resolvers?)(\/|\.)/i.test(f.path)) return "api";
  if (kinds.has("component") || kinds.has("hook") || /\.(tsx|jsx|vue|svelte)$/.test(f.path) || /(^|\/)(components?|pages?|views?|screens?|layouts?|ui)\//i.test(f.path)) return "ui";
  if (kinds.has("model") || kinds.has("table") || /(^|\/)(models?|entities|repositories|db|database|schema|migrations?|prisma|dal)\//i.test(f.path)) return "data";
  if (/(^|\/)(ai|llm|agents?|prompts?|rag|embeddings?|inference)\//i.test(f.path)) return "ai";
  if (kinds.has("job") || kinds.has("event_handler") || /(^|\/)(jobs?|workers?|tasks?|cron|scheduler|queue|consumers?)\//i.test(f.path)) return "job";
  if (kinds.has("service") || /(^|\/)(services?|domain|core|usecases?|use_cases|business|logic|managers?|providers?)\//i.test(f.path)) return "service";
  if (/(^|\/)(utils?|helpers?|common|shared|toolkit|support)\//i.test(f.path)) return "util";
  if (f.classification === "source") return symbols.some((s) => s.kind === "class" || s.kind === "function" || s.kind === "method") ? "service" : "util";
  return "unknown";
}

function areaFor(f: LoadedFile, role: string): { name: string; description: string } {
  if (role === "test") return { name: "Testing", description: "Automated tests, fixtures and mocks." };
  if (role === "docs") return { name: "Documentation", description: "Project documentation." };
  if (role === "infra") return { name: "Infrastructure & Deployment", description: "Build, deployment and operations." };
  if (role === "config" && !f.path.includes("/")) return { name: "Configuration", description: "Runtime configuration and tooling settings." };
  const dirs = f.directory.split("/").filter(Boolean);
  const generic = /^(src|app|lib|pkg|internal|cmd|packages|apps|main|java|kotlin|python|source|code|server|backend|frontend|client|web)$/i;
  const catchAll = /^(utils?|utilities|helpers?|lib|libs|common|shared|pkg|toolkit|support)$/i;
  // The most specific directory that names a real concern wins. Catch-all directories (lib, utils, ...) are
  // skipped so that src/lib/parse becomes "Parse" rather than one giant "Shared Utilities" bucket.
  for (let i = dirs.length - 1; i >= 0; i--) {
    if (catchAll.test(dirs[i])) continue;
    for (const h of AREA_HINTS) if (h.name !== "Shared Utilities" && h.match.test(dirs[i] + "/")) return { name: h.name, description: h.description };
  }
  const k = dirs.findIndex((d) => catchAll.test(d));
  if (k >= 0 && dirs[k + 1] && !generic.test(dirs[k + 1])) return { name: humanizeDir(dirs[k + 1]), description: `Code under ${dirs.slice(0, k + 2).join("/")}/.` };
  if (k >= 0) return { name: "Shared Utilities", description: "Reusable helpers and shared code." };
  if (role === "data" || role === "schema") return { name: "Data Layer", description: "Schemas, models, migrations and data access." };
  if (role === "ui") return { name: "User Interface", description: "Pages, components and client-side state." };
  if (role === "api") return { name: "API Layer", description: "HTTP/RPC endpoints and request handling." };
  if (role === "ai") return { name: "AI Processing", description: "Language-model prompts, agents and inference." };
  if (role === "job") return { name: "Background Jobs", description: "Asynchronous and scheduled work." };
  if (role === "entry") return { name: "Application Core", description: "Startup and top-level wiring." };
  const meaningful = dirs.filter((d) => !generic.test(d));
  if (meaningful.length) return { name: humanizeDir(meaningful[0]), description: `Code under ${dirs.slice(0, dirs.indexOf(meaningful[0]) + 1).join("/")}/.` };
  if (dirs.length && role !== "config") return { name: "Application Core", description: "Top-level application code." };
  return { name: role === "config" ? "Configuration" : "Application Core", description: role === "config" ? "Runtime configuration and tooling settings." : "Top-level application code." };
}

function detectTests(files: LoadedFile[], rels: RelationshipRow[], filesById: Map<string, LoadedFile>, symbolsById: Map<string, SymbolRow>, deps: { name: string }[]): Architecture["tests"] {
  const testFiles = files.filter((f) => !f.isExcluded && (f.isTest || f.classification === "test"));
  const frameworks = FRAMEWORK_SIGNATURES.filter((fw) => fw.category === "testing" && fw.packages.some((p) => deps.some((d) => d.name === p))).map((f) => f.name);
  const infos: TestInfo[] = testFiles.map((f) => {
    const kind: TestInfo["kind"] = /(^|\/)(e2e|cypress|playwright|integration)(\/|\.)/i.test(f.path) || /\.e2e\./.test(f.path) ? (/(e2e|cypress|playwright)/i.test(f.path) ? "e2e" : "integration") : /fixtures?\//i.test(f.path) || /fixture/i.test(f.name) ? "fixture" : /__mocks__|mocks?\//i.test(f.path) || /mock/i.test(f.name) ? "mock" : /(helpers?|utils?|setup|conftest)/i.test(f.name) ? "helper" : /integration|api\.test|\.int\./i.test(f.path) ? "integration" : "unit";
    const targets = rels.filter((r) => r.kind === "TESTS" && r.sourceId === f.id).map((r) => (r.targetType === "file" ? filesById.get(r.targetId)?.path : symbolsById.get(r.targetId)?.filePath)).filter((x): x is string => !!x);
    const fw = f.text ? (/from ['"]vitest['"]/.test(f.text) ? "Vitest" : /from ['"]@playwright\/test['"]/.test(f.text) ? "Playwright" : /cy\./.test(f.text) ? "Cypress" : /import pytest|def test_/.test(f.text) ? "pytest" : /unittest/.test(f.text) ? "unittest" : /testing\.T\b/.test(f.text) ? "Go testing" : /@Test/.test(f.text) ? "JUnit/xUnit" : /RSpec\.describe|describe\s+['"]/.test(f.text) && f.language === "Ruby" ? "RSpec" : /describe\(|it\(|test\(/.test(f.text) ? "Jest-style" : undefined) : undefined;
    return { path: f.path, kind, framework: fw, targets: [...new Set(targets)] };
  });
  const tested = new Set(infos.flatMap((t) => t.targets));
  const untestedCritical = files
    .filter((f) => !f.isExcluded && f.classification === "source" && !f.isTest && !tested.has(f.path) && f.importance > 0.15)
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 25)
    .map((f) => ({ path: f.path, reason: `high-importance ${f.role ?? "source"} file with no test referencing it` }));
  const coverageByArea: Record<string, { tested: number; total: number }> = {};
  for (const f of files) {
    if (f.isExcluded || f.classification !== "source" || f.isTest || !f.area) continue;
    const c = (coverageByArea[f.area] ??= { tested: 0, total: 0 });
    c.total++;
    if (tested.has(f.path)) c.tested++;
  }
  return { files: infos, frameworks, untestedCritical, coverageByArea };
}

function buildFlows(arch: Pick<Architecture, "routes" | "entryPoints" | "models">, symbolsById: Map<string, SymbolRow>, rels: RelationshipRow[], filesById: Map<string, LoadedFile>, filesByPath: Map<string, LoadedFile>): DataFlow[] {
  const outBySource = new Map<string, RelationshipRow[]>();
  for (const r of rels) {
    const l = outBySource.get(r.sourceId) ?? [];
    l.push(r);
    outBySource.set(r.sourceId, l);
  }
  const flows: DataFlow[] = [];
  const expand = (startId: string, startLabel: string, kind: DataFlow["kind"], trigger: string, name: string, evidence: DataFlow["evidence"]): DataFlow | undefined => {
    const steps: FlowStep[] = [];
    const models = new Set<string>();
    const externals = new Set<string>();
    const visited = new Set<string>();
    const start = symbolsById.get(startId);
    steps.push({ label: startLabel, kind: start?.kind ?? "handler", path: start?.filePath, line: start?.startLine, symbolId: startId });
    const queue: { id: string; depth: number }[] = [{ id: startId, depth: 0 }];
    visited.add(startId);
    while (queue.length && steps.length < 14) {
      const { id, depth } = queue.shift()!;
      const outs = (outBySource.get(id) ?? []).filter((r) => ["CALLS", "INSTANTIATES", "USES", "READS_FROM", "WRITES_TO", "EMITS", "DEPENDS_ON"].includes(r.kind)).sort((a, b) => b.confidence - a.confidence);
      for (const r of outs) {
        if (r.targetType === "symbol") {
          const t = symbolsById.get(r.targetId);
          if (!t || visited.has(t.id)) continue;
          if (r.kind === "READS_FROM" || r.kind === "WRITES_TO") {
            models.add(t.name);
            steps.push({ label: `${r.kind === "WRITES_TO" ? "writes" : "reads"} ${t.name}`, kind: "model", path: t.filePath, line: t.startLine, symbolId: t.id, detail: (r.meta as { expression?: string } | null)?.expression });
            visited.add(t.id);
            continue;
          }
          if (["service", "function", "method", "class", "job", "endpoint", "hook", "component", "model"].includes(t.kind) && depth < 3) {
            visited.add(t.id);
            steps.push({ label: t.qualifiedName, kind: t.kind, path: t.filePath, line: t.startLine, symbolId: t.id });
            queue.push({ id: t.id, depth: depth + 1 });
            if (steps.length >= 14) break;
          }
        } else if (r.targetType === "external") {
          const name = r.targetId.replace(/^(pkg|event|type):/, "");
          if (r.kind === "EMITS") { externals.add(`event ${name}`); steps.push({ label: `emits ${name}`, kind: "event" }); }
          else if (r.kind === "DEPENDS_ON" && /stripe|aws|openai|anthropic|redis|pg|prisma|mongoose|kafka|amqp|sendgrid|twilio|resend|supabase|firebase|@aws-sdk|boto3|sqlalchemy|django/i.test(name)) { externals.add(name); }
        }
      }
      // file-level relationships when the symbol is a file
      const file = filesById.get(id);
      if (file) {
        for (const r of (outBySource.get(id) ?? []).filter((x) => x.kind === "IMPORTS").slice(0, 6)) {
          const tf = filesById.get(r.targetId);
          if (tf && !visited.has(tf.id) && depth < 2 && (tf.role === "service" || tf.role === "data" || tf.role === "api")) {
            visited.add(tf.id);
            steps.push({ label: tf.path, kind: tf.role ?? "file", path: tf.path, line: 1 });
            queue.push({ id: tf.id, depth: depth + 1 });
          }
        }
      }
    }
    if (steps.length < 2) return undefined;
    return { id: newId("flow"), name, kind, trigger, steps, models: [...models], externals: [...externals], evidence };
  };
  // Request flows from routes (top by importance)
  const routeFlows = arch.routes.filter((r) => r.symbolId && symbolsById.has(r.symbolId)).map((r) => ({ r, imp: symbolsById.get(r.symbolId!)!.importance }))
    .sort((a, b) => b.imp - a.imp).slice(0, 25);
  for (const { r } of routeFlows) {
    const f = expand(r.symbolId!, `${r.method} ${r.path}`, "request", `${r.method} ${r.path}`, `${r.method} ${r.path}`, [{ path: r.file, line: r.line }]);
    if (f && f.steps.length >= 2) flows.push(f);
  }
  // Job / event flows
  for (const s of [...symbolsById.values()].filter((s) => s.kind === "job" || s.kind === "event_handler").slice(0, 10)) {
    const f = expand(s.id, s.qualifiedName, s.kind === "job" ? "job" : "event", s.kind === "job" ? "scheduled or queued job" : "incoming event", `${s.kind === "job" ? "Job" : "Event"}: ${s.name}`, [{ path: s.filePath, line: s.startLine }]);
    if (f) flows.push(f);
  }
  // Startup flows from entry points
  for (const e of arch.entryPoints.filter((e) => e.kind === "web-server" || e.kind === "application").slice(0, 3)) {
    const file = filesByPath.get(e.path);
    if (!file) continue;
    const entrySym = e.symbolId ? symbolsById.get(e.symbolId) : [...symbolsById.values()].find((s) => s.filePath === e.path && /^(main|start|bootstrap|init|run|createApp|createServer)$/i.test(s.name));
    const f = expand(entrySym?.id ?? file.id, entrySym ? entrySym.qualifiedName : e.path, "startup", e.reason, `Startup: ${e.path}`, [{ path: e.path, line: e.line }]);
    if (f) flows.push(f);
  }
  return flows;
}

function detectPattern(files: LoadedFile[], arch: Pick<Architecture, "routes" | "entryPoints" | "infra" | "stack" | "externalServices">): Architecture["pattern"] {
  const reasoning: string[] = [];
  const src = files.filter((f) => !f.isExcluded && f.classification === "source");
  const roots = new Set(src.map((f) => f.path.split("/")[0]));
  const hasFrontend = arch.stack.frameworks.some((f) => ["frontend-framework", "ui-library"].includes(f.category));
  const hasBackend = arch.stack.frameworks.some((f) => ["backend-framework", "api-framework"].includes(f.category)) || arch.routes.some((r) => r.kind === "api");
  const workers = arch.entryPoints.filter((e) => e.kind === "worker" || e.kind === "scheduled").length;
  const servers = arch.entryPoints.filter((e) => e.kind === "web-server").length;
  const composeServices = arch.infra.filter((i) => i.kind === "Docker Compose").length;
  const queue = arch.externalServices.some((s) => ["queue", "messaging", "workflow"].includes(s.category));
  const k8s = arch.infra.some((i) => i.kind === "Kubernetes");
  const monorepo = ["apps", "packages", "services"].some((d) => roots.has(d)) && src.filter((f) => /^(apps|packages|services)\//.test(f.path)).length > src.length * 0.5;
  const serverless = arch.infra.some((i) => /Serverless|Vercel|Netlify/.test(i.kind)) && !servers;
  let label = "unclassified";
  let confidence: Architecture["pattern"]["confidence"] = "low";
  if (monorepo && servers + (hasFrontend ? 1 : 0) > 1) { label = "monorepo with multiple deployable services"; confidence = "medium"; reasoning.push("Source is organised under apps/packages/services with more than one deployable entry point."); }
  else if (servers > 1 || (k8s && servers >= 1 && composeServices)) { label = "service-oriented (multiple servers)"; confidence = "medium"; reasoning.push(`${servers} server entry points were detected.`); }
  else if (queue && workers > 0 && hasBackend) { label = "modular monolith with worker-based pipeline"; confidence = "medium"; reasoning.push("A web server, a queue/messaging dependency and worker entry points coexist."); }
  else if (hasFrontend && hasBackend) { label = arch.stack.frameworks.some((f) => f.name === "Next.js") ? "full-stack monolith (Next.js)" : "client/server monolith"; confidence = "high"; reasoning.push("Both frontend and backend frameworks are present in one codebase."); }
  else if (hasBackend) { label = src.length > 150 ? "modular monolith (backend)" : "backend service / API"; confidence = "high"; reasoning.push(`Backend framework detected with ${arch.routes.length} routes and no frontend framework.`); }
  else if (hasFrontend) { label = "frontend application"; confidence = "high"; reasoning.push("Frontend framework present without server-side routes."); }
  else if (arch.entryPoints.some((e) => e.kind === "cli")) { label = "command-line application"; confidence = "medium"; reasoning.push("CLI entry point detected."); }
  else if (arch.entryPoints.some((e) => e.kind === "library")) { label = "library / SDK"; confidence = "medium"; reasoning.push("package main/module entry without server or CLI."); }
  else if (src.length > 0) { label = "library or script collection"; confidence = "low"; reasoning.push("No server, frontend or CLI entry detected."); }
  if (serverless) reasoning.push("Serverless/platform hosting configuration present.");
  if (queue) reasoning.push("Queue or messaging infrastructure is used for asynchronous work.");
  if (k8s) reasoning.push("Kubernetes manifests are present.");
  return { label, confidence, reasoning };
}

/** Run architecture discovery and persist results on the project. */
export async function discoverArchitecture(projectId: string): Promise<Architecture> {
  const db = getDb();
  const files = loadProjectFiles(projectId, { includeExcluded: true });
  const included = files.filter((f) => !f.isExcluded);
  const symbols = db.select().from(schema.symbols).where(eq(schema.symbols.projectId, projectId)).all();
  const rels = db.select().from(schema.relationships).where(eq(schema.relationships.projectId, projectId)).all();
  const filesById = new Map(files.map((f) => [f.id, f]));
  const filesByPath = new Map(files.map((f) => [f.path, f]));
  const symbolsById = new Map(symbols.map((s) => [s.id, s]));
  const symbolsByFile = new Map<string, SymbolRow[]>();
  for (const s of symbols) { const l = symbolsByFile.get(s.filePath) ?? []; l.push(s); symbolsByFile.set(s.filePath, l); }

  const dependencies = detectDependencies(included);
  const externalRels = rels.filter((r) => r.kind === "DEPENDS_ON" && r.targetType === "external" && !filesById.get(r.sourceId)?.isTest && !(symbolsById.get(r.sourceId)?.filePath && filesByPath.get(symbolsById.get(r.sourceId)!.filePath)?.isTest)).map((r) => ({ pkg: r.targetId.replace(/^pkg:/, ""), path: filesById.get(r.sourceId)?.path ?? "", line: r.line ?? undefined }));
  const usage = new Map<string, number>();
  for (const e of externalRels) usage.set(e.pkg, (usage.get(e.pkg) ?? 0) + 1);
  for (const d of dependencies) d.usedBy = usage.get(d.name) ?? [...usage.entries()].filter(([k]) => k.startsWith(d.name + "/")).reduce((a, [, v]) => a + v, 0);
  // Imports of packages not declared in manifests still count as dependencies.
  for (const [pkg, count] of usage) if (!dependencies.some((d) => d.name === pkg) && !/^[A-Z]/.test(pkg)) dependencies.push({ name: pkg, manifest: "(imported, not declared)", dev: false, ecosystem: "import", usedBy: count });

  const { envVars, ports, featureFlags, configFiles } = detectEnvVars(included);
  const externalServices = detectExternalServices(included, dependencies, envVars, externalRels);
  const routes = detectRoutes(included, symbols);
  const models = detectModels(included, symbols);
  const entryPoints = detectEntryPoints(included, symbols, dependencies);
  const infra = detectInfra(included);
  const ai = detectAIComponents(included);

  // Roles and areas
  const routeFiles = new Set(routes.map((r) => r.file));
  const entryFiles = new Set(entryPoints.filter((e) => e.kind !== "test-runner" && e.kind !== "container").map((e) => e.path));
  const roles: Record<string, string> = {};
  const areaMap = new Map<string, FunctionalArea>();
  for (const f of included) {
    const role = assignRole(f, symbolsByFile.get(f.path) ?? [], routeFiles, entryFiles);
    roles[f.path] = role;
    f.role = role;
    const a = areaFor(f, role);
    const id = a.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    let area = areaMap.get(id);
    if (!area) { area = { id, name: a.name, description: a.description, role, files: [], keySymbols: [], dependsOn: [], usedBy: [], externalServices: [], models: [], routes: [], tests: [] }; areaMap.set(id, area); }
    area.files.push(f.path);
    f.area = a.name;
  }
  // Area role = most common file role
  for (const area of areaMap.values()) {
    const counts = new Map<string, number>();
    for (const p of area.files) counts.set(roles[p], (counts.get(roles[p]) ?? 0) + 1);
    area.role = [...counts.entries()].sort((a, b) => b[1] - a[1] || ROLE_ORDER.indexOf(a[0]) - ROLE_ORDER.indexOf(b[0]))[0]?.[0] ?? "unknown";
    const syms = area.files.flatMap((p) => symbolsByFile.get(p) ?? []).filter((s) => s.kind !== "section" && s.kind !== "variable" && s.kind !== "property").sort((a, b) => b.importance - a.importance);
    area.keySymbols = syms.slice(0, 12).map((s) => ({ name: s.qualifiedName, kind: s.kind, path: s.filePath, line: s.startLine, id: s.id }));
    area.models = models.filter((m) => area.files.includes(m.file)).map((m) => m.name);
    area.routes = routes.filter((r) => area.files.includes(r.file)).map((r) => `${r.method} ${r.path}`);
  }
  // Area dependencies via file imports
  const areaOfPath = (p: string) => filesByPath.get(p)?.area;
  const areaDeps = new Map<string, Map<string, number>>();
  for (const r of rels) {
    if (r.kind !== "IMPORTS" && r.kind !== "CALLS" && r.kind !== "USES") continue;
    const sp = r.sourceType === "file" ? filesById.get(r.sourceId)?.path : symbolsById.get(r.sourceId)?.filePath;
    const tp = r.targetType === "file" ? filesById.get(r.targetId)?.path : symbolsById.get(r.targetId)?.filePath;
    if (!sp || !tp) continue;
    const sa = areaOfPath(sp), ta = areaOfPath(tp);
    if (!sa || !ta || sa === ta) continue;
    const m = areaDeps.get(sa) ?? new Map();
    m.set(ta, (m.get(ta) ?? 0) + 1);
    areaDeps.set(sa, m);
  }
  for (const area of areaMap.values()) {
    area.dependsOn = [...(areaDeps.get(area.name)?.entries() ?? [])].sort((a, b) => b[1] - a[1]).map(([n]) => n);
    area.usedBy = [...areaDeps.entries()].filter(([, m]) => m.has(area.name)).sort((a, b) => (b[1].get(area.name) ?? 0) - (a[1].get(area.name) ?? 0)).map(([n]) => n);
    area.externalServices = externalServices.filter((s) => s.evidence.some((e) => area.files.includes(e.path))).map((s) => s.name);
  }
  for (const r of rels.filter((r) => r.kind === "TESTS")) {
    const sp = filesById.get(r.sourceId)?.path;
    const tp = r.targetType === "file" ? filesById.get(r.targetId)?.path : symbolsById.get(r.targetId)?.filePath;
    if (!sp || !tp) continue;
    const ta = areaOfPath(tp);
    const area = ta ? [...areaMap.values()].find((a) => a.name === ta) : undefined;
    if (area && !area.tests.includes(sp)) area.tests.push(sp);
  }

  const stackFrameworks = FRAMEWORK_SIGNATURES.filter((fw) => fw.packages.some((p) => dependencies.some((d) => d.name === p || d.name.toLowerCase() === p.toLowerCase()) || externalRels.some((e) => e.pkg === p))).map((fw) => ({ name: fw.name, category: fw.category, evidence: fw.packages.find((p) => dependencies.some((d) => d.name === p)) ?? fw.packages[0] }));
  if (infra.some((i) => i.kind === "Docker")) stackFrameworks.push({ name: "Docker", category: "infrastructure", evidence: infra.find((i) => i.kind === "Docker")!.path });
  const langCounts = new Map<string, { bytes: number; files: number }>();
  for (const f of included) { if (f.classification !== "source" && f.classification !== "test" && f.classification !== "schema") continue; const c = langCounts.get(f.language) ?? { bytes: 0, files: 0 }; c.bytes += f.size; c.files++; langCounts.set(f.language, c); }
  const stack: Architecture["stack"] = {
    languages: [...langCounts.entries()].map(([name, c]) => ({ name, ...c })).sort((a, b) => b.bytes - a.bytes),
    frameworks: stackFrameworks,
    databases: externalServices.filter((s) => ["database", "vector-db"].includes(s.category)).map((s) => s.name),
    infrastructure: [...new Set(infra.map((i) => i.kind))],
    testing: stackFrameworks.filter((f) => f.category === "testing").map((f) => f.name),
  };

  const partial = { routes, entryPoints, models, infra, stack, externalServices };
  const pattern = detectPattern(included, partial);
  const flows = buildFlows(partial, symbolsById, rels, filesById, filesByPath);
  const tests = detectTests(included, rels, filesById, symbolsById, dependencies);

  const layerDefs: { name: string; roles: string[]; description: string }[] = [
    { name: "Entry Points", roles: ["entry"], description: "Where execution begins." },
    { name: "Presentation / UI", roles: ["ui"], description: "Pages, components and client state." },
    { name: "API / Transport", roles: ["api"], description: "Routes, controllers and request handling." },
    { name: "Domain / Services", roles: ["service", "util"], description: "Business logic and shared helpers." },
    { name: "Background Processing", roles: ["job"], description: "Workers, queues and scheduled jobs." },
    { name: "AI", roles: ["ai"], description: "Prompts, providers and retrieval." },
    { name: "Data", roles: ["data", "schema"], description: "Models, schemas, migrations and queries." },
    { name: "Infrastructure & Config", roles: ["infra", "config"], description: "Deployment, CI and configuration." },
    { name: "Tests & Docs", roles: ["test", "docs"], description: "Automated tests and documentation." },
  ];
  const layers = layerDefs.map((l) => ({ name: l.name, description: l.description, files: included.filter((f) => l.roles.includes(roles[f.path])).length })).filter((l) => l.files > 0);

  const applicationType = pattern.label;
  const secrets: Architecture["secrets"] = [];
  for (const f of included) {
    if (!f.text || f.classification === "lockfile") continue;
    for (const m of detectSecrets(f.text, f.path)) if (secrets.length < 100) secrets.push({ path: f.path, line: m.line, kind: m.kind, preview: m.preview });
  }
  const excludedSummary: Record<string, number> = {};
  for (const f of files) if (f.isExcluded) excludedSummary[f.excludeReason ?? "excluded"] = (excludedSummary[f.excludeReason ?? "excluded"] ?? 0) + 1;

  const stats: Record<string, number> = {
    files: included.length,
    sourceFiles: included.filter((f) => f.classification === "source").length,
    testFiles: tests.files.length,
    lines: included.reduce((a, f) => a + f.lines, 0),
    symbols: symbols.length,
    relationships: rels.length,
    routes: routes.length,
    models: models.length,
    dependencies: dependencies.length,
    externalServices: externalServices.length,
    envVars: envVars.length,
    areas: areaMap.size,
    excluded: files.length - included.length,
    astParsed: included.filter((f) => f.parseStatus === "ast").length,
    textParsed: included.filter((f) => f.parseStatus === "text").length,
  };

  const architecture: Architecture = {
    pattern, applicationType, entryPoints, routes, models, externalServices, dependencies, envVars, ports, featureFlags, configFiles, infra,
    areas: [...areaMap.values()].sort((a, b) => b.files.length - a.files.length), roles, flows, tests, ai, stack, layers, stats, secrets, excludedSummary,
  };

  // Persist: routes -> relationships, files area/role, project.analysis.architecture
  db.transaction((tx) => {
    tx.delete(schema.relationships).where(and(eq(schema.relationships.projectId, projectId), eq(schema.relationships.kind, "ROUTES_TO"))).run();
    const routeRels = routes.filter((r) => r.symbolId).map((r) => ({ id: newId("rel"), projectId, kind: "ROUTES_TO", sourceType: "external", sourceId: `route:${r.method} ${r.path}`, targetType: "symbol", targetId: r.symbolId!, filePath: r.file, line: r.line, confidence: 0.9, meta: { method: r.method, path: r.path, framework: r.framework } }));
    for (let i = 0; i < routeRels.length; i += 200) tx.insert(schema.relationships).values(routeRels.slice(i, i + 200)).run();
    for (const f of included) tx.update(schema.files).set({ area: f.area ?? null, role: f.role ?? null }).where(eq(schema.files.id, f.id)).run();
    const project = tx.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
    tx.update(schema.projects).set({ analysis: { ...(project?.analysis ?? {}), architecture }, updatedAt: Date.now() }).where(eq(schema.projects.id, projectId)).run();
  });
  return architecture;
}
