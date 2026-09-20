import type { LoadedFile } from "../graph/build";
import { maxOf } from "../util/arrays";
import type { DocInputs } from "./deterministic";
import type { CollectionFile, FileDoc, ModuleDoc } from "./types";

/**
 * Collection-level ("macro") explanations. A collection is a folder, or any set of files a reader picks. Everything
 * here is derived from the dependency graph, so it works without an AI provider and never states more than the graph
 * shows. The AI pass in ai.ts then rewrites the narrative fields from the file summaries.
 */

const MEMBER_CLASSES = new Set(["source", "schema", "config", "infra", "ci", "manifest"]);
const SEVERITY_ORDER = ["Critical", "High", "Medium", "Low", "Informational"];

const list = (xs: string[], max = 4) => (xs.length <= max ? xs.join(", ") : `${xs.slice(0, max).join(", ")} and ${xs.length - max} more`);
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const ROLE_LABEL: Record<string, string> = { api: "API-layer", ui: "user-interface", data: "data-layer", service: "service-layer", entry: "entry-point", util: "utility", config: "configuration", test: "test", job: "background-job", infra: "infrastructure", schema: "schema" };

export interface CollectionIndex {
  filesByPath: Map<string, LoadedFile>;
  importsOut: Map<string, Set<string>>;
  importsIn: Map<string, Set<string>>;
  packages: Map<string, Set<string>>;
  /** Files (by path) that reference each symbol from another file. */
  symbolReaders: Map<string, Set<string>>;
  symbolsByFile: Map<string, DocInputs["symbols"]>;
  reads: Map<string, Set<string>>;
  writes: Map<string, Set<string>>;
  emits: Map<string, Set<string>>;
}

export function buildCollectionIndex(inp: DocInputs): CollectionIndex {
  const filesById = new Map(inp.files.map((f) => [f.id, f]));
  const symbolsById = new Map(inp.symbols.map((s) => [s.id, s]));
  const idx: CollectionIndex = { filesByPath: new Map(inp.files.map((f) => [f.path, f])), importsOut: new Map(), importsIn: new Map(), packages: new Map(), symbolReaders: new Map(), symbolsByFile: new Map(), reads: new Map(), writes: new Map(), emits: new Map() };
  const add = (m: Map<string, Set<string>>, k: string | undefined, v: string | undefined) => { if (k && v) { let s = m.get(k); if (!s) m.set(k, (s = new Set())); s.add(v); } };
  for (const s of inp.symbols) { const l = idx.symbolsByFile.get(s.filePath); if (l) l.push(s); else idx.symbolsByFile.set(s.filePath, [s]); }
  for (const r of inp.rels) {
    const srcPath = r.sourceType === "file" ? filesById.get(r.sourceId)?.path : r.sourceType === "symbol" ? symbolsById.get(r.sourceId)?.filePath : undefined;
    if (r.kind === "IMPORTS" && r.targetType === "file") { const t = filesById.get(r.targetId)?.path; if (srcPath && t && srcPath !== t) { add(idx.importsOut, srcPath, t); add(idx.importsIn, t, srcPath); } }
    else if (r.kind === "DEPENDS_ON") add(idx.packages, srcPath, r.targetId.replace(/^pkg:/, ""));
    else if (r.kind === "EMITS") add(idx.emits, srcPath, r.targetId.replace(/^event:/, ""));
    else if (r.kind === "READS_FROM") add(idx.reads, srcPath, symbolsById.get(r.targetId)?.name);
    else if (r.kind === "WRITES_TO") add(idx.writes, srcPath, symbolsById.get(r.targetId)?.name);
    if (r.targetType === "symbol" && srcPath && ["CALLS", "INSTANTIATES", "USES", "EXTENDS", "IMPLEMENTS", "ROUTES_TO"].includes(r.kind)) {
      const target = symbolsById.get(r.targetId);
      if (target && target.filePath !== srcPath) add(idx.symbolReaders, target.id, srcPath);
    }
  }
  return idx;
}

interface Selection { kind: "folder" | "selection"; path: string; title?: string; files: LoadedFile[] }

