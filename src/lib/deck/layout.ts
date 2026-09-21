import { Canvas } from "./build";
import type { DeckContent } from "./content";
import { textWidth } from "./measure";
import { H, W, type DeckSlides, type Slide } from "./scene";
import { C, MARGIN, PRIORITY_COLOR, SEVERITY_COLOR, STATUS_COLOR, STATUS_LABEL } from "./theme";

/**
 * The deck's look: white pages, an accent tick and a small-caps kicker over a serif "action title" (the point of the slide,
 * not its topic), soft tinted cards, generous space and one idea per slide. Slides are made of shapes and pre-wrapped text
 * only, so HTML, PDF and PowerPoint draw exactly the same thing.
 */
const X = MARGIN;
const CW = W - MARGIN * 2;
const TOP = 164;
const RISK_COLOR = { none: C.info, low: C.low, medium: C.med, high: C.high, critical: C.crit } as const;
const RISK_LABEL = { none: "", low: "Low risk", medium: "Medium risk", high: "High risk", critical: "Critical risk" } as const;
const LANE_COLOR: Record<string, string> = { interface: C.accent, api: C.navy, logic: "#2C6E8F", data: "#3F7F6E", external: "#7B5EA7" };
const LANE_ICON: Record<string, string> = { interface: "ui", api: "api", logic: "service", data: "data", external: "globe" };
const ROLE_ICON: Record<string, string> = { ui: "ui", api: "api", service: "service", data: "data", schema: "data", job: "job", infra: "infra", util: "util", entry: "service", ai: "star" };
const ROLE_COLOR: Record<string, string> = { ui: C.accent, api: C.navy, service: "#2C6E8F", data: "#3F7F6E", schema: "#3F7F6E", job: "#8A5A9E", infra: "#5B6E7C", util: "#5B6E7C", entry: C.accent, ai: "#8A5A9E" };
const DIM_ICON: Record<string, string> = { security: "shield", reliability: "pulse", quality: "check", maintain: "sliders", ops: "gear", delivery: "box" };
const DIM_SHORT: Record<string, string> = { security: "Security", reliability: "Reliability", quality: "Quality assurance", maintain: "Maintainability", ops: "Operations", delivery: "Delivery" };
const KPI_ICON: Record<string, string> = { "Source files": "files", "Lines of code": "code", "Main languages": "list", "Functional areas": "layers", "API routes": "api", "Data models": "data", "External services": "globe", "Critical or high findings": "alert" };

const num = (n: number) => n.toLocaleString("en-US");
const pct = (f: number) => `${Math.round(f * 100)}%`;
const plural = (n: number, w: string) => `${num(n)} ${w}${n === 1 ? "" : "s"}`;
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const lower = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const serious = (c: DeckContent) => c.quality.severity[0].count + c.quality.severity[1].count;

function refText(c: DeckContent, ...keys: string[]): string {
  return keys.map((k) => c.refs.find((r) => r.key === k)).filter((r): r is NonNullable<typeof r> => !!r).map((r) => `§${r.n} ${r.title}`).join(" · ");
}

/** The page frame: accent tick, kicker, and the action title. The footer is added once page numbers are known. */
function frame(id: string, kicker: string, title: string, ref: string, notes: string): { cv: Canvas; done: () => Slide } {
  const cv = new Canvas();
  cv.rect(0, 0, W, H, { fill: C.white });
  cv.rect(X, 42, 34, 4, { fill: C.accent, r: 2 });
  cv.text(kicker.toUpperCase(), X + 46, 34, 600, 20, { size: 13, color: C.accent, bold: true, spacing: 1.8, maxLines: 1, valign: "m" });
  cv.text("BRODY", W - X - 120, 34, 120, 20, { size: 13, color: C.muted, bold: true, spacing: 3, align: "r", maxLines: 1, valign: "m" });
  cv.fit(title, X, 60, CW, 88, { size: 33, min: 24, color: C.navy, bold: true, font: "serif", lh: 41, maxLines: 2 });
  return { cv, done: () => ({ id, title, kicker, ref: ref || undefined, notes, prims: cv.prims }) };
}

