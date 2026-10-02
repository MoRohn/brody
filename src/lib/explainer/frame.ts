/**
 * One frame of a scene, as SVG: a pure function of (scene, scene-local time). The live player in the browser calls it
 * on every animation frame with the narration audio's clock, and the server-side renderer calls it for every video frame
 * and rasterises the result, so the interactive explainer and the MP4 cannot disagree. Browser-safe, no dependencies.
 *
 * Visual rules carried over from the Manim safeguards: dimming is a scrim laid OVER the picture (kept objects are drawn
 * again above it), never a change to the picture's own opacity; highlights are an outline added around an object,
 * never a scale pulse that slides it out from under other marks.
 */
import { MOTION, PALETTES, stateColor, type Palette } from "./design";
import { GLYPHS } from "./glyphs";
import type { Box, ObjectState, SceneSpec, VisualObject, VisualStyle } from "./types";

export interface ObjState { opacity: number; rise: number; highlight: number; state: ObjectState; prevState: ObjectState; stateMix: number; value?: number; draw: number; flow: number | null; lines?: [number, number]; linesMix: number; sub: string; prevSub: string; subMix: number }
export interface FrameState { objs: Map<string, ObjState>; scrim: { level: number; keep: Set<string>; region?: Box }; view: Box }

const FULL: Box = { x: 0, y: 0, w: 1280, h: 720 };
const ease = (p: number) => (p <= 0 ? 0 : p >= 1 ? 1 : p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

function polyLength(pts: { x: number; y: number }[]): number {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return n;
}
function pointAt(pts: { x: number; y: number }[], frac: number): { x: number; y: number } {
  const total = polyLength(pts);
  let d = frac * total;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (d <= seg || i === pts.length - 1) { const p = seg ? Math.min(1, d / seg) : 0; return { x: lerp(pts[i - 1].x, pts[i].x, p), y: lerp(pts[i - 1].y, pts[i].y, p) }; }
    d -= seg;
  }
  return pts[pts.length - 1];
}

