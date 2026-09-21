import { Canvas } from "./build";
import type { DeckContent } from "./content";
import { textWidth } from "./measure";
import { H, W, type DeckSlides, type Slide } from "./scene";
import { C, MARGIN, PRIORITY_COLOR, SEVERITY_COLOR } from "./theme";

const X = MARGIN;
const CW = W - MARGIN * 2;
const RISK_COLOR = { none: C.info, low: C.low, medium: C.med, high: C.high, critical: C.crit } as const;
const RISK_LABEL = { none: "", low: "Low risk", medium: "Medium risk", high: "High risk", critical: "Critical risk" } as const;
const LANE_COLOR: Record<string, string> = { interface: C.accent, api: C.navy, logic: "#2C6E8F", data: "#3F7F6E", external: "#7B5EA7" };
const LANE_ICON: Record<string, string> = { interface: "ui", api: "api", logic: "service", data: "data", external: "external" };
const ROLE_ICON: Record<string, string> = { ui: "ui", api: "api", service: "service", data: "data", schema: "data", job: "job", infra: "infra", util: "util", entry: "service", ai: "service" };
const ROLE_COLOR: Record<string, string> = { ui: C.accent, api: C.navy, service: "#2C6E8F", data: "#3F7F6E", schema: "#3F7F6E", job: "#8A5A9E", infra: "#5B6E7C", util: "#5B6E7C", entry: C.accent, ai: "#8A5A9E" };

const num = (n: number) => n.toLocaleString("en-US");
const pct = (f: number) => `${Math.round(f * 100)}%`;
const plural = (n: number, w: string) => `${num(n)} ${w}${n === 1 ? "" : "s"}`;
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function refText(c: DeckContent, ...keys: string[]): string {
  return keys.map((k) => c.refs.find((r) => r.key === k)).filter((r): r is NonNullable<typeof r> => !!r).map((r) => `§${r.n} ${r.title}`).join(" · ");
}

/** The slide frame: a navy header with the title, on a light page. The footer is added once page numbers are known. */
function frame(id: string, kicker: string, title: string, ref: string, notes: string): { cv: Canvas; done: () => Slide } {
  const cv = new Canvas();
  cv.rect(0, 0, W, H, { fill: C.bg });
  cv.rect(0, 0, W, 96, { fill: C.navy });
  cv.rect(0, 96, W, 4, { fill: C.accent });
  cv.text(kicker.toUpperCase(), X, 20, 700, 18, { size: 13, color: C.accentLight, spacing: 1.6, maxLines: 1 });
  cv.text(title, X, 40, CW, 46, { size: 32, color: C.white, bold: true, font: "serif", maxLines: 1, valign: "m" });
  return { cv, done: () => ({ id, title, kicker, ref: ref || undefined, notes, prims: cv.prims }) };
}

