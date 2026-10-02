/**
 * The visual scene planner: spec + narration + MEASURED beats → VisualScenePlan.
 *
 * This is the deterministic boundary between reasoning and rendering. No model draws anything: the planner lays every
 * object out on the 1280 x 720 grid (text pre-wrapped with the renderers' own fonts), and turns each timed beat into
 * animation primitives in scene-local milliseconds. Renderers only draw what this produces, so the Manim renderer, the
 * server-side SVG renderer and the live player in the browser all show the same thing at the same moment.
 *
 * Scenes are one per narration section and frame aligned, so any scene can be rendered, repaired or replaced alone.
 * Diagram scenes share one diagram geometry for the whole video, so the picture stays put while the story moves.
 */
import { sha256 } from "../util/ids";
import { CANVAS, CONTENT, GRID, LINE_HEIGHT, MOTION, SHAPE, TYPE } from "./design";
import { textWidth, wrapText } from "./measure";
import type { Box, Concept, ExplanationArtifactSpec, NarrationPlan, NarrationSection, NarrativeBeat, ObjectState, RendererId, SceneSpec, SectionAudio, SourceOverlay, TimedAction, VisualLayout, VisualObject, VisualScenePlan, VisualStyle } from "./types";

export const SCENE_PLANNER_VERSION = 4;
const lh = (size: number) => Math.round(size * LINE_HEIGHT);
/** On-screen text never shows Markdown: backticks, emphasis markers and link syntax are removed. */
export const plain = (t: string) => t.replace(/`([^`]*)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|[.,;:!?]|$)/g, "$1$2").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim();
/** A sentence cut to a headline: at most `max` words, at a clause boundary when there is one. */
export function headline(sentence: string, max = 12): string {
  const words = plain(sentence).split(" ");
  if (words.length <= max) return words.join(" ");
  for (let i = max; i >= 5; i--) if (/[,;:–—]$/.test(words[i - 1])) return words.slice(0, i).join(" ").replace(/[,;:–—]$/, "");
  return `${words.slice(0, max).join(" ")}…`;
}
const DIAGRAM_LAYOUTS = new Set<VisualLayout>(["architecture", "contention"]);

// ---------------------------------------------------------------------------------------------------------------------
// Diagram geometry, shared by every diagram scene
// ---------------------------------------------------------------------------------------------------------------------
interface Part { conceptId: string; primary: string; reveal: string[]; cells: string[]; box: Box }
interface Conn { id: string; relId: string; from: string; to: string; objs: string[] }
/** A consumer drawn as N instances using a resource drawn as N instances (8 pods on 8 GPUs): shown on the resource cells. */
interface Pair { relId: string; consumer: string; resource: string; n: number }
export interface Diagram { objects: VisualObject[]; parts: Map<string, Part>; connectors: Conn[]; pairs: Pair[]; dropped: string[] }

interface Sized { concept: Concept; w: number; h: number; place: (x: number, y: number) => VisualObject[] }

function nodeFor(k: Concept, nested: boolean): Sized {
  const n = k.count && k.count > 1 ? k.count : 0;
  if (n && nested) {
    // Cells drawn straight into the parent group, under a small caption.
    const cols = n <= 4 ? n : Math.ceil(n / 2);
    const rows = Math.ceil(n / cols);
    const cw = 92, ch = 70, gap = SHAPE.cellGap;
    const caption = wrapText(plain(`${k.name} × ${n}`), cols * cw + (cols - 1) * gap, TYPE.nodeSub, { maxLines: 1 }).lines;
    const w = cols * cw + (cols - 1) * gap;
    const h = lh(TYPE.nodeSub) + 8 + rows * ch + (rows - 1) * gap;
    const short = shortName(k.name);
    return { concept: k, w, h, place: (x, y) => {
      const objs: VisualObject[] = [{ id: `k:${k.id}`, kind: "node", plain: true, box: { x, y, w, h }, lines: caption, fontSize: TYPE.nodeSub, refs: [k.id], z: 3, tone: "secondary", initial: { visible: false } }];
      for (let i = 0; i < n; i++) {
        const cx = x + (i % cols) * (cw + gap), cy = y + lh(TYPE.nodeSub) + 8 + Math.floor(i / cols) * (ch + gap);
        objs.push({ id: `k:${k.id}#${i}`, kind: "cell", box: { x: cx, y: cy, w: cw, h: ch }, lines: wrapText(`${short} ${k.glyph === "gpu" ? i : i + 1}`, cw - 16, 16, { maxLines: 1 }).lines, sub: [], fontSize: 16, refs: [k.id], parent: `k:${k.id}`, z: 4, initial: { visible: false, state: "idle" } });
      }
      return objs;
    } };
  }
  const labelW = 196;
  const label = wrapText(plain(n ? `${k.name} × ${n}` : k.name), labelW, TYPE.node, { maxLines: 2 }).lines;
  const textW = Math.max(...label.map((l) => textWidth(l, TYPE.node)));
  const cols = n ? Math.min(n, 8) : 0, rows = n ? Math.ceil(n / cols) : 0;
  const cell = 34, gap = SHAPE.cellGap;
  const cellsW = cols ? cols * cell + (cols - 1) * gap : 0;
  const w = Math.round(Math.max(150, textW + 2 * SHAPE.padX + 34, cellsW + 2 * SHAPE.padX));
  const labelH = label.length * lh(TYPE.node);
  const h = Math.round(Math.max(64, 2 * SHAPE.padY + labelH + (rows ? 10 + rows * cell + (rows - 1) * gap : 0)));
  return { concept: k, w, h, place: (x, y) => {
    const objs: VisualObject[] = [{ id: `k:${k.id}`, kind: "node", box: { x, y, w, h }, lines: label, fontSize: TYPE.node, glyph: k.glyph, refs: [k.id], z: 2, initial: { visible: false, state: "idle" } }];
    for (let i = 0; i < n; i++) {
      const cx = x + SHAPE.padX + (i % cols) * (cell + gap), cy = y + SHAPE.padY + labelH + 10 + Math.floor(i / cols) * (cell + gap);
      objs.push({ id: `k:${k.id}#${i}`, kind: "cell", box: { x: cx, y: cy, w: cell, h: cell }, lines: [String(i + 1)], fontSize: 16, refs: [k.id], parent: `k:${k.id}`, z: 3, initial: { visible: false, state: "idle" } });
    }
    return objs;
  } };
}

/** A short noun for one instance: an acronym if the name has one (GPU), else its last word (pod, job). */
export const shortName = (name: string) => { const w = name.split(/\s+/).filter(Boolean); const acr = w.find((x) => /^[A-Z][A-Z0-9]+s?$/.test(x)); const last = w[w.length - 1] ?? "item"; return (acr ?? (last.length <= 9 ? last : w[0].slice(0, 9))).replace(/s$/, ""); };
/** The first candidate that fits `width` at 16 px, else the last (shortest) one. */
const fitLabel = (candidates: string[], width: number) => candidates.find((c) => textWidth(c, 16) <= width) ?? candidates[candidates.length - 1];

function groupFor(k: Concept, children: Concept[]): Sized {
  const kids = children.map((c) => nodeFor(c, true));
  const pad = 20;
  const title = wrapText(plain(k.name), 360, 20, { bold: true, maxLines: 1 }).lines;
  const titleH = lh(20) + 10;
  const w = Math.round(Math.max(kids.reduce((a, c) => a + c.w, 0) + (kids.length - 1) * 24 + 2 * pad, textWidth(title[0] ?? "", 20, { bold: true }) + 2 * pad + 34));
  const h = Math.round(pad + titleH + Math.max(0, ...kids.map((c) => c.h)) + pad);
  return { concept: k, w, h, place: (x, y) => {
    const objs: VisualObject[] = [{ id: `k:${k.id}`, kind: "group", box: { x, y, w, h }, lines: title, fontSize: 20, bold: true, glyph: k.glyph, refs: [k.id], z: 1, initial: { visible: false, state: "idle" } }];
    let cx = x + pad;
    for (const c of kids) { objs.push(...c.place(cx, y + pad + titleH).map((o) => ({ ...o, parent: o.parent ?? `k:${k.id}` }))); cx += c.w + 24; }
    return objs;
  } };
}