/** The state of every object at scene-local time t (ms). Actions apply in start order; later ones override earlier ones. */
export function sceneStateAt(scene: SceneSpec, t: number): FrameState {
  const objs = new Map<string, ObjState>();
  for (const o of scene.objects) {
    const v = o.initial.visible ? 1 : 0;
    const sub = o.kind === "cell" ? o.sub?.[0] ?? "" : "";
    objs.set(o.id, { opacity: v, rise: 0, highlight: o.initial.highlight ? 1 : 0, state: o.initial.state ?? "idle", prevState: o.initial.state ?? "idle", stateMix: 1, value: o.value, draw: v, flow: null, linesMix: 0, sub, prevSub: sub, subMix: 1 });
  }
  let scrim = { level: 0, keep: new Set<string>(), region: undefined as Box | undefined };
  let view = { ...FULL };
  for (const a of scene.actions) {
    if (a.startMs > t) break;
    const raw = (t - a.startMs) / Math.max(1, a.durationMs);
    const p = ease(Math.min(1, raw));
    const s = a.target ? objs.get(a.target) : undefined;
    switch (a.kind) {
      case "appear": if (s) { s.opacity = p; s.rise = (1 - p) * MOTION.rise; s.draw = Math.max(s.draw, p); } break;
      case "disappear": if (s) { s.opacity = Math.min(s.opacity, 1 - p); s.draw = s.opacity; } break;
      case "draw": if (s) { s.opacity = 1; s.draw = p; } break;
      case "highlight": if (s) s.highlight = Math.max(s.highlight, p); break;
      case "unhighlight": if (s) s.highlight = Math.min(s.highlight, 1 - p); break;
      case "state": if (s && a.state) { if (p < 1) { s.prevState = s.state; s.stateMix = p; } else { s.prevState = a.state; s.stateMix = 1; } s.state = a.state; } break;
      case "value": if (s && a.value !== undefined) { const from = s.value ?? 0; s.value = lerp(from, a.value, p); } break;
      case "label": if (s && a.text !== undefined) { if (p < 1) { s.prevSub = s.sub; s.subMix = p; } else { s.prevSub = a.text; s.subMix = 1; } s.sub = a.text; } break;
      case "flow": if (s) s.flow = raw <= 1 ? ((t - a.startMs) / 1000) * MOTION.flowPxPerSec : null; break;
      case "lines": if (s && a.range) { s.lines = a.range; s.linesMix = p; } break;
      case "scrim": scrim = { level: 0.8 * p, keep: new Set(a.keep ?? []), region: a.view }; break;
      case "unscrim": scrim = { ...scrim, level: scrim.level * (1 - p) }; break;
      case "camera": if (a.view) { const from = view; view = { x: lerp(from.x, a.view.x, p), y: lerp(from.y, a.view.y, p), w: lerp(from.w, a.view.w, p), h: lerp(from.h, a.view.h, p) }; } break;
      default: break;
    }
  }
  return { objs, scrim, view };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n = (x: number) => Math.round(x * 10) / 10;

function mixHex(a: string, b: string, p: number): string {
  if (p >= 1 || a === b) return b;
  if (p <= 0) return a;
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (sh: number) => Math.round(lerp((pa >> sh) & 255, (pb >> sh) & 255, p));
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0")}`;
}

export interface FrameOptions { style: VisualStyle; fontSans?: string; fontMono?: string; width?: number; height?: number }

function text(x: number, y: number, s: string, size: number, fill: string, o: { bold?: boolean; mono?: boolean; anchor?: "start" | "middle" | "end"; fonts: { sans: string; mono: string }; opacity?: number }): string {
  return `<text x="${n(x)}" y="${n(y)}" font-family="${o.mono ? o.fonts.mono : o.fonts.sans}" font-size="${size}"${o.bold ? ' font-weight="bold"' : ""}${o.anchor && o.anchor !== "start" ? ` text-anchor="${o.anchor}"` : ""} fill="${fill}"${o.opacity !== undefined && o.opacity < 1 ? ` opacity="${n(o.opacity)}"` : ""}>${esc(s)}</text>`;
}
/** Baseline of line i in a block that starts at `top`, for DejaVu metrics (ascent 0.928 em) in a 1.28 em line box. */
const baseline = (top: number, i: number, size: number) => top + i * Math.round(size * 1.28) + size * 0.986;

function glyph(name: string, x: number, y: number, size: number, color: string): string {
  const prims = GLYPHS[name as keyof typeof GLYPHS] ?? GLYPHS.generic;
  const k = size / 24;
  const parts = prims.map((p) => {
    switch (p.t) {
      case "rect": return `<rect x="${n(x + p.x * k)}" y="${n(y + p.y * k)}" width="${n(p.w * k)}" height="${n(p.h * k)}" rx="${n((p.r ?? 0) * k)}" fill="none"/>`;
      case "circle": return `<circle cx="${n(x + p.cx * k)}" cy="${n(y + p.cy * k)}" r="${n(p.r * k)}" fill="${p.fill ? color : "none"}"/>`;
      case "line": return `<line x1="${n(x + p.x1 * k)}" y1="${n(y + p.y1 * k)}" x2="${n(x + p.x2 * k)}" y2="${n(y + p.y2 * k)}"/>`;
      case "poly": { const pts = p.pts.map(([a, b]) => `${n(x + a * k)},${n(y + b * k)}`).join(" "); return p.closed ? `<polygon points="${pts}" fill="none"/>` : `<polyline points="${pts}" fill="none"/>`; }
    }
  });
  return `<g stroke="${color}" stroke-width="${n(1.5 * k)}" stroke-linecap="round" stroke-linejoin="round">${parts.join("")}</g>`;
}

function drawObject(o: VisualObject, s: ObjState, pal: Palette, fonts: { sans: string; mono: string }, hasCells: boolean): string {
  if (s.opacity <= 0.001 && (o.kind !== "connector" || s.draw <= 0.001)) return "";
  const b = o.box;
  const out: string[] = [];
  const stroke = mixHex(stateColor(pal, s.prevState), stateColor(pal, s.state), s.stateMix);
  const ink = o.tone === "secondary" ? pal.inkSecondary : o.tone === "accent" ? pal.accent : pal.ink;
  const hl = (pad: number, r: number) => (s.highlight > 0.01 ? `<rect x="${n(b.x - pad)}" y="${n(b.y - pad)}" width="${n(b.w + 2 * pad)}" height="${n(b.h + 2 * pad)}" rx="${r + pad}" fill="none" stroke="${pal.accent}" stroke-width="2.4" opacity="${n(s.highlight)}"/>` : "");
  switch (o.kind) {
    case "kicker": {
      out.push(`<rect x="${b.x}" y="${b.y + 10}" width="22" height="4" fill="${pal.accent}"/>`);
      out.push(text(b.x + 32, baseline(b.y, 0, o.fontSize) - 4, `${o.sub?.[0] ?? ""}`, 15, pal.inkSecondary, { mono: true, fonts }));
      out.push(text(b.x + 32 + 30, baseline(b.y, 0, o.fontSize) - 4, o.lines[0] ?? "", o.fontSize, pal.accent, { bold: true, fonts }));
      break;
    }
    case "statement":
      o.lines.forEach((l, i) => out.push(text(b.x, baseline(b.y, i, o.fontSize), l, o.fontSize, i === 0 && o.lines.length > 2 ? pal.ink : pal.ink, { bold: o.bold, fonts })));
      break;
    case "group": {
      out.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${SHAPE_R + 4}" fill="${pal.panel}" stroke="${stroke}" stroke-width="1.6"/>`);
      if (o.glyph) out.push(glyph(o.glyph, b.x + 16, b.y + 14, 22, pal.inkSecondary));
      out.push(text(b.x + 46, baseline(b.y + 12, 0, o.fontSize) - 2, o.lines[0] ?? "", o.fontSize, pal.ink, { bold: true, fonts }));
      out.push(hl(5, SHAPE_R + 4));
      break;
    }
    case "node": {
      if (o.plain) {
        o.lines.forEach((l, i) => out.push(text(b.x, baseline(b.y - 2, i, o.fontSize), l, o.fontSize, pal.inkSecondary, { fonts })));
        out.push(hl(6, SHAPE_R));
        break;
      }
      out.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${SHAPE_R}" fill="${pal.panelRaised}" stroke="${stroke}" stroke-width="${s.state === "idle" ? 1.6 : 2.2}"/>`);
      const step = o.sub?.[0];
      if (step) {
        out.push(`<circle cx="${b.x + 22}" cy="${b.y + 22}" r="12" fill="none" stroke="${pal.accent}" stroke-width="1.6"/>`);
        out.push(text(b.x + 22, b.y + 27.5, step, 15, pal.accent, { bold: true, anchor: "middle", fonts }));
        o.lines.forEach((l, i) => out.push(text(b.x + 16, baseline(b.y + 42, i, o.fontSize), l, o.fontSize, pal.ink, { fonts })));
      } else {
        const gy = hasCells ? b.y + 13 : b.y + b.h / 2 - 12;
        if (o.glyph) out.push(glyph(o.glyph, b.x + 14, gy, 24, mixHex(pal.inkSecondary, stateColor(pal, s.state), s.state === "idle" ? 0 : s.stateMix)));
        const textTop = hasCells ? b.y + 10 : b.y + (b.h - o.lines.length * Math.round(o.fontSize * 1.28)) / 2;
        o.lines.forEach((l, i) => out.push(text(b.x + (o.glyph ? 48 : 16), baseline(textTop, i, o.fontSize), l, o.fontSize, pal.ink, { fonts })));
      }
      out.push(hl(5, SHAPE_R));
      break;
    }
    case "cell": {
      const fill = s.state === "busy" ? mixHex(pal.panelRaised, pal.accent, 0.18 * s.stateMix) : s.state === "ok" ? mixHex(pal.panelRaised, pal.ok, 0.16 * s.stateMix) : s.state === "blocked" ? mixHex(pal.panelRaised, pal.signal, 0.16 * s.stateMix) : pal.panelRaised;
      out.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="6" fill="${fill}" stroke="${s.state === "idle" ? pal.hairline : stroke}" stroke-width="${s.state === "idle" ? 1.2 : 1.8}"/>`);
      const big = b.h >= 50;
      if (!big) { out.push(text(b.x + b.w / 2, b.y + b.h / 2 + 5.5, o.lines[0] ?? "", o.fontSize, pal.inkSecondary, { anchor: "middle", fonts })); break; }
      out.push(text(b.x + 9, b.y + 21, o.lines[0] ?? "", o.fontSize, pal.ink, { fonts }));
      // The secondary line says who holds this instance; it crossfades when that changes.
      const subColor = s.state === "ok" ? pal.ok : pal.inkSecondary;
      if (s.subMix < 1 && s.prevSub) out.push(text(b.x + 9, b.y + 41, s.prevSub, 16, subColor, { fonts, opacity: 1 - s.subMix }));
      if (s.sub) out.push(text(b.x + 9, b.y + 41, s.sub, 16, subColor, { fonts, opacity: s.subMix }));
      if (s.value !== undefined) {
        const tw = b.w - 18, ty = b.y + b.h - 15;
        out.push(`<rect x="${b.x + 9}" y="${ty}" width="${tw}" height="7" rx="2" fill="${mixHex(pal.panelRaised, pal.signal, 0.38)}"/>`);
        out.push(`<rect x="${b.x + 9}" y="${ty}" width="${n(tw * Math.max(0, Math.min(1, s.value)))}" height="7" rx="2" fill="${pal.accent}"/>`);
      }
      break;
    }
    case "connector": {
      const pts = o.points ?? [];
      if (pts.length < 2) break;
      const len = polyLength(pts);
      const shown = len * Math.max(0, Math.min(1, s.draw));
      const isRule = o.tone === "accent";
      const color = isRule ? pal.accent : pal.rule;
      const d = `M${pts.map((p) => `${n(p.x)} ${n(p.y)}`).join(" L")}`;
      const dash = o.dashed ? `stroke-dasharray="6 6"` : s.draw < 0.999 ? `stroke-dasharray="${n(shown)} ${n(len + 10)}"` : "";
      out.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="${isRule ? 3 : 1.8}" ${dash} stroke-linecap="round" opacity="${n(o.dashed ? Math.min(1, s.draw) : 1)}"/>`);
      if (!isRule && s.draw > 0.96) {
        const a = pts[pts.length - 2], z = pts[pts.length - 1];
        const ang = Math.atan2(z.y - a.y, z.x - a.x);
        const L = 9, W = 5;
        const p1 = `${n(z.x)},${n(z.y)}`, p2 = `${n(z.x - L * Math.cos(ang) + W * Math.sin(ang))},${n(z.y - L * Math.sin(ang) - W * Math.cos(ang))}`, p3 = `${n(z.x - L * Math.cos(ang) - W * Math.sin(ang))},${n(z.y - L * Math.sin(ang) + W * Math.cos(ang))}`;
        out.push(`<polygon points="${p1} ${p2} ${p3}" fill="${color}"/>`);
      }
      if (s.flow !== null && len > 0) {
        for (const offset of [0, 0.5]) {
          const frac = ((s.flow / len) + offset) % 1;
          const p = pointAt(pts, frac);
          out.push(`<circle cx="${n(p.x)}" cy="${n(p.y)}" r="4.5" fill="${pal.accent}"/>`);
        }
      }
      break;
    }
    case "chip": {
      const accent = o.tone === "accent";
      out.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${b.h / 2}" fill="${pal.ground}" stroke="${accent ? pal.accent : pal.hairline}" stroke-width="${accent ? 1.8 : 1.2}"/>`);
      out.push(text(b.x + b.w / 2, b.y + b.h / 2 + o.fontSize * 0.36, o.lines[0] ?? "", o.fontSize, accent ? pal.accent : pal.inkSecondary, { anchor: "middle", bold: o.bold, fonts }));
      out.push(hl(4, b.h / 2));
      break;
    }
    case "list": {
      const after = o.tone === "accent";
      out.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${SHAPE_R}" fill="${pal.panel}" stroke="${after ? pal.ok : pal.signal}" stroke-width="1.6"/>`);
      out.push(`<rect x="${b.x}" y="${b.y + 14}" width="4" height="30" fill="${after ? pal.ok : pal.signal}"/>`);
      out.push(text(b.x + 24, b.y + 38, o.sub?.[0] ?? "", 24, after ? pal.ok : pal.signal, { bold: true, fonts }));
      o.lines.forEach((l, i) => out.push(text(b.x + 24, baseline(b.y + 64, i, o.fontSize), l, o.fontSize, pal.ink, { fonts })));
      out.push(hl(5, SHAPE_R));
      break;
    }
    case "metric":
      out.push(text(b.x, baseline(b.y, 0, o.fontSize) - o.fontSize * 0.15, o.lines[0] ?? "", o.fontSize, pal.accent, { bold: true, fonts }));
      break;
    case "callout":
      o.lines.forEach((l, i) => out.push(text(b.x, baseline(b.y, i, o.fontSize), l, o.fontSize, ink, { fonts })));
      break;
    case "meter":
      out.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="3" fill="${pal.hairline}"/>`);
      out.push(`<rect x="${b.x}" y="${b.y}" width="${n(b.w * Math.max(0, Math.min(1, s.value ?? 0)))}" height="${b.h}" rx="3" fill="${pal.accent}"/>`);
      break;
    case "code": {
      const lhPx = Math.round(o.fontSize * 1.28);
      out.push(text(b.x, b.y - 12, o.sub?.[0] ?? "", 15, pal.inkSecondary, { mono: true, fonts }));
      out.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="8" fill="${pal.codeGround}" stroke="${pal.hairline}" stroke-width="1.2"/>`);
      if (s.lines && o.firstLine !== undefined) {
        const a = Math.max(0, s.lines[0] - o.firstLine), z = Math.min(o.lines.length - 1, s.lines[1] - o.firstLine);
        if (z >= a) out.push(`<rect x="${b.x + 2}" y="${b.y + 14 + a * lhPx - 2}" width="${b.w - 4}" height="${(z - a + 1) * lhPx + 2}" fill="${pal.codeHighlight}" opacity="${n(s.linesMix)}"/><rect x="${b.x + 2}" y="${b.y + 14 + a * lhPx - 2}" width="3" height="${(z - a + 1) * lhPx + 2}" fill="${pal.accent}" opacity="${n(s.linesMix)}"/>`);
      }
      o.lines.forEach((l, i) => {
        const yb = baseline(b.y + 14, i, o.fontSize);
        out.push(text(b.x + 52, yb, String((o.firstLine ?? 1) + i), o.fontSize - 2, pal.inkSecondary, { mono: true, anchor: "end", fonts }));
        out.push(text(b.x + 68, yb, l, o.fontSize, pal.ink, { mono: true, fonts }));
      });
      break;
    }
    case "source":
      out.push(`<rect x="${b.x + 2}" y="${b.y + 7}" width="7" height="7" transform="rotate(45 ${b.x + 5.5} ${b.y + 10.5})" fill="${pal.accent}"/>`);
      out.push(text(b.x + 20, b.y + 15.5, o.lines[0] ?? "", o.fontSize, pal.inkSecondary, { mono: true, fonts }));
      break;
    default:
      o.lines.forEach((l, i) => out.push(text(b.x, baseline(b.y, i, o.fontSize), l, o.fontSize, ink, { fonts })));
  }
  const body = out.join("");
  if (!body) return "";
  const op = o.kind === "connector" ? 1 : s.opacity;
  return op < 0.999 || s.rise > 0.01 ? `<g opacity="${n(op)}"${s.rise > 0.01 ? ` transform="translate(0 ${n(s.rise)})"` : ""}>${body}</g>` : body;
}
const SHAPE_R = 10;

