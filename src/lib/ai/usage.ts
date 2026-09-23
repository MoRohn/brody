/**
 * Token and cost accounting for one analysis run.
 *
 * Providers report every billable response here (analysis calls, retries and embeddings), with the model that actually
 * served it; a server-side fallback can answer with a different model than the one requested. The ledger for the current
 * run is found through AsyncLocalStorage, so every call made anywhere inside the run is counted without passing the ledger
 * through each function, and calls outside a run (health checks, other requests) are never attributed to it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { costOf, PRICES_AS_OF, priceFor, type Rate, type TokenCounts } from "./pricing";

export interface UsageEvent {
  provider: string;
  model: string;
  /** The analysis task ("review:security", "formal:model", "embed"...). */
  task: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Host of an OpenAI-compatible endpoint, so a local model is never priced as OpenAI. */
  host?: string;
}

export interface ModelUsage extends TokenCounts {
  provider: string;
  model: string;
  calls: number;
  costUsd: number | null;
  rate: Rate | null;
  priceSource: "list" | "custom" | "none";
  priceBasis: string;
}

export interface StageUsage extends TokenCounts { key: string; label: string; calls: number; costUsd: number | null }

export interface UsageSnapshot extends TokenCounts {
  calls: number;
  models: ModelUsage[];
  stages: StageUsage[];
  /** Sum over the models that have a price; null when none has. */
  costUsd: number | null;
  /** Some tokens came from a model without a known price, so the cost covers only part of the run. */
  costPartial: boolean;
  pricesAsOf: string;
  updatedAt: number;
}

/** Which pipeline step a task belongs to, for the per-step breakdown. */
const STAGE_OF: [RegExp, string, string][] = [
  [/^review:verify$/, "verify", "Verifying findings"],
  [/^review:/, "review", "AI review"],
  [/^formal:/, "formal", "Formal verification (Lean)"],
  [/^docs:/, "docs", "Documentation"],
  [/^embed/, "index", "Search index (embeddings)"],
  [/^ask/, "ask", "Ask repository"],
];
function stageOf(task: string): { key: string; label: string } {
  for (const [re, key, label] of STAGE_OF) if (re.test(task)) return { key, label };
  return { key: "other", label: "Other AI tasks" };
}

const zero = (): TokenCounts => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
const addTo = (t: TokenCounts, e: UsageEvent) => {
  t.inputTokens += e.inputTokens;
  t.outputTokens += e.outputTokens;
  t.cacheReadTokens += e.cacheReadTokens ?? 0;
  t.cacheWriteTokens += e.cacheWriteTokens ?? 0;
};

export class UsageLedger {
  private models = new Map<string, TokenCounts & { provider: string; model: string; host?: string; calls: number }>();
  /** Per step and model, so each step's cost uses the right model's price. */
  private stages = new Map<string, { label: string; calls: number; byModel: Map<string, TokenCounts> }>();
  private listeners: (() => void)[] = [];

  record(e: UsageEvent): void {
    const mk = `${e.provider}|${e.model}|${e.host ?? ""}`;
    const m = this.models.get(mk) ?? { provider: e.provider, model: e.model, host: e.host, calls: 0, ...zero() };
    m.calls++;
    addTo(m, e);
    this.models.set(mk, m);
    const st = stageOf(e.task);
    const s = this.stages.get(st.key) ?? { label: st.label, calls: 0, byModel: new Map() };
    s.calls++;
    const sm = s.byModel.get(mk) ?? zero();
    addTo(sm, e);
    s.byModel.set(mk, sm);
    this.stages.set(st.key, s);
    for (const l of this.listeners) l();
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  snapshot(): UsageSnapshot {
    const totals = zero();
    let calls = 0;
    let cost = 0;
    let priced = false;
    let partial = false;
    const models: ModelUsage[] = [];
    const prices = new Map<string, ReturnType<typeof priceFor>>();
    for (const [mk, m] of this.models) {
      const p = priceFor(m.provider, m.model, m.host);
      prices.set(mk, p);
      const c = p.rate ? costOf(p.rate, m) : null;
      if (c !== null) { cost += c; priced = true; } else if (m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheWriteTokens > 0) partial = true;
      models.push({ provider: m.provider, model: m.model, calls: m.calls, inputTokens: m.inputTokens, outputTokens: m.outputTokens, cacheReadTokens: m.cacheReadTokens, cacheWriteTokens: m.cacheWriteTokens, costUsd: c, rate: p.rate, priceSource: p.source, priceBasis: p.basis });
      calls += m.calls;
      totals.inputTokens += m.inputTokens;
      totals.outputTokens += m.outputTokens;
      totals.cacheReadTokens += m.cacheReadTokens;
      totals.cacheWriteTokens += m.cacheWriteTokens;
    }
    const stages: StageUsage[] = [...this.stages.entries()].map(([key, s]) => {
      const t = zero();
      let c: number | null = null;
      for (const [mk, sm] of s.byModel) {
        t.inputTokens += sm.inputTokens; t.outputTokens += sm.outputTokens; t.cacheReadTokens += sm.cacheReadTokens; t.cacheWriteTokens += sm.cacheWriteTokens;
        const rate = prices.get(mk)?.rate;
        if (rate) c = (c ?? 0) + costOf(rate, sm);
      }
      return { key, label: s.label, calls: s.calls, ...t, costUsd: c };
    });
    const order = ["index", "review", "formal", "verify", "docs", "ask", "other"];
    stages.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    models.sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
    return { calls, ...totals, models, stages, costUsd: priced ? cost : null, costPartial: priced && partial, pricesAsOf: PRICES_AS_OF, updatedAt: Date.now() };
  }
}

const scope = new AsyncLocalStorage<UsageLedger>();

/** Run `fn` with every AI call inside it counted in `ledger`. */
export function withUsageLedger<T>(ledger: UsageLedger, fn: () => Promise<T>): Promise<T> {
  return scope.run(ledger, fn);
}

/** Called by providers after every billable response. A no-op outside a run. */
export function recordUsage(e: UsageEvent): void {
  if (!(e.inputTokens || e.outputTokens || e.cacheReadTokens || e.cacheWriteTokens)) return;
  scope.getStore()?.record(e);
}
