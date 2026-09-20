"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, fmtDuration, useApi } from "@/lib/client";
import type { JobStage } from "@/lib/db/schema";
import { Icon } from "./Icon";
import { Chip, ErrorBox, Loading, Spinner } from "./ui";

export interface ProjectSummary {
  id: string; name: string; sourceType: string; sourceUrl: string | null; owner: string | null; branch: string | null; commit: string | null;
  imported?: { at: number; exportedAt: number } | null;
  fileCount: number; sourceFileCount: number; totalBytes: number; lineCount: number; languages: Record<string, number>; status: string;
  incremental: { changed: number; unchanged: number; added: number; removed: number } | null; previousProjectId: string | null; createdAt: number; updatedAt: number;
  job: { id: string; status: string; currentStage: string | null; stages: JobStage[]; error: string | null; createdAt: number; startedAt: number | null; finishedAt: number | null; log: string[]; summary: Record<string, unknown> | null } | null;
}

interface Ctx { project: ProjectSummary; reload: () => void }
const ProjectCtx = createContext<Ctx | null>(null);
export function useProject(): Ctx {
  const c = useContext(ProjectCtx);
  if (!c) throw new Error("useProject outside provider");
  return c;
}
export { ProjectCtx };

const ICON: Record<string, string> = { done: "✓", running: "●", pending: "○", failed: "✕", skipped: "–", warning: "!" };

export function AnalysisProgress({ project, reload }: { project: ProjectSummary; reload: () => void }) {
  const router = useRouter();
  const job = project.job;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const running = project.status === "analyzing" || project.status === "importing";
  const stages = job?.stages ?? [];
  const done = stages.filter((s) => s.status === "done" || s.status === "skipped" || s.status === "warning").length;
  const currentIndex = stages.findIndex((s) => s.status === "running");
  const current = currentIndex >= 0 ? stages[currentIndex] : undefined;
  useEffect(() => {
    if (!running) return;
    const previous = document.title;
    document.title = `Analysing ${project.name}… · Brody`;
    return () => { document.title = previous; };
  }, [running, project.name]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null);
    try { await fn(); reload(); } catch (e) { setErr(e as ApiError); }
    setBusy(false);
  };
  const restart = () => act(async () => {
    const r = await api<{ project: { id: string } }>(`/api/projects/${project.id}/analyze`, { method: "POST" });
    if (r.project.id !== project.id) router.push(`/p/${r.project.id}`);
  });

  return (
    <div className="mx-auto max-w-[760px] p-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="flex items-center gap-3 font-serif text-2xl font-bold">
          {running && <Spinner className="!h-5 !w-5 text-accent" />}
          <span>{running ? "Analysing" : project.status === "failed" ? "Analysis failed" : "Analysis not running"} <span className="text-muted">{project.name}</span></span>
        </h1>
        {job && job.startedAt && <span className="text-sm text-muted tabular-nums" title="Time since the analysis started">{fmtDuration((job.finishedAt ?? now) - job.startedAt)}</span>}
      </div>
      {running && (
        <>
          {/* A finished step counts fully and the running step counts half, so the bar is never stuck at zero, and the
              moving highlight shows the work is alive even while one long step (an AI pass) runs. */}
          <div className="progress running mt-3" role="progressbar" aria-label="Analysis progress" aria-valuemin={0} aria-valuemax={stages.length} aria-valuenow={done}><div className="bar" style={{ width: `${Math.max(4, ((done + (current ? 0.5 : 0)) / Math.max(1, stages.length)) * 100)}%` }} /></div>
          <p role="status" className="mt-2 flex flex-wrap items-center gap-x-2 text-sm text-muted">
            <span className="font-medium text-fg">{current ? `Step ${currentIndex + 1} of ${stages.length}: ${current.label}` : job?.status === "queued" ? "Waiting for a worker to pick this up" : "Starting"}</span>
            {current?.startedAt && <span className="tabular-nums">· {fmtDuration(now - current.startedAt)} on this step</span>}
          </p>
        </>
      )}
      {job?.error && (
        <div role="alert" className="card mt-4 p-3" style={{ borderColor: job.status === "cancelled" ? "var(--line)" : "var(--crit)" }}>
          <div className="font-semibold" style={{ color: job.status === "cancelled" ? "var(--fg)" : "var(--crit)" }}>{job.status === "cancelled" ? "Analysis was cancelled" : "What went wrong"}</div>
          <div className="mt-1">{job.error}</div>
        </div>
      )}
      <ol className="card mt-4 divide-y divide-line">
        {(stages.length ? stages : []).map((s, i) => (
          <li key={s.key} className="flex items-start gap-3 px-3 py-2" style={s.status === "running" ? { background: "var(--accent-soft)" } : undefined} aria-current={s.status === "running" ? "step" : undefined}>
            {s.status === "running" ? <Spinner className="mt-1 !h-[0.95em] !w-[0.95em] text-accent" /> : <span className="mono w-4 text-center" aria-hidden style={{ color: s.status === "failed" ? "var(--crit)" : s.status === "warning" ? "var(--high)" : s.status === "done" ? "var(--ok)" : "var(--muted)" }}>{ICON[s.status]}</span>}
            <div className="min-w-0 flex-1">
              <div className={s.status === "pending" ? "text-muted" : "font-medium"}>{i + 1}. {s.label} <span className="sr-only">({s.status})</span></div>
              {s.detail && <div className={`text-xs ${s.status === "warning" ? "" : "truncate text-muted"}`} style={s.status === "warning" ? { color: "var(--high)" } : undefined} title={s.detail}>{s.detail}</div>}
              {s.status === "running" && !s.detail && <div className="text-xs text-muted">Working<span className="dots ml-1.5" aria-hidden><i /><i /><i /></span></div>}
            </div>
            {s.startedAt && (s.finishedAt ? <span className="text-xs text-muted tabular-nums">{fmtDuration(s.finishedAt - s.startedAt)}</span> : s.status === "running" ? <span className="text-xs tabular-nums" style={{ color: "var(--link)" }}>{fmtDuration(now - s.startedAt)}</span> : null)}
          </li>
        ))}
      </ol>
      {job && job.log.length > 0 && (
        <details className="mt-3 text-xs"><summary className="cursor-pointer text-muted">Activity log</summary><pre tabIndex={0} className="mt-1 max-h-48">{job.log.join("\n")}</pre></details>
      )}
      {err && <div role="alert" className="mt-3 text-sm" style={{ color: "var(--crit)" }}>{err.message}</div>}
      <div className="mt-4 flex gap-2">
        {running && job && <button className="btn" disabled={busy} aria-busy={busy} onClick={() => act(() => api(`/api/jobs/${job.id}/cancel`, { method: "POST" }))}>{busy ? "Cancelling…" : "Cancel analysis"}</button>}
        {!running && <button className="btn btn-primary" disabled={busy} aria-busy={busy} onClick={restart}>{busy ? "Starting…" : project.status === "failed" ? "Retry analysis" : "Start analysis"}</button>}
        <Link href="/" className="btn">Back to projects</Link>
      </div>
      <p className="mt-4 text-xs text-muted">Progress is stored on the server. You can refresh or leave this page and come back; the analysis continues.</p>
    </div>
  );
}