// ---------------------------------------------------------------------------------------------------------------------------
function titleSlide(c: DeckContent): Slide {
  const cv = new Canvas();
  cv.rect(0, 0, W, H, { fill: C.navyDark });
  cv.poly([[W, 0], [W, H], [860, H], [1010, 0]], { fill: C.navy, opacity: 0.55 });
  cv.rect(0, 0, 10, H, { fill: C.accent });
  cv.text("EXECUTIVE SUMMARY", 72, 86, 600, 20, { size: 15, color: C.accentLight, spacing: 2.4, maxLines: 1 });
  const nl = cv.fit(c.project.name, 72, 122, 660, 150, { size: 60, min: 36, color: C.white, bold: true, font: "serif", lh: 66, maxLines: 2 });
  const y2 = 122 + nl * (nl === 1 ? 66 : 60) + 26;
  cv.rect(72, y2, 84, 5, { fill: C.accent, r: 2.5 });
  cv.text(c.headline, 72, y2 + 26, 640, 170, { size: 23, color: "#DCEBF4", lh: 33, maxLines: 5 });
  const stat = (label: string) => c.kpis.find((k) => k.label === label)?.value;
  const strip: [string, string][] = ([["Functional areas", "areas"], ["API routes", "API routes"], ["Data models", "data models"], ["Critical or high findings", "serious findings"]] as const)
    .map(([l, t]) => [stat(l) ?? "", t] as [string, string]).filter(([v]) => v && v !== "0").slice(0, 4);
  strip.forEach(([v, t], i) => {
    const sx = 72 + i * 158;
    cv.text(v, sx, 392, 140, 54, { size: 44, color: i === strip.length - 1 && t === "serious findings" ? "#FF9A8F" : C.white, bold: true, font: "serif", maxLines: 1, valign: "m" });
    cv.text(t, sx, 448, 150, 24, { size: 15, color: "#9FD3E8", maxLines: 1 });
  });
  let x = 72;
  const chips = [`Analysed ${plural(c.coverage.filesAnalysed, "file")}`, new Date(c.generatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }), c.project.branch ? `Branch ${c.project.branch}` : ""].filter(Boolean);
  for (const t of chips) x += cv.pill(t, x, 560, { fill: "#24566F", size: 14, bold: false, color: "#DCEBF4" }) + 10;
  cv.text("Part of the Repository Intelligence Report. Every figure here comes from the same analysis.", 72, 610, 640, 40, { size: 14, color: "#9FBBCC", lh: 20, maxLines: 2 });

  // A small map of the system on the right: one column per layer, one dot per area, sized by how much code it holds.
  const lanes = c.architecture.lanes.filter((l) => l.areas.length > 0);
  const gx = 800, gy = 130, gw = 400, gh = 440;
  if (lanes.length) {
    const colW = Math.min(64, (gw - (lanes.length - 1) * 30) / lanes.length);
    const gap = lanes.length > 1 ? (gw - colW * lanes.length) / (lanes.length - 1) : 0;
    const maxFiles = Math.max(1, ...lanes.flatMap((l) => l.areas.map((a) => a.files)));
    const centers = new Map<string, { x: number; ys: number[] }>();
    lanes.forEach((l, i) => {
      const x0 = gx + i * (colW + gap);
      cv.rect(x0, gy, colW, gh, { fill: "#1E5675", r: colW / 2, opacity: 0.6 });
      const shown = l.areas.slice(0, 6);
      const ys: number[] = [];
      shown.forEach((a, k) => {
        const r = 8 + 13 * Math.sqrt(a.files / maxFiles);
        const cy = gy + 44 + (k + 0.5) * ((gh - 88) / shown.length);
        cv.ellipse(x0 + colW / 2 - r, cy - r, r * 2, r * 2, { fill: a.risk === "critical" || a.risk === "high" ? RISK_COLOR[a.risk] : "#7CCBEE" });
        ys.push(cy);
      });
      centers.set(l.id, { x: x0 + colW / 2, ys });
    });
    for (const link of c.architecture.links) {
      const a = centers.get(link.from), b = centers.get(link.to);
      if (!a || !b) continue;
      const ya = a.ys[Math.floor(a.ys.length / 2)] ?? gy + gh / 2, yb = b.ys[Math.floor(b.ys.length / 2)] ?? gy + gh / 2;
      cv.line(a.x + 14, ya, b.x - 14, yb, { color: "#9FD3E8", sw: 2, arrow: true });
    }
    cv.text("How the system is layered", gx, gy + gh + 14, gw, 20, { size: 13, color: "#9FBBCC", align: "c", maxLines: 1 });
  }
  return { id: "title", title: c.project.name, kicker: "Executive summary", notes: `Executive summary of ${c.project.name}. ${c.headline} This deck and the Repository Intelligence Report are two views of one analysis: every slide names the report section that holds the detail.`, dark: true, prims: cv.prims };
}

function summarySlide(c: DeckContent): Slide {
  const { cv, done } = frame("summary", "Executive summary", "The system in brief", refText(c, "exec"), `${c.headline} ${c.summary} Detail: ${refText(c, "exec")}.`);
  cv.fit(c.headline, X, 126, CW, 118, { size: 30, min: 22, color: C.navy, bold: true, font: "serif", lh: 40, maxLines: 4 });
  cv.text(c.summary, X, 252, CW, 112, { size: 18, color: C.text, lh: 27, maxLines: 4 });
  const next = c.actions.find((a) => a.priority === "Now") ?? c.actions[0];
  const pts = [...c.keyPoints.slice(0, 3), ...(next ? [{ title: "What to do first", detail: next.action }] : [])];
  const n = Math.max(1, pts.length), gap = 16, w = (CW - gap * (n - 1)) / n;
  pts.forEach((k, i) => {
    const x = X + i * (w + gap), y = 378;
    const hot = k.title === "Where the risk is";
    cv.card(x, y, w, 262, { accent: hot ? C.crit : k.title === "What to do first" ? C.ok : C.accent });
    cv.text(k.title, x + 24, y + 22, w - 40, 28, { size: 19, color: hot ? C.crit : k.title === "What to do first" ? C.ok : C.accent, bold: true, maxLines: 1 });
    cv.text(k.detail, x + 24, y + 62, w - 44, 184, { size: 17, color: C.text, lh: 26, maxLines: 7 });
  });
  return done();
}

