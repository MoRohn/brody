"use client";
import "@xyflow/react/dist/style.css";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useStore, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { useMemo } from "react";
import type { Graph, GraphNode, NodeType } from "@/lib/map";
import { CARD_H, CARD_W, layoutMap, type EdgeSide, type LayoutMode, type MapLayout } from "@/lib/map/layout";
import { glyphFor, riskGlyph, type RiskLevel } from "@/lib/map/legend";

export interface NodeData extends Record<string, unknown> { label: string; type: NodeType; risk: RiskLevel; description?: string; facts: string[]; highlight?: boolean; selected?: boolean; dim?: boolean; foundation?: boolean }
export interface BandData extends Record<string, unknown> { label: string; hint: string; count: number; foundation: boolean }

const TYPE_LABEL: Record<NodeType, string> = { entry: "Entry point", service: "Service", ui: "Interface", api: "API", model: "Data", util: "Utility", external: "External", test: "Test", config: "Configuration", job: "Background job", infra: "Infrastructure" };
const TYPE_SHAPE: Record<NodeType, React.CSSProperties> = {
  entry: { borderRadius: 18 },
  service: { borderRadius: 6 },
  ui: { borderRadius: 2 },
  api: { borderRadius: 6, borderLeftWidth: 6 },
  model: { borderRadius: 14, borderWidth: 2 },
  util: { borderRadius: 6, borderStyle: "dashed" },
  external: { borderRadius: 18, borderWidth: 2, borderStyle: "double" },
  test: { borderRadius: 6, borderStyle: "dotted" },
  config: { borderRadius: 6, borderStyle: "dashed" },
  job: { borderRadius: 18, borderStyle: "dashed" },
  infra: { borderRadius: 2, borderWidth: 2 },
};
export const RISK_COLOR: Record<RiskLevel, string> = { critical: "var(--crit)", high: "var(--high)", medium: "var(--med)", low: "var(--low)", none: "var(--line-strong)" };

const HANDLE_STYLE = { opacity: 0, pointerEvents: "none" as const };

/**
 * Semantic zoom. Zoomed out to see the whole map, small print is unreadable, so cards drop their detail and titles grow
 * to stay legible; zoom in and the detail returns. Bucketed so only crossing a step re-renders the cards.
 */
const zoomBucket = (s: { transform: [number, number, number] }) => { const z = s.transform[2]; return z < 0.42 ? 0.35 : z < 0.58 ? 0.5 : z < 0.8 ? 0.7 : 1; };
const useZoomBucket = () => useStore(zoomBucket);