/** Explain one collection of files as a unit. */
export function explainSet(inp: DocInputs, idx: CollectionIndex, fileDocs: Map<string, FileDoc>, sel: Selection): ModuleDoc {
  const members = sel.files;
  const set = new Set(members.map((f) => f.path));
  const name = sel.kind === "folder" ? baseOf(sel.path) || sel.path : "Selected files";
  const title = sel.title ?? (sel.kind === "folder" ? `${sel.path}/` : `${plural(members.length, "selected file")}`);

  const files: CollectionFile[] = members
    .slice()
    .sort((a, b) => b.importance - a.importance || a.path.localeCompare(b.path))
    .map((f) => ({ path: f.path, role: f.role ?? f.classification, lines: f.lines, purpose: fileDocs.get(f.path)?.purpose ?? fallbackPurpose(f, idx) }));

  const roleCounts = new Map<string, number>();
  for (const f of members) { const r = f.role ?? f.classification; roleCounts.set(r, (roleCounts.get(r) ?? 0) + 1); }
  const roles = [...roleCounts.entries()].map(([role, count]) => ({ role, count })).sort((a, b) => b.count - a.count);

  // Structure between the files: who is shared, who orchestrates.
  const internalLinks: { from: string; to: string }[] = [];
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  const outsideDeps = new Set<string>();
  const outsideUsers = new Set<string>();
  for (const p of set) {
    for (const t of idx.importsOut.get(p) ?? []) {
      if (set.has(t)) { internalLinks.push({ from: p, to: t }); inDeg.set(t, (inDeg.get(t) ?? 0) + 1); outDeg.set(p, (outDeg.get(p) ?? 0) + 1); }
      else if (idx.filesByPath.get(t)?.classification !== "test") outsideDeps.add(dirOf(t) || "(root)");
    }
    for (const u of idx.importsIn.get(p) ?? []) if (!set.has(u) && idx.filesByPath.get(u)?.classification !== "test") outsideUsers.add(dirOf(u) || "(root)");
  }
  const hub = [...inDeg.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const orchestrator = [...outDeg.entries()].filter(([p]) => p !== hub?.[0]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];

  // The collection's real interface: exported symbols that other code actually uses.
  const publicSurface: ModuleDoc["publicSurface"] = [];
  for (const p of set) for (const s of idx.symbolsByFile.get(p) ?? []) {
    if (!s.exported || s.kind === "section") continue;
    const readers = [...(idx.symbolReaders.get(s.id) ?? [])].filter((r) => !set.has(r) && idx.filesByPath.get(r)?.classification !== "test");
    if (readers.length) publicSurface.push({ name: s.qualifiedName, kind: s.kind, path: s.filePath, line: s.startLine, usedBy: readers.length });
  }
  publicSurface.sort((a, b) => b.usedBy - a.usedBy || a.name.localeCompare(b.name));

  const packages = new Set<string>();
  const reads = new Set<string>();
  const writes = new Set<string>();
  const emits = new Set<string>();
  for (const p of set) {
    for (const x of idx.packages.get(p) ?? []) packages.add(x);
    for (const x of idx.reads.get(p) ?? []) reads.add(x);
    for (const x of idx.writes.get(p) ?? []) writes.add(x);
    for (const x of idx.emits.get(p) ?? []) emits.add(x);
  }
  const routes = inp.arch.routes.filter((r) => set.has(r.file));
  const models = inp.arch.models.filter((m) => set.has(m.file));
  const areas = [...new Set(members.map((f) => f.area).filter((a): a is string => !!a))];

  const live = inp.findings.filter((f) => f.filePath && set.has(f.filePath) && f.verification !== "rejected");
  const bySeverity: Record<string, number> = {};
  for (const f of live) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
  const top = live.slice().sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)).slice(0, 3).map((f) => `${f.code}: ${f.title}`);

  const tests = new Set<string>();
  for (const p of set) for (const u of idx.importsIn.get(p) ?? []) if (idx.filesByPath.get(u)?.classification === "test") tests.add(u);

  const totalLines = members.reduce((n, f) => n + f.lines, 0);
  const roleText = list(roles.slice(0, 3).map((r) => `${r.count} ${ROLE_LABEL[r.role] ?? r.role}`), 3);
  const purposeParts = [`${title} groups ${plural(members.length, "file")} (${totalLines.toLocaleString()} lines): ${roleText}.`];
  if (areas.length) purposeParts.push(`It ${areas.length === 1 ? "sits inside" : "spans"} the ${list(areas, 3)} functional area${areas.length === 1 ? "" : "s"}.`);
  if (routes.length) purposeParts.push(`It serves ${list(routes.map((r) => `${r.method} ${r.path}`), 4)}.`);
  if (models.length) purposeParts.push(`It defines the data model${models.length > 1 ? "s" : ""} ${list(models.map((m) => m.name), 4)}.`);

  const how: string[] = [];
  if (members.length === 1) how.push("This selection contains a single file, so there is no interaction between files to describe.");
  else if (internalLinks.length === 0) how.push(`The ${members.length} files do not import one another. They are independent units that share a location rather than a call structure.`);
  else {
    how.push(`${internalLinks.length === 1 ? "1 import connects" : `${internalLinks.length} imports connect`} the files inside.`);
    if (hub && hub[1] >= 2) how.push(`${baseOf(hub[0])} is the shared piece: ${hub[1]} of the other ${members.length - 1} files import it.`);
    else if (hub) how.push(`${baseOf(hub[0])} is imported by ${baseOf(internalLinks.find((l) => l.to === hub[0])!.from)}.`);
    if (orchestrator && orchestrator[1] >= 2) how.push(`${baseOf(orchestrator[0])} coordinates the others by importing ${orchestrator[1]} of them.`);
  }
  if (publicSurface.length) how.push(`Code outside reaches this collection through ${list(publicSurface.slice(0, 4).map((s) => s.name), 4)}.`);
  else if (outsideUsers.size === 0 && members.length > 1) how.push("Nothing outside imports these files, so they may be entry points, dynamically loaded, or unused.");
  if (outsideDeps.size) how.push(`It relies on ${list([...outsideDeps].sort(), 4)}${packages.size ? ` and the packages ${list([...packages].sort(), 4)}` : ""}.`);

  const routeIn = routes.length ? `HTTP requests to ${list(routes.map((r) => `${r.method} ${r.path}`), 3)}` : outsideUsers.size ? `Calls from ${list([...outsideUsers].sort(), 3)}` : "Startup and configuration";
  const dataOut = writes.size ? `Persists to ${list([...writes], 3)}` : emits.size ? `Events ${list([...emits], 3)}` : routes.length ? "HTTP responses" : "Return values to callers";
  const dataIn = reads.size ? `${routeIn}; reads ${list([...reads], 3)}` : routeIn;

  const keyFiles = files.slice(0, 5).map((f) => ({
    path: f.path,
    why: f.path === hub?.[0] ? `Shared by ${hub![1]} sibling file${hub![1] === 1 ? "" : "s"}` : f.path === orchestrator?.[0] ? `Coordinates ${orchestrator![1]} sibling files` : (idx.importsIn.get(f.path)?.size ?? 0) > 0 ? `Used by ${plural(idx.importsIn.get(f.path)!.size, "file")}` : "One of the most significant files here",
  }));

  return {
    id: sel.kind === "folder" ? `mod:${sel.path}` : "sel", kind: sel.kind, path: sel.path, name, title, depth: sel.path ? sel.path.split("/").length : 0, parent: null, children: [],
    areas, files, fileCount: members.length, lines: totalLines, roles, purpose: purposeParts.join(" "), howFilesWork: how.join(" "), keyFiles,
    publicSurface: publicSurface.slice(0, 10), internalLinks: internalLinks.slice(0, 12), dependsOn: [...outsideDeps].sort().slice(0, 10), usedBy: [...outsideUsers].sort().slice(0, 10),
    externalPackages: [...packages].sort().slice(0, 12), dataIn, dataOut, findings: { total: live.length, bySeverity, top }, tests: [...tests].sort().slice(0, 8),
    evidence: files.slice(0, 3).map((f) => f.path), origin: "deterministic",
  };
}