const HUD = new Set(["kicker", "source"]);

/** The SVG for scene-local time t. */
export function renderFrameSvg(scene: SceneSpec, t: number, o: FrameOptions): string {
  const pal = PALETTES[o.style] ?? PALETTES.brody;
  const fonts = { sans: o.fontSans ?? "DejaVu Sans Condensed", mono: o.fontMono ?? "DejaVu Sans Mono" };
  const st = sceneStateAt(scene, t);
  const objects = [...scene.objects].sort((a, b) => a.z - b.z);
  const parents = new Set(scene.objects.filter((x) => x.kind === "cell" && x.parent).map((x) => x.parent!));
  const draw = (x: VisualObject) => drawObject(x, st.objs.get(x.id)!, pal, fonts, parents.has(x.id));
  const world = objects.filter((x) => !HUD.has(x.kind));
  const hud = objects.filter((x) => HUD.has(x.kind));
  const v = st.view;
  const zoom = Math.abs(v.w - 1280) > 0.5 || Math.abs(v.x) > 0.5 || Math.abs(v.y) > 0.5;
  const transform = zoom ? ` transform="scale(${n(1280 / v.w * 1000) / 1000}) translate(${n(-v.x)} ${n(-v.y)})"` : "";
  let body = world.map(draw).join("");
  if (st.scrim.level > 0.005) {
    const r = st.scrim.region ?? { x: -10, y: -10, w: 1300, h: 740 };
    body += `<rect x="${r.x - 6}" y="${r.y - 6}" width="${r.w + 12}" height="${r.h + 12}" rx="12" fill="${pal.scrim}" opacity="${n(st.scrim.level)}"/>`;
    body += world.filter((x) => st.scrim.keep.has(x.id)).map(draw).join("");
  }
  const W = o.width ?? 1280, H = o.height ?? 720;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 1280 720"><rect width="1280" height="720" fill="${pal.ground}"/><line x1="64" y1="90" x2="1216" y2="90" stroke="${pal.hairline}" stroke-width="1"/><g${transform}>${body}</g>${hud.map(draw).join("")}</svg>`;
}

/** The scene that covers absolute time `ms`, and the local time inside it. */
export function sceneAt(scenes: SceneSpec[], ms: number): { scene: SceneSpec; local: number } | null {
  if (!scenes.length) return null;
  for (const s of scenes) if (ms >= s.startMs && ms < s.endMs) return { scene: s, local: ms - s.startMs };
  const last = scenes[scenes.length - 1];
  return ms >= last.endMs ? { scene: last, local: last.endMs - last.startMs - 1 } : { scene: scenes[0], local: 0 };
}