/** Clip the segment between two box centres to the boxes' edges. */
function edgePoints(a: Box, b: Box, buffer = 6): { x: number; y: number }[] {
  const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const clip = (box: Box, from: { x: number; y: number }, to: { x: number; y: number }) => {
    const dx = to.x - from.x, dy = to.y - from.y;
    const tx = dx ? (box.w / 2 + buffer) / Math.abs(dx) : Infinity, ty = dy ? (box.h / 2 + buffer) / Math.abs(dy) : Infinity;
    const t = Math.min(tx, ty, 0.49);
    return { x: Math.round(from.x + dx * t), y: Math.round(from.y + dy * t) };
  };
  return [clip(a, ca, cb), clip(b, cb, ca)];
}

/** Rank top-level items left to right by the longest path of relationships into them. */
function ranks(ids: string[], edges: [string, string][]): Map<string, number> {
  const out = new Map<string, number>();
  const incoming = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const [a, b] of edges) if (a !== b && incoming.has(b) && incoming.has(a)) incoming.get(b)!.push(a);
  const visiting = new Set<string>();
  const rank = (id: string): number => {
    if (out.has(id)) return out.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const r = Math.max(-1, ...incoming.get(id)!.map(rank)) + 1;
    visiting.delete(id);
    out.set(id, r);
    return r;
  };
  ids.forEach(rank);
  return out;
}

export function buildDiagram(spec: ExplanationArtifactSpec, wanted: string[], priority: string[]): Diagram {
  const byId = new Map(spec.concepts.map((k) => [k.id, k]));
  const dropped: string[] = [];
  let include = new Set(wanted.filter((id) => byId.has(id)));
  // A drawn child needs its parent drawn too.
  for (const id of [...include]) { const p = byId.get(id)!.parentId; if (p && byId.has(p)) include.add(p); }
  for (let attempt = 0; attempt < 12; attempt++) {
    const top = spec.concepts.filter((k) => include.has(k.id) && !(k.parentId && include.has(k.parentId)));
    const sized = new Map(top.map((k) => {
      const kids = spec.concepts.filter((c) => c.parentId === k.id && include.has(c.id));
      return [k.id, kids.length ? groupFor(k, kids) : nodeFor(k, false)] as const;
    }));
    const topOf = (id: string): string => { const k = byId.get(id); return k?.parentId && include.has(k.parentId) ? topOf(k.parentId) : id; };
    const edges = spec.relationships.filter((r) => include.has(r.from) && include.has(r.to) && r.kind !== "contains").map((r) => [topOf(r.from), topOf(r.to)] as [string, string]);
    const rk = ranks(top.map((k) => k.id), edges);
    const order = (id: string) => { const i = priority.indexOf(id); return i < 0 ? 999 : i; };
    const columns: string[][] = [];
    for (const k of [...top].sort((a, b) => order(a.id) - order(b.id))) { const r = rk.get(k.id) ?? 0; (columns[r] ??= []).push(k.id); }
    const cols = columns.filter((c) => c && c.length);
    for (const gapX of [84, 56, 36]) {
      const colW = cols.map((c) => Math.max(...c.map((id) => sized.get(id)!.w)));
      const colH = cols.map((c) => c.reduce((a, id) => a + sized.get(id)!.h, 0) + (c.length - 1) * 28);
      const W = colW.reduce((a, b) => a + b, 0) + (cols.length - 1) * gapX;
      const H = Math.max(...colH);
      if (W <= CONTENT.w && H <= CONTENT.h) {
        const objects: VisualObject[] = [];
        let x = CONTENT.x + (CONTENT.w - W) / 2;
        cols.forEach((c, ci) => {
          let y = CONTENT.y + (CONTENT.h - colH[ci]) / 2;
          for (const id of c) { const s = sized.get(id)!; objects.push(...s.place(Math.round(x + (colW[ci] - s.w) / 2), Math.round(y))); y += s.h + 28; }
          x += colW[ci] + gapX;
        });
        return finishDiagram(spec, objects, include, dropped);
      }
      // Too wide for columns: try rows (ranks top to bottom) at this gap.
      const rowH = cols.map((c) => Math.max(...c.map((id) => sized.get(id)!.h)));
      const rowW = cols.map((c) => c.reduce((a, id) => a + sized.get(id)!.w, 0) + (c.length - 1) * 32);
      const TH = rowH.reduce((a, b) => a + b, 0) + (cols.length - 1) * Math.round(gapX * 0.6);
      if (Math.max(...rowW) <= CONTENT.w && TH <= CONTENT.h) {
        const objects: VisualObject[] = [];
        let y = CONTENT.y + (CONTENT.h - TH) / 2;
        cols.forEach((c, ci) => {
          let x = CONTENT.x + (CONTENT.w - rowW[ci]) / 2;
          for (const id of c) { const s = sized.get(id)!; objects.push(...s.place(Math.round(x), Math.round(y + (rowH[ci] - s.h) / 2))); x += s.w + 32; }
          y += rowH[ci] + Math.round(gapX * 0.6);
        });
        return finishDiagram(spec, objects, include, dropped);
      }
    }
    // Still does not fit: drop the least important concept and try again.
    const victim = [...include].filter((id) => !spec.concepts.some((c) => c.parentId === id && include.has(c.id))).sort((a, b) => order(b) - order(a))[0];
    if (!victim) break;
    dropped.push(byId.get(victim)!.name);
    include = new Set([...include].filter((id) => id !== victim));
  }
  return { objects: [], parts: new Map(), connectors: [], pairs: [], dropped };
}

