"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { UsageSnapshot } from "@/lib/ai/usage";
import { useDialog } from "@/lib/useDialog";
import { Icon } from "./Icon";

export interface RunUsage {
  usage: UsageSnapshot | null;
  model: { provider: string; model: string } | null;
  /** The run is still going, so the numbers are still rising. */
  live: boolean;
}

/** The AI usage of a project's latest run, from the job summary (live while it runs, final afterwards). */
export function runUsage(job: { status: string; summary: Record<string, unknown> | null } | null | undefined): RunUsage | null {
  if (!job?.summary) return null;
  const s = job.summary as { aiUsage?: UsageSnapshot; model?: RunUsage["model"] };
  if (!s.aiUsage && s.model === undefined) return null;
  return { usage: s.aiUsage ?? null, model: s.model ?? null, live: job.status === "running" || job.status === "queued" };
}

const PROVIDER: Record<string, string> = { anthropic: "Anthropic", "openai-compatible": "OpenAI-compatible" };

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

export function fmtUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(n < 10 ? 3 : 2)}`;
}

const total = (u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }) => u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;

function costLabel(u: UsageSnapshot | null): string {
  if (!u || u.calls === 0) return "$0.00";
  if (u.costUsd === null) return "cost n/a";
  return `${u.costPartial ? "≥" : "~"}${fmtUsd(u.costUsd)}`;
}

function LiveDot({ live }: { live: boolean }) {
  return live ? <span className="live-dot" aria-hidden /> : null;
}

/** Everything about one run's AI usage: model, tokens by kind, cost, per-step breakdown and the pricing basis. */
export function UsageDetail({ run }: { run: RunUsage }) {
  const u = run.usage;
  const tokens = u ? total(u) : 0;
  const maxStage = Math.max(1, ...(u?.stages ?? []).map(total));
  return (
    <div className="text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="h-label">Model</span>
        {run.model ? <span className="mono rounded-md border border-line bg-panel2 px-1.5 py-0.5 text-[12px] text-deep" title={PROVIDER[run.model.provider] ?? run.model.provider}>{run.model.model}</span> : <span className="text-muted">No AI provider for this run</span>}
        {run.model && <span className="text-xs text-muted">{PROVIDER[run.model.provider] ?? run.model.provider}</span>}
        {run.live && <span className="ml-auto inline-flex items-center gap-1.5 text-xs font-semibold" style={{ color: "var(--accent)" }}><LiveDot live />Live</span>}
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { k: "Tokens", v: fmtTokens(tokens), t: `${tokens.toLocaleString()} tokens in total` },
          { k: "Input", v: fmtTokens(u?.inputTokens ?? 0), t: `${(u?.inputTokens ?? 0).toLocaleString()} input tokens (uncached)` },
          { k: "Output", v: fmtTokens(u?.outputTokens ?? 0), t: `${(u?.outputTokens ?? 0).toLocaleString()} output tokens` },
          { k: "Est. cost", v: costLabel(u), t: u?.costUsd != null ? `$${u.costUsd.toFixed(4)}` : "No price is known for this model" },
        ].map((x) => (
          <div key={x.k} className="rounded-xl border border-line bg-panel2 px-2.5 py-1.5" title={x.t}>
            <dt className="text-[11px] uppercase tracking-wide text-muted">{x.k}</dt>
            <dd className="font-serif text-lg font-bold lining-nums tabular-nums text-deep">{x.v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-1 text-xs text-muted tabular-nums">
        {(u?.calls ?? 0).toLocaleString()} request{u?.calls === 1 ? "" : "s"}
        {u && (u.cacheReadTokens > 0 || u.cacheWriteTokens > 0) && <> · {fmtTokens(u.cacheReadTokens)} cache read · {fmtTokens(u.cacheWriteTokens)} cache write</>}
      </div>

      {u && u.stages.length > 0 && (
        <>
          <div className="h-label mb-1 mt-3">By step</div>
          <ul className="space-y-1.5">
            {u.stages.map((s) => (
              <li key={s.key}>
                <div className="flex items-baseline justify-between gap-2"><span>{s.label}</span><span className="tabular-nums text-muted">{fmtTokens(total(s))} · {s.costUsd === null ? "n/a" : fmtUsd(s.costUsd)}</span></div>
                <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-panel2" aria-hidden><div className="h-full rounded-full" style={{ width: `${Math.max(2, (total(s) / maxStage) * 100)}%`, background: "var(--accent)" }} /></div>
              </li>
            ))}
          </ul>
        </>
      )}

      {u && u.models.length > 0 && (
        <>
          <div className="h-label mb-1 mt-3">{u.models.length > 1 ? "Models that answered" : "Pricing"}</div>
          <ul className="divide-y divide-line rounded-xl border border-line">
            {u.models.map((m) => (
              <li key={`${m.provider}|${m.model}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-2.5 py-1.5">
                <span className="mono min-w-0 break-all text-deep">{m.model}</span>
                <span className="text-xs text-muted tabular-nums" title={m.priceBasis}>{m.rate ? `$${m.rate.input} in · $${m.rate.output} out per 1M` : "no price on file"}</span>
                <span className="ml-auto whitespace-nowrap text-xs tabular-nums">{m.calls} req · {fmtTokens(m.inputTokens + m.cacheReadTokens + m.cacheWriteTokens)} in · {fmtTokens(m.outputTokens)} out · <strong>{m.costUsd === null ? "n/a" : fmtUsd(m.costUsd)}</strong></span>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="mt-3 text-[11.5px] leading-snug text-muted">
        {u?.models.length ? `${[...new Set(u.models.map((m) => m.priceBasis))].join("; ")}.` : "Tokens appear here as soon as the first AI request returns."}
        {u?.costPartial && " Some models have no known price, so the cost shown is a lower bound."}
        {" "}Estimated from the token counts the provider reports, at list prices, before tax, credits and discounts.
      </p>
    </div>
  );
}