function glanceSlide(c: DeckContent): Slide {
  const risk = c.quality.severity[0].count + c.quality.severity[1].count;
  const { cv, done } = frame("glance", "At a glance", "The numbers that matter", refText(c, "glance"), `The system spans ${plural(c.coverage.sourceFiles, "source file")} and ${c.kpis[1]?.value ?? ""} lines of code. ${c.quality.verdict} Detail: ${refText(c, "glance")}.`);
  const k = c.kpis.slice(0, 8);
  const gap = 16, w = (CW - gap * 3) / 4, h = 140;
  k.forEach((m, i) => {
    const x = X + (i % 4) * (w + gap), y = 130 + Math.floor(i / 4) * (h + gap);
    const hot = m.label.startsWith("Critical") && Number(m.value) > 0;
    cv.card(x, y, w, h, { accent: hot ? C.crit : C.accent });
    const long = m.value.length > 9;
    cv.fit(m.value, x + 26, y + 18, w - 40, long ? 62 : 58, { size: long ? 26 : 50, min: 16, color: hot ? C.crit : C.navy, bold: true, font: "serif", maxLines: long ? 2 : 1, valign: "m" });
    cv.text(m.label, x + 26, y + h - 46, w - 40, 28, { size: 17, color: C.muted, maxLines: 1 });
  });
  const tone = risk > 0 && c.quality.severity[0].count > 0 ? C.crit : risk > 0 ? C.high : C.ok;
  const by = 130 + 2 * (h + gap) + 4;
  cv.card(X, by, CW, 100, { accent: tone });
  cv.text("Overall assessment", X + 28, by + 14, 400, 22, { size: 14, color: C.muted, bold: true, spacing: 0.8, maxLines: 1 });
  cv.text(c.quality.verdict, X + 28, by + 40, CW - 60, 60, { size: 21, color: C.navy, bold: true, lh: 29, maxLines: 2 });
  if (c.tech.frameworks.length) {
    cv.text("Built with", X, by + 116, 120, 30, { size: 16, color: C.muted, bold: true, valign: "m", maxLines: 1 });
    let x = X + 104;
    for (const f of c.tech.frameworks.slice(0, 7)) { const pw = textWidth(f, 15, "sans", true) + 28; if (x + pw > X + CW) break; x += cv.pill(f, x, by + 116, { fill: C.sky, color: C.navy, size: 15 }) + 10; }
  }
  return done();
}

function capabilitiesSlide(c: DeckContent): Slide {
  const caps = c.capabilities;
  const { cv, done } = frame("capabilities", "What the system does", "Main capabilities", refText(c, "areas"), `${caps.length} main capabilities, led by ${caps.slice(0, 3).map((a) => a.name).join(", ")}. Bars show how much of the code base each one accounts for; a risk tag appears where the review found serious issues. Detail: ${refText(c, "areas")}.`);
  const maxFiles = Math.max(1, ...caps.map((a) => a.files));
  const gap = 16, w = (CW - gap) / 2, h = 122;
  caps.forEach((a, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = X + col * (w + gap), y = 126 + row * (h + 12);
    cv.card(x, y, w, h);
    const color = ROLE_COLOR[a.role] ?? C.accent;
    cv.icon(ROLE_ICON[a.role] ?? "default", x + 46, y + 44, 26, color);
    cv.text(a.name, x + 88, y + 14, w - 250, 28, { size: 20, color: C.navy, bold: true, maxLines: 1 });
    cv.text(a.line, x + 88, y + 46, w - 88 - 172, 64, { size: 15, color: C.muted, lh: 21, maxLines: 3 });
    cv.bar(x + w - 150, y + 20, 120, 10, a.files / maxFiles, color);
    cv.text(`${plural(a.files, "file")}`, x + w - 150, y + 36, 120, 18, { size: 12, color: C.muted, maxLines: 1 });
    if (a.risk !== "none" && a.risk !== "low") cv.pill(RISK_LABEL[a.risk], x + w - 12 - (textWidth(RISK_LABEL[a.risk], 12, "sans", true) + 18), y + h - 34, { fill: RISK_COLOR[a.risk], size: 12, padX: 18 });
  });
  if (!caps.length) cv.text("No distinct capabilities were identified.", X, 140, CW, 40, { size: 18, color: C.muted });
  return done();
}

