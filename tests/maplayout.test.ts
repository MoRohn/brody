import { describe, expect, it } from "vitest";
import { connectionsOf, graphToMermaid, layoutMap, CARD_H, CARD_W, type Graph, type GraphNode, type NodeType } from "@/lib/map";

const node = (id: string, type: NodeType, extra: Partial<GraphNode> = {}): GraphNode => ({ id, label: id, type, risk: "none", size: 5, ...extra });

/** A dense architecture like a real product: every area talks to most others. */
function hairball(): Graph {
  const types: NodeType[] = ["ui", "ui", "api", "api", "service", "service", "service", "service", "service", "job", "model", "model", "external", "external", "util", "util", "config", "test", "infra", "entry"];
  const nodes = types.map((t, i) => node(`${t}${i}`, t));
  const edges: Graph["edges"] = [];
  for (const a of nodes) for (const b of nodes) if (a.id !== b.id && (a.id.length + b.id.length + a.id.charCodeAt(0)) % 3 !== 0) edges.push({ id: `${a.id}->${b.id}`, source: a.id, target: b.id, kind: "CALLS", weight: 1 + ((a.id.charCodeAt(1) * b.id.charCodeAt(2)) % 9) });
  return { nodes, edges, truncated: false, totalNodes: nodes.length };
}

const rect = (l: ReturnType<typeof layoutMap>, id: string) => { const p = l.nodes.find((n) => n.id === id)!; return { x: p.x, y: p.y, r: p.x + CARD_W, b: p.y + CARD_H }; };
const overlap = (a: ReturnType<typeof rect>, b: ReturnType<typeof rect>) => a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b;