function finishDiagram(spec: ExplanationArtifactSpec, objects: VisualObject[], include: Set<string>, dropped: string[]): Diagram {
  const parts = new Map<string, Part>();
  for (const k of spec.concepts) {
    const prim = objects.find((o) => o.id === `k:${k.id}`);
    if (!prim) continue;
    const cells = objects.filter((o) => o.id.startsWith(`k:${k.id}#`)).map((o) => o.id);
    parts.set(k.id, { conceptId: k.id, primary: prim.id, reveal: [prim.id, ...cells], cells, box: prim.box });
  }
  const connectors: Conn[] = [];
  const pairs: Pair[] = [];
  // Obstacles for routing: every top-level box (groups and free nodes).
  const tops = objects.filter((o) => (o.kind === "group" || o.kind === "node") && !o.parent);
  const topOf = (cid: string): VisualObject | undefined => { let o = objects.find((x) => x.id === `k:${cid}`); while (o?.parent) o = objects.find((x) => x.id === o!.parent); return o; };
  const drawnRel = spec.relationships.filter((r) => include.has(r.from) && include.has(r.to) && r.kind !== "contains" && parts.has(r.from) && parts.has(r.to));
  for (const r of drawnRel) {
    const a = parts.get(r.from)!, b = parts.get(r.to)!;
    // A child is never joined to its own container: containment is already drawn.
    if (spec.concepts.find((k) => k.id === r.from)?.parentId === r.to || spec.concepts.find((k) => k.id === r.to)?.parentId === r.from) continue;
    if (connectors.some((c) => (c.from === r.from && c.to === r.to) || (c.from === r.to && c.to === r.from))) continue;
    if (a.cells.length && b.cells.length) pairs.push({ relId: r.id, consumer: r.from, resource: r.to, n: Math.min(a.cells.length, b.cells.length) });
    const ta = topOf(r.from), tb = topOf(r.to);
    const obstacles = tops.filter((o) => o !== ta && o !== tb).map((o) => o.box);
    // A nested concept is reached at its container's edge, so the line is never hidden under the container's fill.
    const pts = route(ta?.box ?? a.box, tb?.box ?? b.box, obstacles);
    const id = `c:${r.id}`;
    objects.push({ id, kind: "connector", box: { x: 0, y: 0, w: 0, h: 0 }, points: pts, lines: [], fontSize: 0, refs: [r.id], z: 0, dashed: r.kind === "blocks" || r.kind === "contends_with", initial: { visible: false } });
    const objs = [id];
    const label = plain(r.label).length <= 24 ? plain(r.label) : "";
    const lw = label ? textWidth(label, 16) : 0;
    // The label sits on the longest segment and knocks a gap in the line, like a drafted figure.
    let best = 0, bestLen = 0;
    for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); if (l > bestLen) { bestLen = l; best = i; } }
    if (label && bestLen > lw + 40) {
      const mx = (pts[best - 1].x + pts[best].x) / 2, my = (pts[best - 1].y + pts[best].y) / 2;
      const chip: Box = { x: Math.round(mx - lw / 2 - 8), y: Math.round(my - 13), w: Math.round(lw + 16), h: 26 };
      if (!tops.some((o) => overlaps(o.box, chip))) {
        objects.push({ id: `l:${r.id}`, kind: "chip", box: chip, lines: [label], fontSize: 16, refs: [r.id], z: 5, tone: "secondary", initial: { visible: false } });
        objs.push(`l:${r.id}`);
      }
    }
    connectors.push({ id, relId: r.id, from: r.from, to: r.to, objs });
  }
  return { objects, parts, connectors, pairs, dropped };
}

export const overlaps = (a: Box, b: Box, pad = 0) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

function segmentHits(p: { x: number; y: number }, q: { x: number; y: number }, box: Box): boolean {
  const steps = Math.max(2, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / 4));
  for (let i = 1; i < steps; i++) {
    const x = p.x + ((q.x - p.x) * i) / steps, y = p.y + ((q.y - p.y) * i) / steps;
    if (x > box.x - 4 && x < box.x + box.w + 4 && y > box.y - 4 && y < box.y + box.h + 4) return true;
  }
  return false;
}

/** A straight connector when nothing is in the way; otherwise an elbow around the boxes, above or below. */
export function route(a: Box, b: Box, obstacles: Box[]): { x: number; y: number }[] {
  const straight = edgePoints(a, b);
  const blocked = (pts: { x: number; y: number }[]) => pts.slice(1).some((q, i) => obstacles.some((o) => segmentHits(pts[i], q, o)));
  if (!blocked(straight)) return straight;
  const ax = Math.round(a.x + a.w / 2), bx = Math.round(b.x + b.w / 2);
  const span = obstacles.filter((o) => o.x < Math.max(ax, bx) && o.x + o.w > Math.min(ax, bx));
  const top = Math.min(a.y, b.y, ...span.map((o) => o.y)) - 26;
  const bottom = Math.max(a.y + a.h, b.y + b.h, ...span.map((o) => o.y + o.h)) + 26;
  const above = [{ x: ax, y: a.y - 6 }, { x: ax, y: top }, { x: bx, y: top }, { x: bx, y: b.y - 6 }];
  const below = [{ x: ax, y: a.y + a.h + 6 }, { x: ax, y: bottom }, { x: bx, y: bottom }, { x: bx, y: b.y + b.h + 6 }];
  const fits = (y: number) => y >= GRID.contentTop - 18 && y <= GRID.contentBottom + 6;
  const options = [above, below].filter((pts) => fits(pts[1].y) && !blocked(pts));
  if (!options.length) return straight;
  const len = (pts: { x: number; y: number }[]) => pts.slice(1).reduce((n, q, i) => n + Math.abs(q.x - pts[i].x) + Math.abs(q.y - pts[i].y), 0);
  return options.sort((p, q) => len(p) - len(q))[0];
}

// ---------------------------------------------------------------------------------------------------------------------
// Scene construction
// ---------------------------------------------------------------------------------------------------------------------
class SceneBuilder {
  objects: VisualObject[] = [];
  actions: TimedAction[] = [];
  visible = new Set<string>();
  highlighted = new Set<string>();
  /** The latest state and secondary label of each object, so later beats build on earlier ones. */
  states = new Map<string, ObjectState>();
  subs = new Map<string, string>();
  values = new Map<string, number>();
  private n = 0;
  constructor(readonly durationMs: number) {}
  add(o: VisualObject) {
    if (this.objects.some((x) => x.id === o.id)) return o;
    this.objects.push(o);
    if (o.initial.visible) this.visible.add(o.id);
    if (o.initial.state) this.states.set(o.id, o.initial.state);
    if (o.sub?.length && o.kind === "cell") this.subs.set(o.id, o.sub[0]);
    if (o.value !== undefined) this.values.set(o.id, o.value);
    return o;
  }
  obj(id: string) { return this.objects.find((o) => o.id === id); }
  act(a: Omit<TimedAction, "id">) {
    const start = Math.max(0, Math.min(a.startMs, this.durationMs - 1));
    const dur = Math.max(1, Math.min(a.durationMs, this.durationMs - start));
    this.actions.push({ id: `a${++this.n}`, ...a, startMs: Math.round(start), durationMs: Math.round(dur) });
  }
  appear(ids: string[], at: number, beatId: string, beatMs: number) {
    let k = 0;
    for (const id of ids) {
      if (this.visible.has(id) || !this.obj(id)) continue;
      this.act({ beatId, kind: "appear", target: id, startMs: at + Math.min(k * 90, beatMs * 0.3), durationMs: clampMotion(MOTION.appear, beatMs) });
      this.visible.add(id);
      k++;
    }
  }
  draw(ids: string[], at: number, beatId: string, beatMs: number) {
    for (const id of ids) {
      if (this.visible.has(id)) continue;
      const o = this.obj(id);
      if (!o) continue;
      this.act({ beatId, kind: o.kind === "connector" ? "draw" : "appear", target: id, startMs: at, durationMs: clampMotion(o.kind === "connector" ? MOTION.draw : MOTION.appear, beatMs) });
      this.visible.add(id);
    }
  }
  hide(ids: string[], at: number, beatId: string, beatMs: number) {
    for (const id of ids) if (this.visible.has(id)) { this.act({ beatId, kind: "disappear", target: id, startMs: at, durationMs: clampMotion(MOTION.disappear, beatMs) }); this.visible.delete(id); }
  }
  highlight(ids: string[], at: number, beatId: string, beatMs: number) {
    for (const id of [...this.highlighted]) if (!ids.includes(id)) { this.act({ beatId, kind: "unhighlight", target: id, startMs: at, durationMs: clampMotion(MOTION.highlight, beatMs) }); this.highlighted.delete(id); }
    for (const id of ids) if (!this.highlighted.has(id) && this.visible.has(id)) { this.act({ beatId, kind: "highlight", target: id, startMs: at, durationMs: clampMotion(MOTION.highlight, beatMs) }); this.highlighted.add(id); }
  }
  state(id: string, st: ObjectState, at: number, beatId: string, beatMs: number) {
    if (this.states.get(id) === st || !this.obj(id)) return;
    this.act({ beatId, kind: "state", target: id, startMs: at, durationMs: clampMotion(MOTION.state, beatMs), state: st });
    this.states.set(id, st);
  }
  label(id: string, text: string, at: number, beatId: string, beatMs: number) {
    if ((this.subs.get(id) ?? "") === text || !this.obj(id)) return;
    this.act({ beatId, kind: "label", target: id, startMs: at, durationMs: clampMotion(MOTION.state, beatMs), text });
    this.subs.set(id, text);
  }
  value(id: string, v: number, at: number, beatId: string, beatMs: number) {
    const o = this.obj(id);
    if (!o || this.values.get(id) === v) return;
    if (o.value === undefined) o.value = 0;
    if (!this.values.has(id)) this.values.set(id, 0);
    this.act({ beatId, kind: "value", target: id, startMs: at, durationMs: clampMotion(MOTION.value, beatMs), value: v });
    this.values.set(id, v);
  }
}

