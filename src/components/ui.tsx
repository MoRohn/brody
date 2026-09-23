"use client";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { parseCite } from "@/lib/client";

export const SEV_STYLE: Record<string, { color: string; glyph: string }> = {
  Critical: { color: "var(--crit)", glyph: "!" },
  High: { color: "var(--high)", glyph: "▲" },
  Medium: { color: "var(--med)", glyph: "●" },
  Low: { color: "var(--low)", glyph: "○" },
  Informational: { color: "var(--info)", glyph: "·" },
};

export function SeverityBadge({ severity }: { severity: string }) {
  const s = SEV_STYLE[severity] ?? SEV_STYLE.Informational;
  return (
    <span className="chip" style={{ color: s.color, background: `color-mix(in srgb, ${s.color} 11%, var(--panel))` }} title={`Severity: ${severity}`}>
      <span aria-hidden>{s.glyph}</span>{severity}
    </span>
  );
}

/** A short label. `wrap` lets a chip that carries free text (a claim, a path) wrap instead of running past a narrow screen. */
export function Chip({ children, tone = "neutral", title, wrap = false }: { children: ReactNode; tone?: "neutral" | "ok" | "warn" | "info" | "danger"; title?: string; wrap?: boolean }) {
  const color = tone === "ok" ? "var(--ok)" : tone === "warn" ? "var(--med)" : tone === "danger" ? "var(--crit)" : tone === "info" ? "var(--link)" : "var(--muted)";
  return <span title={title} className={wrap ? "chip chip-wrap" : "chip"} style={{ color, background: `color-mix(in srgb, ${color} 10%, var(--panel))` }}>{children}</span>;
}

export function OriginBadge({ origin, verification }: { origin: string; verification?: string }) {
  return (
    <span className="inline-flex gap-1">
      {origin === "formal" ? <Chip tone="ok" title="Proved by the Lean 4 proof kernel with a concrete counterexample">Proved (Lean 4)</Chip>
        : <Chip tone={origin === "static" ? "info" : "neutral"} title={origin === "static" ? "Produced by a deterministic analyzer" : "Inferred by an AI model"}>{origin === "static" ? "Static analyzer" : "AI-inferred"}</Chip>}
      {verification && verification !== "verified" && <Chip tone="warn" title="Evidence was insufficient to confirm this finding">Needs verification</Chip>}
    </span>
  );
}

/** A turning ring for any inline wait. Decorative: pair it with text that says what is happening. */
export function Spinner({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`spinner ${className}`} />;
}

/** Seconds since mount, ticking once a second. Long waits are reassuring only if the reader can see time passing. */
export function useElapsed(active = true): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) return;
    const start = Date.now();
    const t = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => { clearInterval(t); setSeconds(0); };
  }, [active]);
  return seconds;
}

export function Loading({ label = "Loading" }: { label?: string }) {
  const seconds = useElapsed();
  return (
    <div role="status" className="flex items-center gap-2.5 p-6 text-sm text-muted">
      <Spinner className="text-accent" />
      <span>{label}…{seconds >= 3 && <span className="ml-1.5 tabular-nums">{seconds}s</span>}</span>
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: { message: string; hint?: string }; onRetry?: () => void }) {
  return (
    <div role="alert" className="card m-4 p-4" style={{ borderColor: "var(--crit)", background: "color-mix(in srgb, var(--crit) 7%, var(--panel))" }}>
      <div className="font-semibold" style={{ color: "var(--crit)" }}>{error.message}</div>
      {error.hint && <div className="mt-1 text-muted">{error.hint}</div>}
      {onRetry && <button className="btn mt-3" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="p-10 text-center text-muted">
      <div className="font-serif text-base font-bold text-deep">{title}</div>
      {children && <div className="mt-1 text-sm">{children}</div>}
    </div>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-3 mt-7 flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-line pb-1.5">
      <h2 className="font-serif text-[18px] font-bold">{children}</h2>
      {right}
    </div>
  );
}

/** Link to a source location in the code explorer. */
export function SourceLink({ projectId, cite, children }: { projectId: string; cite: string; children?: ReactNode }) {
  const c = parseCite(cite);
  const href = `/p/${projectId}/files?path=${encodeURIComponent(c.path)}${c.line ? `&line=${c.line}` : ""}${c.end ? `&end=${c.end}` : ""}`;
  return <Link href={href} className="mono text-[12px]" title={`Open ${cite}`}>{children ?? cite}</Link>;
}

export function Evidence({ projectId, items, max = 4 }: { projectId: string; items: string[]; max?: number }) {
  if (!items.length) return null;
  return (
    <span className="ml-1 text-muted">
      [{items.slice(0, max).map((e, i) => (<span key={e + i}>{i > 0 && ", "}<SourceLink projectId={projectId} cite={e} /></span>))}{items.length > max ? `, +${items.length - max}` : ""}]
    </span>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="card px-4 py-3">
      <div className="h-label">{label}</div>
      <div className="mt-0.5 font-serif text-2xl font-bold lining-nums tabular-nums text-deep">{value}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="mono rounded-md border border-line-strong bg-panel2 px-1.5 text-[11px]">{children}</kbd>;
}