const WIDTH = 420;

/** The header control: live tokens and cost for the latest run, opening the full breakdown. */
export function UsagePill({ run }: { run: RunUsage }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const panel = useDialog(open, close);
  const place = useCallback(() => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(WIDTH, window.innerWidth - 16);
    setPos({ top: r.bottom + 8, left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)) });
  }, []);
  useLayoutEffect(() => { if (open) place(); }, [open, place]);
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!btn.current?.contains(t) && !panel.current?.contains(t)) setOpen(false);
    };
    window.addEventListener("mousedown", click); window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("mousedown", click); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, place, panel]);

  const u = run.usage;
  const tokens = u ? total(u) : 0;
  const summary = run.model ? `${fmtTokens(tokens)} tokens, ${costLabel(u)}${run.live ? ", updating live" : ""}` : "No AI used in this run";
  return (
    <>
      <button ref={btn} className="btn gap-1.5 tabular-nums" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)} aria-label={`AI usage: ${summary}. Show details`} title={run.model ? `${run.model.model}: ${summary}` : summary} data-testid="usage-pill">
        <Icon name="gauge" size={15} />
        {run.model ? (
          <>
            <span>{fmtTokens(tokens)}</span>
            <span className="text-muted">·</span>
            <span className="font-semibold">{costLabel(u)}</span>
            <LiveDot live={run.live} />
          </>
        ) : <span className="hidden text-muted sm:inline">No AI</span>}
      </button>
      {open && pos && createPortal(
        <div ref={panel} role="dialog" aria-label="AI usage for this analysis" tabIndex={-1} style={{ position: "fixed", top: pos.top, left: pos.left, width: `min(${WIDTH}px, calc(100vw - 16px))` }} className="card animate-in z-50 !rounded-2xl p-4 shadow-xl" data-testid="usage-panel">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="font-serif text-[15px] font-bold text-deep">AI usage · latest analysis</div>
            <button className="btn px-1.5 py-0.5" onClick={close} aria-label="Close AI usage"><Icon name="x" size={14} /></button>
          </div>
          <UsageDetail run={run} />
        </div>,
        document.body,
      )}
    </>
  );
}

/** The same breakdown inline, for the analysis progress screen. */
export function UsagePanel({ run }: { run: RunUsage }) {
  return (
    <section className="card mt-4 p-3" aria-label="AI usage" aria-live="off" data-testid="usage-inline">
      <div className="mb-2 flex items-center gap-2 font-semibold"><Icon name="gauge" size={16} />AI usage</div>
      <UsageDetail run={run} />
    </section>
  );
}
