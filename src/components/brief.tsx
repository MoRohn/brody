"use client";
import type { ExecutiveBrief, Statement } from "@/lib/docs/types";
import { Chip, Evidence } from "./ui";

const PRIORITY_TONE = { Now: "danger", Next: "info", Later: "neutral" } as const;

function tone(verdict: string): string {
  return /^needs attention/i.test(verdict) ? "var(--crit)" : /^generally sound/i.test(verdict) ? "var(--med)" : "var(--ok)";
}

/**
 * The business-readable Executive Summary: short, plain language, shaped like slides. The in-depth, evidence-linked
 * statements it was distilled from sit beneath it as "Summary evidence".
 */
export function BriefView({ id, brief, evidence, compact = false }: { id: string; brief: ExecutiveBrief; evidence?: Statement[]; compact?: boolean }) {
  return (
    <div className="space-y-4">
      <div className="card p-5">
        <p className="font-serif text-[22px] font-bold leading-snug" style={{ color: "var(--deep)" }}>{brief.headline}</p>
        <p className="mt-2 max-w-[80ch] text-[15px] text-fg2">{brief.summary}</p>
        {brief.audience && !/^not stated/i.test(brief.audience) && <p className="mt-2 text-sm text-muted"><strong className="text-fg">Who it serves.</strong> {brief.audience}</p>}
        <p className="mt-3 text-[11px] uppercase tracking-wide text-muted" title={brief.origin === "ai" ? "Written by an AI model from the summary evidence below" : "Assembled from the analysis"}>{brief.origin === "ai" ? "Summarised by AI from the evidence below" : "Assembled from the analysis"}</p>
      </div>

      {!compact && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4" role="list" aria-label="Snapshot">
          {brief.metrics.map((m) => (
            <div key={m.label} role="listitem" className="card px-4 py-3">
              <div className="h-label">{m.label}</div>
              <div className={`mt-0.5 font-serif font-bold lining-nums ${m.value.length > 12 ? "text-lg" : "text-2xl"}`} style={{ color: m.label.startsWith("Critical") && m.value !== "0" ? "var(--crit)" : "var(--deep)" }}>{m.value}</div>
            </div>
          ))}
        </div>
      )}

      {brief.keyPoints.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {brief.keyPoints.map((k) => (
            <div key={k.title} className="card p-4" style={{ borderLeft: "4px solid var(--accent)" }}>
              <div className="font-serif text-[16px] font-bold" style={{ color: "var(--link)" }}>{k.title}</div>
              <p className="mt-1 text-sm">{k.detail}</p>
            </div>
          ))}
        </div>
      )}

      <div className={`grid gap-4 ${compact ? "" : "lg:grid-cols-2"}`}>
        {!compact && brief.capabilities.length > 0 && (
          <div className="card p-4">
            <div className="h-label mb-1.5">What it does</div>
            <ul className="list-disc space-y-1 pl-5 text-sm">{brief.capabilities.map((c) => <li key={c}>{c}</li>)}</ul>
          </div>
        )}
        <div className="card p-4" style={{ borderLeft: `4px solid ${tone(brief.health.verdict)}` }}>
          <div className="h-label mb-1.5">Health and risk</div>
          <p className="text-sm font-semibold">{brief.health.verdict}</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <div>
              <div className="text-xs font-bold" style={{ color: "var(--ok)" }}>Strengths</div>
              <ul className="mt-0.5 list-disc space-y-0.5 pl-5 text-[13px]">{brief.health.strengths.length ? brief.health.strengths.map((x) => <li key={x}>{x}</li>) : <li className="list-none text-muted">None identified.</li>}</ul>
            </div>
            <div>
              <div className="text-xs font-bold" style={{ color: "var(--crit)" }}>Concerns</div>
              <ul className="mt-0.5 list-disc space-y-0.5 pl-5 text-[13px]">{brief.health.concerns.length ? brief.health.concerns.map((x) => <li key={x}>{x}</li>) : <li className="list-none text-muted">None identified.</li>}</ul>
            </div>
          </div>
        </div>
      </div>

      {brief.nextSteps.length > 0 && (
        <div className="card overflow-hidden">
          <table className="tbl">
            <thead><tr><th className="w-[90px]">Priority</th><th>Recommended next step</th><th>Why it matters</th></tr></thead>
            <tbody>{brief.nextSteps.map((n, i) => <tr key={i}><td><Chip tone={PRIORITY_TONE[n.priority]}>{n.priority}</Chip></td><td className="font-medium">{n.action}</td><td className="text-muted">{n.why || "—"}</td></tr>)}</tbody>
          </table>
        </div>
      )}

      {evidence && evidence.length > 0 && (
        <details id="summary-evidence" className="card">
          <summary className="cursor-pointer px-4 py-3 font-serif text-[16px] font-bold" style={{ color: "var(--deep)" }}>Summary evidence <span className="ml-1 font-sans text-xs font-normal text-muted">the in-depth summary this was distilled from, with sources</span></summary>
          <div className="prose-doc border-t border-line p-4">
            {evidence.map((s, i) => <p key={i}>{s.text}<Evidence projectId={id} items={s.evidence} />{s.origin === "ai" && <span className="ml-1 text-[11px] text-muted" title="Written by an AI model from indexed evidence">AI</span>}</p>)}
          </div>
        </details>
      )}
    </div>
  );
}
