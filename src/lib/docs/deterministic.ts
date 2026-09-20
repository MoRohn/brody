import type { FindingRow, RelationshipRow, SymbolRow } from "../db/schema";
import type { Architecture } from "../discover/types";
import type { LoadedFile } from "../graph/build";
import { formatBytes } from "../util/text";
import type { AreaDoc, DocReport, DocSection, FileDoc, FlowDoc, ModuleDoc, Statement, SymbolDoc } from "./types";

export interface DocInputs {
  projectName: string;
  sourceUrl?: string | null;
  branch?: string | null;
  commit?: string | null;
  files: LoadedFile[];
  symbols: SymbolRow[];
  rels: RelationshipRow[];
  findings: FindingRow[];
  arch: Architecture;
}

const loc = (path: string, a?: number, b?: number) => (a ? `${path}:${a}${b && b !== a ? `-${b}` : ""}` : path);
const list = (xs: string[], max = 5) => (xs.length <= max ? xs.join(", ") : `${xs.slice(0, max).join(", ")} and ${xs.length - max} more`);
const st = (text: string, evidence: string[] = []): Statement => ({ text, evidence, origin: "deterministic" });

export function readmeSummary(files: LoadedFile[]): { text: string; evidence: string } | undefined {
  const readme = files.find((f) => /^readme(\.md|\.rst|\.txt)?$/i.test(f.path) && f.text) ?? files.find((f) => /readme(\.md)?$/i.test(f.name) && f.text);
  if (!readme?.text) return undefined;
  const lines = readme.text.split("\n");
  const out: string[] = [];
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l || /^(#|!\[|\[!\[|<|---|===|\*\*\*|```)/.test(l) || /^\[.*\]:\s/.test(l) || /^>?\s*(note|warning)/i.test(l)) { if (out.length) break; continue; }
    if (start < 0) start = i + 1;
    out.push(l.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, ""));
    if (out.join(" ").length > 400) break;
  }
  const text = out.join(" ").trim();
  if (text.length < 20) return undefined;
  return { text: text.slice(0, 500), evidence: loc(readme.path, start, start + out.length - 1) };
}

function packageDescription(files: LoadedFile[]): { text: string; evidence: string } | undefined {
  const pkg = files.find((f) => f.path === "package.json" && f.text);
  if (!pkg?.text) return undefined;
  try { const j = JSON.parse(pkg.text); if (typeof j.description === "string" && j.description.length > 10) return { text: j.description, evidence: pkg.path }; } catch { /* ignore */ }
  return undefined;
}