const clampMotion = (ms: number, beatMs: number) => Math.max(120, Math.min(ms, Math.round(beatMs * 0.6)));

function kicker(title: string, index: number): VisualObject {
  const lines = wrapText(plain(title), 700, TYPE.kicker, { bold: true, maxLines: 1 }).lines;
  return { id: "kicker", kind: "kicker", box: { x: GRID.marginX, y: GRID.top, w: Math.round(textWidth(lines[0] ?? "", TYPE.kicker, { bold: true }) + 40), h: 26 }, lines, sub: [String(index).padStart(2, "0")], fontSize: TYPE.kicker, bold: true, refs: [], z: 6, tone: "accent", initial: { visible: true } };
}

function statementObjects(text: string, emphasis: boolean, id = "statement"): VisualObject[] {
  let size: number = TYPE.statement;
  let w = wrapText(plain(text), 1040, size, { bold: true, maxLines: 3 });
  if (w.truncated) { size = 36; w = wrapText(plain(text), 1080, size, { bold: true, maxLines: 4 }); }
  const h = w.lines.length * lh(size);
  const y = Math.round(CONTENT.y + (CONTENT.h - h) / 2 - 10);
  const box = { x: GRID.marginX, y, w: 1080, h };
  const objs: VisualObject[] = [{ id, kind: "statement", box, lines: w.lines, fontSize: size, bold: true, refs: [], z: 3, initial: { visible: false } }];
  if (emphasis) {
    const lastW = textWidth(w.lines[w.lines.length - 1] ?? "", size, { bold: true });
    objs.push({ id: "underline", kind: "connector", box: { x: 0, y: 0, w: 0, h: 0 }, points: [{ x: GRID.marginX, y: y + h + 10 }, { x: Math.round(GRID.marginX + Math.min(lastW, 1080)), y: y + h + 10 }], lines: [], fontSize: 0, refs: [], z: 3, tone: "accent", initial: { visible: false } });
  }
  return objs;
}

function sourceLabel(spec: ExplanationArtifactSpec, claimIds: string[]): { label: string; sourceIds: string[] } | null {
  const sids = [...new Set(claimIds.flatMap((id) => spec.claims.find((c) => c.id === id && c.supported)?.sourceIds ?? []))];
  if (!sids.length) return null;
  const first = spec.sources.find((s) => s.id === sids[0]);
  if (!first) return null;
  const label = `${first.label}${sids.length > 1 ? `  +${sids.length - 1}` : ""}`;
  return { label, sourceIds: sids };
}

export interface PlanScenesInput {
  spec: ExplanationArtifactSpec;
  plan: NarrationPlan;
  audio: SectionAudio[];
  beats: NarrativeBeat[];
  style: VisualStyle;
  renderer: RendererId | "auto";
  available: RendererId[];
  fps?: number;
}

export function planScenes(input: PlanScenesInput): { plan: VisualScenePlan; warnings: string[] } {
  const { spec, plan } = input;
  const fps = input.fps ?? CANVAS.fps;
  const warnings: string[] = [];
  // One diagram for the whole video: every concept a diagram section focuses on or acts on.
  const diagramSections = plan.sections.filter((s) => DIAGRAM_LAYOUTS.has(s.visualIntent.layout));
  const wanted: string[] = [];
  const conceptIds = new Set(spec.concepts.map((k) => k.id));
  for (const s of diagramSections) for (const id of [...s.visualIntent.focus, ...input.beats.filter((b) => b.sectionId === s.id).flatMap((b) => b.visualAction.targets)]) if (conceptIds.has(id) && !wanted.includes(id)) wanted.push(id);
  // Relationships acted on bring their ends.
  for (const b of input.beats) for (const t of b.visualAction.targets) { const r = spec.relationships.find((x) => x.id === t); if (r) for (const e of [r.from, r.to]) if (!wanted.includes(e)) wanted.push(e); }
  const diagram = wanted.length >= 2 ? buildDiagram(spec, wanted.slice(0, 12), wanted) : null;
  if (diagram?.dropped.length) warnings.push(`Left out of the diagram to keep it legible: ${diagram.dropped.join(", ")}.`);

  const introducedBefore = new Set<string>();
  // The opening state of a diagram scene is the closing state of the previous one (who holds which GPU, what is blocked),
  // reconstructed at planning time so each scene still renders on its own. It is part of the scene, so part of its hash.
  let carry: Carry | null = null;
  const scenes: SceneSpec[] = [];
  let index = 0;
  for (const sec of plan.sections) {
    const audio = input.audio.find((a) => a.sectionId === sec.id);
    if (!audio) { warnings.push(`No audio for section ${sec.id}; it has no scene.`); continue; }
    index++;
    const beats = input.beats.filter((b) => b.sectionId === sec.id);
    let layout = sec.visualIntent.layout;
    if (DIAGRAM_LAYOUTS.has(layout) && (!diagram || !diagram.objects.length)) layout = "statement";
    const startFrame = Math.round((audio.startMs / 1000) * fps);
    const { scene, closing } = buildScene({ ...input, fps }, sec, layout, beats, audio, diagram, introducedBefore, index, warnings, carry);
    if (closing) carry = closing;
    scene.startFrame = startFrame;
    scenes.push(scene);
    for (const b of beats) for (const t of b.visualAction.targets) introducedBefore.add(t);
    for (const id of sec.visualIntent.focus) introducedBefore.add(id);
  }
  const frames = scenes.reduce((a, s) => a + s.frameCount, 0);
  return { plan: { version: SCENE_PLANNER_VERSION, canvas: { width: CANVAS.width, height: CANVAS.height, fps }, style: input.style, durationMs: Math.round((frames / fps) * 1000), frames, scenes }, warnings };
}

function chooseRenderer(layout: VisualLayout, requested: RendererId | "auto", available: RendererId[]): RendererId {
  if (requested !== "auto" && available.includes(requested)) return requested;
  // Manim for systems, relationships, transformations and maths; HTML for statements, data cards, code and timelines.
  const manimFirst = ["architecture", "contention", "process", "comparison", "equation"].includes(layout);
  if (manimFirst && available.includes("manim")) return "manim";
  return available.includes("html") ? "html" : available[0] ?? "html";
}

type Carry = Map<string, { state?: ObjectState; sub?: string; value?: number }>;

