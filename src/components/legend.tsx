"use client";
import { EDGE_LEGEND, NODE_LEGEND, RISK_LEGEND } from "@/lib/map/legend";

/** The legend is identical everywhere: glyphs, line styles and risk marks, never colour alone. */
export function Legend({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`card ${compact ? "p-2 text-[11px]" : "p-3 text-[12px]"}`} aria-label="Legend">
      <div className="h-label mb-1">Legend</div>
      <div className={`grid ${compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4"} gap-x-4 gap-y-0.5`}>
        {NODE_LEGEND.map((n) => <div key={n.type}><span className="mono inline-block w-4 text-center" aria-hidden>{n.glyph}</span> {n.label}</div>)}
      </div>
      <div className={`mt-2 grid ${compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-6"} gap-x-4 gap-y-0.5`}>
        {EDGE_LEGEND.map((e) => (
          <div key={e.kind} className="flex items-center gap-1.5">
            <svg width="26" height="8" aria-hidden><line x1="0" y1="4" x2="26" y2="4" stroke="currentColor" strokeWidth="1.5" strokeDasharray={e.dash} /></svg>
            <span className="mono" aria-hidden>{e.glyph}</span> {e.label}
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4"><span className="text-muted">Risk:</span>{RISK_LEGEND.map((r) => <span key={r.level}><span className="mono" aria-hidden>{r.glyph}</span> {r.label}</span>)}</div>
    </div>
  );
}