function architectureSlide(c: DeckContent): Slide {
  const lanes = c.architecture.lanes.filter((l) => l.areas.length > 0);
  const { cv, done } = frame("architecture", "How it is built", "Architecture: who and what talks to whom", refText(c, "arch", "codemap"), `${c.architecture.pattern}. Read left to right: people and systems come in on the left, business rules are in the middle, information is stored and outside services are on the right. Arrows show the strength of the connections between layers. Detail: ${refText(c, "arch", "codemap")}.`);
  const top = 122, laneH = c.architecture.foundation.length ? 392 : 440;
  const n = Math.max(1, lanes.length), gap = 54, lw = (CW - gap * (n - 1)) / n;
  const centers: { id: string; x: number; y: number; w: number }[] = [];
  const maxLink = Math.max(1, ...c.architecture.links.map((l) => l.weight));
  lanes.forEach((l, i) => {
    const x = X + i * (lw + gap);
    const color = LANE_COLOR[l.id] ?? C.navy;
    cv.rect(x, top, lw, laneH, { fill: C.sky, r: 14 });
    cv.rect(x, top, lw, 50, { fill: color, r: 14 });
    cv.rect(x, top + 30, lw, 20, { fill: color });
    cv.icon(LANE_ICON[l.id] ?? "default", x + 30, top + 25, 15, "#FFFFFF33");
    cv.text(l.label, x + 54, top, lw - 62, 50, { size: 15, color: C.white, bold: true, valign: "m", maxLines: 2, lh: 18 });
    const shown = l.areas.length > 5 ? l.areas.slice(0, 4) : l.areas;
    const chipH = 58;
    shown.forEach((a, k) => {
      const y = top + 62 + k * (chipH + 6);
      cv.card(x + 12, y, lw - 24, chipH, { r: 8, accent: a.risk === "high" || a.risk === "critical" ? RISK_COLOR[a.risk] : color });
      cv.text(a.name, x + 28, y + 4, lw - 48, 36, { size: 14, color: C.navy, bold: true, maxLines: 2, lh: 17, valign: "m" });
      cv.text(`${plural(a.files, "file")}`, x + 28, y + 40, lw - 48, 16, { size: 12, color: C.muted, maxLines: 1 });
    });
    if (l.areas.length > shown.length) cv.text(`+ ${l.areas.length - shown.length} more`, x + 12, top + laneH - 26, lw - 24, 20, { size: 13, color: C.muted, align: "c", maxLines: 1 });
    centers.push({ id: l.id, x, y: top + laneH / 2, w: lw });
  });
  for (const link of c.architecture.links) {
    const a = centers.find((k) => k.id === link.from), b = centers.find((k) => k.id === link.to);
    if (!a || !b || b.x <= a.x) continue;
    const span = centers.indexOf(b) - centers.indexOf(a);
    const y = top + laneH / 2 + (span > 1 ? 66 : 0);
    if (span === 1) cv.arrow(a.x + a.w + 3, y, gap - 6, 10 + 20 * (link.weight / maxLink), C.accent, 0.85);
  }
  if (c.architecture.foundation.length) {
    const fy = top + laneH + 12;
    cv.rect(X, fy, CW, 70, { fill: C.card, stroke: C.skyDeep, sw: 1.5, r: 12 });
    cv.text("Shared foundations", X + 20, fy + 8, 200, 24, { size: 15, color: C.navy, bold: true, maxLines: 1 });
    cv.text("used across the system", X + 20, fy + 34, 200, 24, { size: 13, color: C.muted, maxLines: 1 });
    let x = X + 240;
    for (const f of c.architecture.foundation.slice(0, 7)) { const pw = textWidth(f.name, 14, "sans", true) + 26; if (x + pw > X + CW - 12) break; x += cv.pill(f.name, x, fy + 22, { fill: C.sky, color: C.navy, size: 14 }) + 10; }
  }
  cv.text(`Overall pattern: ${c.architecture.pattern}`, X, H - 72, CW, 24, { size: 16, color: C.navy, bold: true, maxLines: 1 });
  if (!lanes.length) cv.text("No layered structure was detected.", X, 150, CW, 40, { size: 18, color: C.muted });
  return done();
}

function technologySlide(c: DeckContent): Slide {
  const { cv, done } = frame("technology", "Technology and footprint", "What it is made of", refText(c, "glance", "arch"), `The code is mainly ${c.tech.languages.slice(0, 2).map((l) => l.name).join(" and ")}. It is ${c.tech.footprint[0]?.value ?? ""} source files and ${c.tech.footprint[1]?.value ?? ""} lines. Detail: ${refText(c, "glance", "arch")}.`);
  const palette = [C.navy, C.accent, "#3F7F6E", "#8A5A9E", C.med, C.info];
  const cx = 250, cy = 320, r = 140;
  cv.donut(cx, cy, r, 46, c.tech.languages.map((l, i) => ({ value: l.share, color: palette[i % palette.length] })));
  cv.text(String(c.tech.languages.filter((l) => l.name !== "Other").length), cx - 60, cy - 34, 120, 44, { size: 40, color: C.navy, bold: true, font: "serif", align: "c", maxLines: 1 });
  cv.text("languages", cx - 60, cy + 12, 120, 22, { size: 15, color: C.muted, align: "c", maxLines: 1 });
  c.tech.languages.slice(0, 6).forEach((l, i) => {
    const y = 172 + i * 38;
    cv.rect(430, y + 5, 16, 16, { fill: palette[i % palette.length], r: 4 });
    cv.text(l.name, 456, y, 150, 26, { size: 17, color: C.text, bold: true, valign: "m", maxLines: 1 });
    cv.text(pct(l.share), 590, y, 60, 26, { size: 17, color: C.muted, align: "r", valign: "m", maxLines: 1 });
  });
  const tx = 700, tw = X + CW - tx;
  cv.text("Footprint", tx, 130, tw, 26, { size: 18, color: C.navy, bold: true, maxLines: 1 });
  cv.table(tx, 164, [tw - 130, 130], c.tech.footprint.map((f) => [{ text: f.label, size: 16 }, { text: f.value, size: 18, bold: true, align: "r" as const, color: C.navy }]), { minRowH: 38, padY: 8 });
  const groups: [string, string[]][] = [["Frameworks", c.tech.frameworks], ["Data stores", c.tech.stores], ["Platform", c.tech.platform]];
  let gy = 420;
  for (const [label, items] of groups) {
    if (!items.length) continue;
    cv.text(label, tx, gy, 130, 30, { size: 15, color: C.muted, bold: true, valign: "m", maxLines: 1 });
    let x = tx + 130;
    for (const it of items) { const pw = textWidth(it, 14, "sans", true) + 26; if (x + pw > tx + tw) break; x += cv.pill(it, x, gy, { fill: C.sky, color: C.navy, size: 14 }) + 8; }
    gy += 46;
  }
  return done();
}