function MapNode({ data }: NodeProps) {
  const d = data as NodeData;
  const zoom = useZoomBucket();
  const overview = zoom < 0.7;
  const ring = d.selected || d.highlight ? "var(--accent)" : RISK_COLOR[d.risk];
  const shape = TYPE_SHAPE[d.type];
  return (
    <div title={[d.label, d.description, d.facts.join(" · ")].filter(Boolean).join("\n")} className="relative bg-panel px-3 py-2 shadow-sm transition-opacity"
      style={{ width: CARD_W, height: CARD_H, borderWidth: shape.borderWidth ?? 1, borderStyle: shape.borderStyle ?? "solid", borderColor: ring, borderRadius: shape.borderRadius, borderLeftWidth: shape.borderLeftWidth, outline: d.selected ? "2px solid var(--accent)" : d.highlight ? "1px dashed var(--accent)" : undefined, opacity: d.dim ? 0.4 : shape.opacity ?? 1 }}>
      <Handle id="in" type="target" position={Position.Left} style={HANDLE_STYLE} />
      <Handle id="in-r" type="target" position={Position.Right} style={HANDLE_STYLE} />
      <Handle id="in-t" type="target" position={Position.Top} style={HANDLE_STYLE} />
      <Handle id="in-b" type="target" position={Position.Bottom} style={HANDLE_STYLE} />
      <div className={`flex gap-2 ${overview ? "h-full items-center" : "items-center"}`}>
        <span className="mono w-4 flex-none text-center" style={{ fontSize: overview ? 18 : 13 }} aria-label={TYPE_LABEL[d.type]}>{glyphFor(d.type)}</span>
        <span className={`min-w-0 flex-1 font-semibold ${overview ? "line-clamp-2 leading-[1.1] [overflow-wrap:anywhere]" : "truncate leading-5"}`} style={{ fontSize: overview ? Math.min(22, Math.round(14 / zoom)) : 14 }}>{d.label}</span>
        {d.risk !== "none" && <span className="mono flex-none font-bold" style={{ color: RISK_COLOR[d.risk], fontSize: overview ? 18 : 13 }} aria-label={`${d.risk} risk`} title={`${d.risk} risk`}>{riskGlyph(d.risk)}</span>}
      </div>
      {!overview && d.description && <div className="mt-0.5 line-clamp-2 pl-6 text-[11.5px] leading-[15px] text-muted">{d.description}</div>}
      {!overview && (
        <div className="absolute bottom-1.5 left-3 right-3 flex items-center gap-1.5 overflow-hidden whitespace-nowrap pl-6 text-[10.5px] text-muted">
          <span className="rounded-sm border border-line px-1 leading-4">{TYPE_LABEL[d.type]}</span>
          {d.facts.map((f) => <span key={f}>{f}</span>)}
        </div>
      )}
      <Handle id="out" type="source" position={Position.Right} style={HANDLE_STYLE} />
      <Handle id="out-l" type="source" position={Position.Left} style={HANDLE_STYLE} />
      <Handle id="out-b" type="source" position={Position.Bottom} style={HANDLE_STYLE} />
      <Handle id="out-t" type="source" position={Position.Top} style={HANDLE_STYLE} />
    </div>
  );
}

function BandNode({ data }: NodeProps) {
  const d = data as BandData;
  const zoom = useZoomBucket();
  const overview = zoom < 0.7;
  return (
    <div className="h-full w-full rounded-xl border border-line" style={{ background: d.foundation ? "transparent" : "color-mix(in srgb, var(--panel2) 60%, transparent)", borderStyle: d.foundation ? "dashed" : "solid" }}>
      <div className="px-4 pt-2.5">
        <div className="font-bold uppercase tracking-wide text-fg2" style={{ fontSize: overview ? Math.min(24, Math.round(13 / zoom)) : 13 }}>{d.label}<span className="ml-2 font-normal normal-case tracking-normal text-muted">{d.count}</span></div>
        {!overview && d.hint && <div className="text-[11.5px] leading-4 text-muted">{d.hint}</div>}
      </div>
    </div>
  );
}
export const nodeTypes = { map: MapNode, band: BandNode };

export interface FlowOptions { mode: LayoutMode; selected: string | null; highlight: Set<string>; showAll: boolean }

const sideHandles = (side: EdgeSide): { sourceHandle: string; targetHandle: string } => {
  switch (side) {
    case "back": return { sourceHandle: "out-l", targetHandle: "in-r" };
    case "same": return { sourceHandle: "out", targetHandle: "in-r" };
    case "down": return { sourceHandle: "out-b", targetHandle: "in-t" };
    case "up": return { sourceHandle: "out-t", targetHandle: "in-b" };
    default: return { sourceHandle: "out", targetHandle: "in" };
  }
};

function factsFor(n: GraphNode, usedBy: number): string[] {
  const facts: string[] = [];
  if (n.group === "area") facts.push(`${(n.meta as { files?: number } | undefined)?.files ?? n.size} files`);
  else if (n.path && (n.meta as { lines?: number } | undefined)?.lines) facts.push(`${(n.meta as { lines: number }).lines} lines`);
  const routes = (n.meta as { routes?: number } | undefined)?.routes;
  if (routes) facts.push(`${routes} route${routes === 1 ? "" : "s"}`);
  if (usedBy) facts.push(`used by ${usedBy}`);
  return facts;
}