// ---------------------------------------------------------------------------------------------------------------------------
function titleSlide(c: DeckContent): Slide {
  const cv = new Canvas();
  cv.gradient(0, 0, W, H, C.deep, C.navy, 40);
  // Layered, translucent shapes for depth.
  cv.disc(1140, 160, 380, { fill: C.accent, opacity: 0.16 });
  cv.disc(1240, 590, 260, { fill: "#7CCBEE", opacity: 0.07 });
  cv.poly([[0, H], [0, 560], [420, H]], { fill: C.accent, opacity: 0.22 });
  cv.rect(0, 0, 10, H, { fill: C.accent });
  cv.text("BRODY  ·  REPOSITORY INTELLIGENCE", 88, 64, 640, 20, { size: 13, color: "#9FD3E8", spacing: 2.6, maxLines: 1, valign: "m" });
  cv.text("EXECUTIVE SUMMARY", 88, 130, 600, 22, { size: 15, color: "#7CCBEE", bold: true, spacing: 3, maxLines: 1 });
  const nl = cv.fit(c.project.name, 88, 162, 640, 150, { size: 70, min: 38, color: C.white, bold: true, font: "serif", lh: 76, maxLines: 2 });
  const y2 = 162 + nl * (nl === 1 ? 76 : 64) + 22;
  cv.rect(88, y2, 96, 5, { fill: "#7CCBEE", r: 2.5 });
  cv.text(c.headline, 88, y2 + 30, 620, 150, { size: 24, color: "#E4F0F7", lh: 34, maxLines: 4 });

  const stat = (label: string) => c.kpis.find((k) => k.label === label)?.value;
  const strip: [string, string][] = ([["Functional areas", "capabilities"], ["API routes", "API routes"], ["Data models", "data models"], ["Critical or high findings", "serious issues"]] as const)
    .map(([l, t]) => [stat(l) ?? "", t] as [string, string]).filter(([v]) => v && v !== "0").slice(0, 4);
  strip.forEach(([v, t], i) => {
    const sx = 88 + i * 158;
    if (i > 0) cv.line(sx - 20, 420, sx - 20, 470, { color: "#FFFFFF33", sw: 1 });
    cv.text(v, sx, 404, 140, 56, { size: 46, color: t === "serious issues" ? "#FF9A8F" : C.white, bold: true, font: "serif", maxLines: 1, valign: "m" });
    cv.text(t, sx, 462, 150, 24, { size: 15, color: "#9FD3E8", maxLines: 1 });
  });
  let x = 88;
  const level = c.quality.level;
  const lw = Math.ceil(textWidth(STATUS_LABEL[level], 14, "sans", true)) + 46;
  cv.rect(x, 548, lw, 34, { fill: STATUS_COLOR[level], r: 17 });
  cv.ellipse(x + 13, 559, 12, 12, { fill: C.white });
  cv.text(STATUS_LABEL[level], x + 34, 548, lw - 40, 34, { size: 14, color: C.white, bold: true, valign: "m", maxLines: 1 });
  x += lw + 12;
  for (const t of [`${plural(c.coverage.filesAnalysed, "file")} analysed`, new Date(c.generatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })]) x += cv.pill(t, x, 548, { fill: "#FFFFFF1F", size: 14, h: 34, bold: false, color: "#DCEBF4" }) + 10;
  cv.text("Every figure comes from the same analysis as the Repository Intelligence Report.", 88, 606, 620, 40, { size: 14, color: "#9FBBCC", lh: 20, maxLines: 2 });

  // The system, drawn as a glass panel: one column per layer, one dot per capability sized by how much code it holds.
  const lanes = c.architecture.lanes.filter((l) => l.areas.length > 0);
  const gx = 780, gy = 120, gw = 420, gh = 440;
  cv.rect(gx - 30, gy - 36, gw + 60, gh + 96, { fill: "#FFFFFF", opacity: 0.06, r: 28 });
  cv.rect(gx - 30, gy - 36, gw + 60, gh + 96, { stroke: "#FFFFFF33", sw: 1, r: 28 });
  if (lanes.length) {
    const colW = Math.min(64, (gw - (lanes.length - 1) * 26) / lanes.length);
    const gap = lanes.length > 1 ? (gw - colW * lanes.length) / (lanes.length - 1) : 0;
    const maxFiles = Math.max(1, ...lanes.flatMap((l) => l.areas.map((a) => a.files)));
    const centers = new Map<string, { x: number; ys: number[] }>();
    lanes.forEach((l, i) => {
      const x0 = gx + i * (colW + gap);
      cv.rect(x0, gy, colW, gh, { fill: "#FFFFFF", opacity: 0.08, r: colW / 2 });
      const shown = l.areas.slice(0, 6);
      const ys: number[] = [];
      shown.forEach((a, k) => {
        const r = 8 + 14 * Math.sqrt(a.files / maxFiles);
        const cy = gy + 46 + (k + 0.5) * ((gh - 92) / shown.length);
        const hot = a.risk === "critical" || a.risk === "high";
        cv.ellipse(x0 + colW / 2 - r, cy - r, r * 2, r * 2, { fill: hot ? RISK_COLOR[a.risk] : "#7CCBEE" });
        ys.push(cy);
      });
      centers.set(l.id, { x: x0 + colW / 2, ys });
    });
    for (const link of c.architecture.links) {
      const a = centers.get(link.from), b = centers.get(link.to);
      if (!a || !b) continue;
      cv.line(a.x + 16, a.ys[Math.floor(a.ys.length / 2)] ?? gy + gh / 2, b.x - 16, b.ys[Math.floor(b.ys.length / 2)] ?? gy + gh / 2, { color: "#9FD3E8", sw: 2, arrow: true });
    }
  }
  cv.text("How the system is layered", gx, gy + gh + 22, gw, 22, { size: 14, color: "#9FBBCC", align: "c", maxLines: 1 });
  return { id: "title", title: c.project.name, kicker: "Executive summary", notes: `Executive summary of ${c.project.name}. ${c.headline} This deck and the Repository Intelligence Report are two views of one analysis: every slide names the report section that holds the detail.`, dark: true, prims: cv.prims };
}

function bottomLineSlide(c: DeckContent): Slide {
  const q = c.quality, n = serious(c);
  const title = q.level === "act" ? `${plural(n, "serious issue")} need attention before this system can be relied on`
    : q.level === "watch" ? `Sound overall, with ${plural(n || q.total, n ? "serious issue" : "finding")} worth fixing soon` : "In good shape: no serious issues were found";
  const { cv, done } = frame("summary", "The bottom line", title, refText(c, "exec"), `${c.headline} ${c.summary} ${q.verdict} Detail: ${refText(c, "exec")}.`);
  // Left: the verdict, on a dark card.
  cv.rect(X, TOP, 500, 496, { fill: C.deep, r: 22 });
  cv.rect(X, TOP, 500, 496, { fill: C.accent, r: 22, opacity: 0.18 });
  cv.rect(X + 32, TOP + 32, 8, 8, { fill: STATUS_COLOR[q.level], r: 4 });
  cv.text(STATUS_LABEL[q.level].toUpperCase(), X + 48, TOP + 24, 380, 24, { size: 14, color: q.level === "act" ? "#FF9A8F" : q.level === "watch" ? "#FFD27A" : "#8FE0B0", bold: true, spacing: 2, valign: "m", maxLines: 1 });
  cv.fit(c.headline, X + 32, TOP + 68, 436, 230, { size: 29, min: 21, color: C.white, bold: true, font: "serif", lh: 38, maxLines: 6 });
  cv.rect(X + 32, TOP + 326, 60, 3, { fill: "#7CCBEE", r: 1.5 });
  cv.text(c.summary, X + 32, TOP + 348, 436, 130, { size: 16, color: "#C9DCE8", lh: 24, maxLines: 5 });
  // Right: four takeaways.
  const next = c.actions.find((a) => a.priority === "Now") ?? c.actions[0];
  const rows: { icon: string; color: string; title: string; detail: string }[] = [
    ...c.keyPoints.slice(0, 3).map((k, i) => ({ icon: ["layers", "target", q.level === "good" ? "shield" : "alert"][i], color: [C.accent, "#2C6E8F", STATUS_COLOR[q.level]][i], title: k.title, detail: k.detail })),
    ...(next ? [{ icon: "list", color: C.good, title: "What to do first", detail: next.action }] : []),
  ];
  const rx = X + 528, rw = CW - 528, rh = (496 - 16 * (rows.length - 1)) / Math.max(1, rows.length);
  rows.forEach((r, i) => {
    const y = TOP + i * (rh + 16);
    cv.card(rx, y, rw, rh, { shadow: true });
    cv.icon(r.icon, rx + 46, y + rh / 2, 24, r.color);
    cv.text(r.title, rx + 92, y + 16, rw - 116, 26, { size: 19, color: C.navy, bold: true, maxLines: 1 });
    cv.text(r.detail, rx + 92, y + 46, rw - 116, rh - 58, { size: 16, color: C.muted, lh: 23, maxLines: 3 });
  });
  return done();
}

