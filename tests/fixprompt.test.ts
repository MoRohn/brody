/**
 * The Code Review fix-it prompt: every open finding, condensed and ordered, with its fix, as one Markdown prompt.
 */
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { analyze, fixtureFiles, freshDb } from "./helpers";
import { getDb, schema } from "@/lib/db/client";
import type { FindingRow } from "@/lib/db/schema";
import { buildFixPrompt, condense, SEVERITIES, titleWords } from "@/lib/review/fixprompt";
import { GET } from "@/app/api/projects/[id]/fix-prompt/route";

const finding = (o: Partial<FindingRow>): FindingRow => ({ id: o.code ?? "f", projectId: "p", code: "X-1", title: "t", category: "Correctness", severity: "Medium", confidence: "high", origin: "ai", analyzer: null, filePath: "src/a.ts", startLine: 10, endLine: 20, evidence: null, whatHappens: "w", whyItMatters: "y", businessImpact: null, remediation: "r", patch: null, relatedComponents: [], verification: "verified", verificationNote: null, area: null, ...o });

describe("condensing", () => {
  it("merges the same problem reported twice and rewordings on the same lines, never different problems", () => {
    const issues = condense([
      finding({ code: "A-1", title: "Inference server pins DEVICE to cuda:0, which defeats GPU packing", filePath: "src/s.py", startLine: 5, endLine: 11, severity: "Medium" }),
      finding({ code: "A-2", title: "Inference server hardcodes cuda:0 and cannot honour a packed GPU assignment", filePath: "src/s.py", startLine: 5, endLine: 11, severity: "Low", category: "Architecture" }),
      finding({ code: "B-1", title: "Prometheus query is not percent-encoded", filePath: "src/m.py", startLine: 5, endLine: 13 }),
      finding({ code: "B-2", title: "Prometheus call has no timeout", filePath: "src/m.py", startLine: 8, endLine: 13 }),
      finding({ code: "C-1", title: "Missing input validation", filePath: "src/x.ts", startLine: 1, endLine: 2, severity: "High" }),
      finding({ code: "C-2", title: "Missing input validation", filePath: "src/y.ts", startLine: 40, endLine: 41, severity: "High" }),
    ]);
    expect(issues.map((i) => i.codes)).toEqual([["C-1", "C-2"], ["A-1", "A-2"], ["B-1"], ["B-2"]]);
    expect(issues[0]).toMatchObject({ n: 1, severity: "High", locations: ["src/x.ts:1-2", "src/y.ts:40-41"] });
    expect(issues[1]).toMatchObject({ severity: "Medium", category: "Correctness, Architecture" });
    expect([...titleWords("Packing packed packer")]).toEqual(["pack"]);
  });
});

describe("fix prompt for a real review", () => {
  let projectId = "";
  beforeAll(async () => {
    freshDb();
    projectId = (await analyze(fixtureFiles())).projectId;
  }, 120_000);

  it("lists every open finding, ordered by severity, with its fix and the ground rules", () => {
    const rows = getDb().select().from(schema.findings).where(eq(schema.findings.projectId, projectId)).all().filter((f) => f.verification !== "rejected");
    expect(rows.length).toBeGreaterThan(3);
    const p = buildFixPrompt(projectId);
    expect(p.stats.findings).toBe(rows.length);
    for (const f of rows) expect(p.markdown).toContain(f.code);
    for (const f of rows) expect(p.markdown).toContain(f.remediation.replace(/\r?\n+/g, " ").replace(/\|/g, "\\|").trim().slice(0, 60));
    const order = p.issues.map((i) => SEVERITIES.indexOf(i.severity as (typeof SEVERITIES)[number]));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(p.markdown).toMatch(/^# Fix the issues Brody found in /);
    expect(p.markdown).toContain("## Ground rules");
    expect(p.markdown).toContain("confirm the issue is real and still present");
    expect(p.markdown).toContain("## When you finish");
    expect(p.fileName).toMatch(/-fix-prompt\.md$/);
    expect(p.stats.approxTokens).toBeGreaterThan(100);
  });

  it("honours the options: severities, unverified findings, patches and evidence", () => {
    const all = buildFixPrompt(projectId);
    const high = buildFixPrompt(projectId, { severities: ["Critical", "High"] });
    expect(high.issues.every((i) => i.severity === "Critical" || i.severity === "High")).toBe(true);
    expect(high.stats.findings).toBeLessThan(all.stats.findings);
    const verifiedOnly = buildFixPrompt(projectId, { includeUnverified: false });
    expect(verifiedOnly.issues.every((i) => i.findings.every((f) => f.verification === "verified"))).toBe(true);
    expect(buildFixPrompt(projectId, { includePatches: false }).markdown).not.toContain("Suggested patch (");
    expect(buildFixPrompt(projectId, { includeEvidence: false }).markdown).not.toContain("Evidence (");
    expect(buildFixPrompt(projectId, { severities: ["Nonexistent"] }).markdown).toContain("There is nothing to fix.");
  });

  it("keeps fences intact when evidence contains backticks, and never prints a secret", () => {
    const f = getDb().select().from(schema.findings).where(eq(schema.findings.projectId, projectId)).all()[0];
    getDb().update(schema.findings).set({ evidence: "const s = `x`;\n```\nconst key = \"sk-ant-abcdefghijklmnopqrstuvwxyz0123\";", verification: "verified" }).where(eq(schema.findings.id, f.id)).run();
    const md = buildFixPrompt(projectId).markdown;
    expect(md).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz0123");
    expect(md).toContain("````");
    expect((md.match(/^````/gm) ?? []).length % 2).toBe(0);
  });

  it("serves JSON and a Markdown download over HTTP", async () => {
    const ctx = { params: Promise.resolve({ id: projectId }) };
    const j = await (await GET(new Request("http://x/?severity=High,Medium&patches=0"), ctx)).json();
    expect(j.issues.length).toBeGreaterThan(0);
    expect(j.issues[0]).toHaveProperty("fix");
    expect(j.markdown).not.toContain("Suggested patch (");
    const dl = await GET(new Request("http://x/?download=1"), { params: Promise.resolve({ id: projectId }) });
    expect(dl.headers.get("content-type")).toMatch(/^text\/markdown/);
    expect(dl.headers.get("content-disposition")).toMatch(/attachment; filename=".+-fix-prompt\.md"/);
    expect(await dl.text()).toMatch(/^# Fix the issues/);
  });
});
