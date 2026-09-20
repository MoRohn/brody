import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { GET as exportRoute } from "@/app/api/projects/[id]/export/route";
import { getDb, schema } from "@/lib/db/client";
import { setAIProvider, UsageMeter } from "@/lib/ai";
import { loadDocInputs } from "@/lib/docs";
import { narrateBrief } from "@/lib/docs/ai";
import { buildBrief } from "@/lib/docs/brief";
import type { Architecture } from "@/lib/discover/types";
import type { DocReport } from "@/lib/docs/types";
import { buildMarkdown } from "@/lib/export";
import { analyze, fixtureFiles, freshDb, MockProvider } from "./helpers";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
let pid: string;
let docs: DocReport;
let arch: Architecture;
const load = () => {
  const a = getDb().select().from(schema.projects).where(eq(schema.projects.id, pid)).get()!.analysis as { docs: DocReport; architecture: Architecture };
  docs = a.docs; arch = a.architecture;
};
beforeAll(async () => {
  freshDb();
  pid = (await analyze(fixtureFiles(), "sample-shop")).projectId;
  load();
});

describe("executive brief (business summary)", () => {
  it("is always produced, from the analysis alone, with numbers computed from the repository", () => {
    const b = docs.brief!;
    expect(b.origin).toBe("deterministic");
    expect(b.headline).toMatch(/Order taking backend/);
    expect(b.metrics.map((m) => m.label)).toEqual(["Source files", "Lines of code", "Main languages", "Functional areas", "API routes", "Data models", "External services", "Critical or high findings"]);
    expect(b.metrics.find((m) => m.label === "API routes")!.value).toBe("5");
    expect(b.metrics.find((m) => m.label === "Critical or high findings")!.value).toBe("3");
    expect(b.health.verdict).toMatch(/Needs attention.*1 critical issue and 2 high-severity/);
    expect(b.keyPoints.map((k) => k.title)).toEqual(["What it is", "How it is built", "What it does", "Where the risk is", "What to do next"]);
  });

  it("speaks to business readers: no file paths or finding codes, no duplicate steps, with a business reason where a finding has one", () => {
    const b = docs.brief!;
    const text = JSON.stringify(b);
    expect(text).not.toMatch(/[A-Z]{2,4}-\d{3}/);
    expect(text).not.toMatch(/\bsrc\/[\w/.-]+\.(ts|py)/);
    const actions = b.nextSteps.map((n) => n.action.toLowerCase());
    expect(new Set(actions).size).toBe(actions.length);
    expect(b.nextSteps[0]).toMatchObject({ priority: "Now" });
    expect(b.nextSteps[0].why).toMatch(/credential|exposure/i);
    expect(b.capabilities.every((c) => c.length < 140)).toBe(true);
  });

  it("can be derived for reports generated before it existed", () => {
    const { brief: _drop, ...old } = docs;
    void _drop;
    const findings = getDb().select().from(schema.findings).where(eq(schema.findings.projectId, pid)).all();
    expect(buildBrief(old, arch, findings, "sample-shop").headline).toBe(docs.brief!.headline);
  });
});

