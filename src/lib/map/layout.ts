import type { Graph, GraphEdge, GraphNode } from "./index";
import type { NodeType, RiskLevel } from "./legend";

/**
 * One layout for every code map. It is deterministic and pure, so the app, the Mermaid export and the tests all agree.
 *
 * Instead of letting a generic graph algorithm scatter the nodes, the map reads left to right through the layers of a system:
 * who starts things, the APIs that expose them, the business logic, the data, and the outside world. Shared code that
 * nearly everything depends on (configuration, tests, common helpers) sits in its own band with its links hidden, because
 * drawing them is what turns a map into a hairball. Only each node's strongest links are drawn by default; every other link
 * is kept (`tier: "secondary"`) and appears when the node is selected.
 */

export const CARD_W = 236;
export const CARD_H = 92;
export const COLUMN_GAP = 40;
export const LANE_GAP = 84;
export const ROW_GAP = 20;
export const LANE_PAD = 18;
export const LANE_HEAD = 52;

export type LayoutMode = "area" | "module" | "symbol";
export interface LayoutOptions { mode?: LayoutMode; focus?: string; maxPerColumn?: number }

export type EdgeSide = "forward" | "back" | "same" | "down" | "up";
export interface PlacedNode { id: string; x: number; y: number; lane: string; foundation: boolean; /** Distinct neighbours that use this node. */ usedBy: number; /** Distinct neighbours this node relies on. */ uses: number }
export interface PlacedEdge { id: string; source: string; target: string; kind: string; weight: number; tier: "primary" | "secondary"; side: EdgeSide }
export interface Band { id: string; label: string; hint: string; x: number; y: number; w: number; h: number; foundation: boolean }
export interface MapLayout { nodes: PlacedNode[]; edges: PlacedEdge[]; bands: Band[]; width: number; height: number; hiddenCount: number }

interface LaneDef { id: string; label: string; hint: string; types: NodeType[] }
const LANES: LaneDef[] = [
  { id: "interface", label: "Users & entry points", hint: "Screens, pages and where the application starts", types: ["entry", "ui"] },
  { id: "api", label: "Interfaces & APIs", hint: "How screens and other systems ask the application to do things", types: ["api"] },
  { id: "logic", label: "Business logic", hint: "Rules, workflows and background work", types: ["service", "job", "util"] },
  { id: "data", label: "Data", hint: "Models and where information is stored", types: ["model"] },
  { id: "external", label: "External & platform", hint: "Third-party services and infrastructure", types: ["external", "infra"] },
];
const FOUNDATION = { id: "foundation", label: "Shared foundations", hint: "Configuration, tests and helpers used across the system. Their links are hidden until you select one." };

const RISK_RANK: Record<RiskLevel, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
const KIND_PRIORITY: Record<string, number> = { WRITES_TO: 5, READS_FROM: 4, CALLS: 3, INSTANTIATES: 3, EXTENDS: 3, IMPLEMENTS: 3, USES: 2, IMPORTS: 1, OPTIONAL: 0 };
const laneOfType = (t: NodeType) => LANES.find((l) => l.types.includes(t)) ?? LANES[2];

/** How many links a node keeps in the default view. Small maps show everything. */
function linkBudget(n: number): number {
  if (n <= 8) return Infinity;
  if (n <= 14) return 4;
  if (n <= 24) return 3;
  return 2;
}

/** Collapse duplicate node pairs into one edge (strongest kind wins, weights add up). */
function mergeEdges(edges: GraphEdge[], ids: Set<string>): GraphEdge[] {
  const byPair = new Map<string, GraphEdge>();
  for (const e of edges) {
    if (e.source === e.target || !ids.has(e.source) || !ids.has(e.target)) continue;
    const key = `${e.source}\u0000${e.target}`;
    const cur = byPair.get(key);
    if (!cur) byPair.set(key, { ...e });
    else {
      cur.weight += e.weight;
      if ((KIND_PRIORITY[e.kind] ?? 0) > (KIND_PRIORITY[cur.kind] ?? 0)) cur.kind = e.kind;
    }
  }
  return [...byPair.values()];
}

const byRiskSizeLabel = (a: GraphNode, b: GraphNode) => RISK_RANK[b.risk] - RISK_RANK[a.risk] || b.size - a.size || a.label.localeCompare(b.label);