export function buildSymbolDocs(inp: DocInputs, limit = 300): SymbolDoc[] {
  const { symbols, rels, files } = inp;
  const symbolsById = new Map(symbols.map((s) => [s.id, s]));
  const filesById = new Map(files.map((f) => [f.id, f]));
  const callersOf = new Map<string, Set<string>>();
  const calleesOf = new Map<string, Set<string>>();
  for (const r of rels) {
    if (!["CALLS", "INSTANTIATES", "USES", "ROUTES_TO", "READS_FROM", "WRITES_TO", "EXTENDS", "IMPLEMENTS"].includes(r.kind)) continue;
    if (r.targetType === "symbol") {
      const src = r.sourceType === "symbol" ? symbolsById.get(r.sourceId)?.qualifiedName : r.sourceType === "file" ? filesById.get(r.sourceId)?.path : undefined;
      if (src) { const s = callersOf.get(r.targetId) ?? new Set(); s.add(src); callersOf.set(r.targetId, s); }
    }
    if (r.sourceType === "symbol" && r.targetType === "symbol") {
      const t = symbolsById.get(r.targetId);
      if (t) { const s = calleesOf.get(r.sourceId) ?? new Set(); s.add(`${r.kind === "READS_FROM" ? "reads " : r.kind === "WRITES_TO" ? "writes " : ""}${t.qualifiedName}`); calleesOf.set(r.sourceId, s); }
    }
  }
  const eligible = symbols.filter((s) => ["function", "method", "class", "service", "endpoint", "component", "hook", "model", "job", "event_handler", "struct", "trait", "interface", "table"].includes(s.kind) && !filesById.get(s.fileId)?.isTest);
  eligible.sort((a, b) => b.importance - a.importance || b.inboundCount - a.inboundCount);
  return eligible.slice(0, limit).map((s) => {
    const params = (s.signature ?? "").match(/\(([^)]*)\)/)?.[1]?.trim();
    const ret = (s.signature ?? "").match(/\)\s*(?::|->|=>)\s*([^{=]+)/)?.[1]?.trim();
    const doc = s.documentation?.split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").trim();
    const callers = [...(callersOf.get(s.id) ?? [])];
    const callees = [...(calleesOf.get(s.id) ?? [])];
    const meta = (s.meta ?? {}) as { fields?: string[]; complexity?: number };
    const purpose = doc ? doc.slice(0, 300) : s.kind === "model" || s.kind === "table" ? `Data model ${s.name}${meta.fields?.length ? ` with fields ${list(meta.fields, 6)}` : ""}.` : `${s.kind[0].toUpperCase()}${s.kind.slice(1)} ${s.qualifiedName} (no doc comment; role inferred from name and relationships).`;
    return {
      symbolId: s.id, name: s.qualifiedName, signature: s.signature ?? s.name, kind: s.kind, path: s.filePath, startLine: s.startLine, endLine: s.endLine, purpose,
      inputs: params ? params.slice(0, 200) : "none declared", process: meta.complexity ? `Contains ${meta.complexity} independent execution paths.${callees.length ? ` Delegates to ${list(callees.slice(0, 6))}.` : ""}` : callees.length ? `Delegates to ${list(callees.slice(0, 6))}.` : "Leaf logic with no calls to other indexed symbols.",
      outputs: ret ? ret.slice(0, 160) : "not declared", dependencies: callees.slice(0, 10), usedBy: callers.slice(0, 10),
      businessMeaning: "", importantBehavior: s.exported ? "Part of the module's public surface." : "Internal to its module.", evidence: [loc(s.filePath, s.startLine, s.endLine)], origin: "deterministic" as const,
    };
  });
}

