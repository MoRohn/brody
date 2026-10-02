"use client";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useApi } from "@/lib/client";
import { useDialog } from "@/lib/useDialog";
import { Icon } from "./Icon";
import { SeverityBadge } from "./ui";

interface Issue { n: number; title: string; severity: string; category: string; codes: string[]; locations: string[]; verified: boolean; fix: string; patch: boolean }
interface Resp { markdown: string; fileName: string; stats: { findings: number; issues: number; files: number; verified: number; needsVerification: number; bySeverity: Record<string, number>; patches: number; approxTokens: number }; issues: Issue[] }

const SEV = ["Critical", "High", "Medium", "Low", "Informational"];

/**
 * "AI fix prompt" on the Code Review page: every open issue condensed, ordered and paired with its fix, as one Markdown
 * prompt to paste into an AI coding assistant. Copy it or download it as a .md file.
 */
export function FixPromptButton({ projectId, filters, q, severityCounts }: { projectId: string; filters: Record<string, string[]>; q: string; severityCounts: Record<string, number> }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn btn-primary py-0.5 text-xs" onClick={() => setOpen(true)} data-testid="fix-prompt-open" title="Every issue, condensed with its fix, as a prompt for your AI coding assistant"><Icon name="sparkle" size={14} />AI fix prompt</button>
      {open && <FixPromptDialog projectId={projectId} filters={filters} q={q} severityCounts={severityCounts} onClose={() => setOpen(false)} />}
    </>
  );
}

