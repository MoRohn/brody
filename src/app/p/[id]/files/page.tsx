"use client";
import { Highlight } from "prism-react-renderer";
import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chip, Empty, ErrorBox, Loading, SeverityBadge, SourceLink } from "@/components/ui";
import { useApi } from "@/lib/client";
import { DARK_SYNTAX, LIGHT_SYNTAX } from "@/lib/syntax";
import { isDarkLevel } from "@/lib/theme";
import { useThemeLevel } from "@/lib/themeState";
import type { FileDoc, SymbolDoc } from "@/lib/docs/types";
import type { FindingRow } from "@/lib/db/schema";
import type { ImpactResult, SymbolNeighborhood, TreeNode } from "@/lib/map";

interface FilesResp { files: { path: string; language: string; lines: number; isExcluded: boolean; excludeReason: string | null; role: string | null }[]; tree: TreeNode; excluded: Record<string, number> }
interface FileResp {
  file: { path: string; language: string; size: number; lines: number; classification: string; role: string | null; area: string | null; isExcluded: boolean; excludeReason: string | null; parseStatus: string; parseError: string | null; importance: number };
  content: string | null; note?: string;
  symbols: { id: string; name: string; qualifiedName: string; kind: string; startLine: number; endLine: number; signature: string | null; exported: boolean; inbound: number; outbound: number; doc: SymbolDoc | null }[];
  dependencies: { outgoing: string[]; incoming: string[]; external: string[]; tests: string[] };
  findings: Omit<FindingRow, "projectId">[]; fileDoc: FileDoc | null; impact: (Pick<ImpactResult, "summary" | "affectedRoutes" | "affectedTests" | "chains" | "upstream" | "downstream">) | null;
}
interface SymResp { neighborhood: SymbolNeighborhood; doc: SymbolDoc | null; code: string | null }

const PRISM: Record<string, string> = { TypeScript: "tsx", JavaScript: "jsx", Python: "python", Go: "go", JSON: "json", CSS: "css", SCSS: "css", HTML: "markup", XML: "markup", SVG: "markup", YAML: "yaml", Markdown: "markdown", SQL: "sql", Rust: "rust", Kotlin: "kotlin", Swift: "swift", C: "c", "C++": "cpp", GraphQL: "graphql", Vue: "markup", Java: "clike", "C#": "clike", PHP: "clike", Ruby: "clike", Shell: "clike" };
const MAX_LINES = 6000;

/** Panel widths survive reloads. This page only renders after client-side data loads, so reading storage during init cannot cause a hydration mismatch. */
function usePersisted(key: string, initial: number): [number, (n: number) => void] {
  const [v, setV] = useState(() => {
    try { const s = typeof window !== "undefined" ? localStorage.getItem(key) : null; const n = s ? Number(s) : NaN; return Number.isFinite(n) ? n : initial; } catch { return initial; }
  });
  return [v, (n) => { setV(n); try { localStorage.setItem(key, String(n)); } catch { /* storage unavailable */ } }];
}

function Splitter({ onDrag, label, value, min, max }: { onDrag: (dx: number) => void; label: string; value: number; min: number; max: number }) {
  const [active, setActive] = useState(false);
  return (
    <div role="separator" aria-orientation="vertical" aria-label={label} aria-valuenow={Math.round(value)} aria-valuemin={min} aria-valuemax={max} tabIndex={0} className={`splitter ${active ? "active" : ""}`}
      onMouseDown={(e) => { e.preventDefault(); setActive(true); let last = e.clientX; const move = (ev: MouseEvent) => { onDrag(ev.clientX - last); last = ev.clientX; }; const up = () => { setActive(false); window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); }; window.addEventListener("mousemove", move); window.addEventListener("mouseup", up); }}
      onKeyDown={(e) => { if (e.key === "ArrowLeft") onDrag(-16); if (e.key === "ArrowRight") onDrag(16); }} />
  );
}