function buildScene(input: PlanScenesInput & { fps: number }, sec: NarrationSection, layout: VisualLayout, beats: NarrativeBeat[], audio: SectionAudio, diagram: Diagram | null, introducedBefore: Set<string>, index: number, warnings: string[], carry: Carry | null): { scene: SceneSpec; closing: Carry | null } {
  const { spec } = input;
  const durationMs = Math.round((audio.frames / input.fps) * 1000);
  const b = new SceneBuilder(durationMs);
  b.add(kicker(sec.role === "hook" ? "The question" : sec.role === "conclusion" ? "Takeaway" : sec.title, index));
  // Scene-local integer milliseconds, computed relative to the section so they never depend on its absolute position.
  const local = (t: number) => Math.max(0, Math.round(Math.round((t - audio.startMs) * 1000) / 1000));
  const beatMs = (x: NarrativeBeat) => Math.max(200, x.endMs - x.startMs);

  if (DIAGRAM_LAYOUTS.has(layout) && diagram) {
    for (const o of diagram.objects) b.add({ ...o, initial: { ...o.initial } });
    // Concepts named in earlier sections are already on screen; so are links between them.
    for (const [cid, part] of diagram.parts) if (introducedBefore.has(cid)) for (const id of part.reveal) { b.visible.add(id); setInitial(b, id, true); }
    for (const c of diagram.connectors) if (b.visible.has(diagram.parts.get(c.from)?.primary ?? "") && b.visible.has(diagram.parts.get(c.to)?.primary ?? "")) for (const id of c.objs) { b.visible.add(id); setInitial(b, id, true); }
    // Parents of visible children are visible.
    for (const o of b.objects) if (b.visible.has(o.id) && o.parent && !b.visible.has(o.parent)) { b.visible.add(o.parent); setInitial(b, o.parent, true); }
    if (carry) for (const [id, c] of carry) {
      const o = b.obj(id);
      if (!o || !b.visible.has(id)) continue;
      if (c.state) { o.initial = { ...o.initial, state: c.state }; b.states.set(id, c.state); }
      if (c.sub !== undefined && o.kind === "cell") { o.sub = c.sub ? [c.sub] : []; b.subs.set(id, c.sub); }
      if (c.value !== undefined) { o.value = c.value; b.values.set(id, c.value); }
    }
    diagramBeats(b, spec, diagram, sec, beats, local, beatMs);
  } else if (layout === "process" && processSteps(spec, sec).length >= 2) {
    processScene(b, spec, sec, beats, local, beatMs);
  } else if (layout === "comparison" && (spec.comparisons ?? []).length) {
    comparisonScene(b, spec, beats, local, beatMs);
  } else if (layout === "metric" && (spec.metrics ?? []).length) {
    metricScene(b, spec, sec, beats, local, beatMs);
  } else if (layout === "code" && (spec.codeReferences ?? []).length) {
    codeScene(b, spec, beats, local, beatMs);
  } else {
    if (!["statement"].includes(layout)) layout = "statement";
    if (sec.role === "body" && beats.length > 1) {
      // A long statement scene follows the narration: each beat brings its own short headline, so the picture never
      // sits still on one sentence for most of a minute.
      beats.forEach((x, i) => {
        const id = `statement:${i}`;
        for (const o of statementObjects(headline(x.cueText.length > 30 ? x.cueText : sentenceAt(sec.narration, x.cueText)), false, id)) b.add(o);
        if (i > 0) b.hide([`statement:${i - 1}`], local(x.startMs), x.id, beatMs(x));
        b.appear([id], local(x.startMs) + (i > 0 ? 200 : 0), x.id, beatMs(x));
      });
    } else {
      const text = sec.role === "hook" ? (spec.narrative.hook || spec.title) : firstSentence(sec.narration);
      for (const o of statementObjects(text, sec.role === "conclusion")) b.add(o);
      const first = beats[0];
      b.appear(["statement"], first ? local(first.startMs) : 0, first?.id ?? "start", first ? beatMs(first) : 1000);
    }
    const reveal = beats.find((x) => x.visualAction.kind === "reveal_result") ?? (sec.role === "conclusion" ? beats[beats.length - 1] : undefined);
    if (reveal && b.objects.some((o) => o.id === "underline")) b.draw(["underline"], local(reveal.startMs) + 200, reveal.id, beatMs(reveal));
  }

  // Source markers: one small label per beat that rests on sources.
  const citations: SourceOverlay[] = [];
  for (const x of beats) {
    const s = sourceLabel(spec, x.claimIds);
    if (!s) continue;
    x.sourceRefs = s.sourceIds;
    const lines = wrapText(s.label, 460, TYPE.source, { mono: true, maxLines: 1 }).lines;
    const w = Math.round(textWidth(lines[0], TYPE.source, { mono: true }) + 30);
    const id = `src:${x.id}`;
    b.add({ id, kind: "source", box: { x: CANVAS.width - GRID.marginX - w, y: GRID.top + 2, w, h: 22 }, lines, fontSize: TYPE.source, mono: true, refs: s.sourceIds, z: 7, tone: "secondary", initial: { visible: false } });
    const st = local(x.startMs), en = local(x.endMs);
    b.act({ beatId: x.id, kind: "appear", target: id, startMs: st, durationMs: 160 });
    if (en - st > 400) b.act({ beatId: x.id, kind: "disappear", target: id, startMs: en - 160, durationMs: 160 });
    citations.push({ claimId: x.claimIds[0] ?? "", sourceIds: s.sourceIds, label: s.label, startMs: st, endMs: en });
  }

  b.actions.sort((p, q) => p.startMs - q.startMs || p.id.localeCompare(q.id, "en", { numeric: true }));
  const renderer = chooseRenderer(layout, input.renderer, input.available);
  const scene: SceneSpec = {
    id: `scene-${sec.id}`, sectionId: sec.id, objective: sec.objective, layout,
    startMs: Math.round(audio.startMs), endMs: Math.round(audio.startMs + durationMs), startFrame: 0, frameCount: audio.frames, renderer,
    objects: b.objects, actions: b.actions, citations, hash: "",
  };
  if (!scene.actions.some((a) => a.kind !== "appear" || a.target !== undefined) && b.visible.size <= 1) warnings.push(`Scene ${scene.id} has nothing but its title.`);
  scene.hash = sceneHash(scene, input.style, input.fps);
  let closing: Carry | null = null;
  if (DIAGRAM_LAYOUTS.has(layout) && diagram) {
    closing = new Map();
    for (const o of diagram.objects) closing.set(o.id, { state: b.states.get(o.id), sub: b.subs.get(o.id), value: b.values.get(o.id) });
  }
  return { scene, closing };
}

function setInitial(b: SceneBuilder, id: string, visible: boolean) {
  const o = b.objects.find((x) => x.id === id);
  if (o) o.initial = { ...o.initial, visible };
}

const firstSentence = (s: string) => (s.match(/^.*?[.!?](\s|$)/)?.[0] ?? s).trim();
/** The narration sentence a cue opens. */
function sentenceAt(narration: string, cue: string): string {
  const i = narration.toLowerCase().indexOf(cue.toLowerCase().slice(0, 24));
  return i < 0 ? cue : firstSentence(narration.slice(i));
}

