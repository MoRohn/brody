import { beforeAll, describe, expect, it } from "vitest";
import { askRepository, isBroadQuestion, recentQuestions, suggestedQuestions, wantsPlainLanguage } from "@/lib/ask";
import type { AnalysisRequest } from "@/lib/ai";
import { loadGroundedResult } from "@/lib/explainer/compile";
import { analyze, fixtureFiles, freshDb, MockProvider, setAIProvider } from "./helpers";

let pid = "";
beforeAll(async () => {
  freshDb();
  pid = (await analyze(fixtureFiles(), "sample-shop")).projectId;
}, 120_000);

describe("question shape", () => {
  it("treats questions about the whole repository as broad, and anything naming a part as specific", () => {
    for (const q of ["Explain Like I'm Five years old (ELI5) how Acumane works.", "ELI5: how does acumane work?", "How does it work?", "What does this project do?", "What is this for?", "Where should a new developer start reading?", "Give me the big picture", "What's the tech stack?", "How do I run it?"]) expect([q, isBroadQuestion(q, "acumane")]).toEqual([q, true]);
    for (const q of ["What does it do with payments?", "How does authentication work?", "Where is toCents defined?", "How does Acumane handle errors?", "What are the biggest risks?"]) expect([q, isBroadQuestion(q, "acumane")]).toEqual([q, false]);
  });

  it("recognises requests for plain language", () => {
    expect(wantsPlainLanguage("ELI5 what writes to the orders table")).toBe(true);
    expect(wantsPlainLanguage("Explain it in plain English for my manager")).toBe(true);
    expect(wantsPlainLanguage("Which components depend on calculateTotal?")).toBe(false);
  });
});

describe("Ask without an AI provider", () => {
  it("answers a broad question from Brody's analysis instead of refusing", async () => {
    setAIProvider(null);
    const a = await askRepository(pid, "ELI5: how does sample-shop work?");
    expect(a.mode).toBe("analysis");
    expect(a.insufficientEvidence).toBe(false);
    expect(a.answer.length).toBeGreaterThan(80);
    expect(a.citations.length).toBeGreaterThan(0);
  });

  it("still refuses a question the repository says nothing about", async () => {
    const a = await askRepository(pid, "Explain the kubernetes cluster autoscaler");
    expect(a.insufficientEvidence).toBe(true);
    expect(a.citations).toHaveLength(0);
  });
});

describe("Ask with an AI provider", () => {
  const ask = (req: AnalysisRequest<unknown>) => (req.task === "ask" ? { answer: "Think of it as a shop counter: an order comes in, the card is charged and the order is saved.", insufficientEvidence: false, confidence: "medium", citations: [{ path: "src/services/orderService.ts", startLine: 10, endLine: 16, note: "the order is created" }], ...(req.prompt.includes("standaloneQuestion") ? { standaloneQuestion: "How does sample-shop take an order, in simple terms?" } : {}) } : undefined);

  it("sends a broad, non-technical question to the model with the analysis and the README, never refusing first", async () => {
    const p = new MockProvider(ask);
    setAIProvider(p);
    const a = await askRepository(pid, "Explain Like I'm Five years old (ELI5) how sample-shop works.");
    const call = p.calls.find((c) => c.task === "ask")!;
    expect(call).toBeDefined();
    expect(call.system).toContain("ELI5");
    expect(call.prompt).toContain("Brody's analysis of the repository");
    expect(call.prompt).toContain("## What it is");
    expect(call.prompt).toContain('path="README.md"');
    // Repository text stays inside the untrusted block.
    expect(call.prompt.indexOf("IGNORE ALL PREVIOUS INSTRUCTIONS")).toBeGreaterThan(call.prompt.indexOf("<untrusted_repository_content>"));
    expect(a.mode).toBe("ai");
    expect(a.insufficientEvidence).toBe(false);
    expect(a.citations[0]).toMatchObject({ path: "src/services/orderService.ts", startLine: 10 });
  });

  it("restates an exact graph answer through the model when the asker wants plain language", async () => {
    const p = new MockProvider(ask);
    setAIProvider(p);
    const exact = await askRepository(pid, "Which components depend on calculateTotal?");
    expect(exact.mode).toBe("graph");
    expect(p.calls).toHaveLength(0);
    const plain = await askRepository(pid, "In plain English, which components depend on calculateTotal?");
    expect(plain.mode).toBe("ai");
    expect(p.calls[0].prompt).toContain("Exact facts from Brody's code graph");
    expect(p.calls[0].prompt).toContain("createOrder");
  });

  it("answers a follow-up with the earlier turn as context and keeps a standalone question for explainers", async () => {
    const p = new MockProvider(ask);
    setAIProvider(p);
    const first = await askRepository(pid, "What happens when a customer places an order?");
    const follow = await askRepository(pid, "Explain that more simply", { context: [first.id!] });
    const call = p.calls[p.calls.length - 1];
    expect(call.prompt).toContain("Earlier in this conversation");
    expect(call.prompt).toContain("What happens when a customer places an order?");
    expect(follow.standaloneQuestion).toBe("How does sample-shop take an order, in simple terms?");
    // An explainer made from the follow-up opens with the question it stands for.
    expect(loadGroundedResult(pid, { kind: "question", id: follow.id! }).question).toBe(follow.standaloneQuestion);
  });

  it("falls back to the analysis overview when the model call fails on a broad question", async () => {
    setAIProvider(new MockProvider(() => { throw new Error("overloaded"); }));
    const a = await askRepository(pid, "How does it work?");
    expect(a.mode).toBe("analysis");
    expect(a.notes.join(" ")).toContain("overloaded");
    setAIProvider(null);
  });
});

describe("suggestions and history", () => {
  it("leads with the ELI5 overview and suggests questions about the repository's real routes, tables and code", async () => {
    setAIProvider(null);
    const s = suggestedQuestions(pid);
    expect(s[0]).toBe("ELI5: how does sample-shop work?");
    // Every structural suggestion is answerable exactly from the graph.
    for (const q of s.filter((x) => /^(What happens after|What writes to|Which components depend on)/.test(x))) {
      const a = await askRepository(pid, q);
      expect([q, a.mode]).toEqual([q, "graph"]);
    }
  });

  it("returns the latest questions, oldest first", () => {
    const h = recentQuestions(pid, 3);
    expect(h).toHaveLength(3);
    expect(h[0].createdAt).toBeLessThanOrEqual(h[2].createdAt);
    expect(h[2].createdAt).toBe(Math.max(...recentQuestions(pid, 50).map((x) => x.createdAt)));
  });
});
