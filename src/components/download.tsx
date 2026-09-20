"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SCOPES, type ReportScope } from "@/lib/export/scopes";
import { Icon } from "./Icon";

type Format = "pdf" | "docx" | "md" | "html" | "json" | "print" | "bundle";

export const FORMAT_INFO: Record<Format, { label: string; ext: string; hint: string; view: boolean }> = {
  pdf: { label: "PDF document", ext: ".pdf", hint: "Print-ready, with contents and bookmarks", view: true },
  docx: { label: "Word document", ext: ".docx", hint: "Editable in Word, Pages and Google Docs", view: false },
  md: { label: "Markdown", ext: ".md", hint: "Plain text for repositories and wikis", view: true },
  html: { label: "Web page", ext: ".html", hint: "Self-contained, opens in any browser", view: true },
  json: { label: "Structured data", ext: ".json", hint: "Files, symbols, relationships, findings", view: false },
  print: { label: "Print view", ext: "", hint: "Opens the print dialog", view: true },
  bundle: { label: "Brody bundle", ext: ".zip", hint: "The whole project in one file. Open it in any Brody to get the full interface back.", view: false },
};

export function exportUrl(projectId: string, format: Format, scope: ReportScope, inline = false): string {
  return `/api/projects/${projectId}/export?format=${format}&scope=${scope}${inline ? "&download=0" : ""}`;
}

/** Fetch a report and save it, showing progress and surfacing server errors instead of navigating to a JSON error page. */
export async function saveReport(url: string, fallbackName: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    let msg = `The report could not be generated (status ${res.status}).`;
    try { const j = await res.json(); msg = j.error?.message ? `${j.error.message}${j.error.hint ? ` ${j.error.hint}` : ""}` : msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
  const cd = res.headers.get("content-disposition") ?? "";
  const name = cd.match(/filename="([^"]+)"/)?.[1] ?? fallbackName;
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

export function FormatRow({ projectId, scope, format, compact = false, inMenu = false, onDone }: { projectId: string; scope: ReportScope; format: Format; compact?: boolean; inMenu?: boolean; onDone?: () => void }) {
  const info = FORMAT_INFO[format];
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");
  const [err, setErr] = useState("");
  const go = async () => {
    setState("busy"); setErr("");
    try { await saveReport(exportUrl(projectId, format, scope), `report${info.ext}`); setState("idle"); onDone?.(); } catch (e) { setErr((e as Error).message); setState("error"); }
  };
  return (
    <div className={`flex items-center gap-2 ${compact ? "px-3 py-1.5" : "py-1.5"}`} role={inMenu ? "none" : undefined}>
      <div className="min-w-0 flex-1">
        <div className="font-medium">{info.label} <span className="mono text-xs font-normal text-muted">{info.ext}</span></div>
        {!compact && <div className="text-xs text-muted">{info.hint}</div>}
        {state === "error" && <div role="alert" className="text-xs" style={{ color: "var(--crit)" }}>{err}</div>}
      </div>
      {info.view && <a role={inMenu ? "menuitem" : undefined} data-testid={`view-${format}-${scope}`} className="btn py-0.5 text-xs" href={exportUrl(projectId, format, scope, true)} target="_blank" rel="noreferrer" onClick={onDone}>View</a>}
      <button role={inMenu ? "menuitem" : undefined} data-testid={`dl-${format}-${scope}`} className="btn btn-primary py-0.5 text-xs" onClick={go} disabled={state === "busy"} aria-busy={state === "busy"} aria-label={`Download ${info.label}`}>{state === "busy" ? "Preparing…" : "Download"}</button>
    </div>
  );
}

const MENU_WIDTH = 340;

/** One control on every result view: view or download that result as PDF, Word or Markdown. */
export function DownloadMenu({ projectId, scope = "full", label = "Download", align = "right", small = false }: { projectId: string; scope?: ReportScope; label?: string; align?: "left" | "right"; small?: boolean }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // The menu is portaled to <body> with fixed positioning so scrollable/overflow-hidden ancestors can't clip it.
  const place = useCallback(() => {
    const btn = ref.current?.querySelector("button");
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const width = Math.min(MENU_WIDTH, window.innerWidth - 16);
    const left = align === "right" ? r.right - width : r.left;
    setPos({ top: r.bottom + 8, left: Math.max(8, Math.min(left, window.innerWidth - width - 8)) });
  }, [align]);
  useLayoutEffect(() => { if (open) place(); }, [open, place]);
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", click); window.addEventListener("keydown", key);
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("mousedown", click); window.removeEventListener("keydown", key);
      window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);
  const more: Format[] = scope === "full" ? ["html", "json", "bundle"] : ["html"];
  return (
    <div ref={ref} className="relative">
      <button className={`btn ${small ? "py-0.5 text-xs" : ""}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} data-testid={`download-menu-${scope}`}>
        <Icon name="download" size={15} /> {label} <Icon name="chevron" size={14} />
      </button>
      {open && pos && createPortal(
        <div ref={menuRef} role="menu" aria-label={`${SCOPES[scope].title} downloads`} style={{ position: "fixed", top: pos.top, left: pos.left, width: `min(${MENU_WIDTH}px, calc(100vw - 16px))` }} className="card z-50 overflow-hidden !rounded-2xl py-1.5 shadow-xl">
          <div className="px-3 pb-1 pt-1"><div className="font-serif text-[15px] font-bold text-deep">{SCOPES[scope].title}</div><div className="text-xs text-muted">{SCOPES[scope].description}</div></div>
          <div className="divide-y divide-line">
            {(["pdf", "docx", "md"] as Format[]).map((f) => <FormatRow key={f} projectId={projectId} scope={scope} format={f} compact inMenu onDone={() => setOpen(false)} />)}
          </div>
          <div className="h-label border-t border-line px-3 pb-0.5 pt-2">More formats</div>
          {more.map((f) => <FormatRow key={f} projectId={projectId} scope={scope} format={f} compact inMenu onDone={() => setOpen(false)} />)}
          <div className="border-t border-line px-3 py-1 text-xs text-muted">All Reports and downloads are on the <a href={`/p/${projectId}/reports`}>Reports page</a>.</div>
        </div>,
        document.body,
      )}
    </div>
  );
}