function diagramBeats(b: SceneBuilder, spec: ExplanationArtifactSpec, d: Diagram, sec: NarrationSection, beats: NarrativeBeat[], local: (t: number) => number, beatMs: (x: NarrativeBeat) => number) {
  const short = (cid: string) => { const n = shortName(spec.concepts.find((k) => k.id === cid)?.name ?? ""); return /^[A-Z0-9]+$/.test(n) ? n : n.toLowerCase(); };
  const applied = new Set<string>();
  const shared = new Set<string>();
  /** Show who holds which resource: each consumer instance on its own resource cell. */
  const applyPair = (p: Pair, at: number, beatId: string, ms: number, initial = false) => {
    if (applied.has(p.relId) || shared.has(p.resource)) return;
    applied.add(p.relId);
    const cells = d.parts.get(p.resource)!.cells;
    const width = (b.obj(cells[0])?.box.w ?? 90) - 18;
    for (let i = 0; i < p.n; i++) {
      const text = fitLabel([`${short(p.consumer)} ${i + 1}`, `#${i + 1}`], width);
      if (initial) { const o = b.obj(cells[i])!; o.sub = [text]; o.initial = { ...o.initial, state: "busy" }; b.subs.set(cells[i], text); b.states.set(cells[i], "busy"); }
      else { b.label(cells[i], text, at + 60 * i, beatId, ms); b.state(cells[i], "busy", at + 60 * i, beatId, ms); }
    }
  };
  const revealConcept = (cid: string, at: number, beatId: string, ms: number) => {
    const p = d.parts.get(cid);
    if (!p) return;
    const parent = b.obj(p.primary)?.parent;
    if (parent && !b.visible.has(parent)) revealConcept(parent.slice(2), at, beatId, ms);
    b.appear(p.reveal, at, beatId, ms);
    // Links appear once both of their ends are on screen.
    for (const c of d.connectors) {
      const fa = d.parts.get(c.from)?.primary, fb = d.parts.get(c.to)?.primary;
      if (!fa || !fb || !b.visible.has(fa) || !b.visible.has(fb)) continue;
      b.draw(c.objs, at + Math.min(260, ms * 0.3), beatId, ms);
      const pair = d.pairs.find((x) => x.relId === c.relId);
      if (pair) applyPair(pair, at + Math.min(500, ms * 0.4), beatId, ms);
    }
  };
  // Allocations carried in from the previous scene are already shown.
  for (const p of d.pairs) {
    const first = d.parts.get(p.resource)!.cells[0];
    const sub = first ? b.subs.get(first) ?? "" : "";
    if (sub) { applied.add(p.relId); if (/–|free/.test(sub) || d.parts.get(p.resource)!.cells.some((c) => b.subs.get(c) === "free")) shared.add(p.resource); }
  }
  // Pairs whose two ends are already on screen when the scene opens are shown from the first frame.
  for (const p of d.pairs) if (b.visible.has(d.parts.get(p.consumer)!.primary) && b.visible.has(d.parts.get(p.resource)!.primary)) applyPair(p, 0, "start", 1000, true);

  let zoomed = false, scrimmed = false;
  const stateOf = (cid: string, st: ObjectState, at: number, beatId: string, ms: number) => {
    const p = d.parts.get(cid);
    if (!p) return;
    // Counted things change instance by instance; a single thing changes as a whole.
    if (p.cells.length && !d.pairs.some((x) => x.resource === cid && applied.has(x.relId))) for (const id of p.cells) b.state(id, st, at, beatId, ms);
    b.state(p.primary, st, at, beatId, ms);
  };
  // Everything this section is about must be on screen by its first beat, so no diagram scene opens empty.
  const focus = sec.visualIntent.focus.filter((id) => d.parts.has(id) && !b.visible.has(d.parts.get(id)!.primary));
  beats.forEach((beat, i) => {
    const at = local(beat.startMs), ms = beatMs(beat);
    const a = beat.visualAction;
    if (zoomed) { b.act({ beatId: beat.id, kind: "camera", startMs: at, durationMs: clampMotion(MOTION.camera, ms), view: { x: 0, y: 0, w: CANVAS.width, h: CANVAS.height } }); zoomed = false; }
    if (scrimmed && a.kind !== "dim_context") { b.act({ beatId: beat.id, kind: "unscrim", startMs: at, durationMs: clampMotion(MOTION.scrim, ms) }); scrimmed = false; }
    if (i === 0) for (const id of focus) if (!a.targets.includes(id)) revealConcept(id, at, beat.id, ms);
    const concepts = a.targets.filter((t) => d.parts.has(t));
    const rels = a.targets.filter((t) => d.connectors.some((c) => c.relId === t));
    const prim = (cid: string) => d.parts.get(cid)!.primary;
    switch (a.kind) {
      case "introduce_component":
        concepts.forEach((cid, k) => revealConcept(cid, at + k * 140, beat.id, ms));
        if (a.state) concepts.forEach((cid) => stateOf(cid, a.state!, at + 300, beat.id, ms));
        b.highlight(concepts.map(prim), at + 200, beat.id, ms);
        break;
      case "highlight_component":
      case "reveal_result":
        concepts.forEach((cid) => revealConcept(cid, at, beat.id, ms));
        b.highlight(concepts.map(prim), at, beat.id, ms);
        break;
      case "connect_components":
      case "show_data_flow": {
        for (const rid of rels) {
          const c = d.connectors.find((x) => x.relId === rid)!;
          revealConcept(c.from, at, beat.id, ms);
          revealConcept(c.to, at, beat.id, ms);
          b.highlight([prim(c.from), prim(c.to)], at, beat.id, ms);
          if (a.kind === "show_data_flow") {
            const start = at + clampMotion(MOTION.draw, ms) + 120;
            b.act({ beatId: beat.id, kind: "flow", target: c.id, startMs: start, durationMs: Math.max(300, ms - (start - at) - 150) });
          }
        }
        if (!rels.length) { concepts.forEach((cid) => revealConcept(cid, at, beat.id, ms)); b.highlight(concepts.map(prim), at, beat.id, ms); }
        break;
      }
      case "set_state":
        concepts.forEach((cid) => { revealConcept(cid, at, beat.id, ms); stateOf(cid, a.state ?? "busy", at, beat.id, ms); });
        b.highlight(concepts.map(prim), at, beat.id, ms);
        break;
      case "emphasize_metric": {
        const m = (spec.metrics ?? []).find((x) => a.targets.includes(x.id));
        if (!m) break;
        const res = [...d.parts.values()].find((p) => p.cells.length && spec.concepts.find((k) => k.id === p.conceptId)?.kind === "resource") ?? [...d.parts.values()].find((p) => p.cells.length);
        const chipText = plain(`${m.display} ${m.label}`).slice(0, 40);
        const w = Math.round(textWidth(chipText, 18, { bold: true }) + 24);
        const holder = res ? b.obj(b.obj(res.primary)?.parent ?? res.primary)?.box ?? res.box : CONTENT;
        const id = `metric:${m.id}`;
        b.add({ id, kind: "chip", box: freeSpot(holder, w, 30, d.objects), lines: [chipText], fontSize: 18, bold: true, refs: [m.id], z: 6, tone: "accent", initial: { visible: false } });
        if (res) revealConcept(res.conceptId, at, beat.id, ms);
        // One number at a time: the previous metric steps aside for this one.
        b.hide([...b.visible].filter((x) => x.startsWith("metric:") && x !== id), at, beat.id, ms);
        b.appear([id], at, beat.id, ms);
        if (res && m.unit === "%" && m.value >= 0 && m.value <= 100) {
          const pair = d.pairs.find((x) => x.resource === res.conceptId && applied.has(x.relId));
          const cells = pair ? res.cells.slice(0, pair.n) : res.cells;
          cells.forEach((cid, k) => b.value(cid, m.value / 100, at + 150 + k * 50, beat.id, ms));
        }
        b.highlight([id], at, beat.id, ms);
        break;
      }
      case "transform_object":
      case "compare_states": {
        // Sharing: instances re-pack two to a resource; the resources that come free turn healthy, and whatever was
        // waiting for them stops waiting.
        const pair = d.pairs.find((p) => a.targets.includes(p.resource) || a.targets.includes(p.consumer) || a.targets.includes(p.relId)) ?? d.pairs[0];
        if (pair) {
          revealConcept(pair.consumer, at, beat.id, ms);
          revealConcept(pair.resource, at, beat.id, ms);
          const cells = d.parts.get(pair.resource)!.cells;
          const used = Math.ceil(pair.n / 2);
          const name = short(pair.consumer);
          cells.forEach((cid, k) => {
            const t = at + 250 + k * 70;
            if (k < used) {
              const first = 2 * k + 1, second = Math.min(pair.n, 2 * k + 2);
              const width = (b.obj(cid)?.box.w ?? 90) - 18;
              b.label(cid, second > first ? fitLabel([`${name}s ${first}–${second}`, `${first}–${second}`], width) : fitLabel([`${name} ${first}`, `#${first}`], width), t, beat.id, ms);
              b.state(cid, "busy", t, beat.id, ms);
              const v = b.values.get(cid);
              if (v !== undefined && v > 0) b.value(cid, Math.min(1, v * (second - first + 1)), t, beat.id, ms);
            } else {
              b.label(cid, "free", t, beat.id, ms);
              b.state(cid, "ok", t, beat.id, ms);
              if (b.values.has(cid)) b.value(cid, 0, t, beat.id, ms);
            }
          });
          shared.add(pair.resource);
          for (const [cid, p] of d.parts) if (b.states.get(p.primary) === "blocked" || b.states.get(p.primary) === "waiting") { revealConcept(cid, at, beat.id, ms); b.state(p.primary, "ok", at + 250 + cells.length * 70, beat.id, ms); }
          b.highlight([d.parts.get(pair.resource)!.primary], at + 250, beat.id, ms);
        } else {
          concepts.forEach((cid) => stateOf(cid, "ok", at, beat.id, ms));
          b.highlight(concepts.map(prim), at, beat.id, ms);
        }
        break;
      }
      case "zoom_to_subsystem": {
        const boxes = concepts.map((c) => d.parts.get(c)!.box);
        if (!boxes.length) break;
        concepts.forEach((cid) => revealConcept(cid, at, beat.id, ms));
        b.act({ beatId: beat.id, kind: "camera", startMs: at, durationMs: clampMotion(MOTION.camera, ms), view: zoomView(boxes) });
        zoomed = true;
        break;
      }
      case "dim_context":
        concepts.forEach((cid) => revealConcept(cid, at, beat.id, ms));
        b.act({ beatId: beat.id, kind: "scrim", startMs: at, durationMs: clampMotion(MOTION.scrim, ms), keep: concepts.flatMap((c) => d.parts.get(c)!.reveal) });
        scrimmed = true;
        break;
      default:
        if (concepts.length) { concepts.forEach((cid) => revealConcept(cid, at, beat.id, ms)); b.highlight(concepts.map(prim), at, beat.id, ms); }
    }
  });
  // A diagram scene must end with something on screen even if no beat introduced it.
  if (![...d.parts.values()].some((p) => b.visible.has(p.primary))) for (const cid of d.parts.keys()) revealConcept(cid, 0, beats[0]?.id ?? "start", 1200);
}