const PRESETS = ["file", "symbol", "code", "finding", "doc"] as const;
interface Hit { kind: string; refId: string; title: string; path?: string; line?: number; snippet?: string; score: number; meta?: Record<string, unknown> }

export function SearchBox({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [kinds, setKinds] = useState<string[]>([]);
  const [language, setLanguage] = useState("");
  const [severity, setSeverity] = useState("");
  const [category, setCategory] = useState("");
  const [symbolKind, setSymbolKind] = useState("");
  const [area, setArea] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const files = useApi<{ files: { language: string; area: string | null }[] }>(open ? `/api/projects/${projectId}/files` : null);
  const languages = useMemo(() => [...new Set((files.data?.files ?? []).map((f) => f.language))].sort(), [files.data]);
  const areas = useMemo(() => [...new Set((files.data?.files ?? []).map((f) => f.area).filter(Boolean) as string[])].sort(), [files.data]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); input.current?.focus(); setOpen(true); } if (e.key === "Escape") setOpen(false); };
    const onClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("keydown", onKey); window.addEventListener("mousedown", onClick);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onClick); };
  }, []);

  useEffect(() => {
    if (q.trim().length < 2) return;
    const params = new URLSearchParams({ q });
    if (kinds.length) params.set("kinds", kinds.join(","));
    if (language) params.set("language", language);
    if (severity) params.set("severity", severity);
    if (category) params.set("category", category);
    if (symbolKind) params.set("symbolKind", symbolKind);
    if (area) params.set("area", area);
    const t = setTimeout(async () => {
      try { setHits((await api<{ hits: Hit[] }>(`/api/projects/${projectId}/search?${params}`)).hits); setErr(null); } catch (e) { setErr((e as Error).message); }
    }, 220);
    return () => clearTimeout(t);
  }, [q, kinds, language, severity, category, symbolKind, area, projectId]);

  const go = (h: Hit) => {
    setOpen(false);
    if (h.kind === "finding") router.push(`/p/${projectId}/review?finding=${encodeURIComponent(h.refId)}`);
    else if (h.kind === "doc") {
      // Folder and area explanations live on the Explain page's "Collections" view; file explanations on the Files page.
      if (h.refId.startsWith("module:")) router.push(`/p/${projectId}/explain?scale=collections&item=${encodeURIComponent(h.refId)}`);
      else if (h.refId.startsWith("area:")) router.push(`/p/${projectId}/explain?scale=collections&item=${encodeURIComponent(h.refId)}`);
      else router.push(h.path ? `/p/${projectId}/files?path=${encodeURIComponent(h.path)}` : `/p/${projectId}/explain`);
    }
    else if (h.path) router.push(`/p/${projectId}/files?path=${encodeURIComponent(h.path)}${h.line ? `&line=${h.line}` : ""}${h.kind === "symbol" ? `&symbol=${encodeURIComponent(h.refId)}` : ""}`);
  };
  const toggleKind = (k: string) => setKinds((ks) => (ks.includes(k) ? ks.filter((x) => x !== k) : [...ks, k]));
  const shownHits = q.trim().length < 2 ? null : hits;
  const grouped = useMemo(() => { const g: Record<string, Hit[]> = {}; for (const h of shownHits ?? []) (g[h.kind] ??= []).push(h); return g; }, [shownHits]);
  const label: Record<string, string> = { file: "Files", symbol: "Symbols", code: "Code", finding: "Findings", doc: "Documentation" };

  return (
    <div ref={ref} className="relative w-full sm:w-[340px]">
      <Icon name="search" size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
      <input ref={input} className="input !rounded-full !pl-9" value={q} placeholder="Search files, symbols, code, findings…  (⌘K)" aria-label="Search repository" onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }} />
      {open && (
        <div className="card absolute right-0 z-30 mt-2 w-[560px] max-w-[calc(100vw-2rem)] overflow-hidden !rounded-2xl shadow-xl">
          <div className="flex flex-wrap items-center gap-1 border-b border-line p-2">
            {PRESETS.map((k) => <button key={k} className="btn" aria-pressed={kinds.includes(k)} style={kinds.includes(k) ? { background: "var(--accent-soft)", borderColor: "var(--accent)" } : undefined} onClick={() => toggleKind(k)}>{label[k]}</button>)}
          </div>
          <div className="grid grid-cols-2 gap-1 border-b border-line p-2 text-xs sm:grid-cols-5">
            <select className="input" value={language} onChange={(e) => setLanguage(e.target.value)} aria-label="Language filter"><option value="">Any language</option>{languages.map((l) => <option key={l}>{l}</option>)}</select>
            <select className="input" value={symbolKind} onChange={(e) => setSymbolKind(e.target.value)} aria-label="Symbol type filter"><option value="">Any symbol</option>{["function", "method", "class", "service", "endpoint", "model", "component", "hook", "job", "interface", "type", "enum"].map((l) => <option key={l}>{l}</option>)}</select>
            <select className="input" value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="Severity filter"><option value="">Any severity</option>{["Critical", "High", "Medium", "Low", "Informational"].map((l) => <option key={l}>{l}</option>)}</select>
            <select className="input" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Review category filter"><option value="">Any category</option>{["Correctness", "Security", "Reliability", "Performance", "Maintainability", "API Design", "Data", "Testing", "Operations", "Architecture", "Dependencies"].map((l) => <option key={l}>{l}</option>)}</select>
            <select className="input" value={area} onChange={(e) => setArea(e.target.value)} aria-label="Functional area filter"><option value="">Any area</option>{areas.map((l) => <option key={l}>{l}</option>)}</select>
          </div>
          <div className="max-h-[55vh] overflow-auto">
            {err && <div className="p-3 text-sm" style={{ color: "var(--crit)" }}>{err}</div>}
            {q.trim().length < 2 ? <div className="p-3 text-sm text-muted">Type at least two characters. Filters narrow results by file type, symbol type, severity, category and functional area.</div> : shownHits === null ? <Loading label="Searching" /> : shownHits.length === 0 ? <div className="p-3 text-sm text-muted">No matches for “{q}”.</div> : Object.entries(grouped).map(([k, list]) => (
              <div key={k}>
                <div className="h-label bg-panel2 px-3 py-1">{label[k] ?? k}</div>
                {list.slice(0, 8).map((h) => (
                  <button key={h.kind + h.refId} className="block w-full border-b border-line px-3 py-1.5 text-left hover:bg-panel2" onClick={() => go(h)}>
                    <div className="mono truncate text-[12px]">{h.title}{h.line ? <span className="text-muted">  :{h.line}</span> : null}</div>
                    {h.snippet && <div className="truncate text-xs text-muted">{h.kind === "file" || h.kind === "symbol" ? (h.path ?? "") : h.snippet}</div>}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function StatusChip({ status }: { status: string }) {
  const working = status === "analyzing" || status === "importing";
  return <Chip tone={status === "ready" ? "ok" : status === "failed" ? "danger" : working ? "info" : "neutral"}>{working && <Spinner className="mr-1.5 !h-[0.85em] !w-[0.85em]" />}{status === "analyzing" ? "analysing" : status}</Chip>;
}

export { ErrorBox };