function scorecardSlide(c: DeckContent): Slide {
  const acts = c.scorecard.filter((d) => d.status === "act").map((d) => DIM_SHORT[d.key]);
  const watch = c.scorecard.filter((d) => d.status === "watch").map((d) => DIM_SHORT[d.key]);
  const title = acts.length ? `${list(acts)} ${acts.length > 1 ? "need" : "needs"} attention${watch.length ? `; ${list(watch).toLowerCase()} to watch` : ""}`
    : watch.length ? `${list(watch)} to watch; everything else is on track` : "All six health checks are on track";
  const { cv, done } = frame("scorecard", "Health scorecard", title, refText(c, "review", "risks"), `Six health checks an executive would ask about, each rated from the same findings the report lists: On track, Watch or Needs attention. Detail: ${refText(c, "review", "risks")}.`);
  const gap = 20, w = (CW - gap * 2) / 3, h = 240;
  c.scorecard.forEach((d, i) => {
    const x = X + (i % 3) * (w + gap), y = TOP + Math.floor(i / 3) * (h + 16);
    const color = STATUS_COLOR[d.status];
    cv.card(x, y, w, h, { accent: color, shadow: true });
    cv.icon(DIM_ICON[d.key] ?? "default", x + 44, y + 52, 22, color);
    cv.text(d.name, x + 80, y + 24, w - 100, 56, { size: 19, color: C.navy, bold: true, lh: 23, maxLines: 2, valign: "m" });
    cv.status(STATUS_LABEL[d.status], x + 24, y + 92, color, { size: 14, h: 30 });
    const n = d.sev.critical + d.sev.high;
    cv.text(String(n), x + 24, y + 128, 90, 50, { size: 44, color: n > 0 ? color : C.navy, bold: true, font: "serif", maxLines: 1, valign: "m" });
    cv.text(n === 1 ? "serious issue" : "serious issues", x + 24, y + 176, 120, 20, { size: 13, color: C.muted, maxLines: 1 });
    const total = d.sev.critical + d.sev.high + d.sev.medium + d.sev.low;
    const bx = x + 130, bw = w - 154;
    cv.rect(bx, y + 142, bw, 12, { fill: C.mist2, r: 6 });
    let px = bx;
    for (const [k, col] of [["critical", C.crit], ["high", C.high], ["medium", C.med], ["low", C.low]] as const) {
      const sw = total ? (d.sev[k] / total) * bw : 0;
      if (sw > 0) { cv.rect(px, y + 142, Math.max(5, sw), 12, { fill: col, r: 3 }); px += Math.max(5, sw); }
    }
    cv.text(total ? `${plural(total, "finding")} in total` : "no findings", bx, y + 160, bw, 18, { size: 13, color: C.muted, maxLines: 1 });
    cv.text(d.evidence, x + 24, y + 200, w - 48, 34, { size: 13, color: C.muted, lh: 16, maxLines: 2 });
  });
  return done();
}

function numbersSlide(c: DeckContent): Slide {
  const get = (l: string) => c.kpis.find((k) => k.label === l)?.value ?? "0";
  const title = `${get("Functional areas")} functional areas across ${get("Source files")} source files${serious(c) ? `, with ${plural(serious(c), "serious issue")} to resolve` : ""}`;
  const { cv, done } = frame("glance", "By the numbers", title, refText(c, "glance"), `The system spans ${plural(c.coverage.sourceFiles, "source file")} and ${get("Lines of code")} lines of code. ${c.quality.verdict} Detail: ${refText(c, "glance")}.`);
  const gap = 18, w = (CW - gap * 3) / 4, h = 236;
  c.kpis.slice(0, 8).forEach((m, i) => {
    const x = X + (i % 4) * (w + gap), y = TOP + Math.floor(i / 4) * (h + 24);
    const hot = m.label.startsWith("Critical") && Number(m.value) > 0;
    cv.card(x, y, w, h, { shadow: true, fill: hot ? "#FCEFED" : C.mist });
    cv.icon(KPI_ICON[m.label] ?? "default", x + 44, y + 48, 22, hot ? C.act : C.accent);
    const long = m.value.length > 9;
    cv.fit(m.value, x + 24, y + 86, w - 44, long ? 66 : 62, { size: long ? 27 : 54, min: 18, color: hot ? C.act : C.navy, bold: true, font: "serif", maxLines: long ? 2 : 1, valign: "m" });
    cv.text(m.label, x + 24, y + 158, w - 44, 26, { size: 17, color: C.text, bold: true, maxLines: 1 });
    if (m.note) cv.text(m.note, x + 24, y + 186, w - 44, 40, { size: 14, color: C.muted, lh: 18, maxLines: 2 });
  });
  return done();
}

function capabilitiesSlide(c: DeckContent): Slide {
  const caps = c.capabilities;
  const total = Math.max(1, c.coverage.filesAnalysed);
  const share = Math.min(1, caps.reduce((a, x) => a + x.files, 0) / total);
  const areaCount = c.kpis.find((k) => k.label === "Functional areas")?.value;
  const title = caps.length >= 2 ? `The ${caps.length} largest${areaCount ? ` of ${areaCount}` : ""} functional areas hold ${pct(share)} of the code` : "What the system does";
  const { cv, done } = frame("capabilities", "What the system does", title, refText(c, "areas"), `${caps.length} main capabilities, led by ${caps.slice(0, 3).map((a) => a.name).join(", ")}. Bars show each one's share of the analysed files; a risk tag appears where the review found serious issues. Detail: ${refText(c, "areas")}.`);
  const maxFiles = Math.max(1, ...caps.map((a) => a.files));
  const gap = 18, w = (CW - gap) / 2, h = 112;
  caps.forEach((a, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = X + col * (w + gap), y = TOP + row * (h + 14);
    cv.card(x, y, w, h, { shadow: true });
    const color = ROLE_COLOR[a.role] ?? C.accent;
    cv.icon(ROLE_ICON[a.role] ?? "default", x + 44, y + h / 2, 24, color);
    cv.text(a.name, x + 88, y + 16, w - 88 - 190, 28, { size: 19, color: C.navy, bold: true, maxLines: 1 });
    cv.text(a.line, x + 88, y + 46, w - 88 - 190, 60, { size: 15, color: C.muted, lh: 20, maxLines: 3 });
    cv.text(pct(a.files / total), x + w - 170, y + 14, 146, 28, { size: 22, color: C.navy, bold: true, font: "serif", align: "r", maxLines: 1 });
    cv.bar(x + w - 170, y + 48, 146, 8, a.files / maxFiles, color, C.mist2);
    cv.text(`${plural(a.files, "file")}`, x + w - 170, y + 60, 146, 18, { size: 13, color: C.muted, align: "r", maxLines: 1 });
    if (a.risk !== "none" && a.risk !== "low") cv.pill(RISK_LABEL[a.risk], x + w - 24 - (textWidth(RISK_LABEL[a.risk], 12, "sans", true) + 20), y + h - 34, { fill: RISK_COLOR[a.risk], size: 12, padX: 20 });
  });
  if (!caps.length) cv.text("No distinct capabilities were identified.", X, TOP + 10, CW, 40, { size: 18, color: C.muted });
  return done();
}