/** A place for a label near `near` that touches no drawn box: below, above, right, left, then anywhere in the content area. */
function freeSpot(near: Box, w: number, h: number, objects: VisualObject[]): Box {
  const solids = objects.filter((o) => (o.kind === "group" || o.kind === "node" || o.kind === "chip") && !o.parent).map((o) => o.box);
  const clampX = (x: number) => Math.round(Math.min(Math.max(GRID.marginX, x), CANVAS.width - GRID.marginX - w));
  const cx = near.x + near.w / 2 - w / 2;
  const candidates: Box[] = [
    { x: clampX(cx), y: near.y + near.h + 14, w, h },
    { x: clampX(cx), y: near.y - 14 - h, w, h },
    { x: clampX(near.x + near.w + 16), y: near.y + near.h / 2 - h / 2, w, h },
    { x: clampX(near.x - 16 - w), y: near.y + near.h / 2 - h / 2, w, h },
    { x: clampX(near.x), y: near.y + near.h + 14, w, h },
    { x: clampX(near.x + near.w - w), y: near.y + near.h + 14, w, h },
  ];
  for (let y = GRID.contentTop; y + h <= GRID.contentBottom; y += 24) for (let x = GRID.marginX; x + w <= CANVAS.width - GRID.marginX; x += 40) candidates.push({ x, y, w, h });
  const fits = (c: Box) => c.y >= GRID.contentTop - 12 && c.y + c.h <= GRID.contentBottom && !solids.some((o) => overlaps(o, c, 6));
  const best = candidates.find(fits) ?? candidates[0];
  return { ...best, x: Math.round(best.x), y: Math.round(best.y) };
}

function zoomView(boxes: Box[]): Box {
  const x0 = Math.min(...boxes.map((x) => x.x)) - 60, y0 = Math.min(...boxes.map((x) => x.y)) - 60;
  const x1 = Math.max(...boxes.map((x) => x.x + x.w)) + 60, y1 = Math.max(...boxes.map((x) => x.y + x.h)) + 60;
  let w = Math.max(480, x1 - x0), h = Math.max(270, y1 - y0);
  if (w / h > 16 / 9) h = (w * 9) / 16; else w = (h * 16) / 9;
  w = Math.min(w, CANVAS.width); h = Math.min(h, CANVAS.height);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return { x: Math.round(Math.max(0, Math.min(CANVAS.width - w, cx - w / 2))), y: Math.round(Math.max(0, Math.min(CANVAS.height - h, cy - h / 2))), w: Math.round(w), h: Math.round(h) };
}

function processSteps(spec: ExplanationArtifactSpec, sec: NarrationSection): string[] {
  const p = spec.processes.find((x) => x.claimIds.some((id) => sec.claimIds.includes(id))) ?? spec.processes[0];
  return (p?.steps ?? []).slice(0, 8).map((s) => s.label);
}

function processScene(b: SceneBuilder, spec: ExplanationArtifactSpec, sec: NarrationSection, beats: NarrativeBeat[], local: (t: number) => number, beatMs: (x: NarrativeBeat) => number) {
  const steps = processSteps(spec, sec);
  const perRow = steps.length <= 5 ? steps.length : Math.ceil(steps.length / 2);
  const rows = Math.ceil(steps.length / perRow);
  const gap = 44;
  const w = Math.floor((CONTENT.w - (perRow - 1) * gap) / perRow);
  const wrapped = steps.map((s) => wrapText(plain(s), w - 2 * SHAPE.padX, 20, { maxLines: 4 }).lines);
  const h = Math.max(96, Math.max(...wrapped.map((l) => l.length)) * lh(20) + 2 * SHAPE.padY + 26);
  const totalH = rows * h + (rows - 1) * 56;
  const top = Math.round(CONTENT.y + (CONTENT.h - totalH) / 2);
  steps.forEach((_, i) => {
    const r = Math.floor(i / perRow), c = i % perRow;
    b.add({ id: `step:${i}`, kind: "node", box: { x: CONTENT.x + c * (w + gap), y: top + r * (h + 56), w, h }, lines: wrapped[i], sub: [String(i + 1)], fontSize: 20, refs: [], z: 2, initial: { visible: false, state: "idle" } });
    if (i > 0) {
      const a = b.objects.find((o) => o.id === `step:${i - 1}`)!.box, z = b.objects.find((o) => o.id === `step:${i}`)!.box;
      const pts = r === Math.floor((i - 1) / perRow) ? [{ x: a.x + a.w + 6, y: a.y + a.h / 2 }, { x: z.x - 6, y: z.y + z.h / 2 }] : [{ x: a.x + a.w / 2, y: a.y + a.h + 6 }, { x: a.x + a.w / 2, y: a.y + a.h + 28 }, { x: z.x + z.w / 2, y: a.y + a.h + 28 }, { x: z.x + z.w / 2, y: z.y - 6 }];
      b.add({ id: `link:${i}`, kind: "connector", box: { x: 0, y: 0, w: 0, h: 0 }, points: pts, lines: [], fontSize: 0, refs: [], z: 1, initial: { visible: false } });
    }
  });
  // Spread the steps over the beats, one or more per beat, in order.
  const n = Math.max(1, beats.length);
  steps.forEach((_, i) => {
    const beat = beats[Math.min(n - 1, Math.floor((i * n) / steps.length))];
    const at = beat ? local(beat.startMs) + (i % Math.max(1, Math.ceil(steps.length / n))) * 300 : i * 600;
    const ms = beat ? beatMs(beat) : 1200;
    const id = beat?.id ?? "start";
    if (i > 0) b.draw([`link:${i}`], at, id, ms);
    b.appear([`step:${i}`], at + (i > 0 ? 160 : 0), id, ms);
    b.highlight([`step:${i}`], at + 200, id, ms);
  });
}

