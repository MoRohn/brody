"use client";
import "@xyflow/react/dist/style.css";
import dagre from "@dagrejs/dagre";
import { Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, ReactFlowProvider, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { useMemo } from "react";
import type { Graph, GraphNode, NodeType } from "@/lib/map";
import { glyphFor, riskGlyph, type RiskLevel } from "@/lib/map/legend";

export interface NodeData extends Record<string, unknown> { label: string; type: NodeType; risk: RiskLevel; sub?: string; highlight?: boolean; selected?: boolean }

const TYPE_SHAPE: Record<NodeType, React.CSSProperties> = {
  entry: { borderRadius: 999 },
  service: { borderRadius: 3 },
  ui: { borderRadius: 0 },
  api: { borderRadius: 3, borderLeftWidth: 5 },
  model: { borderRadius: 10, borderWidth: 2 },
  util: { borderRadius: 3, borderStyle: "dashed" },
  external: { borderRadius: 999, borderWidth: 2, borderStyle: "double" },
  test: { borderRadius: 3, borderStyle: "dotted" },
  config: { borderRadius: 3, borderStyle: "dashed", opacity: 0.85 },
  job: { borderRadius: 999, borderStyle: "dashed" },
  infra: { borderRadius: 0, borderWidth: 2 },
};
export const RISK_COLOR: Record<RiskLevel, string> = { critical: "var(--crit)", high: "var(--high)", medium: "var(--med)", low: "var(--low)", none: "var(--line)" };

function MapNode({ data }: NodeProps) {
  const d = data as NodeData;
  return (
    <div title={`${d.label}${d.sub ? ` · ${d.sub}` : ""}`} className="bg-panel px-2 py-1 text-[12px] shadow-sm" style={{ width: 190, border: `1px solid ${d.selected ? "var(--accent)" : d.highlight ? "var(--accent)" : RISK_COLOR[d.risk]}`, outline: d.selected ? "2px solid var(--accent)" : d.highlight ? "1px dashed var(--accent)" : undefined, ...TYPE_SHAPE[d.type] }}>
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div className="flex items-center gap-1.5">
        <span className="mono w-4 flex-none text-center" aria-label={d.type}>{glyphFor(d.type)}</span>
        <span className="min-w-0 flex-1 truncate font-medium">{d.label}</span>
        {d.risk !== "none" && <span className="mono flex-none font-bold" style={{ color: RISK_COLOR[d.risk] }} aria-label={`${d.risk} risk`} title={`${d.risk} risk`}>{riskGlyph(d.risk)}</span>}
      </div>
      {d.sub && <div className="truncate pl-[22px] text-[10px] text-muted">{d.sub}</div>}
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}
export const nodeTypes = { map: MapNode };

export function layout(g: Graph, selected: string | null, highlight: Set<string>): { nodes: Node<NodeData>[]; edges: Edge[] } {
  const dg = new dagre.graphlib.Graph();
  dg.setGraph({ rankdir: "LR", nodesep: 22, ranksep: 90, marginx: 10, marginy: 10 });
  dg.setDefaultEdgeLabel(() => ({}));
  for (const n of g.nodes) dg.setNode(n.id, { width: 190, height: 46 });
  for (const e of g.edges) if (dg.hasNode(e.source) && dg.hasNode(e.target)) dg.setEdge(e.source, e.target);
  dagre.layout(dg);
  const nodes: Node<NodeData>[] = g.nodes.map((n: GraphNode) => {
    const p = dg.node(n.id);
    return { id: n.id, type: "map", position: { x: (p?.x ?? 0) - 95, y: (p?.y ?? 0) - 23 }, data: { label: n.label, type: n.type, risk: n.risk, sub: n.group === "area" ? `${(n.meta as { files?: number } | undefined)?.files ?? n.size} files` : n.path && n.path !== n.label ? n.path : n.area, highlight: highlight.has(n.id), selected: selected === n.id } };
  });
  const edges: Edge[] = g.edges.filter((e) => dg.hasNode(e.source) && dg.hasNode(e.target)).map((e) => ({
    id: e.id, source: e.source, target: e.target, label: e.weight > 1 ? String(e.weight) : undefined,
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
    style: { strokeWidth: e.kind === "WRITES_TO" ? 2.4 : 1.4, strokeDasharray: e.kind === "IMPORTS" ? "6 3" : e.kind === "OPTIONAL" ? "2 4" : undefined, stroke: "var(--muted)" },
    labelStyle: { fontSize: 10, fill: "var(--muted)" }, labelBgStyle: { fill: "var(--panel)" },
    data: { kind: e.kind },
  }));
  return { nodes, edges };
}


/** A read-only graph canvas for embedding in other views. Selecting a node calls onSelect. */
export function GraphCanvas({ graph, height = 380, onSelect }: { graph: Graph; height?: number; onSelect?: (n: GraphNode) => void }) {
  const laid = useMemo(() => layout(graph, null, new Set()), [graph]);
  return (
    <div style={{ height, background: "var(--bg)" }} className="card overflow-hidden">
      <ReactFlowProvider>
        <ReactFlow nodes={laid.nodes} edges={laid.edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.1, maxZoom: 1.1 }} minZoom={0.15} maxZoom={1.8} nodesConnectable={false} nodesDraggable={false} proOptions={{ hideAttribution: true }}
          onNodeClick={(_, n) => { const g = graph.nodes.find((x) => x.id === n.id); if (g) onSelect?.(g); }}>
          <Background gap={20} color="var(--line)" />
          <Controls showInteractive={false} />
          {laid.nodes.length > 25 && <MiniMap pannable zoomable />}
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