function architectureSlide(c: DeckContent): Slide {
  const lanes = c.architecture.lanes.filter((l) => l.areas.length > 0);
  const title = lanes.length ? `Organised in ${lanes.length} layers, from where people enter to the services it relies on` : "How the system is organised";
  const { cv, done } = frame("architecture", "How it is built", title, refText(c, "arch", "codemap"), `${c.architecture.pattern}. Read left to right: people and systems come in on the left, business rules are in the middle, information is stored and outside services are on the right. Arrows show how strongly layers are connected. Detail: ${refText(c, "arch", "codemap")}.`);
  const laneH = c.architecture.foundation.length ? 372 : 420;
  const n = Math.max(1, lanes.length), gap = 48, lw = (CW - gap * (n - 1)) / n;
  const centers: { id: string; x: number; w: number }[] = [];
  const maxLink = Math.max(1, ...c.architecture.links.map((l) => l.weight));
  lanes.forEach((l, i) => {
    const x = X + i * (lw + gap);
    const color = LANE_COLOR[l.id] ?? C.navy;
    cv.rect(x, TOP, lw, laneH, { fill: C.mist, r: 18 });
    cv.rect(x + 20, TOP, lw - 40, 5, { fill: color, r: 2.5 });
    cv.icon(LANE_ICON[l.id] ?? "default", x + 38, TOP + 44, 18, color);
    cv.text(l.label, x + 66, TOP + 22, lw - 80, 44, { size: 15, color: C.navy, bold: true, lh: 18, maxLines: 2, valign: "m" });
    const chipH = 52;
    const fits = Math.floor((laneH - 76 - 8) / (chipH + 6));
    const shown = l.areas.length > fits ? l.areas.slice(0, fits - 1) : l.areas;
    shown.forEach((a, k) => {
      const y = TOP + 76 + k * (chipH + 6);
      cv.card(x + 12, y, lw - 24, chipH, { r: 10, fill: C.white, shadow: true });
      cv.ellipse(x + 26, y + 18, 10, 10, { fill: a.risk === "high" || a.risk === "critical" ? RISK_COLOR[a.risk] : color });
      cv.text(a.name, x + 46, y + 4, lw - 68, 32, { size: 14, color: C.navy, bold: true, maxLines: 2, lh: 16, valign: "m" });
      cv.text(`${plural(a.files, "file")}`, x + 46, y + 34, lw - 68, 16, { size: 12, color: C.muted, maxLines: 1 });
    });
    if (l.areas.length > shown.length) cv.text(`+ ${l.areas.length - shown.length} more`, x + 12, TOP + laneH - 30, lw - 24, 20, { size: 13, color: C.muted, align: "c", maxLines: 1 });
    centers.push({ id: l.id, x, w: lw });
  });
  for (const link of c.architecture.links) {
    const a = centers.find((k) => k.id === link.from), b = centers.find((k) => k.id === link.to);
    if (!a || !b || centers.indexOf(b) - centers.indexOf(a) !== 1) continue;
    cv.arrow(a.x + a.w + 6, TOP + laneH / 2, gap - 12, 12 + 18 * (link.weight / maxLink), C.accent, 0.85);
  }
  if (c.architecture.foundation.length) {
    const fy = TOP + laneH + 12;
    cv.rect(X, fy, CW, 64, { fill: C.mist2, r: 14 });
    cv.icon("layers", X + 36, fy + 32, 16, C.navy);
    cv.text("Shared foundations", X + 66, fy + 8, 200, 24, { size: 15, color: C.navy, bold: true, maxLines: 1 });
    cv.text("used across the system", X + 66, fy + 34, 200, 20, { size: 13, color: C.muted, maxLines: 1 });
    let x = X + 290;
    for (const f of c.architecture.foundation.slice(0, 7)) { const pw = textWidth(f.name, 14, "sans", true) + 28; if (x + pw > X + CW - 14) break; x += cv.pill(f.name, x, fy + 17, { fill: C.white, color: C.navy, size: 14, h: 30 }) + 10; }
  }
  cv.text(`Overall pattern: ${c.architecture.pattern}`, X, H - 70, CW, 22, { size: 15, color: C.muted, maxLines: 1 });
  if (!lanes.length) cv.text("No layered structure was detected.", X, TOP + 10, CW, 40, { size: 18, color: C.muted });
  return done();
}