function FixPromptDialog({ projectId, filters, q, severityCounts, onClose }: { projectId: string; filters: Record<string, string[]>; q: string; severityCounts: Record<string, number>; onClose: () => void }) {
  const ref = useDialog(true, onClose);
  const filtered = Object.values(filters).some((v) => v.length) || !!q.trim();
  const [useFilters, setUseFilters] = useState(filtered);
  const present = SEV.filter((s) => severityCounts[s]);
  const [severities, setSeverities] = useState<string[]>(filters.severity?.length ? filters.severity : present.filter((s) => s !== "Informational"));
  const [unverified, setUnverified] = useState(true);
  const [patches, setPatches] = useState(true);
  const [evidence, setEvidence] = useState(true);
  const [view, setView] = useState<"issues" | "prompt">("issues");
  const [copied, setCopied] = useState<"" | "ok" | "fail">("");

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (severities.length) p.set("severity", severities.join(","));
    if (useFilters) {
      for (const k of ["category", "origin", "area"]) if (filters[k]?.length) p.set(k, filters[k].join(","));
      if (q.trim()) p.set("q", q.trim());
      if (filters.verification?.length === 1 && filters.verification[0] === "verified") p.set("unverified", "0");
    }
    if (!unverified) p.set("unverified", "0");
    if (!patches) p.set("patches", "0");
    if (!evidence) p.set("evidence", "0");
    return p.toString();
  }, [severities, useFilters, filters, q, unverified, patches, evidence]);
  const { data, error, loading } = useApi<Resp>(`/api/projects/${projectId}/fix-prompt?${query}`, { keepPrevious: true });
  useEffect(() => { if (copied) { const t = setTimeout(() => setCopied(""), 2200); return () => clearTimeout(t); } }, [copied]);

  const copy = async () => {
    if (!data) return;
    try { await navigator.clipboard.writeText(data.markdown); setCopied("ok"); } catch { setCopied("fail"); }
  };
  const toggleSev = (s: string) => setSeverities((x) => (x.includes(s) ? x.filter((y) => y !== s) : [...x, s]));
  const st = data?.stats;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-2 sm:p-6" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="fix-prompt-title" tabIndex={-1} className="card flex max-h-full w-full max-w-[980px] flex-col overflow-hidden !rounded-2xl shadow-2xl" data-testid="fix-prompt-dialog">
        <div className="flex items-start gap-3 border-b border-line bg-panel2 px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id="fix-prompt-title" className="font-serif text-lg font-bold text-deep">AI fix prompt</h2>
            <p className="text-[13px] text-muted">Every issue Brody found, condensed and ordered by severity, each with its fix, as one prompt for Claude Code, Cursor, Copilot or ChatGPT. Paste it with the repository open and the assistant works through the list.</p>
          </div>
          <button className="icon-btn !h-8 !w-8" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <div className="grid min-h-0 flex-1 md:grid-cols-[230px_minmax(0,1fr)]">
          <div className="space-y-3 overflow-auto border-b border-line p-3 text-[13px] md:border-b-0 md:border-r">
            <fieldset>
              <legend className="h-label mb-1">Severities</legend>
              {present.map((s) => <label key={s} className="flex items-center gap-2 py-0.5"><input type="checkbox" checked={severities.includes(s)} onChange={() => toggleSev(s)} /><span className="flex-1">{s}</span><span className="tabular-nums text-muted">{severityCounts[s]}</span></label>)}
            </fieldset>
            <fieldset className="space-y-1">
              <legend className="h-label mb-1">Include</legend>
              <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5" checked={unverified} onChange={(e) => setUnverified(e.target.checked)} /><span>Findings that still need verification <span className="text-muted">(marked, so the assistant checks first)</span></span></label>
              <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5" checked={patches} onChange={(e) => setPatches(e.target.checked)} /><span>Suggested patches</span></label>
              <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5" checked={evidence} onChange={(e) => setEvidence(e.target.checked)} /><span>Cited code evidence</span></label>
              {filtered && <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5" checked={useFilters} onChange={(e) => setUseFilters(e.target.checked)} /><span>Only findings matching the current filters</span></label>}
            </fieldset>
            {st && (
              <div className="rounded-lg bg-panel2 p-2 text-xs" data-testid="fix-prompt-stats">
                <div><strong>{st.findings}</strong> finding{st.findings === 1 ? "" : "s"} condensed into <strong>{st.issues}</strong> issue{st.issues === 1 ? "" : "s"}</div>
                <div className="text-muted">{st.files} file{st.files === 1 ? "" : "s"} · {st.verified} verified · {st.patches} with a patch</div>
                <div className="text-muted">about {st.approxTokens.toLocaleString()} tokens</div>
              </div>
            )}
          </div>
          <div className="flex min-h-0 flex-col">
            <div className="flex items-center gap-1.5 border-b border-line px-3 py-1.5">
              <div className="tabs" role="tablist" aria-label="Fix prompt view">
                <button role="tab" aria-selected={view === "issues"} className="tab !py-1 !text-[13px]" onClick={() => setView("issues")}>Issues and fixes</button>
                <button role="tab" aria-selected={view === "prompt"} className="tab !py-1 !text-[13px]" onClick={() => setView("prompt")} data-testid="fix-prompt-tab-prompt">Full prompt</button>
              </div>
              {loading && <span className="spinner ml-1 text-[var(--accent)]" aria-label="Updating" />}
            </div>
            <div className="min-h-[260px] flex-1 overflow-auto p-3">
              {error && <div role="alert" style={{ color: "var(--crit)" }}>{error.message}</div>}
              {data && view === "issues" && (data.issues.length === 0 ? <p className="text-muted">No open issues match these options.</p> : (
                <ol className="space-y-2" data-testid="fix-prompt-issues">
                  {data.issues.map((i) => (
                    <li key={i.n} className="rounded-lg border border-line p-2.5">
                      <div className="flex flex-wrap items-center gap-2"><span className="tabular-nums text-xs text-muted">{i.n}.</span><SeverityBadge severity={i.severity} /><span className="font-semibold">{i.title}</span>{!i.verified && <span className="chip" style={{ color: "var(--med)" }}>needs verification</span>}{i.patch && <span className="chip" style={{ color: "var(--ok)" }}>patch</span>}</div>
                      <div className="mt-1 text-[13px]"><span className="text-muted">Fix: </span>{i.fix}</div>
                      <div className="mono mt-1 truncate text-[11.5px] text-muted" title={i.locations.join(", ")}>{i.codes.join(", ")} · {i.locations.length === 1 ? i.locations[0] : `${i.locations.length} locations: ${i.locations.slice(0, 3).join(", ")}${i.locations.length > 3 ? ", …" : ""}`}</div>
                    </li>
                  ))}
                </ol>
              ))}
              {data && view === "prompt" && <pre tabIndex={0} className="!m-0 whitespace-pre-wrap text-[12px]" data-testid="fix-prompt-markdown">{data.markdown}</pre>}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2.5">
          <span className="text-xs text-muted" aria-live="polite">{copied === "ok" ? "Copied to the clipboard." : copied === "fail" ? "The browser blocked the clipboard; use Download instead." : data ? data.fileName : ""}</span>
          <div className="ml-auto flex gap-2">
            <button className="btn" onClick={copy} disabled={!data || loading} data-testid="fix-prompt-copy"><Icon name={copied === "ok" ? "check" : "files"} size={14} />{copied === "ok" ? "Copied" : "Copy contents"}</button>
            <a className={`btn btn-primary ${!data ? "pointer-events-none opacity-50" : ""}`} href={`/api/projects/${projectId}/fix-prompt?${query}${query ? "&" : ""}download=1`} download={data?.fileName} data-testid="fix-prompt-download"><Icon name="download" size={14} />Download .md</a>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