describe("the brief opens the report; the in-depth summary becomes Summary evidence", () => {
  it("puts the brief first and keeps the original statements, with sources, below it as 'Summary evidence'", () => {
    const md = buildMarkdown(pid);
    const exec = md.slice(md.indexOf("## 1. Executive Summary"), md.indexOf("## 2. "));
    const order = ["> **", "### Snapshot", "### Key points", "### What it does", "### Health and risk", "### Recommended next steps", "### Summary evidence"].map((h) => exec.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const evidence = exec.slice(exec.indexOf("### Summary evidence"));
    for (const st of docs.executiveSummary) expect(evidence).toContain(st.text);
    expect(evidence).toMatch(/`src\/server\.ts:\d+/); // sources stay on the evidence, not the brief
    expect(exec.slice(0, exec.indexOf("### Summary evidence"))).not.toMatch(/`src\//);
  });

  it("is condensed by default and complete on request, with every section and the required order in both", async () => {
    const concise = buildMarkdown(pid);
    const complete = buildMarkdown(pid, { scope: "complete" });
    expect(concise.length).toBeLessThan(complete.length * 0.6);
    for (const md of [concise, complete]) {
      const order = Array.from({ length: 19 }, (_, i) => md.indexOf(`## ${i + 1}. `));
      expect(order.every((x) => x >= 0) && [...order].sort((a, b) => a - b).join() === order.join()).toBe(true);
    }
    // Detail lives only in the complete report.
    expect(complete).toContain("#### `createOrder`");
    expect(complete).toContain("**Why it matters.**");
    expect(concise).not.toContain("**Why it matters.**");
    expect(concise).not.toContain("#### `createOrder`");
    expect(concise).toMatch(/\| ID \| Severity \| Finding \| Where \| Fix \|/);
    expect(concise).toContain("The **Complete Technical Report** contains every finding");
    expect(complete).not.toContain("condensed report");
  });

  it("serves the complete report as its own scope over the API", async () => {
    const res = await exportRoute(new Request("http://localhost/x?format=md&scope=complete"), ctx(pid));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("complete-report.md");
    expect((await res.text()).startsWith("# Complete Technical Report")).toBe(true);
  });

  it("renders the PDF executive summary as five landscape slides after the cover, without repeating them as text", async () => {
    const res = await exportRoute(new Request("http://localhost/x?format=pdf"), ctx(pid));
    const buf = Buffer.from(await res.arrayBuffer());
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), verbosity: 0 }).promise;
    const sizes: string[] = [];
    for (let i = 1; i <= Math.min(8, doc.numPages); i++) { const v = (await doc.getPage(i)).view; sizes.push(`${Math.round(v[2])}x${Math.round(v[3])}`); }
    expect(sizes.slice(0, 7)).toEqual(["595x842", "842x474", "842x474", "842x474", "842x474", "842x474", "595x842"]);
    let bodyText = "";
    for (let i = 7; i <= doc.numPages; i++) bodyText += (await (await doc.getPage(i)).getTextContent()).items.map((it) => ("str" in it ? it.str : "")).join(" ");
    expect(bodyText).toContain("presented as slides");
    expect(bodyText).not.toContain("Snapshot");
    // Slides are excluded from scopes without an executive summary.
    const review = Buffer.from(await (await exportRoute(new Request("http://localhost/x?format=pdf&scope=review"), ctx(pid))).arrayBuffer());
    const rd = await pdfjs.getDocument({ data: new Uint8Array(review), verbosity: 0 }).promise;
    expect(Math.round((await rd.getPage(2)).view[2])).toBe(595);
  });
});

describe("sequential AI step: distil the summary into the business brief", () => {
  it("runs after the technical synthesis, is fed the Summary evidence, and replaces the words but never the numbers", async () => {
    freshDb();
    const calls: string[] = [];
    const provider = new MockProvider((req) => {
      calls.push(req.task);
      if (req.task === "docs:brief") return { headline: "AI: a shop backend.", summary: "AI summary.", audience: "Shop owners", keyPoints: [{ title: "What it does", detail: "Takes orders." }], capabilities: ["Take orders"], health: { verdict: "Needs attention.", strengths: ["Has tests"], concerns: ["Payment errors are hidden"] }, nextSteps: [{ action: "Fix payments", why: "Lost revenue", priority: "Now" }, { action: "Add alerts", why: "Faster response", priority: "whenever" }], metrics: [{ label: "Source files", value: "9999" }] };
      return undefined;
    });
    setAIProvider(provider);
    try {
      const r = await analyze(fixtureFiles(), "sample-shop");
      const d = (r.project.analysis as { docs: DocReport }).docs;
      expect(d.brief).toMatchObject({ origin: "ai", headline: "AI: a shop backend.", audience: "Shop owners" });
      expect(d.brief!.nextSteps.map((n) => n.priority)).toEqual(["Now", "Next"]); // unknown priorities are normalised
      expect(d.brief!.metrics.find((m) => m.label === "Source files")!.value).toBe("9"); // numbers are never the model's
      // The in-depth statements are untouched and remain available as the evidence.
      expect(d.executiveSummary.length).toBeGreaterThan(0);
      // Sequential: the brief call comes after synthesis and sees its output.
      expect(calls.indexOf("docs:brief")).toBeGreaterThan(calls.indexOf("docs:synthesis"));
      const prompt = provider.calls.find((c) => c.task === "docs:brief")!.prompt;
      expect(prompt).toContain("Summary evidence");
      expect(prompt).toContain("<untrusted_repository_content>");
      expect(prompt).toMatch(/Do not use file paths/);
      expect(prompt).toMatch(/Computed numbers: Source files: 9;/);
    } finally { setAIProvider(null); }
  });

  it("keeps the deterministic brief when the model call fails or returns nothing usable", async () => {
    freshDb();
    pid = (await analyze(fixtureFiles(), "sample-shop")).projectId;
    load();
    const inputs = loadDocInputs(pid, arch);
    const failing = new MockProvider(() => { throw new Error("503 overloaded"); });
    const meter = new UsageMeter();
    expect(await narrateBrief({ provider: failing, meter, inputs, report: docs, brief: docs.brief! })).toBeUndefined();
    expect(meter.failures[0].task).toBe("docs:brief");
    const empty = new MockProvider(() => ({ headline: " ", summary: "", audience: "", keyPoints: [], capabilities: [], health: { verdict: "", strengths: [], concerns: [] }, nextSteps: [] }));
    expect(await narrateBrief({ provider: empty, meter: new UsageMeter(), inputs, report: docs, brief: docs.brief! })).toBeUndefined();
  });
});