export function buildFileDocs(inp: DocInputs, limit = 200): FileDoc[] {
  const { files, symbols, rels, arch } = inp;
  const filesById = new Map(files.map((f) => [f.id, f]));
  const symbolsById = new Map(symbols.map((s) => [s.id, s]));
  const importedBy = new Map<string, Set<string>>();
  const imports = new Map<string, Set<string>>();
  const externals = new Map<string, Set<string>>();
  const emits = new Map<string, Set<string>>();
  const reads = new Map<string, Set<string>>();
  const writes = new Map<string, Set<string>>();
  for (const r of rels) {
    const srcFile = r.sourceType === "file" ? filesById.get(r.sourceId)?.path : r.sourceType === "symbol" ? symbolsById.get(r.sourceId)?.filePath : undefined;
    const add = (m: Map<string, Set<string>>, k: string | undefined, v: string | undefined) => { if (k && v) { const s = m.get(k) ?? new Set(); s.add(v); m.set(k, s); } };
    if (r.kind === "IMPORTS" && r.targetType === "file") { const t = filesById.get(r.targetId)?.path; add(imports, srcFile, t); add(importedBy, t, srcFile); }
    if (r.kind === "DEPENDS_ON") add(externals, srcFile, r.targetId.replace(/^pkg:/, ""));
    if (r.kind === "EMITS") add(emits, srcFile, r.targetId.replace(/^event:/, ""));
    if (r.kind === "READS_FROM") add(reads, srcFile, symbolsById.get(r.targetId)?.name);
    if (r.kind === "WRITES_TO") add(writes, srcFile, symbolsById.get(r.targetId)?.name);
  }
  const symsByFile = new Map<string, SymbolRow[]>();
  for (const s of symbols) { const l = symsByFile.get(s.filePath) ?? []; l.push(s); symsByFile.set(s.filePath, l); }
  const candidates = files.filter((f) => !f.isExcluded && ["source", "schema", "config", "infra", "ci", "manifest"].includes(f.classification) && f.text).sort((a, b) => b.importance - a.importance).slice(0, limit);
  return candidates.map((f) => {
    const syms = (symsByFile.get(f.path) ?? []).filter((s) => s.kind !== "section").sort((a, b) => b.importance - a.importance);
    const routes = arch.routes.filter((r) => r.file === f.path);
    const models = arch.models.filter((m) => m.file === f.path);
    const kinds = new Map<string, number>();
    for (const s of syms) kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + 1);
    const kindText = [...kinds.entries()].map(([k, n]) => `${n} ${k}${n > 1 ? "s" : ""}`).join(", ");
    const purposeParts: string[] = [];
    purposeParts.push(`${f.path} is ${f.role === "api" ? "an API layer" : f.role === "ui" ? "a user-interface" : f.role === "data" ? "a data-layer" : f.role === "service" ? "a service-layer" : f.role === "entry" ? "an entry-point" : f.role === "job" ? "a background-processing" : f.role === "infra" ? "an infrastructure" : f.role === "test" ? "a test" : f.role === "config" ? "a configuration" : "a"} ${f.language} file in the ${f.area ?? "application"} area.`);
    if (routes.length) purposeParts.push(`It handles ${list(routes.map((r) => `${r.method} ${r.path}`), 4)}.`);
    if (models.length) purposeParts.push(`It defines the data model${models.length > 1 ? "s" : ""} ${list(models.map((m) => m.name), 4)}.`);
    if (kindText) purposeParts.push(`It declares ${kindText}.`);
    const nonDocDoc = syms.find((s) => s.documentation)?.documentation?.replace(/\s+/g, " ").slice(0, 200);
    const ext = [...(externals.get(f.path) ?? [])];
    const calledBy = [...(importedBy.get(f.path) ?? [])];
    const notes: string[] = [];
    if (f.lines > 600) notes.push(`Large file (${f.lines} lines).`);
    const maxC = Math.max(0, ...syms.map((s) => Number((s.meta as { complexity?: number } | null)?.complexity ?? 0)));
    if (maxC >= 15) notes.push(`Contains a function with cyclomatic complexity ${maxC}.`);
    if (!calledBy.length && f.role !== "entry" && f.role !== "test" && f.classification === "source") notes.push("No other indexed file imports this one; it may be an entry point, dynamically loaded, or dead code.");
    if (f.parseStatus !== "ast") notes.push(`Parsed with ${f.parseStatus === "text" ? "text-based heuristics" : "no structural parser"}, so symbol data is approximate.`);
    return {
      path: f.path, role: f.role ?? f.classification, area: f.area ?? "n/a", purpose: (purposeParts.join(" ") + (nonDocDoc ? ` Its documentation says: "${nonDocDoc}"` : "")).trim(),
      responsibilities: [...routes.slice(0, 5).map((r) => `Serve ${r.method} ${r.path}`), ...models.slice(0, 5).map((m) => `Define model ${m.name}`), ...syms.filter((s) => ["service", "job", "event_handler", "component"].includes(s.kind)).slice(0, 5).map((s) => `${s.kind} ${s.name}`)].slice(0, 8),
      keySymbols: syms.slice(0, 8).map((s) => `${s.qualifiedName}()`.replace("()", s.kind === "class" || s.kind === "model" || s.kind === "service" ? "" : "()")),
      howItOperates: routes.length ? `Requests matching its routes are dispatched to ${list(routes.map((r) => r.handler), 4)}.` : syms.length ? `Exposes ${syms.filter((s) => s.exported).length} exported symbol(s) that other modules call; internal helpers are ${syms.filter((s) => !s.exported).length}.` : "No executable symbols were extracted.",
      calledBy: calledBy.slice(0, 12), dependsOn: [...(imports.get(f.path) ?? []), ...ext].slice(0, 16),
      dataIn: routes.length ? "HTTP request parameters, headers and bodies" : reads.get(f.path)?.size ? `Records read from ${list([...reads.get(f.path)!])}` : calledBy.length ? `Arguments from ${list(calledBy, 3)}` : "n/a",
      dataOut: writes.get(f.path)?.size ? `Persists to ${list([...writes.get(f.path)!])}` : emits.get(f.path)?.size ? `Events ${list([...emits.get(f.path)!])}` : routes.length ? "HTTP responses" : "Return values to callers",
      engineeringNotes: notes, evidence: [loc(f.path, 1, Math.min(f.lines, 1))], origin: "deterministic" as const,
    };
  });
}