function Tree({ node, depth, open, toggle, current, onPick }: { node: TreeNode; depth: number; open: Set<string>; toggle: (p: string) => void; current: string | null; onPick: (p: string) => void }) {
  return (
    <ul role={depth === 0 ? "tree" : "group"}>
      {(node.children ?? []).map((c) => {
        const isOpen = open.has(c.path);
        return (
          <li key={c.path} role="treeitem" aria-expanded={c.type === "dir" ? isOpen : undefined} aria-selected={current === c.path}>
            <button className="flex w-full items-center gap-1 py-[1px] text-left text-[12.5px] hover:bg-panel2" style={{ paddingLeft: 6 + depth * 12, background: current === c.path ? "var(--accent-soft)" : undefined, opacity: c.note?.startsWith("excluded") ? 0.6 : 1 }} onClick={() => (c.type === "dir" ? toggle(c.path) : onPick(c.path))} title={c.note ?? c.path}>
              <span className="mono w-3 flex-none text-muted" aria-hidden>{c.type === "dir" ? (isOpen ? "▾" : "▸") : ""}</span>
              <span className="truncate">{c.name}{c.type === "dir" ? "/" : ""}</span>
              {c.risk && c.risk !== "none" && <span className="mono ml-auto mr-1 flex-none text-[11px] font-bold" style={{ color: c.risk === "critical" ? "var(--crit)" : c.risk === "high" ? "var(--high)" : "var(--med)" }} aria-label={`${c.risk} risk`}>{c.risk === "critical" ? "!" : c.risk === "high" ? "▲" : c.risk === "medium" ? "●" : "○"}</span>}
            </button>
            {c.type === "dir" && isOpen && <Tree node={c} depth={depth + 1} open={open} toggle={toggle} current={current} onPick={onPick} />}
          </li>
        );
      })}
    </ul>
  );
}

function Code({ text, language, hl, symbolsByLine, findingsByLine, scrollTo, onSymbol }: { text: string; language: string; hl: [number, number] | null; symbolsByLine: Map<number, string>; findingsByLine: Map<number, string>; scrollTo: number | null; onSymbol: (id: string) => void }) {
  const level = useThemeLevel();
  const ref = useRef<HTMLDivElement>(null);
  const lines = text.split("\n");
  const truncated = lines.length > MAX_LINES;
  const body = truncated ? lines.slice(0, MAX_LINES).join("\n") : text;
  useEffect(() => {
    if (!scrollTo || !ref.current) return;
    const el = ref.current.querySelector<HTMLElement>(`[data-line="${scrollTo}"]`);
    el?.scrollIntoView({ block: "center" });
  }, [scrollTo, text]);
  return (
    <div ref={ref} className="mono min-w-0 flex-1 overflow-auto bg-panel text-[12.5px] leading-[1.55]" tabIndex={0} aria-label="Source code">
      <Highlight code={body} language={PRISM[language] ?? "plain"} theme={isDarkLevel(level) ? DARK_SYNTAX : LIGHT_SYNTAX}>
        {({ tokens, getLineProps, getTokenProps }) => (
          <pre className="!m-0 !rounded-none !border-0 !bg-transparent !p-0" style={{ background: "transparent" }}>
            {tokens.map((line, i) => {
              const n = i + 1;
              const inHl = hl && n >= hl[0] && n <= hl[1];
              const sym = symbolsByLine.get(n);
              const fin = findingsByLine.get(n);
              const { style: _style, ...lp } = getLineProps({ line });
              return (
                <div key={i} data-line={n} {...lp} className={`src-line flex ${inHl ? "src-hl" : ""}`}>
                  <span className="sticky left-0 z-[1] flex w-[76px] flex-none select-none items-center justify-end gap-1 bg-panel pr-2 text-right text-muted" style={{ background: inHl ? "color-mix(in srgb, var(--med) 22%, var(--panel))" : "var(--panel)" }}>
                    {fin && <span title={fin} style={{ color: "var(--high)" }} aria-label={`Finding: ${fin}`}>▲</span>}
                    {sym && <button title="Show symbol intelligence" onClick={() => onSymbol(sym)} style={{ color: "var(--accent)" }} aria-label="Symbol starts here">◆</button>}
                    <span className="tabular-nums">{n}</span>
                  </span>
                  <span className="whitespace-pre pr-6">{line.map((t, k) => <span key={k} {...getTokenProps({ token: t })} />)}{line.length === 0 ? " " : null}</span>
                </div>
              );
            })}
          </pre>
        )}
      </Highlight>
      {truncated && <div className="p-3 text-xs text-muted">Showing the first {MAX_LINES.toLocaleString()} of {lines.length.toLocaleString()} lines.</div>}
    </div>
  );
}