function flowsSlide(c: DeckContent): Slide {
  const { cv, done } = frame("flows", "How work moves", "Following a request through the system", refText(c, "flows", "runtime"), `Each row traces a real activity through the parts of the system that handle it, ending at any outside service it reaches. Detail: ${refText(c, "flows", "runtime")}.`);
  const flows = c.flows.slice(0, 4);
  if (!flows.length) {
    cv.text("No end-to-end activities were traced. The layered view on the architecture slide shows how the parts connect.", X, 150, CW, 60, { size: 18, color: C.muted });
    return done();
  }
  const rowH = 112, gap = 14;
  flows.forEach((f, i) => {
    const y = 128 + i * (rowH + gap);
    cv.card(X, y, CW, rowH);
    cv.text("Activity", X + 24, y + 16, 200, 18, { size: 12, color: C.muted, bold: true, spacing: 1, maxLines: 1 });
    cv.text(f.name, X + 24, y + 38, 232, 64, { size: 20, color: C.navy, bold: true, font: "serif", lh: 26, maxLines: 2 });
    const steps = [...f.path, ...f.externals.slice(0, 2)];
    const startX = X + 290, avail = X + CW - 20 - startX;
    const sw = Math.min(210, (avail + 14 * (steps.length - 1)) / steps.length);
    steps.forEach((s, k) => {
      const external = k >= f.path.length;
      const x = startX + k * (sw - 14);
      cv.chevron(x, y + 24, sw, 64, external ? "#7B5EA7" : k === 0 ? C.accent : C.navy, k === 0);
      cv.text(s, x + (k === 0 ? 12 : 30), y + 24, sw - (k === 0 ? 40 : 56), 64, { size: 15, color: C.white, bold: true, valign: "m", align: "c", lh: 18, maxLines: 3 });
    });
  });
  cv.text("Blue steps are parts of the system; purple steps are outside services the activity depends on.", X, H - 74, CW, 22, { size: 14, color: C.muted, maxLines: 1 });
  return done();
}

function dataSlide(c: DeckContent): Slide {
  const { cv, done } = frame("data", "Information and partners", "Data the system holds, services it relies on", refText(c, "data", "integrations"), `${plural(c.data.models, "data model")} with ${plural(c.data.relations, "relationship")} between them. The system relies on ${plural(c.integrations.length, "outside service")}; the last column shows the business effect if one is unavailable. Detail: ${refText(c, "data", "integrations")}.`);
  const lw = 430;
  const tiles: [string, string][] = [["Data models", String(c.data.models)], ["Relationships", String(c.data.relations)], ["Data stores", String(c.data.stores.length || 0)]];
  const tw = (lw - 24) / 3;
  tiles.forEach(([label, value], i) => {
    const x = X + i * (tw + 12);
    cv.card(x, 128, tw, 92, { accent: C.accent });
    cv.text(value, x + 20, 138, tw - 28, 44, { size: 32, color: C.navy, bold: true, font: "serif", maxLines: 1, valign: "m" });
    cv.text(label, x + 20, 184, tw - 28, 24, { size: 14, color: C.muted, maxLines: 1 });
  });
  if (c.data.stores.length) cv.text(`Stored in ${c.data.stores.join(", ")}`, X, 232, lw, 24, { size: 15, color: C.muted, maxLines: 1 });
  if (c.data.entities.length) {
    cv.text("Most connected information", X, 268, lw, 26, { size: 17, color: C.navy, bold: true, maxLines: 1 });
    cv.table(X, 300, [lw - 170, 90, 80], [[{ text: "Information" }, { text: "Fields", align: "r" }, { text: "Links", align: "r" }], ...c.data.entities.map((e) => [{ text: e.name, bold: true, color: C.navy }, { text: String(e.fields), align: "r" as const }, { text: String(e.links), align: "r" as const }])], { header: true, size: 16, minRowH: 46, maxH: 340 });
  }
  const rx = X + lw + 40, rw = X + CW - rx;
  cv.text("Outside services", rx, 128, rw, 26, { size: 17, color: C.navy, bold: true, maxLines: 1 });
  if (c.integrations.length) cv.table(rx, 162, [170, 200, rw - 370], [[{ text: "Service" }, { text: "What it does" }, { text: "If unavailable" }], ...c.integrations.slice(0, 6).map((i) => [{ text: `${i.name}`, bold: true, color: C.navy, maxLines: 2 }, { text: i.purpose, maxLines: 2 }, { text: i.ifDown, maxLines: 3 }])], { header: true, size: 15, padY: 10, minRowH: 54, maxH: 520 });
  else cv.text("No outside services were detected.", rx, 170, rw, 30, { size: 16, color: C.muted });
  return done();
}