function technologySlide(c: DeckContent): Slide {
  const top = c.tech.languages[0];
  const fw = c.tech.frameworks.slice(0, 2);
  const title = top ? `Mostly ${top.name} (${pct(top.share)})${fw.length ? `, built on ${list(fw)}` : ""}` : "What the system is made of";
  const { cv, done } = frame("technology", "Technology and footprint", title, refText(c, "glance", "arch"), `The code is mainly ${c.tech.languages.slice(0, 2).map((l) => l.name).join(" and ")}. It is ${c.tech.footprint[0]?.value ?? ""} source files and ${c.tech.footprint[1]?.value ?? ""} lines. Detail: ${refText(c, "glance", "arch")}.`);
  const palette = [C.navy, C.accent, "#3F7F6E", "#8A5A9E", C.med, C.info];
  cv.card(X, TOP, 520, 496, { shadow: true });
  cv.text("Languages by share of code", X + 28, TOP + 22, 460, 26, { size: 17, color: C.navy, bold: true, maxLines: 1 });
  const cx = X + 156, cy = TOP + 262;
  cv.donut(cx, cy, 124, 42, c.tech.languages.map((l, i) => ({ value: l.share, color: palette[i % palette.length] })));
  cv.text(String(c.tech.languages.filter((l) => l.name !== "Other").length), cx - 50, cy - 34, 100, 42, { size: 38, color: C.navy, bold: true, font: "serif", align: "c", maxLines: 1 });
  cv.text("languages", cx - 50, cy + 10, 100, 20, { size: 14, color: C.muted, align: "c", maxLines: 1 });
  c.tech.languages.slice(0, 6).forEach((l, i) => {
    const y = TOP + 130 + i * 40;
    cv.rect(X + 292, y + 7, 14, 14, { fill: palette[i % palette.length], r: 4 });
    cv.text(l.name, X + 316, y, 130, 28, { size: 16, color: C.text, bold: true, valign: "m", maxLines: 1 });
    cv.text(l.share < 0.005 ? "<1%" : pct(l.share), X + 440, y, 56, 28, { size: 16, color: C.muted, align: "r", valign: "m", maxLines: 1 });
  });
  const rx = X + 548, rw = CW - 548;
  cv.text("Footprint", rx, TOP, rw, 26, { size: 17, color: C.navy, bold: true, maxLines: 1 });
  const cw = (rw - 2 * 14) / 3;
  c.tech.footprint.slice(0, 6).forEach((f, i) => {
    const x = rx + (i % 3) * (cw + 14), y = TOP + 36 + Math.floor(i / 3) * 104;
    cv.card(x, y, cw, 92, { shadow: true });
    cv.text(f.value, x + 18, y + 10, cw - 30, 44, { size: 32, color: C.navy, bold: true, font: "serif", maxLines: 1, valign: "m" });
    cv.text(f.label, x + 18, y + 58, cw - 30, 28, { size: 13, color: C.muted, lh: 16, maxLines: 2 });
  });
  cv.card(rx, TOP + 260, rw, 236, { shadow: true });
  const groups: [string, string[]][] = [["Frameworks", c.tech.frameworks], ["Data stores", c.tech.stores], ["Platform", c.tech.platform]];
  let gy = TOP + 282;
  cv.text("Built with", rx + 24, TOP + 268, 300, 24, { size: 17, color: C.navy, bold: true, maxLines: 1 });
  gy = TOP + 308;
  for (const [label, items] of groups) {
    if (!items.length) continue;
    cv.text(label, rx + 24, gy, 120, 32, { size: 14, color: C.muted, bold: true, valign: "m", maxLines: 1 });
    let x = rx + 150;
    for (const it of items) { const pw = textWidth(it, 14, "sans", true) + 28; if (x + pw > rx + rw - 16) break; x += cv.pill(it, x, gy, { fill: C.white, color: C.navy, size: 14, h: 32 }) + 8; }
    gy += 56;
  }
  return done();
}

