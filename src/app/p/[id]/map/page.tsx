"use client";
import { ReactFlow, Background, Controls, MiniMap, ReactFlowProvider } from "@xyflow/react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { DownloadMenu } from "@/components/download";
import { Legend } from "@/components/legend";
import { Chip, Empty, ErrorBox, Loading, SourceLink } from "@/components/ui";
import { api, useApi } from "@/lib/client";
import type { Graph, GraphNode, ImpactResult } from "@/lib/map";
import { connectionsOf, laneSummary, layoutMap, type Connection } from "@/lib/map/layout";
import { glyphFor, riskGlyph } from "@/lib/map/legend";
import { FIT_OPTIONS, minimapClass, nodeTypes, toFlow } from "@/components/graph";

type Mode = "area" | "module" | "symbol";
interface GraphResp { graph: Graph; mermaid?: string }
interface ImpactResp { impact: ImpactResult }

function ImpactPanel({ id, impact }: { id: string; impact: ImpactResult }) {
  const byDepth = (xs: ImpactResult["upstream"]) => { const m = new Map<number, typeof xs>(); for (const x of xs) (m.get(x.depth) ?? m.set(x.depth, []).get(x.depth)!).push(x); return [...m.entries()].sort((a, b) => a[0] - b[0]); };
  return (
    <div className="space-y-3 text-[13px]">
      <p>{impact.summary}</p>
      {impact.chains.length > 0 && <div><div className="h-label mb-1">Likely consumers, nearest first</div>{impact.chains.map((c, i) => <div key={i} className="mono mb-1 text-[11px]">{c.map((x, k) => <span key={k}>{k > 0 && <span className="text-muted"> ← used by ← </span>}{x}</span>)}</div>)}</div>}
      {impact.affectedRoutes.length > 0 && <div><div className="h-label mb-1">Routes that may change behaviour</div>{impact.affectedRoutes.map((r) => <div key={r.route + r.line}><SourceLink projectId={id} cite={`${r.path}:${r.line}`}>{r.route}</SourceLink></div>)}</div>}
      <div><div className="h-label mb-1">Upstream ({impact.upstream.length}) if you change this</div>{impact.upstream.length === 0 ? <span className="text-muted">nothing depends on it</span> : byDepth(impact.upstream).map(([d, xs]) => <div key={d} className="mb-1"><span className="text-muted">depth {d}: </span>{xs.slice(0, 8).map((x, i) => <span key={x.id}>{i > 0 && ", "}{x.path ? <SourceLink projectId={id} cite={`${x.path}:${x.line ?? 1}`}>{x.label}</SourceLink> : x.label}</span>)}{xs.length > 8 && ` +${xs.length - 8}`}</div>)}</div>
      <div><div className="h-label mb-1">Downstream ({impact.downstream.length}) it relies on</div>{impact.downstream.length === 0 ? <span className="text-muted">no indexed dependencies</span> : byDepth(impact.downstream).map(([d, xs]) => <div key={d} className="mb-1"><span className="text-muted">depth {d}: </span>{xs.slice(0, 8).map((x, i) => <span key={x.id}>{i > 0 && ", "}{x.path ? <SourceLink projectId={id} cite={`${x.path}:${x.line ?? 1}`}>{x.label}</SourceLink> : x.label}</span>)}{xs.length > 8 && ` +${xs.length - 8}`}</div>)}</div>
      <div><div className="h-label mb-1">Tests to run</div>{impact.affectedTests.length ? impact.affectedTests.map((t) => <div key={t}><SourceLink projectId={id} cite={t} /></div>) : <span style={{ color: "var(--high)" }}>No known test exercises this code.</span>}</div>
    </div>
  );
}