function riskSlide(c: DeckContent): Slide {
  const q = c.quality;
  const { cv, done } = frame("risk", "Quality and risk", "Where the system stands", refText(c, "review", "risks"), `${q.verdict} ${plural(q.total, "finding")} in total. Themes on the right group the findings by the kind of exposure they create. Detail: ${refText(c, "review", "risks")}.`);
  const cx = 230, cy = 300, r = 130;
  const colors = [C.crit, C.high, C.med, C.low];
  cv.donut(cx, cy, r, 44, q.severity.map((s, i) => ({ value: s.count, color: colors[i] })));
  cv.text(String(q.total), cx - 70, cy - 36, 140, 50, { size: 44, color: C.navy, bold: true, font: "serif", align: "c", maxLines: 1 });
  cv.text(q.total === 1 ? "finding" : "findings", cx - 70, cy + 14, 140, 22, { size: 16, color: C.muted, align: "c", maxLines: 1 });
  q.severity.forEach((s, i) => {
    const y = 470 + i * 34;
    cv.rect(X + 60, y + 6, 16, 16, { fill: colors[i], r: 4 });
    cv.text(s.label, X + 90, y, 140, 28, { size: 17, color: C.text, valign: "m", maxLines: 1 });
    cv.text(String(s.count), X + 240, y, 60, 28, { size: 18, color: C.navy, bold: true, align: "r", valign: "m", maxLines: 1 });
  });
  const rx = 470, rw = X + CW - rx;
  const tone = q.severity[0].count > 0 ? C.crit : q.severity[1].count > 0 ? C.high : C.ok;
  cv.card(rx, 128, rw, 84, { accent: tone });
  cv.text(q.verdict, rx + 26, 134, rw - 44, 72, { size: 18, color: C.navy, bold: true, lh: 25, maxLines: 3, valign: "m" });
  cv.text("Risk by theme", rx, 230, 300, 24, { size: 17, color: C.navy, bold: true, maxLines: 1 });
  const maxTotal = Math.max(1, ...q.themes.map((t) => t.sev.critical + t.sev.high + t.sev.medium + t.sev.low));
  q.themes.slice(0, 5).forEach((t, i) => {
    const y = 262 + i * 80;
    cv.text(t.theme, rx, y, 300, 26, { size: 17, color: C.text, bold: true, maxLines: 1 });
    cv.text(t.exposure, rx, y + 28, 400, 40, { size: 13, color: C.muted, lh: 17, maxLines: 2 });
    const bx = rx + 420, bw = rw - 420 - 46;
    const total = t.sev.critical + t.sev.high + t.sev.medium + t.sev.low;
    cv.rect(bx, y + 8, bw, 22, { fill: C.sky, r: 11 });
    let x = bx;
    for (const [k, col] of [["critical", C.crit], ["high", C.high], ["medium", C.med], ["low", C.low]] as const) {
      const wSeg = (t.sev[k] / maxTotal) * bw;
      if (wSeg > 0) { cv.rect(x, y + 8, Math.max(6, wSeg), 22, { fill: col, r: 3 }); x += Math.max(6, wSeg); }
    }
    cv.text(String(total), bx + bw + 8, y + 6, 40, 26, { size: 16, color: C.navy, bold: true, valign: "m", maxLines: 1 });
  });
  if (!q.themes.length) cv.text("No issues were found by the analysis.", rx, 270, rw, 30, { size: 18, color: C.ok, bold: true });
  return done();
}

function prioritiesSlide(c: DeckContent): Slide {
  const q = c.quality;
  const { cv, done } = frame("priorities", "Quality and risk", "Where the risk is concentrated", refText(c, "review", "risks"), `The left chart shows which parts of the system carry the most serious findings. The table lists the issues to act on first, in business terms, with the reference number used in the report. Detail: ${refText(c, "review", "risks")}.`);
  const lw = 400;
  cv.text("Risk by part of the system", X, 128, lw, 26, { size: 17, color: C.navy, bold: true, maxLines: 1 });
  const max = Math.max(1, ...q.areaRisk.map((a) => a.sev.critical + a.sev.high + a.sev.medium + a.sev.low));
  q.areaRisk.slice(0, 6).forEach((a, i) => {
    const y = 166 + i * 74;
    cv.text(a.area, X, y, lw, 24, { size: 16, color: C.text, bold: true, maxLines: 1 });
    cv.rect(X, y + 30, lw - 44, 20, { fill: C.sky, r: 10 });
    let x = X;
    for (const [k, col] of [["critical", C.crit], ["high", C.high], ["medium", C.med], ["low", C.low]] as const) {
      const w = (a.sev[k] / max) * (lw - 44);
      if (w > 0) { cv.rect(x, y + 30, Math.max(6, w), 20, { fill: col, r: 3 }); x += Math.max(6, w); }
    }
    cv.text(String(a.sev.critical + a.sev.high + a.sev.medium + a.sev.low), X + lw - 36, y + 26, 36, 28, { size: 16, color: C.navy, bold: true, valign: "m", align: "r", maxLines: 1 });
  });
  if (!q.areaRisk.length) cv.text("No findings to chart.", X, 170, lw, 30, { size: 16, color: C.ok, bold: true });
  const rx = X + lw + 40, rw = X + CW - rx;
  cv.text("Issues to act on first", rx, 128, rw, 26, { size: 17, color: C.navy, bold: true, maxLines: 1 });
  if (q.priorities.length) {
    cv.table(rx, 162, [98, 176, rw - 98 - 176 - 96, 96], [
      [{ text: "Severity" }, { text: "Issue" }, { text: "What could go wrong" }, { text: "Ref", align: "c" }],
      ...q.priorities.slice(0, 6).map((p) => [
        { text: p.severity, pill: SEVERITY_COLOR[p.severity] ?? C.info, color: C.white, bold: true, align: "c" as const, size: 13 },
        { text: p.count > 1 ? `${p.issue} (${p.count} places)` : p.issue, bold: true, color: C.navy, size: 14, maxLines: 3 },
        { text: p.exposure, size: 13, maxLines: 3 },
        { text: p.ref, align: "c" as const, size: 13, color: C.muted },
      ]),
    ], { header: true, size: 14, padY: 8, maxH: 500 });
  } else cv.text("No serious issues were found.", rx, 170, rw, 30, { size: 18, color: C.ok, bold: true });
  return done();
}