export function buildAreaDocs(inp: DocInputs): AreaDoc[] {
  const { arch, findings } = inp;
  return arch.areas.filter((a) => a.role !== "docs").map((a) => {
    const svc = arch.externalServices.filter((s) => a.externalServices.includes(s.name));
    const areaFindings = findings.filter((f) => f.area === a.name && f.verification !== "rejected");
    return {
      id: a.id, name: a.name, purpose: a.description, businessFunction: a.routes.length ? `Serves ${list(a.routes, 4)} to callers.` : a.models.length ? `Persists and retrieves ${list(a.models, 5)}.` : `Supports the ${arch.pattern.label} through ${a.files.length} file(s).`,
      components: a.keySymbols.slice(0, 10).map((s) => ({ name: s.name, kind: s.kind, path: s.path, line: s.line })), files: a.files,
      inputs: a.routes.length ? `Requests to ${list(a.routes, 4)}` : a.usedBy.length ? `Calls from ${list(a.usedBy, 4)}` : "Startup and configuration",
      processing: `${a.files.length} file(s), key components: ${list(a.keySymbols.slice(0, 5).map((s) => s.name), 5) || "none extracted"}.`,
      outputs: a.models.length ? `Records for ${list(a.models, 4)}` : a.dependsOn.length ? `Results consumed via ${list(a.dependsOn, 3)}` : "Return values to callers",
      dependencies: [...a.dependsOn, ...svc.map((s) => s.name)],
      failureModes: [...svc.slice(0, 4).map((s) => `${s.name} unavailable: ${s.failureImpact}`), ...areaFindings.filter((f) => ["Critical", "High"].includes(f.severity)).slice(0, 3).map((f) => `${f.code}: ${f.title}`)],
      relationships: a.usedBy.length ? `Used by ${list(a.usedBy, 5)}.` : "No other area depends on it directly.", evidence: a.keySymbols.slice(0, 3).map((s) => loc(s.path, s.line)), origin: "deterministic" as const,
    };
  });
}

export function buildFlowDocs(inp: DocInputs): FlowDoc[] {
  return inp.arch.flows.map((f) => {
    const data = f.steps.slice(1).filter((s) => /^(reads|writes) /.test(s.label));
    const calls = f.steps.slice(1).filter((s) => !/^(reads|writes|emits) /.test(s.label) && s.kind !== "file");
    const reads = data.filter((s) => s.label.startsWith("reads ")).map((s) => s.label.slice(6));
    const writes = data.filter((s) => s.label.startsWith("writes ")).map((s) => s.label.slice(7));
    const parts = [`${f.trigger} is handled by ${f.steps[0]?.label}`];
    if (calls.length) parts.push(`which calls ${list(calls.slice(0, 5).map((s) => s.label), 5)}`);
    const tail: string[] = [];
    if (reads.length) tail.push(`reads ${list([...new Set(reads)])}`);
    if (writes.length) tail.push(`writes ${list([...new Set(writes)])}`);
    if (f.externals.length) tail.push(`uses ${list(f.externals)}`);
    return {
      id: f.id, name: f.name, trigger: f.trigger,
      steps: f.steps.map((s) => ({ label: s.label, kind: s.kind, path: s.path, line: s.line, detail: s.detail })),
      narrative: `${parts.join(", ")}${tail.length ? `; along the way it ${tail.join(" and ")}` : ""}.`,
      models: f.models, externals: f.externals, evidence: f.evidence.map((e) => loc(e.path, e.line)), origin: "deterministic" as const,
    };
  });
}