describe("code map layout", () => {
  it("places every node exactly once and never lets two cards overlap", () => {
    const g = hairball();
    const l = layoutMap(g, { mode: "area" });
    expect(l.nodes.map((n) => n.id).sort()).toEqual(g.nodes.map((n) => n.id).sort());
    const rects = l.nodes.map((n) => rect(l, n.id));
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(overlap(rects[i], rects[j])).toBe(false);
  });

  it("is deterministic", () => {
    const g = hairball();
    expect(layoutMap(g)).toEqual(layoutMap(g));
  });

  it("reads left to right through the layers of the system", () => {
    const l = layoutMap(hairball(), { mode: "area" });
    const x = (id: string) => l.nodes.find((n) => n.id === id)!.x;
    expect(x("ui0")).toBeLessThan(x("api2"));
    expect(x("api2")).toBeLessThan(x("service4"));
    expect(x("service4")).toBeLessThan(x("model10"));
    expect(x("model10")).toBeLessThan(x("external12"));
  });

  it("moves configuration, tests and hub helpers into a foundation band and hides their links", () => {
    const l = layoutMap(hairball(), { mode: "area" });
    const foundation = l.nodes.filter((n) => n.foundation).map((n) => n.id);
    expect(foundation).toEqual(expect.arrayContaining(["config16", "test17"]));
    const band = l.bands.find((b) => b.foundation)!;
    expect(band.y).toBeGreaterThan(l.bands.find((b) => !b.foundation)!.y);
    for (const e of l.edges.filter((e) => foundation.includes(e.source) || foundation.includes(e.target))) expect(e.tier).toBe("secondary");
    for (const id of foundation) expect(rect(l, id).y).toBeGreaterThanOrEqual(band.y);
  });

  it("draws far fewer links than exist, but keeps all of them available", () => {
    const g = hairball();
    const l = layoutMap(g, { mode: "area" });
    const drawn = l.edges.filter((e) => e.tier === "primary");
    expect(l.edges.length).toBeGreaterThan(150);
    expect(drawn.length).toBeLessThan(l.edges.length / 4);
    expect(l.hiddenCount).toBe(l.edges.length - drawn.length);
    // Nothing is left floating: every non-foundation node keeps at least one visible link.
    const touched = new Set(drawn.flatMap((e) => [e.source, e.target]));
    for (const n of l.nodes.filter((n) => !n.foundation)) expect(touched.has(n.id)).toBe(true);
    // Of two opposite links, only one direction is drawn.
    const keys = new Set(drawn.map((e) => `${e.source}>${e.target}`));
    for (const e of drawn) expect(keys.has(`${e.target}>${e.source}`)).toBe(false);
  });

  it("shows every link on a small map", () => {
    const g: Graph = { nodes: [node("a", "ui"), node("b", "api"), node("c", "service"), node("d", "model")], edges: [["a", "b"], ["b", "c"], ["c", "d"], ["a", "c"], ["a", "d"]].map(([s, t]) => ({ id: `${s}${t}`, source: s, target: t, kind: "CALLS", weight: 1 })), truncated: false, totalNodes: 4 };
    const l = layoutMap(g);
    expect(l.hiddenCount).toBe(0);
    expect(l.edges.every((e) => e.side === "forward")).toBe(true);
  });

  it("splits a crowded layer into several columns instead of one tall stack", () => {
    const nodes = Array.from({ length: 20 }, (_, i) => node(`s${i}`, "service"));
    const l = layoutMap({ nodes, edges: [], truncated: false, totalNodes: 20 }, { maxPerColumn: 6 });
    const xs = new Set(l.nodes.map((n) => n.x));
    expect(xs.size).toBe(4);
    for (const x of xs) expect(l.nodes.filter((n) => n.x === x).length).toBeLessThanOrEqual(6);
  });

  it("centres a symbol map on the selection with callers left and callees right", () => {
    const g: Graph = {
      nodes: [node("focus", "service"), node("caller", "api"), node("caller2", "ui"), node("callee", "util"), node("callee2", "model")],
      edges: [["caller", "focus"], ["caller2", "caller"], ["focus", "callee"], ["callee", "callee2"]].map(([s, t]) => ({ id: `${s}>${t}`, source: s, target: t, kind: "CALLS", weight: 1 })),
      truncated: false, totalNodes: 5, focus: "focus",
    };
    const l = layoutMap(g, { mode: "symbol", focus: g.focus });
    const x = (id: string) => l.nodes.find((n) => n.id === id)!.x;
    expect(x("caller2")).toBeLessThan(x("caller"));
    expect(x("caller")).toBeLessThan(x("focus"));
    expect(x("focus")).toBeLessThan(x("callee"));
    expect(x("callee")).toBeLessThan(x("callee2"));
    expect(l.bands.map((b) => b.label)).toEqual(["Used by (2 steps away)", "Used by", "Selected", "Depends on", "Depends on (2 steps away)"]);
    expect(l.nodes.some((n) => n.foundation)).toBe(false);
  });

  it("describes a node's connections in plain terms, strongest first", () => {
    const g: Graph = { nodes: [node("a", "api"), node("b", "service"), node("c", "model")], edges: [{ id: "1", source: "a", target: "b", kind: "CALLS", weight: 10 }, { id: "2", source: "b", target: "c", kind: "WRITES_TO", weight: 2 }, { id: "3", source: "a", target: "c", kind: "CALLS", weight: 1 }], truncated: false, totalNodes: 3 };
    const c = connectionsOf(g, "b");
    expect(c.usedBy.map((x) => [x.node.id, x.strength])).toEqual([["a", "Strong"]]);
    expect(c.dependsOn.map((x) => [x.node.id, x.strength, x.kind])).toEqual([["c", "Light", "WRITES_TO"]]);
  });

  it("exports grouped Mermaid with the same layers and only the links the app draws", () => {
    const g = hairball();
    const l = layoutMap(g);
    const mm = graphToMermaid(g, "LR", { grouped: true });
    expect(mm).toMatch(/^flowchart LR/);
    expect(mm).toContain('subgraph');
    expect(mm).toContain("Shared foundations");
    expect((mm.match(/-->/g) ?? []).length + (mm.match(/==>/g) ?? []).length).toBe(l.edges.filter((e) => e.tier === "primary").length);
    expect(mm).toContain("secondary links omitted");
  });
});