function ConnectionList({ title, items, onPick }: { title: string; items: Connection[]; onPick: (c: Connection) => void }) {
  if (!items.length) return null;
  return (
    <div>
      <div className="h-label mb-1">{title} ({items.length})</div>
      <ul className="max-h-56 overflow-auto rounded border border-line">
        {items.map((c) => (
          <li key={c.node.id} className="border-b border-line last:border-b-0">
            <button className="block w-full px-2 py-1.5 text-left text-[12.5px] hover:bg-panel2" onClick={() => onPick(c)}>
              <span className="mono mr-1">{glyphFor(c.node.type)}</span><span className="font-medium">{c.node.label}</span>
              <span className="block pl-5 text-[11.5px] text-muted">{c.strength} link{c.weight > 1 ? ` · ${c.weight} references` : ""}{c.node.description ? ` · ${c.node.description}` : ""}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MapInner() {
  const { id } = useParams<{ id: string }>();
  const sp = useSearchParams();
  const initialFile = sp.get("impactFile");
  const initialSymbol = sp.get("symbol");
  const [mode, setMode] = useState<Mode>(initialFile ? "module" : initialSymbol ? "symbol" : "area");
  const [area, setArea] = useState<string>("");
  const [symbol, setSymbol] = useState<string>(initialSymbol ?? "");
  const [depth, setDepth] = useState(1);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [impactTarget, setImpactTarget] = useState<{ type: "file" | "symbol"; id: string } | null>(initialFile ? { type: "file", id: initialFile } : null);
  const [fileSymbolsFor, setFileSymbolsFor] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const path = mode === "area" ? `/api/projects/${id}/graph?type=area` : mode === "module" ? `/api/projects/${id}/graph?type=module&limit=${area ? 60 : 36}${area ? `&area=${encodeURIComponent(area)}` : ""}` : symbol ? `/api/projects/${id}/graph?type=symbol&symbol=${encodeURIComponent(symbol)}&depth=${depth}` : null;
  const { data, error, loading, reload } = useApi<GraphResp>(path);
  const areas = useApi<GraphResp>(`/api/projects/${id}/graph?type=area`);
  const areaNames = useMemo(() => (areas.data?.graph.nodes ?? []).filter((n) => n.group === "area").map((n) => n.label), [areas.data]);
  const impactApi = useApi<ImpactResp>(impactTarget ? `/api/projects/${id}/impact?type=${impactTarget.type}&id=${encodeURIComponent(impactTarget.id)}` : null);
  const impact = impactApi.data?.impact ?? null;
  const impactErr = impactApi.error?.message ?? null;
  const fileInfo = useApi<{ symbols: { id: string; qualifiedName: string; kind: string }[] }>(fileSymbolsFor ? `/api/projects/${id}/files/content?path=${encodeURIComponent(fileSymbolsFor)}` : null);
  const fileSymbols = (fileInfo.data?.symbols ?? []).filter((s) => s.kind !== "section").slice(0, 60);

  const select = (n: GraphNode | null) => {
    setSelected(n);
    if (!n) { setImpactTarget(null); setFileSymbolsFor(null); return; }
    if (mode === "module") { setImpactTarget({ type: "file", id: n.id }); setFileSymbolsFor(n.id); }
    else if (mode === "symbol") { setImpactTarget({ type: "symbol", id: n.id }); setFileSymbolsFor(null); }
    else { setImpactTarget(null); setFileSymbolsFor(null); }
  };

  const highlight = useMemo(() => new Set<string>(impact ? [...impact.upstream.map((u) => u.id)] : []), [impact]);
  const placement = useMemo(() => (data ? layoutMap(data.graph, { mode, focus: data.graph.focus }) : null), [data, mode]);
  const laid = useMemo(() => (data && placement ? toFlow(data.graph, placement, { mode, selected: selected?.id ?? null, highlight, showAll }) : { nodes: [], edges: [] }), [data, placement, mode, selected, highlight, showAll]);
  const graphKey = data ? `${mode}:${data.graph.nodes.length}:${data.graph.nodes[0]?.id}:${data.graph.nodes[data.graph.nodes.length - 1]?.id}` : "empty";
  const connections = useMemo(() => (data && selected ? connectionsOf(data.graph, selected.id) : null), [data, selected]);
  const pick = (c: Connection) => { const gn = data?.graph.nodes.find((x) => x.id === c.node.id); if (gn) select(gn); };
  const mostConnected = useMemo(() => (placement && data ? [...placement.nodes].sort((a, b) => b.usedBy + b.uses - (a.usedBy + a.uses)).slice(0, 5).map((p) => ({ p, n: data.graph.nodes.find((x) => x.id === p.id)! })) : []), [placement, data]);
  const switchMode = (m: Mode) => { setMode(m); setSelected(null); setImpactTarget(null); setFileSymbolsFor(null); if (m !== "symbol") setSymbol(""); };

  const copyMermaid = async () => {
    if (!path) return;
    try { const r = await api<GraphResp>(`${path}&mermaid=1`); await navigator.clipboard.writeText(r.mermaid ?? ""); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  };

  return (
    <div className="flex min-h-full flex-col lg:h-full lg:min-h-0">
      <div className="flex flex-none flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2">
        <div role="group" aria-label="Graph level" className="tabs">
          {([["area", "Functional areas"], ["module", "Files"], ["symbol", "Symbol"]] as [Mode, string][]).map(([m, l]) => <button key={m} className="tab" aria-pressed={mode === m} onClick={() => switchMode(m)}>{l}</button>)}
        </div>
        {mode === "module" && <select className="input sm:w-[210px]" value={area} onChange={(e) => { setArea(e.target.value); setSelected(null); setImpactTarget(null); }} aria-label="Limit to functional area"><option value="">All areas (top files)</option>{areaNames.map((a) => <option key={a}>{a}</option>)}</select>}
        {mode === "symbol" && <><span className="text-sm text-muted">depth</span><select className="input w-[60px]" value={depth} onChange={(e) => setDepth(Number(e.target.value))} aria-label="Neighbourhood depth">{[1, 2, 3].map((d) => <option key={d}>{d}</option>)}</select></>}
        <span className="text-xs text-muted">{data ? `${data.graph.nodes.length} of ${data.graph.totalNodes} nodes${data.graph.truncated ? " (largest shown; narrow by area)" : ""}` : ""}</span>
        {placement && placement.hiddenCount > 0 && <button className="btn text-xs" aria-pressed={showAll} onClick={() => setShowAll((v) => !v)} title="By default each card shows its strongest links; select a card to see all of its links">{showAll ? "Showing all connections" : `Key connections · ${placement.hiddenCount} more`}</button>}
        <div className="ml-auto flex gap-2"><button className="btn" onClick={copyMermaid} disabled={!path}>{copied ? "Copied" : "Copy as Mermaid"}</button><DownloadMenu projectId={id} scope="map" label="Download code map" /></div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="relative h-[65vh] min-w-0 flex-none lg:h-auto lg:flex-1" style={{ background: "var(--bg)" }}>
          {mode === "symbol" && !symbol ? <Empty title="Choose a symbol to explore">Open a file in the Files view and pick a symbol, or select a file here in Files mode and choose one of its symbols.</Empty>
            : loading && !data ? <Loading label="Building graph" /> : error ? <ErrorBox error={error} onRetry={reload} /> : !data || data.graph.nodes.length === 0 ? <Empty title="Nothing to draw">No relationships were found at this level.</Empty> : (
              <ReactFlow key={graphKey} nodes={laid.nodes} edges={laid.edges} nodeTypes={nodeTypes} fitView fitViewOptions={FIT_OPTIONS} minZoom={0.2} maxZoom={1.8} nodesConnectable={false} nodesDraggable={false} proOptions={{ hideAttribution: true }}
                onNodeClick={(_, n) => { const gn = data.graph.nodes.find((x) => x.id === n.id) ?? null; select(gn); }} onPaneClick={() => select(null)}>
                <Background gap={20} color="var(--line)" />
                <Controls showInteractive={false} />
                {(data?.graph.nodes.length ?? 0) > 12 && <MiniMap pannable zoomable nodeClassName={minimapClass} maskColor="rgba(0,0,0,0.08)" style={{ background: "var(--panel)" }} />}
              </ReactFlow>
            )}
          <details className="absolute bottom-3 left-14 z-10 max-w-[520px]"><summary className="btn mb-1 w-fit cursor-pointer text-xs">Legend</summary><Legend compact /></details>
        </div>
        <aside className="w-full flex-none border-t border-line bg-panel p-3 lg:w-[340px] lg:overflow-auto lg:border-l lg:border-t-0" aria-label="Selection details">
          {!selected ? (
            <div className="text-[13px] text-muted">
              {placement && data && (
                <div className="mb-3 space-y-2 text-fg">
                  <div className="h-label">This map</div>
                  <div>{laneSummary(placement).map((l) => `${l.label} ${l.count}`).join(" · ")}</div>
                  {mostConnected.length > 0 && <div><div className="mb-1 text-muted">Most connected</div>{mostConnected.map(({ p, n }) => <button key={n.id} className="block w-full border-b border-line py-1 text-left hover:bg-panel2" onClick={() => select(n)}><span className="mono mr-1">{glyphFor(n.type)}</span><span className="font-medium">{n.label}</span><span className="text-muted"> · used by {p.usedBy}, uses {p.uses}</span></button>)}</div>}
                  {placement.hiddenCount > 0 && !showAll && <div className="text-muted">{placement.hiddenCount} lighter links are hidden so the picture stays readable. Select a card to see every link it has, or use “Key connections” above.</div>}
                </div>
              )}
              <div className="h-label mb-1">How to use</div>
              <ul className="list-disc pl-4"><li><strong className="text-fg">Functional areas</strong> gives the high-level picture. Select an area, then drill into its files.</li><li><strong className="text-fg">Files</strong> shows import and call relationships. Select a file to see what changes if you edit it.</li><li><strong className="text-fg">Symbol</strong> shows callers, callees and data access for one function or class.</li></ul>
              <div className="mt-2">Node outlines show role; a mark on the right shows the highest finding severity.</div>
              {impact && <div className="mt-3"><ImpactPanel id={id} impact={impact} /></div>}
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <div className="flex items-center gap-2"><span className="mono">{glyphFor(selected.type)}</span><strong className="break-all">{selected.label}</strong></div>
                <div className="mt-1 flex flex-wrap gap-1"><Chip>{selected.type}</Chip>{selected.risk !== "none" && <Chip tone="warn">{riskGlyph(selected.risk)} {selected.risk} risk</Chip>}{selected.area && <Chip>{selected.area}</Chip>}</div>
                {selected.path && <div className="mt-1"><SourceLink projectId={id} cite={`${selected.path}:${selected.line ?? 1}`} /></div>}
              </div>
              {selected.description && <p className="text-[13px]">{selected.description}</p>}
              {connections && <><ConnectionList title="Depends on" items={connections.dependsOn} onPick={pick} /><ConnectionList title="Used by" items={connections.usedBy} onPick={pick} /></>}
              {mode === "area" && selected.group === "area" && <button className="btn btn-primary w-full" onClick={() => { setArea(selected.label); switchMode("module"); setArea(selected.label); }}>Drill into files of this area</button>}
              {mode === "module" && fileSymbols.length > 0 && (
                <div><div className="h-label mb-1">Explore a symbol</div><div className="max-h-40 overflow-auto rounded border border-line">{fileSymbols.map((s) => <button key={s.id} className="block w-full border-b border-line px-2 py-1 text-left text-[12px] hover:bg-panel2" onClick={() => { setSymbol(s.id); setMode("symbol"); setSelected(null); setImpactTarget(null); setFileSymbolsFor(null); }}><span className="mono">{s.qualifiedName}</span> <span className="text-muted">{s.kind}</span></button>)}</div></div>
              )}
              {mode === "module" && <Link href={`/p/${id}/files?path=${encodeURIComponent(selected.id)}`} className="btn w-full justify-center hover:no-underline">Open in code explorer</Link>}
              {mode !== "area" && (
                <div><div className="h-label mb-1">Change impact: if I modify this…</div>
                  {impactErr ? <div className="text-sm" style={{ color: "var(--crit)" }}>{impactErr}</div> : !impact ? <Loading label="Tracing" /> : <ImpactPanel id={id} impact={impact} />}
                </div>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

export default function MapPage() {
  return <ReactFlowProvider><MapInner /></ReactFlowProvider>;
}