function List({ title, items, id, empty }: { title: string; items: string[]; id: string; empty?: string }) {
  return (
    <div className="mb-3">
      <div className="h-label mb-0.5">{title} <span className="normal-case tracking-normal">({items.length})</span></div>
      {items.length ? items.slice(0, 20).map((p) => <div key={p} className="truncate text-[12px]"><SourceLink projectId={id} cite={p} /></div>) : <div className="text-xs text-muted">{empty ?? "none"}</div>}
      {items.length > 20 && <div className="text-xs text-muted">+{items.length - 20} more</div>}
    </div>
  );
}

export default function FilesPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const path = sp.get("path");
  const line = sp.get("line") ? Number(sp.get("line")) : null;
  const end = sp.get("end") ? Number(sp.get("end")) : null;
  const symbolId = sp.get("symbol");
  const showExcluded = sp.get("excluded") === "1";
  const [leftW, setLeftW] = usePersisted("brody.left", 270);
  const [rightW, setRightW] = usePersisted("brody.right", 380);
  const [q, setQ] = useState("");
  const [userOpened, setUserOpened] = useState<Set<string>>(new Set());
  const [closedState, setClosedState] = useState<{ path: string | null; set: Set<string> }>({ path: null, set: new Set() });

  const files = useApi<FilesResp>(`/api/projects/${id}/files${showExcluded ? "?includeExcluded=1" : ""}`);
  const file = useApi<FileResp>(path ? `/api/projects/${id}/files/content?path=${encodeURIComponent(path)}` : null);
  const sym = useApi<SymResp>(symbolId ? `/api/projects/${id}/symbols/${encodeURIComponent(symbolId)}` : null);

  const nav = useCallback((params: Record<string, string | null>) => {
    const p = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(params)) { if (v === null) p.delete(k); else p.set(k, v); }
    router.replace(`${pathname}?${p}`, { scroll: false });
  }, [sp, router, pathname]);

  // Folders are open when the user opened them, when they contain the current file, or (with no file selected) for the first few top-level folders.
  const open = useMemo(() => {
    const o = new Set(userOpened);
    if (path) { const parts = path.split("/"); for (let i = 1; i < parts.length; i++) o.add(parts.slice(0, i).join("/")); }
    else for (const c of (files.data?.tree.children ?? []).filter((x) => x.type === "dir").slice(0, 3)) o.add(c.path);
    if (closedState.path === path) for (const c of closedState.set) o.delete(c);
    return o;
  }, [userOpened, path, files.data, closedState]);
  const toggleDir = (p: string) => {
    if (open.has(p)) {
      setUserOpened((o) => { const x = new Set(o); x.delete(p); return x; });
      setClosedState((c) => ({ path, set: new Set([...(c.path === path ? c.set : []), p]) }));
    } else {
      setUserOpened((o) => new Set(o).add(p));
      setClosedState((c) => (c.path === path ? { path, set: new Set([...c.set].filter((x) => x !== p)) } : c));
    }
  };

  const matches = useMemo(() => (q.trim() ? (files.data?.files ?? []).filter((f) => f.path.toLowerCase().includes(q.toLowerCase())).slice(0, 200) : []), [q, files.data]);
  const symbolsByLine = useMemo(() => new Map((file.data?.symbols ?? []).filter((s) => s.kind !== "section").map((s) => [s.startLine, s.id] as [number, string])), [file.data]);
  const findingsByLine = useMemo(() => new Map((file.data?.findings ?? []).filter((f) => f.startLine).map((f) => [f.startLine!, `${f.code} ${f.title}`] as [number, string])), [file.data]);
  const scrollTo = symbolId && file.data ? (file.data.symbols.find((s) => s.id === symbolId)?.startLine ?? line) : line;
  const hl: [number, number] | null = symbolId && file.data && !line ? (() => { const s = file.data.symbols.find((x) => x.id === symbolId); return s ? [s.startLine, s.endLine] as [number, number] : null; })() : line ? [line, end ?? line] : null;

  if (files.loading && !files.data) return <Loading label="Loading files" />;
  if (files.error) return <ErrorBox error={files.error} onRetry={files.reload} />;
  const f = file.data;
  const n = sym.data?.neighborhood;

  return (
    <div className="flex flex-col lg:h-full lg:min-h-0 lg:flex-row" style={{ "--lw": `${leftW}px`, "--rw": `${rightW}px` } as React.CSSProperties}>
      <aside className="flex max-h-[38vh] flex-none flex-col border-b border-line bg-panel lg:max-h-none lg:w-[var(--lw)] lg:border-b-0 lg:border-r" aria-label="File tree">
        <div className="space-y-1 border-b border-line p-2">
          <input className="input" placeholder="Find file…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find file by path" />
          <label className="flex items-center gap-1 text-xs text-muted"><input type="checkbox" checked={showExcluded} onChange={(e) => nav({ excluded: e.target.checked ? "1" : null })} /> show excluded (node_modules, build…)</label>
          {showExcluded && files.data && Object.keys(files.data.excluded).length > 0 && <div className="text-[11px] text-muted">{Object.entries(files.data.excluded).slice(0, 4).map(([k, v]) => `${v} ${k}`).join(" · ")}</div>}
        </div>
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {q.trim() ? (matches.length ? matches.map((m) => <button key={m.path} className="block w-full truncate px-2 py-0.5 text-left text-[12.5px] hover:bg-panel2" style={{ background: path === m.path ? "var(--accent-soft)" : undefined }} onClick={() => nav({ path: m.path, line: null, end: null, symbol: null })}>{m.path}</button>) : <div className="p-3 text-xs text-muted">No files match.</div>)
            : files.data && <Tree node={files.data.tree} depth={0} open={open} toggle={toggleDir} current={path} onPick={(p) => nav({ path: p, line: null, end: null, symbol: null })} />}
        </div>
      </aside>
      <div className="hidden lg:block"><Splitter label="Resize file tree" value={leftW} min={180} max={520} onDrag={(dx) => setLeftW(Math.max(180, Math.min(520, leftW + dx)))} /></div>
      <section className="flex min-h-[50vh] min-w-0 flex-1 flex-col lg:min-h-0" aria-label="Source code">
        {!path ? <Empty title="Select a file">Choose a file from the tree, or search for one. The panel on the right explains what the file does and what depends on it.</Empty>
          : file.loading && !f ? <Loading label="Loading file" /> : file.error ? <ErrorBox error={file.error} onRetry={file.reload} /> : f && (
            <>
              <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-line bg-panel px-3 py-1.5 text-[12px]">
                <span className="mono font-semibold">{f.file.path}</span>
                <span className="text-muted">{f.file.language} · {f.file.lines.toLocaleString()} lines</span>
                {f.file.isExcluded && <Chip tone="warn">excluded: {f.file.excludeReason}</Chip>}
                {f.file.parseStatus !== "ast" && <Chip title={f.file.parseError ?? undefined}>{f.file.parseStatus === "text" ? "text-parsed" : f.file.parseStatus}</Chip>}
              </div>
              {f.content === null ? <Empty title={f.note ?? "Content unavailable"} /> : <Code text={f.content} language={f.file.language} hl={hl} symbolsByLine={symbolsByLine} findingsByLine={findingsByLine} scrollTo={scrollTo} onSymbol={(sid) => nav({ symbol: sid, line: null, end: null })} />}
              {f.note && f.content !== null && <div className="border-t border-line px-3 py-1 text-xs text-muted">{f.note}</div>}
            </>
          )}
      </section>
      <div className="hidden lg:block"><Splitter label="Resize intelligence panel" value={rightW} min={280} max={640} onDrag={(dx) => setRightW(Math.max(280, Math.min(640, rightW - dx)))} /></div>
      <aside className="flex-none border-t border-line bg-panel p-3 text-[13px] lg:w-[var(--rw)] lg:overflow-auto lg:border-l lg:border-t-0" aria-label="Code intelligence">
        {!f ? <div className="text-muted">Code intelligence appears here.</div> : (
          <>
            <div className="h-label mb-1">Architecture role</div>
            <div className="mb-2 flex flex-wrap gap-1"><Chip tone="info">{f.file.role ?? f.file.classification}</Chip>{f.file.area && <Chip>{f.file.area}</Chip>}<Chip title="Relative importance from the dependency graph">importance {f.file.importance.toFixed(2)}</Chip></div>
            {f.fileDoc ? <div className="mb-3"><p className="mb-1"><strong>Purpose.</strong> {f.fileDoc.purpose}</p><p className="mb-1"><strong>How it operates.</strong> {f.fileDoc.howItOperates}</p><p className="mb-1 text-muted"><strong>Data in:</strong> {f.fileDoc.dataIn} · <strong>out:</strong> {f.fileDoc.dataOut}</p>{f.fileDoc.engineeringNotes.map((x, i) => <p key={i} className="text-xs text-muted">{x}</p>)}<div className="text-[10px] uppercase tracking-wide text-muted">{f.fileDoc.origin === "ai" ? "AI-written" : "assembled from graph"}</div></div> : <p className="mb-3 text-muted">No generated explanation for this file (it may be outside the explained set).</p>}

            <div className="h-label mb-1">Symbols ({f.symbols.filter((s) => s.kind !== "section").length})</div>
            <div className="mb-3 max-h-52 overflow-auto rounded border border-line">
              {f.symbols.filter((s) => s.kind !== "section").map((s) => (
                <button key={s.id} className="block w-full border-b border-line px-2 py-1 text-left hover:bg-panel2" style={{ background: symbolId === s.id ? "var(--accent-soft)" : undefined }} onClick={() => nav({ symbol: s.id, line: null, end: null })}>
                  <span className="mono text-[12px]">{s.qualifiedName}</span> <span className="text-xs text-muted">{s.kind}{s.exported ? " · exported" : ""} · ↓{s.inbound} ↑{s.outbound}</span>
                </button>
              ))}
              {f.symbols.filter((s) => s.kind !== "section").length === 0 && <div className="p-2 text-xs text-muted">No symbols extracted{f.file.parseStatus !== "ast" ? " (this language uses text-based inspection)" : ""}.</div>}
            </div>

            {symbolId && (sym.loading && !sym.data ? <Loading label="Loading symbol" /> : sym.error ? <ErrorBox error={sym.error} /> : n && (
              <div className="mb-3 rounded border border-accent p-2">
                <div className="flex items-center justify-between"><strong className="mono break-all">{n.symbol.name}</strong><button className="btn py-0 text-xs" onClick={() => nav({ symbol: null })} aria-label="Close symbol">✕</button></div>
                <div className="mono text-[11px] text-muted">{n.symbol.kind} · {n.symbol.path}:{n.symbol.line}-{n.symbol.endLine}</div>
                {sym.data?.doc && <div className="my-1.5"><p><strong>Purpose.</strong> {sym.data.doc.purpose}</p><p><strong>Process.</strong> {sym.data.doc.process}</p>{sym.data.doc.businessMeaning && <p><strong>Business meaning.</strong> {sym.data.doc.businessMeaning}</p>}</div>}
                <div className="mt-2 grid grid-cols-1 gap-y-2">
                  <div><div className="h-label">Called by ({n.calledBy.length})</div>{n.calledBy.slice(0, 8).map((c) => <div key={c.id + c.line} className="truncate text-[12px]"><SourceLink projectId={id} cite={`${c.path}:${c.line}`}>{c.name}</SourceLink></div>)}{n.calledBy.length === 0 && <span className="text-xs text-muted">no known callers</span>}</div>
                  <div><div className="h-label">Calls ({n.calls.length})</div>{n.calls.slice(0, 8).map((c) => <div key={c.id} className="truncate text-[12px]"><SourceLink projectId={id} cite={`${c.path}:${c.line}`}>{c.name}</SourceLink></div>)}{n.calls.length === 0 && <span className="text-xs text-muted">none indexed</span>}</div>
                  {(n.reads.length > 0 || n.writes.length > 0) && <div><div className="h-label">Data access</div>{n.writes.map((w) => <div key={w} className="text-[12px]">writes: {w}</div>)}{n.reads.map((w) => <div key={w} className="text-[12px]">reads: {w}</div>)}</div>}
                  {(n.extends.length > 0 || n.implements.length > 0) && <div><div className="h-label">Inheritance</div>{n.extends.length > 0 && <div className="text-[12px]">extends {n.extends.join(", ")}</div>}{n.implements.length > 0 && <div className="text-[12px]">implements {n.implements.join(", ")}</div>}</div>}
                  <div><div className="h-label">Imports</div><div className="text-[12px] text-muted">{n.imports.slice(0, 10).join(", ") || "none"}</div></div>
                  {n.returns.length > 0 && <div><div className="h-label">Returns</div><span className="mono text-[12px]">{n.returns.join(", ")}</span></div>}
                  <div><div className="h-label">Tested by</div>{n.testedBy.length ? n.testedBy.map((t) => <div key={t} className="text-[12px]"><SourceLink projectId={id} cite={t} /></div>) : <span className="text-xs" style={{ color: "var(--high)" }}>no known tests</span>}</div>
                  {n.routes.length > 0 && <div><div className="h-label">Routes</div>{n.routes.map((r) => <div key={r} className="mono text-[12px]">{r}</div>)}</div>}
                  {n.findings.length > 0 && <div><div className="h-label">Findings</div>{n.findings.map((x) => <div key={x.id} className="text-[12px]"><SeverityBadge severity={x.severity} /> <Link href={`/p/${id}/review?finding=${x.id}`}>{x.code}</Link> {x.title}</div>)}</div>}
                </div>
                <Link href={`/p/${id}/map?symbol=${encodeURIComponent(n.symbol.id)}`} className="btn mt-2 w-full justify-center hover:no-underline">Open symbol graph and change impact</Link>
              </div>
            ))}

            <List title="Imported by / used by" items={f.dependencies.incoming} id={id} empty="nothing imports this file" />
            <List title="Depends on" items={f.dependencies.outgoing} id={id} />
            {f.dependencies.external.length > 0 && <div className="mb-3"><div className="h-label mb-0.5">External packages</div><div className="flex flex-wrap gap-1">{f.dependencies.external.map((e) => <Chip key={e}><span className="mono">{e}</span></Chip>)}</div></div>}
            <List title="Related tests" items={f.dependencies.tests} id={id} empty="no test references this file" />

            <div className="h-label mb-1">Review findings ({f.findings.length})</div>
            <div className="mb-3">{f.findings.length ? f.findings.map((x) => <div key={x.id} className="mb-1 border-b border-line pb-1"><div className="flex items-center gap-1.5"><SeverityBadge severity={x.severity} /><Link href={`/p/${id}/review?finding=${x.id}`} className="mono text-xs">{x.code}</Link>{x.startLine && <button className="text-xs" onClick={() => nav({ line: String(x.startLine), end: String(x.endLine ?? x.startLine), symbol: null })}>line {x.startLine}</button>}</div><div>{x.title}</div></div>) : <span className="text-xs text-muted">none</span>}</div>

            {f.impact && <><div className="h-label mb-1">If you change this file</div><p className="mb-1">{f.impact.summary}</p>{f.impact.chains.slice(0, 2).map((c, i) => <div key={i} className="mono text-[11px] text-muted">{c.join(" ← ")}</div>)}<Link href={`/p/${id}/map?impactFile=${encodeURIComponent(f.file.path)}`} className="mt-1 inline-block">Explore impact on the map →</Link></>}
          </>
        )}
      </aside>
    </div>
  );
}
