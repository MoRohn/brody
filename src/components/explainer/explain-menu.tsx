"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ExplanationSource } from "@/lib/explainer";
import { Icon, type IconName } from "@/components/Icon";
import { errorText, openExplanation } from "./hooks";
import { ExplainerPanel, type ExplainTab } from "./panel";

const OPTIONS: { tab: ExplainTab; label: string; hint: string; icon: IconName }[] = [
  { tab: "text", label: "Clear explanation", hint: "Controlled technical prose, every sentence sourced", icon: "explain" },
  { tab: "diagram", label: "Diagram", hint: "The parts and how they connect", icon: "map" },
  { tab: "interactive", label: "Interactive", hint: "The animation, live and clickable", icon: "sparkle" },
  { tab: "video", label: "Video", hint: "Narrated, animated, with captions", icon: "video" },
];

/**
 * "Explain ▾" on any Brody result. It compiles (or reopens) the result's explanation and shows it inline, so a user
 * never leaves the workflow to get a diagram, an interactive explainer or a video of the same grounded answer.
 */
export function ExplainResult({ projectId, source, label = "Explain", small = true }: { projectId: string; source: ExplanationSource; label?: string; small?: boolean }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [panel, setPanel] = useState<{ id: string; tab: ExplainTab; n: number } | null>(null);
  const [busy, setBusy] = useState<ExplainTab | null>(null);
  const [err, setErr] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const place = useCallback(() => {
    const btn = ref.current?.querySelector("button");
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const width = Math.min(300, window.innerWidth - 16);
    // Open upwards when the menu would run past the bottom of the window (an answer at the foot of the page).
    const height = menuRef.current?.offsetHeight ?? 236;
    const below = r.bottom + 6 + height <= window.innerHeight - 8;
    const top = below ? r.bottom + 6 : Math.max(8, r.top - 6 - height);
    setPos({ top, left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)) });
  }, []);
  useLayoutEffect(() => { if (open) place(); }, [open, place]);
  // Measure again once the menu exists, so the flip uses its real height.
  useLayoutEffect(() => { if (open && pos && menuRef.current) place(); }, [open, !!pos, place]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => { const t = e.target as Node; if (!ref.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", click); window.addEventListener("keydown", key); window.addEventListener("scroll", place, true); window.addEventListener("resize", place);
    return () => { window.removeEventListener("mousedown", click); window.removeEventListener("keydown", key); window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [open, place]);
  const choose = async (tab: ExplainTab) => {
    setBusy(tab); setErr("");
    try {
      const ex = panel ? { id: panel.id } : await openExplanation(projectId, source);
      setPanel({ id: ex.id, tab, n: (panel?.n ?? 0) + 1 });
      setOpen(false);
    } catch (e) { setErr(errorText(e)); }
    setBusy(null);
  };
  return (
    <div>
      <div ref={ref} className="inline-flex items-center gap-2">
        <button className={`btn ${small ? "py-0.5 text-xs" : ""}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} aria-busy={!!busy} data-testid="explain-menu"><Icon name="sparkle" size={14} />{label}<Icon name="chevron" size={13} /></button>
        {err && <span role="alert" className="text-xs" style={{ color: "var(--crit)" }}>{err}</span>}
      </div>
      {open && pos && createPortal(
        <div ref={menuRef} role="menu" aria-label="Explain this result" style={{ position: "fixed", top: pos.top, left: pos.left, width: "min(300px, calc(100vw - 16px))" }} className="card z-50 overflow-hidden !rounded-2xl py-1 shadow-xl">
          {OPTIONS.map((o) => (
            <button key={o.tab} role="menuitem" className="flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-panel2" onClick={() => choose(o.tab)} disabled={!!busy} data-testid={`explain-${o.tab}`}>
              <span className="mt-0.5 text-[var(--accent)]">{busy === o.tab ? <span className="spinner" /> : <Icon name={o.icon} size={16} />}</span>
              <span><span className="block text-[13.5px] font-semibold">{o.label}</span><span className="block text-xs text-muted">{o.hint}</span></span>
            </button>
          ))}
        </div>,
        document.body,
      )}
      {panel && <ExplainerPanel key={panel.n} projectId={projectId} explanationId={panel.id} initialTab={panel.tab} onClose={() => setPanel(null)} />}
    </div>
  );
}