function section(title: string, paras: Statement[], bullets?: Statement[]): DocSection {
  return { title, paragraphs: paras, bullets };
}

export function buildReport(inp: DocInputs, parts: { symbols: SymbolDoc[]; files: FileDoc[]; areas: AreaDoc[]; flows: FlowDoc[]; modules?: ModuleDoc[] }): DocReport {
  const { arch, findings, files, projectName } = inp;
  const live = findings.filter((f) => f.verification !== "rejected");
  const bySev = (s: string) => live.filter((f) => f.severity === s).length;
  const readme = readmeSummary(files);
  const pkg = packageDescription(files);
  const primaryLangs = arch.stack.languages.slice(0, 3).map((l) => l.name);
  const frameworks = arch.stack.frameworks.filter((f) => ["frontend-framework", "backend-framework", "api-framework", "ui-library", "realtime"].includes(f.category)).map((f) => f.name);
  const ormNames = arch.stack.frameworks.filter((f) => ["orm", "query-builder"].includes(f.category)).map((f) => f.name);
  const caches = arch.externalServices.filter((s) => s.category === "cache").map((s) => s.name);
  const shownAreas = arch.areas.filter((a) => !["Documentation", "Testing", "Configuration"].includes(a.name));

  const exec: Statement[] = [];
  const purposeText = pkg?.text ?? readme?.text;
  exec.push(st(purposeText ? `${projectName}: ${purposeText}${/[.!?]$/.test(purposeText) ? "" : "."} (Stated in the project's own documentation.)` : `${projectName} is a ${arch.applicationType} written mainly in ${list(primaryLangs) || "an unrecognised language"}; no README or package description states its purpose, so the purpose below is inferred from code structure.`, [pkg?.evidence ?? readme?.evidence ?? ""].filter(Boolean)));
  exec.push(st(`The repository contains ${arch.stats.sourceFiles} source files (${arch.stats.lines.toLocaleString()} lines across ${arch.stats.files} files) organised into ${shownAreas.length} functional area${shownAreas.length === 1 ? "" : "s"}: ${list(shownAreas.slice(0, 6).map((a) => a.name), 6)}.`));
  if (arch.entryPoints.length) exec.push(st(`Execution begins at ${list(arch.entryPoints.filter((e) => e.kind !== "test-runner").slice(0, 3).map((e) => `${e.path} (${e.reason})`), 3)}.`, arch.entryPoints.slice(0, 3).map((e) => loc(e.path, e.line))));
  if (arch.routes.length) exec.push(st(`Data enters through ${arch.routes.filter((r) => r.kind === "api").length} API route(s) and ${arch.routes.filter((r) => r.kind === "page").length} page(s)${frameworks.length ? ` built with ${list(frameworks, 4)}` : ""}.${arch.models.length ? ` Data is persisted in ${list(arch.stack.databases.length ? arch.stack.databases : ["a data layer"], 3)}${ormNames.length ? ` through ${list(ormNames, 2)}` : ""}, modelled by ${arch.models.length} entit${arch.models.length === 1 ? "y" : "ies"} such as ${list(arch.models.slice(0, 4).map((m) => m.name), 4)}.` : ""}`, arch.routes.slice(0, 2).map((r) => loc(r.file, r.line))));
  else if (arch.models.length) exec.push(st(`Data is persisted through ${arch.models.length} model(s) such as ${list(arch.models.slice(0, 4).map((m) => m.name), 4)}.`, arch.models.slice(0, 2).map((m) => loc(m.file, m.line, m.endLine))));
  if (arch.externalServices.length) exec.push(st(`It integrates with ${list(arch.externalServices.slice(0, 6).map((s) => s.name), 6)}.`, arch.externalServices.slice(0, 3).flatMap((s) => s.evidence.slice(0, 1).map((e) => loc(e.path, e.line)))));
  exec.push(st(`Engineering review found ${live.length} finding(s): ${bySev("Critical")} critical, ${bySev("High")} high, ${bySev("Medium")} medium, ${bySev("Low") + bySev("Informational")} lower-priority. ${live.filter((f) => f.origin === "static").length} came from deterministic analyzers and ${live.filter((f) => f.origin === "ai").length} from AI review. ${arch.tests.files.length ? `${arch.tests.files.length} test file(s) exist.` : "No automated tests were found."}`));

  const stackRow = (cats: string[]) => arch.stack.frameworks.filter((f) => cats.includes(f.category)).map((f) => f.name);
  const auth = arch.externalServices.filter((s) => s.category === "auth").map((s) => s.name);
  const glance = [
    { area: "Primary Purpose", description: purposeText ? purposeText.slice(0, 220) : "Not stated in the repository; inferred from structure.", evidence: [pkg?.evidence ?? readme?.evidence ?? ""].filter(Boolean) },
    { area: "Application Type", description: `${arch.applicationType} (${arch.pattern.confidence} confidence)` },
    { area: "Primary Languages", description: list(arch.stack.languages.slice(0, 5).map((l) => `${l.name} (${l.files} files)`), 5) || "n/a" },
    { area: "Frontend", description: list(stackRow(["frontend-framework", "ui-library", "ui-components", "state-management", "styling"]), 6) || "none detected" },
    { area: "Backend", description: list(stackRow(["backend-framework", "api-framework", "realtime"]), 6) || (arch.routes.length ? "custom HTTP handlers" : "none detected") },
    { area: "Data Layer", description: [arch.stack.databases.length ? `Database: ${list(arch.stack.databases, 5)}` : "", ormNames.length ? `Access: ${list(ormNames, 4)}` : "", caches.length ? `Cache/queue: ${list(caches, 3)}` : "", arch.models.length ? `${arch.models.length} modelled entities` : ""].filter(Boolean).join("; ") || "none detected" },
    { area: "Authentication", description: auth.length ? list(auth) : arch.routes.some((r) => r.auth === "authenticated") ? `custom: ${arch.routes.filter((r) => r.auth === "authenticated").length} of ${arch.routes.filter((r) => r.kind === "api").length} API routes carry an authentication middleware` : "no authentication mechanism detected" },
    { area: "External Services", description: list(arch.externalServices.map((s) => s.name), 8) || "none detected" },
    { area: "Infrastructure", description: list(arch.stack.infrastructure, 6) || "none detected" },
    { area: "Testing", description: arch.tests.files.length ? `${arch.tests.files.length} test files; ${list(arch.tests.frameworks, 4) || "framework not identified"}` : "no automated tests found" },
  ];

  const layerText = arch.layers.map((l) => `${l.name} (${l.files})`).join(", ");
  const architecture = section("Architecture Overview", [
    st(`The codebase is best described as a ${arch.pattern.label} (${arch.pattern.confidence} confidence). ${arch.pattern.reasoning.join(" ")}`),
    st(`Files divide into these layers: ${layerText}.`),
    ...(arch.areas.length ? [st(`The largest functional areas are ${list(arch.areas.slice(0, 5).map((a) => `${a.name} (${a.files.length} files)`), 5)}.`)] : []),
  ]);

  const flowScore = (f: FlowDoc) => (f.name.startsWith("Startup") ? -5 : 0) + f.steps.length + 3 * f.models.length + 2 * f.externals.length + (/^(POST|PUT|PATCH)/.test(f.name) ? 2 : 0);
  const primaryFlow = [...parts.flows].sort((a, b) => flowScore(b) - flowScore(a))[0];
  const runtime = {
    narrative: primaryFlow ? [st(primaryFlow.narrative, primaryFlow.evidence)] : [st("No complete runtime flow could be traced from entry points through the dependency graph; see the entry point list.")],
    steps: primaryFlow ? primaryFlow.steps.map((s) => ({ label: s.label, detail: `${s.kind}${s.path ? ` at ${loc(s.path, s.line)}` : ""}`, evidence: s.path ? [loc(s.path, s.line)] : [] })) : arch.entryPoints.slice(0, 5).map((e) => ({ label: e.path, detail: `${e.kind}: ${e.reason}`, evidence: [loc(e.path, e.line)] })),
  };

  const api = section("API Architecture", arch.routes.length ? [
    st(`${arch.routes.length} route(s) were detected across ${list([...new Set(arch.routes.map((r) => r.framework))], 4)}: ${arch.routes.filter((r) => r.kind === "api").length} API and ${arch.routes.filter((r) => r.kind === "page").length} page routes.`, arch.routes.slice(0, 3).map((r) => loc(r.file, r.line))),
    st(`${arch.routes.filter((r) => r.auth === "authenticated").length} route(s) show an authentication or authorization check near their definition; ${arch.routes.filter((r) => r.auth === "unknown" && r.kind === "api").length} API route(s) show none, which means either the check lives in shared middleware or the route is open.`),
  ] : [st("No HTTP routes were detected.")]);

  const data = section("Data Architecture", arch.models.length ? [
    st(`${arch.models.length} data model(s) were found using ${list([...new Set(arch.models.map((m) => m.orm).filter((x): x is string => !!x))], 4) || "unidentified persistence"}.`, arch.models.slice(0, 3).map((m) => loc(m.file, m.line, m.endLine))),
    ...arch.models.filter((m) => m.references.length).slice(0, 8).map((m) => st(`${m.name} references ${list(m.references, 5)}.`, [loc(m.file, m.line, m.endLine)])),
  ] : [st("No data models or schemas were detected.")]);

  const infra = section("Infrastructure & Deployment", arch.infra.length ? [
    st(`Deployment and operations assets: ${list([...new Set(arch.infra.map((i) => i.kind))], 8)}.`, arch.infra.slice(0, 3).map((i) => i.path)),
    ...(arch.ports.length ? [st(`Network ports referenced: ${list([...new Set(arch.ports.map((p) => p.value))], 8)}.`, arch.ports.slice(0, 2).map((p) => loc(p.path, p.line)))] : []),
    st(`${arch.envVars.length} environment variable(s) configure the application${arch.envVars.some((e) => e.sensitive) ? `, ${arch.envVars.filter((e) => e.sensitive).length} of which look sensitive (names only: ${list(arch.envVars.filter((e) => e.sensitive).map((e) => e.name), 6)})` : ""}.`),
  ] : [st("No infrastructure-as-code, container or CI configuration was found.")]);

  const testing = section("Testing Strategy", arch.tests.files.length ? [
    st(`${arch.tests.files.length} test file(s): ${list(Object.entries(arch.tests.files.reduce<Record<string, number>>((m, t) => { m[t.kind] = (m[t.kind] ?? 0) + 1; return m; }, {})).map(([k, n]) => `${n} ${k}`), 5)}; frameworks: ${list(arch.tests.frameworks, 4) || "not identified"}.`, arch.tests.files.slice(0, 2).map((t) => t.path)),
    ...(arch.tests.untestedCritical.length ? [st(`Important files with no test referencing them include ${list(arch.tests.untestedCritical.slice(0, 5).map((u) => u.path), 5)}.`, arch.tests.untestedCritical.slice(0, 3).map((u) => u.path))] : []),
  ] : [st("The repository has no automated tests, so no behaviour is protected against regression by the build.")]);

  const secFindings = live.filter((f) => f.category === "Security");
  const security = section("Security Model", [
    st(`Authentication: ${auth.length ? `delegated to ${list(auth)}` : arch.routes.some((r) => r.auth === "authenticated") ? "implemented in application code" : "no mechanism detected"}. ${arch.routes.filter((r) => r.kind === "api" && r.auth !== "authenticated").length} of ${arch.routes.filter((r) => r.kind === "api").length} API route(s) have no visible access check.`),
    st(`Secrets: ${arch.secrets.length ? `${arch.secrets.length} likely secret value(s) were found in source (redacted in this report)` : "no likely committed secrets were found by pattern matching"}.`, arch.secrets.slice(0, 2).map((s) => loc(s.path, s.line))),
    st(`${secFindings.length} security finding(s) were recorded: ${secFindings.filter((f) => ["Critical", "High"].includes(f.severity)).length} critical/high.`),
  ], secFindings.filter((f) => ["Critical", "High"].includes(f.severity)).slice(0, 8).map((f) => st(`${f.code} ${f.title}`, f.filePath ? [loc(f.filePath, f.startLine ?? undefined, f.endLine ?? undefined)] : [])));

  const top = live.filter((f) => ["Critical", "High"].includes(f.severity)).slice(0, 10);
  const risks = section("Engineering Risks", top.length ? [st(`The highest-priority findings, ordered by severity, are listed below. Each cites the evidence location and states whether it came from a static analyzer or AI review.`)] : [st("No critical or high-severity findings were recorded.")], top.map((f) => st(`${f.code} [${f.severity}, ${f.origin === "static" ? "static analyzer" : "AI-inferred"}${f.verification === "verified" ? "" : ", needs verification"}] ${f.title}`, f.filePath ? [loc(f.filePath, f.startLine ?? undefined, f.endLine ?? undefined)] : [])));

  const recs: Statement[] = [];
  for (const f of live.filter((f) => ["Critical", "High"].includes(f.severity)).slice(0, 6)) recs.push(st(`${f.code}: ${f.remediation}`, f.filePath ? [loc(f.filePath, f.startLine ?? undefined)] : []));
  if (!arch.tests.files.length) recs.push(st("Add automated tests, starting with the highest-importance modules and the primary request flow."));
  else for (const u of arch.tests.untestedCritical.slice(0, 2)) recs.push(st(`Add tests for ${u.path}, which many files depend on.`, [u.path]));
  if (!arch.infra.some((i) => /Actions|GitLab|Circle|Jenkins/.test(i.kind))) recs.push(st("Add a CI pipeline that runs tests, type checks and the production build on every change."));

  const integrations = arch.externalServices.map((s) => ({ name: s.name, category: s.category, where: s.evidence.slice(0, 4).map((e) => loc(e.path, e.line)), why: s.purpose, ifUnavailable: s.failureImpact }));

  return {
    title: `Repository Intelligence Report: ${projectName}`, generatedAt: Date.now(), executiveSummary: exec, atAGlance: glance, architectureOverview: architecture, runtimeFlow: runtime,
    areas: parts.areas, modules: parts.modules ?? [], flows: parts.flows, apiArchitecture: api, dataArchitecture: data, integrations, infrastructure: infra, testing, securityModel: security, risks, recommendations: recs,
    files: parts.files, symbols: parts.symbols, conflicts: [],
    meta: { aiUsed: false, deterministicSections: 12, aiSections: 0, droppedUngrounded: 0, notes: [`Repository size: ${formatBytes(files.filter((f) => !f.isExcluded).reduce((a, f) => a + f.size, 0))}.`] },
  };
}