function comparisonScene(b: SceneBuilder, spec: ExplanationArtifactSpec, beats: NarrativeBeat[], local: (t: number) => number, beatMs: (x: NarrativeBeat) => number) {
  const c = spec.comparisons![0];
  const colW = Math.floor((CONTENT.w - 48) / 2);
  const panel = (side: "before" | "after", x: number) => {
    const head = wrapText(plain(c[side].label), colW - 40, 24, { bold: true, maxLines: 1 }).lines;
    const lines: string[] = [];
    for (const p of c[side].points.slice(0, 4)) { const w = wrapText(plain(p), colW - 64, 20, { maxLines: 3 }).lines; if ((lines.length + w.length) * lh(20) > CONTENT.h - 90) break; lines.push(...w.map((l, i) => (i === 0 ? `– ${l}` : `   ${l}`))); }
    const h = Math.min(CONTENT.h, 70 + lines.length * lh(20) + 28);
    b.add({ id: `panel:${side}`, kind: "list", box: { x, y: CONTENT.y + 8, w: colW, h }, lines, sub: head, fontSize: 20, refs: [c.id], z: 2, tone: side === "after" ? "accent" : "primary", initial: { visible: false, state: side === "after" ? "ok" : "blocked" } });
  };
  panel("before", CONTENT.x);
  panel("after", CONTENT.x + colW + 48);
  const first = beats[0];
  b.appear(["panel:before"], first ? local(first.startMs) : 0, first?.id ?? "start", first ? beatMs(first) : 1200);
  const cmp = beats.find((x, i) => i > 0 && x.visualAction.kind === "compare_states") ?? beats[Math.max(1, Math.floor(beats.length / 2))] ?? first;
  if (cmp) {
    const at = local(cmp.startMs);
    b.appear(["panel:after"], at, cmp.id, beatMs(cmp));
    b.act({ beatId: cmp.id, kind: "scrim", startMs: at + 200, durationMs: clampMotion(MOTION.scrim, beatMs(cmp)), view: b.objects.find((o) => o.id === "panel:before")!.box, keep: [] });
    b.highlight(["panel:after"], at + 200, cmp.id, beatMs(cmp));
  }
}

function metricScene(b: SceneBuilder, spec: ExplanationArtifactSpec, sec: NarrationSection, beats: NarrativeBeat[], local: (t: number) => number, beatMs: (x: NarrativeBeat) => number) {
  const metrics = (spec.metrics ?? []).filter((m) => m.claimIds.some((id) => sec.claimIds.includes(id))).slice(0, 3);
  const list = metrics.length ? metrics : (spec.metrics ?? []).slice(0, 1);
  const rowH = Math.min(150, Math.floor(CONTENT.h / list.length));
  list.forEach((m, i) => {
    const y = CONTENT.y + i * rowH + Math.max(0, (CONTENT.h - rowH * list.length) / 2);
    const size = list.length > 1 ? 56 : TYPE.metric;
    const numW = Math.round(textWidth(m.display, size, { bold: true }));
    b.add({ id: `num:${m.id}`, kind: "metric", box: { x: GRID.marginX, y: Math.round(y), w: numW, h: lh(size) }, lines: [m.display], fontSize: size, bold: true, refs: [m.id], z: 3, tone: "accent", initial: { visible: false } });
    const label = wrapText(plain(m.label), 620, 20, { maxLines: 2 }).lines;
    b.add({ id: `lab:${m.id}`, kind: "callout", box: { x: GRID.marginX + numW + 32, y: Math.round(y + 8), w: 640, h: label.length * lh(20) }, lines: label, fontSize: 20, refs: [m.id], z: 3, tone: "secondary", initial: { visible: false } });
    if (m.unit === "%" && m.value <= 100) b.add({ id: `bar:${m.id}`, kind: "meter", box: { x: GRID.marginX + numW + 32, y: Math.round(y + lh(size) - 18), w: 640, h: 12 }, lines: [], fontSize: 0, value: 0, refs: [m.id], z: 3, initial: { visible: false } });
    const beat = beats.find((x) => x.visualAction.targets.includes(m.id)) ?? beats[Math.min(beats.length - 1, i)];
    const at = beat ? local(beat.startMs) : i * 800, ms = beat ? beatMs(beat) : 1500, bid = beat?.id ?? "start";
    b.appear([`num:${m.id}`, `lab:${m.id}`, `bar:${m.id}`], at, bid, ms);
    if (m.unit === "%" && m.value <= 100) b.act({ beatId: bid, kind: "value", target: `bar:${m.id}`, startMs: at + 200, durationMs: clampMotion(MOTION.value, ms), value: m.value / 100 });
  });
}

function codeScene(b: SceneBuilder, spec: ExplanationArtifactSpec, beats: NarrativeBeat[], local: (t: number) => number, beatMs: (x: NarrativeBeat) => number) {
  const ref = spec.codeReferences![0];
  const maxChars = Math.floor((CONTENT.w - 90) / textWidth("M", TYPE.code, { mono: true }));
  const raw = ref.code.split("\n").slice(0, 14).map((l) => l.replace(/\t/g, "  "));
  // Prose (Markdown, text) wraps; code is cut, because a wrapped code line reads as two statements.
  const prose = /\.(md|markdown|txt|rst|adoc)$/i.test(ref.path);
  const lines: string[] = [];
  for (const l of raw) {
    if (l.length <= maxChars) lines.push(l);
    else if (!prose) lines.push(`${l.slice(0, maxChars - 1)}…`);
    else lines.push(...wrapText(l, CONTENT.w - 90, TYPE.code, { mono: true }).lines.map((x, i) => (i ? `  ${x}` : x)));
    if (lines.length >= 16) break;
  }
  lines.splice(16);
  const h = lines.length * lh(TYPE.code) + 28;
  b.add({ id: "code", kind: "code", box: { x: CONTENT.x, y: CONTENT.y + 36, w: CONTENT.w, h }, lines, sub: [`${ref.path}:${ref.startLine}-${ref.startLine + lines.length - 1}`], fontSize: TYPE.code, mono: true, firstLine: ref.startLine, refs: [ref.id], z: 2, initial: { visible: false } });
  const first = beats[0];
  b.appear(["code"], first ? local(first.startMs) : 0, first?.id ?? "start", first ? beatMs(first) : 1200);
  const hl = ref.highlight ?? [ref.startLine, Math.min(ref.startLine + 2, ref.startLine + lines.length - 1)];
  const beat = beats[1] ?? first;
  if (beat) b.act({ beatId: beat.id, kind: "lines", target: "code", startMs: local(beat.startMs) + (beat === first ? 500 : 0), durationMs: clampMotion(MOTION.lines, beatMs(beat)), range: hl });
}

export function sceneHash(scene: Omit<SceneSpec, "hash"> & { hash?: string }, style: VisualStyle, fps: number): string {
  const { hash: _h, startMs: _s, endMs: _e, startFrame: _f, ...rest } = scene;
  void _h; void _s; void _e; void _f;
  return sha256(JSON.stringify({ v: SCENE_PLANNER_VERSION, style, fps, rest })).slice(0, 20);
}