export function layoutMap(graph: Graph, opts: LayoutOptions = {}): MapLayout {
  const mode = opts.mode ?? "area";
  const maxPerColumn = opts.maxPerColumn ?? (mode === "module" ? 8 : 7);
  const ids = new Set(graph.nodes.map((n) => n.id));
  const edges = mergeEdges(graph.edges, ids);

  const usedBy = new Map<string, Set<string>>();
  const uses = new Map<string, Set<string>>();
  for (const e of edges) {
    (usedBy.get(e.target) ?? usedBy.set(e.target, new Set()).get(e.target)!).add(e.source);
    (uses.get(e.source) ?? uses.set(e.source, new Set()).get(e.source)!).add(e.target);
  }

  const symbolMode = mode === "symbol" && !!opts.focus && ids.has(opts.focus);
  const n = graph.nodes.length;
  const hubThreshold = Math.max(3, Math.ceil(0.3 * (n - 1)));
  const foundation = new Set<string>();
  if (!symbolMode && n >= 6) {
    for (const node of graph.nodes) {
      if (node.type === "test" || node.type === "config" || (node.type === "util" && (usedBy.get(node.id)?.size ?? 0) >= hubThreshold)) foundation.add(node.id);
    }
  }
  // A map made only of foundations has nothing to separate them from.
  if (foundation.size === n) foundation.clear();

  // ---- lanes and columns ---------------------------------------------------
  interface Col { lane: string; label: string; hint: string; nodes: string[] }
  const cols: Col[] = [];
  const colOf = new Map<string, number>();

  if (symbolMode) {
    const step = new Map<string, number>([[opts.focus!, 0]]);
    const adj = new Map<string, { other: string; dir: 1 | -1 }[]>();
    for (const e of edges) {
      (adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push({ other: e.target, dir: 1 });
      (adj.get(e.target) ?? adj.set(e.target, []).get(e.target)!).push({ other: e.source, dir: -1 });
    }
    let frontier = [opts.focus!];
    while (frontier.length) {
      const next: string[] = [];
      for (const id of frontier) for (const { other, dir } of adj.get(id) ?? []) {
        if (step.has(other)) continue;
        step.set(other, step.get(id)! + dir);
        next.push(other);
      }
      frontier = next;
    }
    const distinct = [...new Set([...step.values()])].sort((a, b) => a - b);
    const labelFor = (s: number): [string, string] => s === 0 ? ["Selected", "The code you are looking at"]
      : s < 0 ? [s === -1 ? "Used by" : `Used by (${-s} steps away)`, "Code that calls or depends on the selection"]
        : [s === 1 ? "Depends on" : `Depends on (${s} steps away)`, "Code the selection calls or relies on"];
    for (const s of distinct) {
      const [label, hint] = labelFor(s);
      cols.push({ lane: `step${s}`, label, hint, nodes: graph.nodes.filter((x) => step.get(x.id) === s).sort(byRiskSizeLabel).map((x) => x.id) });
    }
    cols.forEach((c, i) => c.nodes.forEach((id) => colOf.set(id, i)));
    // Anything the walk could not reach still needs a home.
    const stray = graph.nodes.filter((x) => !colOf.has(x.id));
    if (stray.length) { cols.push({ lane: "other", label: "Related", hint: "", nodes: stray.map((x) => x.id) }); stray.forEach((x) => colOf.set(x.id, cols.length - 1)); }
  } else {
    const placed = graph.nodes.filter((x) => !foundation.has(x.id));
    const laneNodes = new Map<string, GraphNode[]>();
    for (const node of placed) { const l = laneOfType(node.type); (laneNodes.get(l.id) ?? laneNodes.set(l.id, []).get(l.id)!).push(node); }
    for (const lane of LANES) {
      const members = (laneNodes.get(lane.id) ?? []).sort(byRiskSizeLabel);
      if (!members.length) continue;
      // Inside one lane, dependents sit to the left of what they depend on.
      const sub = new Map<string, number>(members.map((m) => [m.id, 0]));
      for (let pass = 0; pass < 3; pass++) for (const e of edges) {
        if (sub.has(e.source) && sub.has(e.target)) sub.set(e.target, Math.min(1, Math.max(sub.get(e.target)!, sub.get(e.source)! + 1)));
      }
      const tiers = [...new Set(sub.values())].sort((a, b) => a - b);
      for (const t of tiers) {
        const inTier = members.filter((m) => sub.get(m.id) === t).map((m) => m.id);
        const chunks = Math.ceil(inTier.length / maxPerColumn);
        const per = Math.ceil(inTier.length / chunks);
        for (let c = 0; c < chunks; c++) cols.push({ lane: lane.id, label: lane.label, hint: lane.hint, nodes: inTier.slice(c * per, (c + 1) * per) });
      }
    }
    cols.forEach((c, i) => c.nodes.forEach((id) => colOf.set(id, i)));
  }

  // ---- which links are drawn ----------------------------------------------
  const budget = symbolMode ? Infinity : linkBudget(n);
  const laneIndex = (id: string) => colOf.get(id) ?? -1;
  const primary = new Set<string>();
  const key = (e: GraphEdge) => `${e.source}\u0000${e.target}`;
  const candidates = edges.filter((e) => !foundation.has(e.source) && !foundation.has(e.target));
  const weightOf = new Map(edges.map((e) => [key(e), e.weight]));
  // Of two opposite links between the same pair, the weaker one is background detail.
  const dominant = candidates.filter((e) => {
    const back = weightOf.get(`${e.target}\u0000${e.source}`);
    if (back === undefined) return true;
    if (e.weight !== back) return e.weight > back;
    return laneIndex(e.source) < laneIndex(e.target) || (laneIndex(e.source) === laneIndex(e.target) && e.source < e.target);
  });
  // Long links that cross several layers are the ones that end up running behind other cards, so they rank lower than short ones.
  const score = (e: GraphEdge) => e.weight / (1 + 0.35 * Math.max(0, Math.abs(laneIndex(e.target) - laneIndex(e.source)) - 1));
  const rank = (list: GraphEdge[], by: "source" | "target") => {
    const groups = new Map<string, GraphEdge[]>();
    for (const e of list) (groups.get(e[by]) ?? groups.set(e[by], []).get(e[by])!).push(e);
    const ok = new Map<string, number>();
    for (const g of groups.values()) g.sort((a, b) => score(b) - score(a) || key(a).localeCompare(key(b))).forEach((e, i) => ok.set(key(e), i));
    return ok;
  };
  const outRank = rank(dominant, "source");
  const inRank = rank(dominant, "target");
  for (const e of dominant) if ((outRank.get(key(e)) ?? 0) < budget && (inRank.get(key(e)) ?? 0) < budget + 2) primary.add(key(e));
  // No node should be left floating with its links all hidden.
  const touched = new Set<string>();
  for (const e of dominant) if (primary.has(key(e))) { touched.add(e.source); touched.add(e.target); }
  for (const node of graph.nodes) {
    if (touched.has(node.id) || foundation.has(node.id)) continue;
    const best = dominant.filter((e) => e.source === node.id || e.target === node.id).sort((a, b) => score(b) - score(a))[0];
    if (best) { primary.add(key(best)); touched.add(best.source); touched.add(best.target); }
  }

  // ---- order nodes inside columns to keep links short ----------------------
  const nbr = new Map<string, string[]>();
  for (const e of edges) if (primary.has(key(e))) {
    (nbr.get(e.source) ?? nbr.set(e.source, []).get(e.source)!).push(e.target);
    (nbr.get(e.target) ?? nbr.set(e.target, []).get(e.target)!).push(e.source);
  }
  const pos = new Map<string, number>();
  const setPos = (c: Col) => c.nodes.forEach((id, i) => pos.set(id, i - (c.nodes.length - 1) / 2));
  cols.forEach(setPos);
  const settle = (c: Col) => {
    const score = new Map<string, number>();
    for (const id of c.nodes) {
      const others = (nbr.get(id) ?? []).filter((o) => colOf.get(o) !== colOf.get(id));
      score.set(id, others.length ? others.reduce((s, o) => s + (pos.get(o) ?? 0), 0) / others.length : pos.get(id)!);
    }
    c.nodes = c.nodes.map((id, i) => ({ id, i })).sort((a, b) => score.get(a.id)! - score.get(b.id)! || a.i - b.i).map((x) => x.id);
    setPos(c);
  };
  for (let it = 0; it < 4; it++) { for (const c of cols) settle(c); for (const c of [...cols].reverse()) settle(c); }

  // ---- coordinates ----------------------------------------------------------
  const tallest = Math.max(0, ...cols.map((c) => c.nodes.length));
  const colHeight = (k: number) => (k ? k * CARD_H + (k - 1) * ROW_GAP : 0);
  const bodyH = colHeight(tallest);
  const bands: Band[] = [];
  const placed = new Map<string, PlacedNode>();
  const stat = (id: string) => ({ usedBy: usedBy.get(id)?.size ?? 0, uses: uses.get(id)?.size ?? 0 });
  let x = 0;
  const groups: { lane: string; cols: Col[] }[] = [];
  for (const c of cols) { const last = groups[groups.length - 1]; if (last && last.lane === c.lane) last.cols.push(c); else groups.push({ lane: c.lane, cols: [c] }); }
  const bandH = LANE_HEAD + bodyH + LANE_PAD;
  for (const g of groups) {
    const w = g.cols.length * CARD_W + (g.cols.length - 1) * COLUMN_GAP + 2 * LANE_PAD;
    bands.push({ id: g.lane, label: g.cols[0].label, hint: g.cols[0].hint, x, y: 0, w, h: bandH, foundation: false });
    g.cols.forEach((c, ci) => {
      const cx = x + LANE_PAD + ci * (CARD_W + COLUMN_GAP);
      const top = LANE_HEAD + (bodyH - colHeight(c.nodes.length)) / 2;
      c.nodes.forEach((id, i) => placed.set(id, { id, x: cx, y: top + i * (CARD_H + ROW_GAP), lane: g.lane, foundation: false, ...stat(id) }));
    });
    x += w + LANE_GAP;
  }
  let width = Math.max(0, x - LANE_GAP);
  let height = groups.length ? bandH : 0;

  if (foundation.size) {
    const list = graph.nodes.filter((nd) => foundation.has(nd.id)).sort(byRiskSizeLabel);
    const minW = 3 * CARD_W + 2 * ROW_GAP + 2 * LANE_PAD;
    const bw = Math.max(width, minW);
    const perRow = Math.max(1, Math.floor((bw - 2 * LANE_PAD + ROW_GAP) / (CARD_W + ROW_GAP)));
    const rows = Math.ceil(list.length / perRow);
    const top = groups.length ? bandH + 56 : 0;
    const h = LANE_HEAD + rows * CARD_H + (rows - 1) * ROW_GAP + LANE_PAD;
    bands.push({ id: FOUNDATION.id, label: FOUNDATION.label, hint: FOUNDATION.hint, x: 0, y: top, w: bw, h, foundation: true });
    list.forEach((nd, i) => placed.set(nd.id, { id: nd.id, x: LANE_PAD + (i % perRow) * (CARD_W + ROW_GAP), y: top + LANE_HEAD + Math.floor(i / perRow) * (CARD_H + ROW_GAP), lane: FOUNDATION.id, foundation: true, ...stat(nd.id) }));
    width = bw;
    height = top + h;
  }

  const out: PlacedEdge[] = edges.map((e) => {
    const s = placed.get(e.source)!;
    const t = placed.get(e.target)!;
    const cs = colOf.get(e.source);
    const ct = colOf.get(e.target);
    const side: EdgeSide = s.foundation && t.foundation ? "same" : t.foundation ? "down" : s.foundation ? "up" : cs! < ct! ? "forward" : cs! > ct! ? "back" : "same";
    return { id: e.id, source: e.source, target: e.target, kind: e.kind, weight: e.weight, tier: primary.has(key(e)) ? "primary" : "secondary", side };
  });
  return { nodes: graph.nodes.map((nd) => placed.get(nd.id)!), edges: out, bands, width, height, hiddenCount: out.filter((e) => e.tier === "secondary").length };
}

// ---------------------------------------------------------------------------
// Plain-language descriptions of a node's connections, shared by the side panel and exports.
// ---------------------------------------------------------------------------
export interface Connection { node: GraphNode; weight: number; kind: string; strength: "Strong" | "Moderate" | "Light" }
export interface Connections { dependsOn: Connection[]; usedBy: Connection[] }

export function connectionsOf(graph: Graph, id: string): Connections {
  const nodeById = new Map(graph.nodes.map((nd) => [nd.id, nd]));
  const merged = mergeEdges(graph.edges, new Set(nodeById.keys()));
  const max = Math.max(1, ...merged.map((e) => e.weight));
  const strength = (w: number): Connection["strength"] => (w / max >= 0.6 ? "Strong" : w / max >= 0.25 ? "Moderate" : "Light");
  const mk = (other: string, e: GraphEdge): Connection => ({ node: nodeById.get(other)!, weight: e.weight, kind: e.kind, strength: strength(e.weight) });
  const order = (a: Connection, b: Connection) => b.weight - a.weight || a.node.label.localeCompare(b.node.label);
  return {
    dependsOn: merged.filter((e) => e.source === id).map((e) => mk(e.target, e)).sort(order),
    usedBy: merged.filter((e) => e.target === id).map((e) => mk(e.source, e)).sort(order),
  };
}

/** Counts of the layers present in a layout, for the summary shown above the map. */
export function laneSummary(layout: MapLayout): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const b of layout.bands) counts.set(b.label, layout.nodes.filter((nd) => nd.lane === b.id).length);
  return [...counts.entries()].map(([label, count]) => ({ label, count }));
}