function fallbackPurpose(f: LoadedFile, idx: CollectionIndex): string {
  const syms = (idx.symbolsByFile.get(f.path) ?? []).filter((s) => s.kind !== "section");
  return `${ROLE_LABEL[f.role ?? ""] ? `A ${ROLE_LABEL[f.role ?? ""]} file` : "A file"} of ${f.lines} lines${syms.length ? ` declaring ${plural(syms.length, "symbol")}` : ""}.`;
}

const isMember = (f: LoadedFile) => !f.isExcluded && MEMBER_CLASSES.has(f.classification);

/** Files under a folder (recursively), or the explicit files/folders in a selection. Folders end with "/" or match a directory. */
export function resolveSelection(inp: DocInputs, entries: string[], cap = 300): LoadedFile[] {
  const out = new Map<string, LoadedFile>();
  for (const raw of entries) {
    const e = raw.trim().replace(/^\/+/, "");
    if (!e) continue;
    const folder = e.replace(/\/+$/, "");
    for (const f of inp.files) {
      if (!isMember(f) && f.classification !== "test") continue;
      if (f.path === e || f.path.startsWith(`${folder}/`)) out.set(f.path, f);
      if (out.size >= cap) return [...out.values()];
    }
  }
  return [...out.values()];
}

/** One document per meaningful folder: at least two source files, not a pure pass-through of its only child. */
export function buildModuleDocs(inp: DocInputs, fileDocsList: FileDoc[], limit = 60): ModuleDoc[] {
  const idx = buildCollectionIndex(inp);
  const fileDocs = new Map(fileDocsList.map((d) => [d.path, d]));
  const dirFiles = new Map<string, LoadedFile[]>();
  for (const f of inp.files) {
    if (!isMember(f)) continue;
    let d = dirOf(f.path);
    while (d) {
      const l = dirFiles.get(d);
      if (l) l.push(f); else dirFiles.set(d, [f]);
      d = dirOf(d);
    }
  }
  const candidates = [...dirFiles.entries()].filter(([, fs]) => fs.length >= 2);
  const childCount = new Map<string, number>();
  for (const [d] of candidates) { const p = dirOf(d); if (p) childCount.set(p, (childCount.get(p) ?? 0) + 1); }
  const kept = candidates.filter(([d, fs]) => {
    // Skip a folder whose files are exactly those of its single documented child: it would repeat that child.
    if (childCount.get(d) === 1) {
      const child = candidates.find(([c]) => dirOf(c) === d);
      if (child && child[1].length === fs.length) return false;
    }
    return true;
  });
  const maxImp = maxOf(inp.files.map((f) => f.importance), 1e-9);
  const scored = kept.map(([d, fs]) => ({ d, fs, score: fs.reduce((n, f) => n + f.importance / maxImp, 0) + fs.length * 0.05 })).sort((a, b) => b.score - a.score || a.d.localeCompare(b.d)).slice(0, limit);
  const docs = scored.map(({ d, fs }) => explainSet(inp, idx, fileDocs, { kind: "folder", path: d, files: fs }));
  const chosen = new Set(docs.map((m) => m.path));
  for (const m of docs) {
    let p = dirOf(m.path);
    while (p && !chosen.has(p)) p = dirOf(p);
    m.parent = p || null;
    if (p) docs.find((x) => x.path === p)!.children.push(m.path);
  }
  return docs.sort((a, b) => a.path.localeCompare(b.path));
}

/** Explain any folder or selection on demand, including projects analysed before this level existed. */
export function explainCollection(inp: DocInputs, fileDocsList: FileDoc[], entries: string[]): ModuleDoc | null {
  const files = resolveSelection(inp, entries);
  if (files.length === 0) return null;
  const idx = buildCollectionIndex(inp);
  const fileDocs = new Map(fileDocsList.map((d) => [d.path, d]));
  const single = entries.length === 1 && !files.some((f) => f.path === entries[0].trim()) ? entries[0].trim().replace(/^\/+|\/+$/g, "") : "";
  return explainSet(inp, idx, fileDocs, single ? { kind: "folder", path: single, files } : { kind: "selection", path: "", files });
}