function flowsSlide(c: DeckContent): Slide {
  const flows = c.flows.slice(0, 4);
  const avg = flows.length ? Math.round((flows.reduce((a, f) => a + f.path.length, 0) / flows.length) * 10) / 10 : 0;
  const { cv, done } = frame("flows", "How work moves", flows.length ? `${plural(flows.length, "key activity").replace("activitys", "activities")}, each crossing about ${avg} parts of the system` : "How work moves through the system", refText(c, "flows", "runtime"), `Each row traces a real activity through the parts of the system that handle it, ending at any outside service it reaches. Detail: ${refText(c, "flows", "runtime")}.`);
  if (!flows.length) {
    cv.text("No end-to-end activities were traced. The layered view on the architecture slide shows how the parts connect.", X, TOP + 10, CW, 60, { size: 18, color: C.muted });
    return done();
  }
  const rowH = 102, gap = 14;
  flows.forEach((f, i) => {
    const y = TOP + i * (rowH + gap);
    cv.card(X, y, CW, rowH, { shadow: true });
    cv.ellipse(X + 22, y + rowH / 2 - 16, 32, 32, { fill: C.accent });
    cv.text(String(i + 1), X + 22, y + rowH / 2 - 16, 32, 32, { size: 16, color: C.white, bold: true, align: "c", valign: "m", maxLines: 1 });
    cv.text(f.name, X + 68, y + 12, 200, rowH - 24, { size: 21, color: C.navy, bold: true, font: "serif", lh: 26, maxLines: 3, valign: "m" });
    const steps = [...f.path, ...f.externals.slice(0, 2)];
    const startX = X + 296, avail = X + CW - 22 - startX;
    const sw = Math.min(210, (avail + 14 * (steps.length - 1)) / steps.length);
    steps.forEach((s, k) => {
      const external = k >= f.path.length;
      const t = f.path.length > 1 ? Math.min(1, k / (f.path.length - 1)) : 0;
      const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
      const fill = external ? "#7B5EA7" : `#${[mix(0x00, 0x1B), mix(0x6C, 0x49), mix(0x96, 0x65)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
      const x = startX + k * (sw - 14);
      cv.chevron(x, y + 19, sw, 64, fill, k === 0);
      cv.text(s, x + (k === 0 ? 12 : 30), y + 19, sw - (k === 0 ? 40 : 56), 64, { size: 15, color: C.white, bold: true, valign: "m", align: "c", lh: 18, maxLines: 3 });
    });
  });
  cv.text("Blue steps are parts of the system; purple steps are outside services the activity depends on.", X, H - 74, CW, 22, { size: 14, color: C.muted, maxLines: 1 });
  return done();
}

function dataSlide(c: DeckContent): Slide {
  const title = `${plural(c.data.models, "data model")} and ${plural(c.integrations.length, "outside service")} power the system`;
  const { cv, done } = frame("data", "Information and partners", title, refText(c, "data", "integrations"), `${plural(c.data.models, "data model")} with ${plural(c.data.relations, "relationship")} between them. The system relies on ${plural(c.integrations.length, "outside service")}; the last column shows the business effect if one is unavailable. Detail: ${refText(c, "data", "integrations")}.`);
  const lw = 440;
  const tiles: [string, string, string][] = [["Data models", String(c.data.models), "data"], ["Relationships", String(c.data.relations), "layers"], ["Data stores", String(c.data.stores.length), "box"]];
  const tw = (lw - 24) / 3;
  tiles.forEach(([label, value, icon], i) => {
    const x = X + i * (tw + 12);
    cv.card(x, TOP, tw, 108, { shadow: true });
    cv.icon(icon, x + 32, TOP + 30, 15, C.accent);
    cv.text(value, x + 58, TOP + 12, tw - 66, 36, { size: 30, color: C.navy, bold: true, font: "serif", maxLines: 1, valign: "m" });
    cv.text(label, x + 16, TOP + 66, tw - 24, 34, { size: 14, color: C.muted, lh: 16, maxLines: 2 });
  });
  if (c.data.stores.length) cv.text(`Stored in ${c.data.stores.join(", ")}`, X, TOP + 122, lw, 22, { size: 14, color: C.muted, maxLines: 1 });
  if (c.data.entities.length) {
    cv.text("Most connected information", X, TOP + 160, lw, 26, { size: 17, color: C.navy, bold: true, maxLines: 1 });
    cv.table(X, TOP + 194, [lw - 170, 90, 80], [[{ text: "Information" }, { text: "Fields", align: "r" }, { text: "Links", align: "r" }], ...c.data.entities.map((e) => [{ text: e.name, bold: true, color: C.navy }, { text: String(e.fields), align: "r" as const }, { text: String(e.links), align: "r" as const }])], { header: true, size: 15, minRowH: 42, maxH: 300 });
  }
  const rx = X + lw + 40, rw = X + CW - rx;
  cv.text("Outside services", rx, TOP, rw, 26, { size: 17, color: C.navy, bold: true, maxLines: 1 });
  if (c.integrations.length) cv.table(rx, TOP + 34, [170, 200, rw - 370], [[{ text: "Service" }, { text: "What it does" }, { text: "If unavailable" }], ...c.integrations.slice(0, 6).map((i) => [{ text: i.name, bold: true, color: C.navy, maxLines: 2 }, { text: i.purpose, maxLines: 2 }, { text: i.ifDown, maxLines: 3 }])], { header: true, size: 15, padY: 10, minRowH: 52, maxH: 460 });
  else cv.text("No outside services were detected.", rx, TOP + 40, rw, 30, { size: 16, color: C.muted });
  return done();
}

function riskSlide(c: DeckContent): Slide {
  const q = c.quality, s = q.severity;
  const title = `${plural(q.total, "finding")}: ${s[0].count + s[1].count} serious, ${s[2].count} moderate, ${s[3].count} minor`;
  const { cv, done } = frame("risk", "Risk posture", title, refText(c, "review", "risks"), `${q.verdict} ${plural(q.total, "finding")} in total. Themes on the right group the findings by the kind of exposure they create. Detail: ${refText(c, "review", "risks")}.`);
  cv.card(X, TOP, 400, 496, { shadow: true });
  const cx = X + 200, cy = TOP + 190, r = 122;
  const colors = [C.crit, C.high, C.med, C.low];
  cv.donut(cx, cy, r, 42, s.map((x, i) => ({ value: x.count, color: colors[i] })));
  cv.text(String(q.total), cx - 70, cy - 40, 140, 56, { size: 46, color: C.navy, bold: true, font: "serif", align: "c", maxLines: 1 });
  cv.text(q.total === 1 ? "finding" : "findings", cx - 70, cy + 22, 140, 22, { size: 15, color: C.muted, align: "c", maxLines: 1 });
  s.forEach((x, i) => {
    const y = TOP + 350 + i * 34;
    cv.rect(X + 60, y + 7, 16, 16, { fill: colors[i], r: 4 });
    cv.text(x.label, X + 90, y, 160, 30, { size: 17, color: C.text, valign: "m", maxLines: 1 });
    cv.text(String(x.count), X + 270, y, 70, 30, { size: 18, color: C.navy, bold: true, align: "r", valign: "m", maxLines: 1 });
  });
  const rx = X + 428, rw = CW - 428;
  const tone = STATUS_COLOR[q.level];
  cv.card(rx, TOP, rw, 92, { fill: C.mist });
  cv.rect(rx, TOP + 16, 6, 60, { fill: tone, r: 3 });
  cv.text(q.verdict, rx + 30, TOP + 6, rw - 50, 80, { size: 18, color: C.navy, bold: true, lh: 25, maxLines: 3, valign: "m" });
  cv.text("Risk by theme", rx, TOP + 112, 300, 24, { size: 17, color: C.navy, bold: true, maxLines: 1 });
  const maxTotal = Math.max(1, ...q.themes.map((t) => t.sev.critical + t.sev.high + t.sev.medium + t.sev.low));
  q.themes.slice(0, 5).forEach((t, i) => {
    const y = TOP + 146 + i * 70;
    cv.text(t.theme, rx, y, 320, 24, { size: 16, color: C.text, bold: true, maxLines: 1 });
    cv.text(t.exposure, rx, y + 25, 420, 40, { size: 13, color: C.muted, lh: 17, maxLines: 2 });
    const bx = rx + 444, bw = rw - 444 - 44;
    const total = t.sev.critical + t.sev.high + t.sev.medium + t.sev.low;
    cv.rect(bx, y + 6, bw, 20, { fill: C.mist2, r: 10 });
    let px = bx;
    for (const [k, col] of [["critical", C.crit], ["high", C.high], ["medium", C.med], ["low", C.low]] as const) {
      const sw = (t.sev[k] / maxTotal) * bw;
      if (sw > 0) { cv.rect(px, y + 6, Math.max(6, sw), 20, { fill: col, r: 4 }); px += Math.max(6, sw); }
    }
    cv.text(String(total), bx + bw + 10, y + 4, 36, 24, { size: 16, color: C.navy, bold: true, valign: "m", maxLines: 1 });
  });
  if (!q.themes.length) cv.text("No issues were found by the analysis.", rx, TOP + 160, rw, 30, { size: 18, color: C.good, bold: true });
  return done();
}

function prioritiesSlide(c: DeckContent): Slide {
  const q = c.quality;
  const first = q.priorities[0];
  const title = first ? `Fix first: ${lower(first.issue)}${q.priorities.length > 1 ? `, and ${q.priorities.length - 1} more` : ""}` : "No serious issues to fix first";
  const { cv, done } = frame("priorities", "Priority issues", title, refText(c, "review", "risks"), `The left chart shows which parts of the system carry the most findings. The table lists the issues to act on first, in business terms, with the reference number used in the report. Detail: ${refText(c, "review", "risks")}.`);
  const lw = 400;
  cv.card(X, TOP, lw, 496, { shadow: true });
  cv.text("Findings by part of the system", X + 26, TOP + 20, lw - 40, 26, { size: 17, color: C.navy, bold: true, maxLines: 1 });
  const max = Math.max(1, ...q.areaRisk.map((a) => a.sev.critical + a.sev.high + a.sev.medium + a.sev.low));
  q.areaRisk.slice(0, 6).forEach((a, i) => {
    const y = TOP + 62 + i * 70;
    cv.text(a.area, X + 26, y, lw - 52, 24, { size: 16, color: C.text, bold: true, maxLines: 1 });
    cv.rect(X + 26, y + 30, lw - 52 - 40, 18, { fill: C.mist2, r: 9 });
    let x = X + 26;
    for (const [k, col] of [["critical", C.crit], ["high", C.high], ["medium", C.med], ["low", C.low]] as const) {
      const w = (a.sev[k] / max) * (lw - 52 - 40);
      if (w > 0) { cv.rect(x, y + 30, Math.max(6, w), 18, { fill: col, r: 4 }); x += Math.max(6, w); }
    }
    cv.text(String(a.sev.critical + a.sev.high + a.sev.medium + a.sev.low), X + lw - 60, y + 26, 34, 26, { size: 16, color: C.navy, bold: true, valign: "m", align: "r", maxLines: 1 });
  });
  if (!q.areaRisk.length) cv.text("No findings to chart.", X + 26, TOP + 70, lw - 52, 30, { size: 16, color: C.good, bold: true });
  const rx = X + lw + 32, rw = X + CW - rx;
  cv.text("Issues to act on first", rx, TOP, rw, 26, { size: 17, color: C.navy, bold: true, maxLines: 1 });
  if (q.priorities.length) {
    cv.table(rx, TOP + 34, [104, 176, rw - 104 - 176 - 100, 100], [
      [{ text: "Severity" }, { text: "Issue" }, { text: "What could go wrong" }, { text: "Ref", align: "c" }],
      ...q.priorities.slice(0, 6).map((p) => [
        { text: p.severity, pill: SEVERITY_COLOR[p.severity] ?? C.info, color: C.white, bold: true, align: "c" as const, size: 13 },
        { text: p.count > 1 ? `${p.issue} (${p.count} places)` : p.issue, bold: true, color: C.navy, size: 14, maxLines: 3 },
        { text: p.exposure, size: 13, maxLines: 3 },
        { text: p.ref, align: "c" as const, size: 13, color: C.muted },
      ]),
    ], { header: true, size: 14, padY: 9, maxH: 460 });
  } else cv.text("No serious issues were found.", rx, TOP + 40, rw, 30, { size: 18, color: C.good, bold: true });
  return done();
}

function testingSlide(c: DeckContent): Slide {
  const t = c.testing;
  const covered = t.coverage.filter((a) => a.total > 0 && a.tested / a.total >= 0.5).length;
  const missing = t.readiness.filter((r) => !r.ok).length;
  const title = t.coverage.length ? `${covered} of ${t.coverage.length} areas are well covered by tests; ${missing ? `${plural(missing, "basic")} still missing` : "the basics are in place"}` : missing ? `${plural(missing, "quality basic")} still missing` : "Quality basics are in place";
  const { cv, done } = frame("testing", "Quality assurance and readiness", title, refText(c, "testing"), `${plural(t.files, "automated test file")}. Coverage bars show how many of the important files in each part of the system are exercised by tests. The checklist is derived from the same findings as the report. Detail: ${refText(c, "testing")}.`);
  const lw = 560;
  cv.card(X, TOP, lw, 496, { shadow: true });
  cv.text("Test coverage by part of the system", X + 26, TOP + 20, lw - 40, 26, { size: 17, color: C.navy, bold: true, maxLines: 1 });
  t.coverage.slice(0, 7).forEach((a, i) => {
    const y = TOP + 64 + i * 60, f = a.total ? a.tested / a.total : 0;
    cv.text(a.area, X + 26, y, 220, 30, { size: 16, color: C.text, bold: true, valign: "m", maxLines: 1 });
    cv.bar(X + 262, y + 8, 200, 14, f, f >= 0.6 ? C.good : f > 0 ? C.watch : C.act, C.mist2);
    cv.text(`${a.tested} of ${a.total}`, X + 470, y, 64, 30, { size: 15, color: C.muted, align: "r", valign: "m", maxLines: 1 });
  });
  if (!t.coverage.length) cv.text("Test coverage by area could not be determined.", X + 26, TOP + 70, lw - 52, 30, { size: 16, color: C.muted });
  const rx = X + lw + 32, rw = CW - lw - 32;
  const tiles: [string, string, boolean][] = [["Test files", String(t.files), false], ["Untested key files", String(t.untestedCritical), t.untestedCritical > 0]];
  tiles.forEach(([label, value, hot], i) => {
    const w = (rw - 16) / 2, x = rx + i * (w + 16);
    cv.card(x, TOP, w, 108, { shadow: true, fill: hot ? "#FCEFED" : C.mist });
    cv.text(value, x + 22, TOP + 10, w - 30, 56, { size: 42, color: hot ? C.act : C.navy, bold: true, font: "serif", valign: "m", maxLines: 1 });
    cv.text(label, x + 22, TOP + 70, w - 30, 26, { size: 15, color: C.muted, maxLines: 1 });
  });
  cv.card(rx, TOP + 128, rw, 368, { shadow: true });
  cv.text("Readiness checklist", rx + 26, TOP + 148, rw - 40, 26, { size: 17, color: C.navy, bold: true, maxLines: 1 });
  t.readiness.forEach((r, i) => {
    const y = TOP + 192 + i * 49;
    cv.ellipse(rx + 26, y + 3, 28, 28, { fill: r.ok ? C.good : C.act });
    if (r.ok) cv.poly([[rx + 33, y + 18], [rx + 38, y + 23], [rx + 47, y + 11]], { stroke: C.white, sw: 3, open: true });
    else { cv.line(rx + 34, y + 11, rx + 46, y + 23, { color: C.white, sw: 3 }); cv.line(rx + 46, y + 11, rx + 34, y + 23, { color: C.white, sw: 3 }); }
    cv.text(r.label, rx + 68, y, rw - 92, 34, { size: 16, color: C.text, valign: "m", maxLines: 2, lh: 20 });
  });
  return done();
}

function actionsSlide(c: DeckContent): Slide {
  const now = c.actions.filter((a) => a.priority === "Now").length;
  const title = now ? `${now} ${now === 1 ? "action" : "actions"} to start now will remove the most serious exposure` : c.actions.length ? "Nothing is urgent; here is what to plan" : "No actions are needed right now";
  const { cv, done } = frame("actions", "Recommended actions", title, refText(c, "recs"), `Actions are grouped by urgency: Now addresses the most serious exposure, Next follows, Later is worth planning. Each shows why it matters and the reference used in the report. Detail: ${refText(c, "recs")}.`);
  const cols: ("Now" | "Next" | "Later")[] = ["Now", "Next", "Later"];
  const gap = 20, w = (CW - gap * 2) / 3;
  const desc = { Now: "Start immediately", Next: "Within the quarter", Later: "Plan and schedule" };
  cols.forEach((p, i) => {
    const x = X + i * (w + gap);
    const color = PRIORITY_COLOR[p];
    cv.rect(x, TOP, w, 496, { fill: C.mist, r: 18 });
    cv.rect(x + 20, TOP, w - 40, 5, { fill: color, r: 2.5 });
    cv.text(p, x + 24, TOP + 14, 120, 38, { size: 28, color: C.navy, bold: true, font: "serif", valign: "m", maxLines: 1 });
    cv.text(desc[p], x + 24, TOP + 52, w - 48, 22, { size: 14, color: C.muted, maxLines: 1 });
    const items = c.actions.filter((a) => a.priority === p).slice(0, 3);
    items.forEach((a, k) => {
      const y = TOP + 84 + k * 134;
      cv.card(x + 14, y, w - 28, 124, { fill: C.white, shadow: true, r: 12 });
      cv.ellipse(x + 30, y + 20, 12, 12, { fill: color });
      cv.text(a.action, x + 50, y + 10, w - 84, 44, { size: 16, color: C.navy, bold: true, lh: 21, maxLines: 2 });
      cv.text(a.why, x + 30, y + 58, w - 64, 34, { size: 13, color: C.muted, lh: 16, maxLines: 2 });
      cv.text(`Ref ${a.ref}`, x + 30, y + 98, w - 64, 18, { size: 12, color: C.accent, bold: true, maxLines: 1 });
    });
    if (!items.length) cv.text(p === "Now" ? "Nothing urgent." : "Nothing in this group.", x, TOP + 200, w, 30, { size: 16, color: C.muted, align: "c" });
  });
  return done();
}

function coverageSlide(c: DeckContent, all: Slide[]): Slide {
  const { cv, done } = frame("coverage", "About this analysis", `Built on ${plural(c.coverage.filesAnalysed, "analysed file")}, with every slide traceable to the report`, refText(c, "exec"), `Coverage and method, and a map from each slide to the report section behind it. Findings are labelled by how they were produced; the report gives the evidence for every one. Detail: ${refText(c, "exec")}.`);
  const lw = 420;
  const facts: [string, string][] = [
    ["Files analysed", num(c.coverage.filesAnalysed)], ["Source files", num(c.coverage.sourceFiles)], ["Files set aside", num(c.coverage.filesExcluded)],
    ["Structure recognised", `${cap(c.coverage.confidence)} confidence`], ["Method", c.coverage.aiUsed ? `Automated analysis with AI writing assistance${c.coverage.model ? ` (${c.coverage.model})` : ""}` : "Automated analysis (no AI provider used)"],
  ];
  cv.table(X, TOP, [170, lw - 170], facts.map(([a, b]) => [{ text: a, color: C.muted, size: 15 }, { text: b, bold: true, color: C.navy, size: 15, maxLines: 3 }]), { minRowH: 46, padY: 9 });
  cv.card(X, TOP + 290, lw, 130, { fill: C.mist2, shadow: false });
  cv.text("Figures are computed from the code; the wording is generated from those figures. Nothing was executed or changed.", X + 22, TOP + 304, lw - 44, 104, { size: 15, color: C.navy, lh: 22, maxLines: 4, valign: "m" });
  const rx = X + lw + 40, rw = X + CW - rx;
  cv.text("Every slide points to its report section", rx, TOP, rw, 26, { size: 17, color: C.navy, bold: true, maxLines: 1 });
  const rows = all.filter((s) => s.id !== "title" && s.id !== "coverage" && s.ref).map((s, i) => [{ text: String(i + 2), align: "c" as const, color: C.muted, size: 13 }, { text: s.kicker, bold: true, color: C.navy, size: 13, maxLines: 1 }, { text: s.ref ?? "", size: 13, maxLines: 1 }]);
  cv.table(rx, TOP + 34, [44, 236, rw - 280], [[{ text: "#", align: "c" as const }, { text: "Slide" }, { text: "Report section" }], ...rows], { header: true, size: 13, padY: 4, minRowH: 31, maxH: 470 });
  return done();
}

/** Lay the whole deck out. Footers (project, report reference, page number) are added last, when the page count is known. */
export function layoutDeck(c: DeckContent): DeckSlides {
  const slides: Slide[] = [titleSlide(c), bottomLineSlide(c), scorecardSlide(c), numbersSlide(c), capabilitiesSlide(c), architectureSlide(c), technologySlide(c), flowsSlide(c), dataSlide(c), riskSlide(c), prioritiesSlide(c), testingSlide(c), actionsSlide(c)];
  slides.push(coverageSlide(c, slides));
  const total = slides.length;
  slides.forEach((s, i) => {
    if (s.dark) return;
    const foot = new Canvas();
    foot.text(`${c.project.name}  ·  Executive summary`, X, H - 38, 440, 22, { size: 12, color: C.muted, maxLines: 1, valign: "m" });
    if (s.ref) foot.text(`Report ${s.ref}`, X + 420, H - 38, 640, 22, { size: 12, color: C.accent, bold: true, align: "r", maxLines: 1, valign: "m" });
    foot.text(`${i + 1} / ${total}`, X + CW - 64, H - 38, 64, 22, { size: 12, color: C.muted, align: "r", maxLines: 1, valign: "m" });
    s.prims.push(...foot.prims);
  });
  return { title: `${c.project.name}: Executive summary`, projectName: c.project.name, generatedAt: c.generatedAt, slides };
}