function testingSlide(c: DeckContent): Slide {
  const t = c.testing;
  const { cv, done } = frame("testing", "Quality assurance and readiness", "How well protected is it?", refText(c, "testing"), `${plural(t.files, "automated test file")}. Coverage bars show how many of the important files in each part of the system are exercised by tests. The checklist on the right is derived from the same findings as the report. Detail: ${refText(c, "testing")}.`);
  const lw = 560;
  cv.text("Test coverage by part of the system", X, 128, lw, 26, { size: 17, color: C.navy, bold: true, maxLines: 1 });
  t.coverage.slice(0, 7).forEach((a, i) => {
    const y = 168 + i * 60, f = a.total ? a.tested / a.total : 0;
    cv.text(a.area, X, y, 250, 30, { size: 16, color: C.text, bold: true, valign: "m", maxLines: 1 });
    cv.bar(X + 260, y + 6, 220, 18, f, f >= 0.6 ? C.ok : f > 0 ? C.med : C.crit);
    cv.text(`${a.tested} of ${a.total}`, X + 490, y, 80, 30, { size: 15, color: C.muted, align: "r", valign: "m", maxLines: 1 });
  });
  if (!t.coverage.length) cv.text("Test coverage by area could not be determined.", X, 170, lw, 30, { size: 16, color: C.muted });
  const rx = X + lw + 50, rw = X + CW - rx;
  const tiles: [string, string][] = [["Test files", String(t.files)], ["Untested key files", String(t.untestedCritical)]];
  tiles.forEach(([label, value], i) => {
    const w = (rw - 14) / 2, x = rx + i * (w + 14);
    cv.card(x, 128, w, 100, { accent: label.startsWith("Untested") && t.untestedCritical > 0 ? C.crit : C.accent });
    cv.text(value, x + 22, 138, w - 30, 46, { size: 36, color: C.navy, bold: true, font: "serif", valign: "m", maxLines: 1 });
    cv.text(label, x + 22, 188, w - 30, 24, { size: 14, color: C.muted, maxLines: 1 });
  });
  cv.text("Readiness checklist", rx, 252, rw, 26, { size: 17, color: C.navy, bold: true, maxLines: 1 });
  t.readiness.forEach((r, i) => {
    const y = 290 + i * 50;
    cv.ellipse(rx, y + 5, 26, 26, { fill: r.ok ? C.ok : C.crit });
    if (r.ok) cv.poly([[rx + 7, y + 19], [rx + 12, y + 24], [rx + 20, y + 13]], { stroke: C.white, sw: 3, open: true });
    else { cv.line(rx + 8, y + 13, rx + 18, y + 23, { color: C.white, sw: 3 }); cv.line(rx + 18, y + 13, rx + 8, y + 23, { color: C.white, sw: 3 }); }
    cv.text(r.label, rx + 40, y, rw - 44, 36, { size: 16, color: C.text, valign: "m", maxLines: 2, lh: 20 });
  });
  return done();
}