/** Turns a computed layout into React Flow nodes and edges, styled for the current selection. */
export function toFlow(g: Graph, layout: MapLayout, o: FlowOptions): { nodes: Node[]; edges: Edge[] } {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const bands: Node<BandData>[] = layout.bands.map((b) => ({
    id: `band:${b.id}`, type: "band", position: { x: b.x, y: b.y }, data: { label: b.label, hint: b.hint, count: layout.nodes.filter((p) => p.lane === b.id).length, foundation: b.foundation },
    width: b.w, height: b.h, draggable: false, selectable: false, focusable: false, zIndex: -1,
  }));
  const linked = new Set<string>();
  if (o.selected) for (const e of layout.edges) if (e.source === o.selected || e.target === o.selected) { linked.add(e.source); linked.add(e.target); }
  const nodes: Node<NodeData>[] = layout.nodes.map((p) => {
    const n = byId.get(p.id)!;
    return {
      id: n.id, type: "map", position: { x: p.x, y: p.y }, width: CARD_W, height: CARD_H, // explicit size: the minimap only draws nodes whose size it knows
      
      data: { label: n.label, type: n.type, risk: n.risk, description: n.description ?? (n.path && n.path !== n.label ? n.path : n.area), facts: factsFor(n, p.usedBy), highlight: o.highlight.has(n.id), selected: o.selected === n.id, dim: !!o.selected && o.selected !== n.id && !linked.has(n.id) && !o.highlight.has(n.id), foundation: p.foundation },
    };
  });
  const maxWeight = Math.max(1, ...layout.edges.map((e) => e.weight));
  const edges: Edge[] = [];
  for (const e of layout.edges) {
    const touches = !!o.selected && (e.source === o.selected || e.target === o.selected);
    const drawn = touches || e.tier === "primary" || o.showAll;
    if (!drawn) continue;
    const emphasised = touches;
    const faint = !!o.selected && !touches;
    const width = 1.4 + 2.2 * Math.sqrt(e.weight / maxWeight);
    const stroke = emphasised ? "var(--accent)" : "var(--line-strong)";
    edges.push({
      id: e.id, source: e.source, target: e.target, ...sideHandles(e.side), zIndex: emphasised ? 10 : 0,
      label: emphasised && e.weight > 1 ? `${e.weight}×` : undefined,
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: stroke },
      style: { stroke, strokeWidth: emphasised ? width + 0.6 : width, opacity: faint ? 0.12 : emphasised ? 1 : e.tier === "primary" ? 0.7 : 0.35, strokeDasharray: e.kind === "IMPORTS" ? "6 3" : e.kind === "OPTIONAL" || e.tier === "secondary" ? "3 5" : undefined },
      labelStyle: { fontSize: 11, fontWeight: 600, fill: "var(--fg)" }, labelBgStyle: { fill: "var(--panel)" }, labelBgPadding: [4, 2], labelBgBorderRadius: 4,
      data: { kind: e.kind, tier: e.tier },
    });
  }
  return { nodes: [...bands, ...nodes], edges };
}

export const FIT_OPTIONS = { padding: 0.04, minZoom: 0.2, maxZoom: 1 };
export const minimapClass = (n: Node) => (n.type === "band" ? "mm-band" : `mm-node mm-${(n.data as NodeData).risk}`);

/** A read-only map canvas for embedding in other views. Selecting a node calls onSelect. */
export function GraphCanvas({ graph, height = 460, mode = "area", onSelect }: { graph: Graph; height?: number; mode?: LayoutMode; onSelect?: (n: GraphNode) => void }) {
  const layout = useMemo(() => layoutMap(graph, { mode, focus: graph.focus }), [graph, mode]);
  const flow = useMemo(() => toFlow(graph, layout, { mode, selected: null, highlight: new Set(), showAll: false }), [graph, layout, mode]);
  return (
    <div style={{ height, background: "var(--bg)" }} className="card overflow-hidden">
      <ReactFlowProvider>
        <ReactFlow nodes={flow.nodes} edges={flow.edges} nodeTypes={nodeTypes} fitView fitViewOptions={FIT_OPTIONS} minZoom={0.2} maxZoom={1.8} nodesConnectable={false} nodesDraggable={false} proOptions={{ hideAttribution: true }}
          onNodeClick={(_, n) => { const g = graph.nodes.find((x) => x.id === n.id); if (g) onSelect?.(g); }}>
          <Background gap={24} color="var(--line)" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
