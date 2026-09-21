import { eq } from "drizzle-orm";
import { unzipSync, strFromU8 } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { GET as deckRoute } from "@/app/api/projects/[id]/deck/route";
import { getDb, projectRows, schema } from "@/lib/db/client";
import { buildDeckContent, deckOutline, deckSlides, ensureDeckContent, exportDeck, layoutDeck, type DeckContent } from "@/lib/deck";
import { exposureFor, humanizeFlow, issueFor, plainText, RULES_WITH_WORDING, TECHNICAL_TOKENS } from "@/lib/deck/lexicon";
import { textWidth } from "@/lib/deck/measure";
import { H, slideText, W } from "@/lib/deck/scene";
import { buildMarkdown, loadReportData } from "@/lib/export/markdown";
import { getJob } from "@/lib/jobs";
import { STAGE_DEFS } from "@/lib/jobs/stages";
import { analyze, fixtureFiles, freshDb } from "./helpers";

let pid: string;
let jobId: string;
let content: DeckContent;
beforeAll(async () => {
  freshDb();
  const r = await analyze(fixtureFiles(), "sample-shop");
  pid = r.projectId;
  jobId = r.jobId;
  content = ensureDeckContent(pid);
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("executive deck: the pipeline step", () => {
  it("runs as its own stage near the end, after the code map and before the report is finalised", () => {
    const keys = STAGE_DEFS.map((s) => s.key);
    expect(keys.slice(-3)).toEqual(["map", "deck", "finalize"]);
    const stage = getJob(jobId)!.stages.find((s) => s.key === "deck")!;
    expect(stage.status).toBe("done");
    expect(stage.detail).toMatch(/14 slides/);
  });

  it("stores its content with the analysis, beside the report's data", () => {
    const p = getDb().select().from(schema.projects).where(eq(schema.projects.id, pid)).get()!;
    const stored = (p.analysis as { deck?: DeckContent; docs?: unknown; architecture?: unknown }).deck!;
    expect(stored.version).toBe(3);
    expect((p.analysis as { docs?: unknown }).docs).toBeTruthy();
    expect(JSON.stringify(stored).length).toBeLessThan(60_000); // a compact snapshot, not a copy of the report
  });

  it("rebuilds a snapshot saved by an older deck version instead of failing on it", () => {
    const p = getDb().select().from(schema.projects).where(eq(schema.projects.id, pid)).get()!;
    const analysis = p.analysis as { deck: Record<string, unknown> };
    const stale: Record<string, unknown> = { ...analysis.deck, version: 2 };
    delete stale.overview;
    getDb().update(schema.projects).set({ analysis: { ...analysis, deck: stale } }).where(eq(schema.projects.id, pid)).run();
    const fresh: DeckContent = ensureDeckContent(pid);
    expect(fresh.version).toBe(3);
    expect(fresh.scorecard.length).toBe(6);
    expect(fresh.overview.business).toHaveLength(3);
    expect(layoutDeck(fresh).slides.length).toBe(14);
  });

  it("is built on first request for a project analysed before the deck existed", async () => {
    const p = getDb().select().from(schema.projects).where(eq(schema.projects.id, pid)).get()!;
    const { deck: _drop, ...rest } = p.analysis as Record<string, unknown>;
    void _drop;
    getDb().update(schema.projects).set({ analysis: rest }).where(eq(schema.projects.id, pid)).run();
    const file = await exportDeck(pid, "html");
    expect(String(file.body)).toContain("Executive summary");
    expect((getDb().select().from(schema.projects).where(eq(schema.projects.id, pid)).get()!.analysis as { deck?: unknown }).deck).toBeTruthy();
    content = ensureDeckContent(pid);
  });
});

describe("executive deck: one set of facts with the report", () => {
  it("names report sections exactly as the full report numbers and titles them", () => {
    const md = buildMarkdown(pid);
    const headings = [...md.matchAll(/^## (\d+)\. (.*)$/gm)].map((m) => ({ n: Number(m[1]), title: m[2] }));
    for (const ref of content.refs) expect(headings.find((h) => h.n === ref.n)?.title, ref.key).toBe(ref.title);
    expect(content.refs.length).toBe(headings.length);
  });

  it("uses the report's own numbers and finding references", () => {
    const { arch, docs, findings } = loadReportData(pid);
    const md = buildMarkdown(pid);
    expect(content.kpis.map((k) => ({ label: k.label, value: k.value }))).toEqual(docs.brief!.metrics);
    expect(content.quality.total).toBe(findings.length);
    const bySeverity = (s: string) => findings.filter((f) => f.severity === s).length;
    expect(content.quality.severity.map((s) => s.count)).toEqual(["Critical", "High", "Medium", "Low"].map(bySeverity));
    for (const p of content.quality.priorities) {
      expect(findings.some((f) => f.code === p.ref), p.ref).toBe(true);
      expect(md).toContain(p.ref); // the same reference appears in the report, so a reader can look it up
    }
    for (const a of content.capabilities) expect(arch.areas.some((x) => x.name === a.name && x.files.length === a.files)).toBe(true);
    expect(content.coverage.filesAnalysed).toBe(arch.stats.files);
    expect(content.data.models).toBe(arch.models.length);
  });

  it("puts a link back to the report on every slide, and lists them all on the last one", () => {
    const deck = deckSlides(pid);
    for (const s of deck.slides.filter((x) => !x.dark)) if (s.id !== "coverage") expect(s.ref, s.id).toMatch(/^§\d+ /);
    const last = slideText(deck.slides[deck.slides.length - 1]).join(" ");
    for (const s of deck.slides.filter((x) => x.ref && x.id !== "coverage")) expect(last, s.id).toContain(s.kicker.slice(0, 12));
    expect(new Set(deck.slides.filter((x) => !x.dark).map((x) => x.kicker)).size).toBe(deck.slides.filter((x) => !x.dark).length); // the map is unambiguous
  });
});

describe("executive deck: the summary and the two lenses", () => {
  it("opens with one summary slide that speaks to the business and to engineering, then names the first move", () => {
    const deck = deckSlides(pid);
    expect(deck.slides[1].id).toBe("summary");
    const text = slideText(deck.slides[1]).join(" ");
    expect(text).toMatch(/For the business/i);
    expect(text).toMatch(/For engineering/i);
    expect(text).toMatch(/First move/i);
    expect(content.overview.business).toHaveLength(3);
    expect(content.overview.engineering).toHaveLength(3);
    for (const p of [...content.overview.business, ...content.overview.engineering]) { expect(p.value.length).toBeGreaterThan(0); expect(p.detail.length).toBeGreaterThan(5); }
    expect(deck.slides[1].notes).toMatch(/For the business:.*For engineering:.*First move:/);
  });

  it("agrees with the rest of the deck and the report", () => {
    const { findings } = loadReportData(pid);
    const serious = findings.filter((f) => ["Critical", "High"].includes(f.severity)).length;
    const p = content.overview.business[2];
    expect(p.value).toBe(String(serious));
    expect(content.overview.engineering[1].value).toBe(`${content.scorecard.filter((d) => d.status === "good").length} of ${content.scorecard.length}`);
    expect(content.overview.engineering[2].value).toBe(`${content.testing.readiness.filter((r) => r.ok).length} of ${content.testing.readiness.length}`);
  });

  it("groups every slide between the title and the appendix under a lens, business first, then engineering, then the plan", () => {
    const body = deckSlides(pid).slides.filter((s) => !["title", "summary", "coverage"].includes(s.id));
    const lens = body.map((s) => s.kicker.split(" · ")[0]);
    expect(lens.every((l) => ["Business", "Engineering", "Action"].includes(l))).toBe(true);
    expect(lens.join(",")).toMatch(/^(Business,)+(Engineering,)+Action$/);
  });
});

describe("executive deck: rating and scorecard", () => {
  it("rates the system by the same rule as the report's executive summary", () => {
    const { docs, findings } = loadReportData(pid);
    const reportSays = /^needs attention/i.test(docs.brief!.health.verdict) ? "act" : /^generally sound/i.test(docs.brief!.health.verdict) ? "watch" : "good";
    expect(content.quality.level).toBe(reportSays);
    const critical = findings.filter((f) => f.severity === "Critical").length, high = findings.filter((f) => f.severity === "High").length;
    expect(content.quality.level).toBe(critical > 0 ? "act" : high > 0 ? "watch" : content.quality.level === "watch" ? "watch" : "good");
  });

  it("scores six dimensions from the findings, each with a status word and evidence", () => {
    expect(content.scorecard.map((d) => d.key)).toEqual(["security", "reliability", "quality", "maintain", "ops", "delivery"]);
    const { findings } = loadReportData(pid);
    const sec = content.scorecard.find((d) => d.key === "security")!;
    expect(sec.sev.critical + sec.sev.high + sec.sev.medium + sec.sev.low).toBe(findings.filter((f) => f.category === "Security" && ["Critical", "High", "Medium", "Low"].includes(f.severity)).length);
    expect(sec.status).toBe(sec.sev.critical > 0 ? "act" : sec.sev.high > 0 || sec.sev.medium >= 3 ? "watch" : "good");
    for (const d of content.scorecard) expect(d.evidence.length, d.key).toBeGreaterThan(5);
    const text = slideText(deckSlides(pid).slides.find((x) => x.id === "scorecard")!).join(" ");
    expect(text).toMatch(/On track|Watch|Needs attention/);
  });

  it("gives each slide an insight title rather than a topic label", () => {
    const deck = deckSlides(pid);
    const titles = deck.slides.filter((s) => !s.dark).map((s) => s.title);
    expect(new Set(titles).size).toBe(titles.length);
    expect(titles.filter((t) => /\d/.test(t)).length).toBeGreaterThan(6); // most titles carry a number from the analysis
    expect(titles.some((t) => /^(Overview|Summary|Details)$/i.test(t))).toBe(false);
  });

  it("never repeats a product name or drops one (Next.js is a product, not a file)", () => {
    expect(plainText("It is built with Next.js, Node.js and React.")).toBe("It is built with Next.js, Node.js and React.");
    expect(plainText("Edit orders.ts and src/app.js, not Next.js.")).toBe("Edit the code and the code, not Next.js.");
    const text = deckSlides(pid).slides.flatMap((s) => slideText(s)).join(" ");
    expect(text).not.toMatch(/built with the code|using the code|, the code,/);
  });
});

describe("executive deck: language", () => {
  const BRANDS = /\b(TypeScript|JavaScript|PostgreSQL|MySQL|GitHub|GraphQL|Nodemailer|SQLite|OpenAI|DeepSeek|Next\.js|Node\.js|Vue\.js|Express\.js|Nuxt\.js|Nest\.js)\b/g;
  it("keeps technical tokens off every slide", () => {
    const deck = deckSlides(pid);
    const leaks: string[] = [];
    for (const s of deck.slides) for (const t of slideText(s)) {
      const text = t.replace(BRANDS, "").replace(/\b[A-Z]{3}-\d{3}\b/g, "").replace(/§\d+/g, "").replace(/\d+ \/ \d+/g, "");
      for (const re of TECHNICAL_TOKENS) if (re.test(text)) leaks.push(`${s.id}: ${t} (${re})`);
    }
    expect(leaks).toEqual([]);
  });

  it("has executive wording for every built-in review rule, so a new rule cannot ship without it", () => {
    expect(RULES_WITH_WORDING()).toEqual([]);
  });

  it("turns findings into issues and exposures without code, files or identifiers", () => {
    const sample = [
      { analyzer: "brody-rules/sql-concat", title: "SQL query assembled by string concatenation", category: "Security", businessImpact: null, whyItMatters: "Any embedded value that originates from a request can alter the query structure." },
      { analyzer: "brody-structure", title: "8 important files have no tests", category: "Testing", businessImpact: null, whyItMatters: "Failures propagate to many callers." },
      { analyzer: "eslint/no-dupe-keys", title: "ESLint no-dupe-keys: Duplicate key 'k'", category: "Correctness", businessImpact: null, whyItMatters: "x" },
      { analyzer: "ai-review", title: "Something odd in src/lib/x.ts", category: "Reliability", businessImpact: "Orders could be lost.", whyItMatters: "y" },
    ];
    expect(sample.map((f) => issueFor(f).issue)).toEqual(["Database queries open to tampering", "Too little automated testing", "A likely defect in the code", "A reliability risk"]);
    expect(exposureFor(sample[1])).toMatch(/break things/);
    expect(exposureFor(sample[3])).toBe("Orders could be lost.");
    for (const f of sample) for (const t of [issueFor(f).issue, issueFor(f).action, exposureFor(f)]) expect(TECHNICAL_TOKENS.some((re) => re.test(t)), t).toBe(false);
    expect(plainText("Fix `eval()` in src/routes/auth.ts:12 (SEC-002): call run(x) now")).toBe("Fix in the code: call now");
  });

  it("describes routes as plain activities", () => {
    expect(humanizeFlow("POST /api/orders", "POST /api/orders")).toBe("Create an order");
    expect(humanizeFlow("GET /api/orders", "GET /api/orders")).toBe("List orders");
    expect(humanizeFlow("GET /api/orders/:id", "GET /api/orders/:id")).toBe("View an order");
    expect(humanizeFlow("POST /api/login", "POST /api/login")).toBe("Sign in");
    expect(humanizeFlow("DELETE /api/users/:id", "DELETE /api/users/:id")).toBe("Remove a user");
    expect(humanizeFlow("main", "startup", "startup")).toBe("System start-up");
    expect(humanizeFlow("POST /api/evaluate", "POST /api/evaluate")).toBe("Evaluate");
    expect(humanizeFlow("POST /api/analyze-excerpt", "POST /api/analyze-excerpt")).toBe("Analyze excerpt");
    expect(humanizeFlow("POST /api/citations", "POST /api/citations")).toBe("Create a citation");
  });
});

describe("executive deck: layout", () => {
  it("draws 14 slides that stay inside the page, with every line of text inside its box", () => {
    const deck = deckSlides(pid);
    expect(deck.slides).toHaveLength(14);
    const problems: string[] = [];
    for (const s of deck.slides) for (const p of s.prims) {
      if (p.t === "text") {
        for (const l of p.lines) if (textWidth(l, p.size, p.font, !!p.bold) > p.w + 1) problems.push(`${s.id}: "${l}" is wider than its ${Math.round(p.w)}px box`);
        if (p.lines.length * p.lh > p.h + p.lh) problems.push(`${s.id}: ${p.lines.length} lines do not fit ${Math.round(p.h)}px`);
        if (p.x < 0 || p.x + p.w > W + 1) problems.push(`${s.id}: text box leaves the page`);
        if (p.size < 12) problems.push(`${s.id}: type below 12px ("${p.lines[0]}")`);
      } else if (p.t === "table") {
        const w = p.cols.reduce((a, b) => a + b, 0), h = p.rowH.reduce((a, b) => a + b, 0);
        if (p.x + w > W - 40 + 20 || p.y + h > H - 46) problems.push(`${s.id}: table runs off the page (${Math.round(p.x + w)}, ${Math.round(p.y + h)})`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("handles a system with little to say: no findings, no services, no flows", () => {
    const empty: DeckContent = {
      ...content, capabilities: [], flows: [], integrations: [], actions: [],
      data: { models: 0, relations: 0, stores: [], entities: [] },
      architecture: { pattern: "Small script", lanes: [], links: [], foundation: [] },
      overview: { business: [], engineering: [], firstMove: "Nothing is urgent." },
      scorecard: [], quality: { total: 0, level: "good" as const, verdict: "No issues were found by the analysis.", strengths: [], severity: [{ label: "Critical", count: 0 }, { label: "High", count: 0 }, { label: "Medium", count: 0 }, { label: "Low", count: 0 }], themes: [], areaRisk: [], priorities: [] },
      testing: { files: 0, frameworks: [], coverage: [], untestedCritical: 0, readiness: [] },
    };
    const deck = layoutDeck(empty);
    expect(deck.slides).toHaveLength(14);
    expect(slideText(deck.slides.find((x) => x.id === "priorities")!).join(" ")).toMatch(/No serious issues|No findings/);
  });

  it("copes with long names and large numbers", () => {
    const big: DeckContent = { ...content, project: { ...content.project, name: "A very long project name that goes on and on for far too many words to fit" }, headline: "A ".repeat(200).trim(), summary: "Word ".repeat(300).trim() };
    for (const s of layoutDeck(big).slides) for (const p of s.prims) if (p.t === "text") for (const l of p.lines) expect(textWidth(l, p.size, p.font, !!p.bold)).toBeLessThanOrEqual(p.w + 1);
  });
});

describe("executive deck: the three formats", () => {
  it("HTML is one self-contained page with every slide, speaker notes and no outside resources", async () => {
    const f = await exportDeck(pid, "html");
    const html = String(f.body);
    expect(f.contentType).toMatch(/text\/html/);
    expect((html.match(/<section class="slide"/g) ?? []).length).toBe(14);
    expect(html).toContain("Speaker notes");
    expect(html).not.toMatch(/(?:src|href)="https?:/);
    expect(html).toContain("@media print");
    expect(html).not.toContain("<script src=");
    // Without script the page still shows every slide (script only upgrades it to a presenter).
    expect(html).toMatch(/\.slide\{display:block/);
    expect(html).toMatch(/\.js \.slide\{display:none\}/);
    expect(html).toContain("classList.add('js')");
    // State classes on <html> must not also be classes of elements: a rule such as ".rail{display:none}" would then hide the whole page.
    const elementClasses = new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)));
    const stateClasses = [...html.matchAll(/(?:classList\.(?:add|toggle|contains)|flag)\('([\w-]+)'/g)].map((m) => m[1]).filter((c) => !["on", "js"].includes(c));
    expect(stateClasses.length).toBeGreaterThan(2);
    for (const c of stateClasses) expect(elementClasses.has(c), `state class "${c}" is also used by an element`).toBe(false);
  });

  it("PDF has one landscape 16:9 page per slide", async () => {
    const f = await exportDeck(pid, "pdf");
    const pdf = (f.body as Buffer).toString("latin1");
    expect(pdf.startsWith("%PDF")).toBe(true);
    expect((pdf.match(/\/Type \/Page\b/g) ?? []).length).toBe(14);
    expect(pdf).toMatch(/\/MediaBox \[0 0 960 540\]/);
  });

  it("PowerPoint has 14 slides with speaker notes, native tables and well-formed XML", async () => {
    const f = await exportDeck(pid, "pptx");
    expect(f.filename).toMatch(/-executive-summary\.pptx$/);
    const files = unzipSync(new Uint8Array(f.body as Buffer));
    const slides = Object.keys(files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    expect(slides).toHaveLength(14);
    expect(Object.keys(files).filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n))).toHaveLength(14);
    let tables = 0;
    for (const n of slides) {
      const xml = strFromU8(files[n]);
      expect(xml.startsWith("<?xml"), n).toBe(true);
      expect((xml.match(/<p:sp>|<p:graphicFrame>|<p:cxnSp>|<p:pic>/g) ?? []).length, n).toBeGreaterThan(3);
      tables += (xml.match(/<a:tbl>/g) ?? []).length;
      for (const m of xml.matchAll(/<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"/g)) {
        const [x, y, cx, cy] = m.slice(1).map(Number);
        expect(x + cx, `${n} shape right edge`).toBeLessThanOrEqual(12192000 + 9525);
        expect(y + cy, `${n} shape bottom edge`).toBeLessThanOrEqual(6858000 + 9525);
      }
    }
    expect(tables).toBeGreaterThanOrEqual(4);
    expect(strFromU8(files["ppt/presProps.xml"] ?? new Uint8Array())).toBeDefined();
    const notes = strFromU8(files["ppt/notesSlides/notesSlide3.xml"]);
    expect(notes).toMatch(/Detail:/);
  });

  it("caches a file per analysis, so repeated downloads are instant", async () => {
    const a = await exportDeck(pid, "pdf");
    const b = await exportDeck(pid, "pdf");
    expect(b).toBe(a);
  });
});

describe("executive deck: API", () => {
  it("lists the slides, with the report section each points to, for the app page", async () => {
    const res = await deckRoute(new Request(`http://localhost/api/projects/${pid}/deck?format=outline`), ctx(pid));
    expect(res.status).toBe(200);
    const o = await res.json();
    expect(o.slides).toHaveLength(14);
    expect(o.slides[0]).toMatchObject({ n: 1, id: "title" });
    expect(o.slides.filter((x: { ref?: string }) => x.ref).length).toBeGreaterThanOrEqual(12);
    expect(o).toEqual(JSON.parse(JSON.stringify(deckOutline(pid))));
  });

  it("serves each format with the right headers, inline where a browser can show it", async () => {
    const html = await deckRoute(new Request(`http://localhost/api/projects/${pid}/deck?format=html&download=0`), ctx(pid));
    expect(html.status).toBe(200);
    expect(html.headers.get("content-disposition")).toMatch(/^inline;/);
    const pptx = await deckRoute(new Request(`http://localhost/api/projects/${pid}/deck?format=pptx&download=0`), ctx(pid));
    expect(pptx.headers.get("content-type")).toMatch(/presentationml/);
    expect(pptx.headers.get("content-disposition")).toMatch(/^attachment;/);
    const pdf = await deckRoute(new Request(`http://localhost/api/projects/${pid}/deck?format=pdf`), ctx(pid));
    expect(pdf.headers.get("content-disposition")).toMatch(/filename="[^"]+\.pdf"/);
  });

  it("refuses an unknown format and a project that is not ready", async () => {
    const bad = await deckRoute(new Request(`http://localhost/api/projects/${pid}/deck?format=keynote`), ctx(pid));
    expect(bad.status).toBe(400);
    const missing = await deckRoute(new Request("http://localhost/api/projects/nope/deck?format=html"), ctx("nope"));
    expect(missing.status).toBe(404);
  });
});

describe("executive deck: the report is unchanged", () => {
  it("does not mention the deck and keeps its own sections, numbering and content", () => {
    const md = buildMarkdown(pid);
    expect(md.toLowerCase()).not.toContain("executive deck");
    expect([...md.matchAll(/^## (\d+)\. /gm)].length).toBe(19);
    expect(md).toContain("## 1. Executive Summary");
    const { findings } = loadReportData(pid);
    expect(projectRows(schema.findings, pid).filter((f) => f.verification !== "rejected").length).toBe(findings.length);
  });
});

describe("executive deck: content builder", () => {
  it("rebuilds the same facts when asked again (only the timestamp differs)", () => {
    const again = buildDeckContent(pid);
    expect({ ...again, generatedAt: 0 }).toEqual({ ...content, generatedAt: 0 });
  });
});