function actionsSlide(c: DeckContent): Slide {
  const { cv, done } = frame("actions", "Recommended actions", "What to do, in order", refText(c, "recs"), `Actions are grouped by urgency: Now addresses the most serious exposure, Next follows, Later is worth planning. Each shows why it matters and the reference used in the report. Detail: ${refText(c, "recs")}.`);
  const cols: ("Now" | "Next" | "Later")[] = ["Now", "Next", "Later"];
  const gap = 20, w = (CW - gap * 2) / 3;
  const desc = { Now: "Most serious exposure", Next: "Address soon", Later: "Plan and schedule" };
  cols.forEach((p, i) => {
    const x = X + i * (w + gap);
    const color = PRIORITY_COLOR[p];
    cv.rect(x, 126, w, 54, { fill: color, r: 12 });
    cv.text(p, x + 22, 126, 100, 54, { size: 22, color: C.white, bold: true, font: "serif", valign: "m", maxLines: 1 });
    cv.text(desc[p], x + 100, 126, w - 118, 54, { size: 14, color: "#FFFFFFDD", valign: "m", align: "r", maxLines: 1 });
    const items = c.actions.filter((a) => a.priority === p).slice(0, 3);
    items.forEach((a, k) => {
      const y = 192 + k * 152;
      cv.card(x, y, w, 140, { accent: color });
      cv.text(a.action, x + 24, y + 12, w - 40, 60, { size: 17, color: C.navy, bold: true, lh: 22, maxLines: 3 });
      cv.text(a.why, x + 24, y + 76, w - 40, 44, { size: 13, color: C.muted, lh: 17, maxLines: 2 });
      cv.text(`Ref ${a.ref}`, x + 24, y + 114, w - 40, 18, { size: 12, color: C.accent, bold: true, maxLines: 1 });
    });
    if (!items.length) cv.text(p === "Now" ? "Nothing urgent." : "Nothing in this group.", x, 200, w, 30, { size: 16, color: C.muted, align: "c" });
  });
  return done();
}

function coverageSlide(c: DeckContent, all: Slide[]): Slide {
  const { cv, done } = frame("coverage", "About this analysis", "What was analysed, and where to find the detail", refText(c, "exec"), `Coverage and method, and a map from each slide to the report section behind it. Findings are labelled by how they were produced; the report gives the evidence for every one. Detail: ${refText(c, "exec")}.`);
  const lw = 400;
  const facts: [string, string][] = [
    ["Files analysed", num(c.coverage.filesAnalysed)], ["Source files", num(c.coverage.sourceFiles)], ["Files set aside", num(c.coverage.filesExcluded)],
    ["Structure recognised", cap(c.coverage.confidence) + " confidence"], ["Method", c.coverage.aiUsed ? `Automated analysis with AI writing assistance${c.coverage.model ? ` (${c.coverage.model})` : ""}` : "Automated analysis (no AI provider used)"],
  ];
  cv.table(X, 128, [170, lw - 170], facts.map(([a, b]) => [{ text: a, color: C.muted, size: 15 }, { text: b, bold: true, color: C.navy, size: 15, maxLines: 3 }]), { minRowH: 44, padY: 9 });
  cv.text("Numbers on these slides are computed from the code; wording is generated from those numbers. Nothing was executed or changed.", X, 400, lw, 90, { size: 15, color: C.muted, lh: 22, maxLines: 4 });
  const rx = X + lw + 40, rw = X + CW - rx;
  cv.text("Every slide points to its report section", rx, 128, rw, 26, { size: 17, color: C.navy, bold: true, maxLines: 1 });
  const rows = all.filter((s) => s.id !== "title" && s.id !== "coverage" && s.ref).map((s, i) => [{ text: String(i + 2), align: "c" as const, color: C.muted, size: 13 }, { text: s.title, bold: true, color: C.navy, size: 13, maxLines: 1 }, { text: s.ref ?? "", size: 13, maxLines: 1 }]);
  cv.table(rx, 160, [46, 336, rw - 382], [[{ text: "#", align: "c" as const }, { text: "Slide" }, { text: "Report section" }], ...rows], { header: true, size: 13, padY: 4, minRowH: 32, maxH: 500 });
  return done();
}

/** Lay the whole deck out. Footers (project, report reference, page number) are added last, when the page count is known. */
export function layoutDeck(c: DeckContent): DeckSlides {
  const slides: Slide[] = [titleSlide(c), summarySlide(c), glanceSlide(c), capabilitiesSlide(c), architectureSlide(c), technologySlide(c), flowsSlide(c), dataSlide(c), riskSlide(c), prioritiesSlide(c), testingSlide(c), actionsSlide(c)];
  slides.push(coverageSlide(c, slides));
  const total = slides.length;
  slides.forEach((s, i) => {
    if (s.dark) return;
    const cv = { prims: s.prims } as { prims: Slide["prims"] };
    const foot = new Canvas();
    foot.line(X, H - 40, X + CW, H - 40, { color: C.line, sw: 1 });
    foot.text(`${c.project.name} · Executive summary`, X, H - 34, 420, 22, { size: 12, color: C.muted, maxLines: 1, valign: "m" });
    if (s.ref) foot.text(`Detail in the report: ${s.ref}`, X + 430, H - 34, 560, 22, { size: 12, color: C.accent, bold: true, align: "r", maxLines: 1, valign: "m" });
    foot.text(`${i + 1} / ${total}`, X + CW - 60, H - 34, 60, 22, { size: 12, color: C.muted, align: "r", maxLines: 1, valign: "m" });
    cv.prims.push(...foot.prims);
  });
  return { title: `${c.project.name}: Executive summary`, projectName: c.project.name, generatedAt: c.generatedAt, slides };
}
