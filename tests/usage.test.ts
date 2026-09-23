import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordUsage, UsageLedger, withUsageLedger, type UsageSnapshot } from "@/lib/ai";
import { costOf, normalizeModelId, priceFor } from "@/lib/ai/pricing";
import { getDb, schema } from "@/lib/db/client";
import { GET as overview } from "@/app/api/projects/[id]/overview/route";
import { analyze, fixtureFiles, freshDb, MockProvider, setAIProvider } from "./helpers";

describe("pricing", () => {
  afterEach(() => { delete process.env.AI_PRICING; });

  it("finds list prices through platform prefixes and date snapshots", () => {
    expect(normalizeModelId("anthropic.claude-opus-5")).toBe("claude-opus-5");
    expect(normalizeModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(normalizeModelId("gpt-4o-2024-08-06")).toBe("gpt-4o");
    expect(priceFor("anthropic", "claude-opus-5").rate).toMatchObject({ input: 5, output: 25, cachedInput: 0.5, cacheWrite: 6.25 });
    expect(priceFor("anthropic", "claude-haiku-4-5-20251001").rate).toMatchObject({ input: 1, output: 5 });
    expect(priceFor("openai-compatible", "gpt-4.1", "api.openai.com").rate).toMatchObject({ input: 2, output: 8, cachedInput: 0.5 });
  });
  it("never prices a local or third-party endpoint as OpenAI, and says why", () => {
    const local = priceFor("openai-compatible", "gpt-4.1", "localhost");
    expect(local).toMatchObject({ rate: null, source: "none" });
    expect(local.basis).toContain("localhost");
    expect(priceFor("anthropic", "some-future-model")).toMatchObject({ rate: null, source: "none" });
  });
  it("lets AI_PRICING override or add rates, and ignores malformed JSON", () => {
    process.env.AI_PRICING = JSON.stringify({ "llama3:70b": { input: 0.5, output: 1 }, "claude-opus-5": { input: 4, output: 20 } });
    expect(priceFor("openai-compatible", "llama3:70b", "localhost")).toMatchObject({ rate: { input: 0.5, output: 1 }, source: "custom" });
    expect(priceFor("anthropic", "claude-opus-5").rate).toMatchObject({ input: 4, output: 20 });
    process.env.AI_PRICING = "{not json";
    expect(priceFor("anthropic", "claude-opus-5")).toMatchObject({ source: "list" });
  });
  it("computes cost from every kind of token", () => {
    const rate = priceFor("anthropic", "claude-opus-5").rate!;
    // 1M input $5 + 1M output $25 + 1M cache read $0.50 + 1M cache write $6.25
    expect(costOf(rate, { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 1e6 })).toBeCloseTo(36.75, 6);
  });
});

describe("usage ledger", () => {
  it("totals tokens and cost by model and by pipeline step, keeping a fallback model apart", () => {
    const l = new UsageLedger();
    l.record({ provider: "anthropic", model: "claude-opus-5", task: "review:security", inputTokens: 100_000, outputTokens: 10_000 });
    l.record({ provider: "anthropic", model: "claude-opus-5", task: "review:verify", inputTokens: 20_000, outputTokens: 2_000 });
    l.record({ provider: "anthropic", model: "claude-opus-4-8", task: "review:security", inputTokens: 50_000, outputTokens: 5_000 });
    l.record({ provider: "anthropic", model: "claude-opus-5", task: "formal:model", inputTokens: 10_000, outputTokens: 4_000, cacheReadTokens: 30_000 });
    const s = l.snapshot();
    expect(s.calls).toBe(4);
    expect(s.inputTokens).toBe(180_000);
    expect(s.outputTokens).toBe(21_000);
    expect(s.cacheReadTokens).toBe(30_000);
    expect(s.models.map((m) => m.model)).toEqual(["claude-opus-5", "claude-opus-4-8"]);
    // Opus 5: 130k in*$5 + 16k out*$25 + 30k cache*$0.5 = 0.65 + 0.4 + 0.015; Opus 4.8: 50k*$5 + 5k*$25 = 0.25 + 0.125
    expect(s.costUsd).toBeCloseTo(1.44, 6);
    expect(s.costPartial).toBe(false);
    expect(s.stages.map((x) => x.key)).toEqual(["review", "formal", "verify"]);
    expect(s.stages.find((x) => x.key === "review")!.costUsd).toBeCloseTo(0.75 + 0.375, 6);
  });
  it("marks the cost as partial when a model has no price, and as unknown when none has", () => {
    const l = new UsageLedger();
    l.record({ provider: "openai-compatible", model: "llama3", task: "docs:files", inputTokens: 1000, outputTokens: 100, host: "localhost" });
    expect(l.snapshot()).toMatchObject({ costUsd: null, costPartial: false });
    l.record({ provider: "anthropic", model: "claude-sonnet-5", task: "docs:files", inputTokens: 1_000_000, outputTokens: 0 });
    expect(l.snapshot()).toMatchObject({ costUsd: 2, costPartial: true });
  });
  it("counts only calls made inside its own run, even when runs overlap", async () => {
    const a = new UsageLedger();
    const b = new UsageLedger();
    const call = async (task: string) => { await new Promise((r) => setTimeout(r, 5)); recordUsage({ provider: "anthropic", model: "claude-haiku-4-5", task, inputTokens: 10, outputTokens: 1 }); };
    recordUsage({ provider: "anthropic", model: "claude-haiku-4-5", task: "ask", inputTokens: 999, outputTokens: 9 }); // outside any run
    await Promise.all([withUsageLedger(a, () => Promise.all([call("review:a"), call("review:b")])), withUsageLedger(b, () => call("docs:x"))]);
    expect(a.snapshot().calls).toBe(2);
    expect(b.snapshot().calls).toBe(1);
    expect(a.snapshot().inputTokens).toBe(20);
  });
});

describe("usage in the analysis pipeline", () => {
  beforeEach(() => freshDb());

  it("saves live usage while the run is going, then the final usage with model and cost", async () => {
    let seenLive: { live?: boolean; aiUsage?: UsageSnapshot; model?: { model: string } } | null = null;
    let jobId = "";
    let waited = false;
    const provider = new MockProvider(async (req) => {
      // Mid-run, after the throttle window, the job row must already carry the usage so far.
      if (req.task === "review:reliability" && !waited) {
        waited = true;
        await new Promise((r) => setTimeout(r, 1300));
        jobId = getDb().select().from(schema.jobs).all().at(-1)!.id;
        seenLive = getDb().select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).get()!.summary as typeof seenLive;
      }
      if (req.task.startsWith("review:") && req.task !== "review:verify") return { findings: [] };
      return undefined; // everything else fails and falls back, but its tokens were still spent
    }, { provider: "anthropic", model: "claude-sonnet-5" });
    setAIProvider(provider);
    const r = await analyze(fixtureFiles(), "shop");
    expect(r.job.status).toBe("succeeded");

    expect(seenLive!.live).toBe(true);
    expect(seenLive!.model!.model).toBe("claude-sonnet-5");
    expect(seenLive!.aiUsage!.calls).toBeGreaterThan(0);

    const final = (r.job.summary as { aiUsage: UsageSnapshot; live?: boolean }).aiUsage;
    expect((r.job.summary as { live?: boolean }).live).toBeUndefined();
    expect(final.calls).toBe(provider.calls.length);
    expect(final.models).toHaveLength(1);
    expect(final.models[0]).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5", priceSource: "list" });
    const expected = (final.inputTokens * 2 + final.outputTokens * 10) / 1e6;
    expect(final.costUsd).toBeCloseTo(expected, 9);
    expect(final.stages.map((s) => s.key)).toContain("review");
    expect(final.stages.map((s) => s.key)).toContain("docs");

    // Some requests failed (the scripted docs tasks) but most succeeded: the Overview says so, and does not claim the
    // whole AI analysis failed and everything shown is deterministic.
    const o = await (await overview(new Request("http://brody/"), { params: Promise.resolve({ id: r.projectId }) })).json() as { aiProblem: { partial: boolean; failures: number; succeeded: number } };
    expect(o.aiProblem).toMatchObject({ partial: true });
    expect(o.aiProblem.succeeded).toBeGreaterThan(0);
  });

  it("records no usage and no model when there is no AI provider", async () => {
    const r = await analyze(fixtureFiles(), "shop");
    const s = r.job.summary as { aiUsage: UsageSnapshot; model: unknown };
    expect(s.model).toBeNull();
    expect(s.aiUsage).toMatchObject({ calls: 0, costUsd: null });
  });
});
