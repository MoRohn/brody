"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, ApiError, fmtDuration, uploadWithProgress, useApi } from "@/lib/client";
import { DEFAULT_EXCLUDED_DIRS } from "@/lib/ingest/classify";
import { useDialog } from "@/lib/useDialog";
import { Icon } from "./Icon";
import type { ProjectSummary } from "./project";
import { ErrorBox, Spinner } from "./ui";
import { fmtUsd, runUsage } from "./usage";

/** GET /api/projects/:id/analyze */
interface Plan {
  source: "github" | "upload";
  sourceType: string;
  current: { commit: string | null; branch: string | null };
  latest?: { commit: string; branch: string } | null;
  upToDate?: boolean;
  checkError?: string;
}

const relPath = (f: File) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
const short = (c: string | null | undefined) => (c ?? "").slice(0, 7);

/**
 * Re-analyze, made explicit about what it will analyse. An uploaded project is a snapshot (the browser sent the files
 * once), so its latest code has to be chosen again; a GitHub project is checked for new commits first. Re-running on
 * unchanged code is still possible, and the dialog says what the last run cost before anyone repeats it.
 */
export function ReanalyzeButton({ project, onRestarted }: { project: ProjectSummary; onRestarted: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn" onClick={() => setOpen(true)} aria-haspopup="dialog" title={project.sourceType === "github" ? "Analyze the latest commit, or re-run this one" : "Upload your updated code and analyze it"} data-testid="reanalyze-open">Re-analyze</button>
      {open && <ReanalyzeDialog project={project} onClose={() => setOpen(false)} onRestarted={() => { setOpen(false); onRestarted(); }} />}
    </>
  );
}

function ReanalyzeDialog({ project, onClose, onRestarted }: { project: ProjectSummary; onClose: () => void; onRestarted: () => void }) {
  const router = useRouter();
  const ref = useDialog(true, onClose);
  const plan = useApi<Plan>(`/api/projects/${project.id}/analyze`);
  const status = useApi<{ ai: { available: boolean; model: string } }>("/api/status");
  const [busy, setBusy] = useState<"" | "rerun" | "upload">("");
  const [err, setErr] = useState<ApiError | null>(null);
  const [picked, setPicked] = useState<{ mode: "folder" | "zip" | "files"; files: File[]; skipped: number } | null>(null);
  const [pct, setPct] = useState(0);
  const folderInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);

  const rerun = async () => {
    setBusy("rerun"); setErr(null);
    try {
      const r = await api<{ project: { id: string } }>(`/api/projects/${project.id}/analyze`, { method: "POST" });
      if (r.project.id !== project.id) router.push(`/p/${r.project.id}`);
      else onRestarted();
    } catch (e) { setErr(e as ApiError); setBusy(""); }
  };

  const choose = (mode: "folder" | "zip" | "files", list: FileList | null) => {
    const all = [...(list ?? [])];
    // Like the home page, dependency and build folders are never transferred.
    const files = mode === "folder" ? all.filter((f) => !relPath(f).split("/").slice(0, -1).some((seg) => DEFAULT_EXCLUDED_DIRS.includes(seg))) : all;
    setErr(null);
    setPicked(files.length ? { mode, files, skipped: all.length - files.length } : null);
  };

  const upload = async () => {
    if (!picked) return;
    setBusy("upload"); setErr(null); setPct(0);
    const form = new FormData();
    form.set("mode", picked.mode === "files" ? (picked.files.length === 1 ? "file" : "files") : picked.mode);
    form.set("previous", project.id);
    for (const f of picked.files) { form.append("files", f); form.append("paths", relPath(f)); }
    try {
      const res = await uploadWithProgress(form, setPct);
      router.push(`/p/${res.project.id}`);
    } catch (e) { setErr(e as ApiError); setBusy(""); }
  };

  // What the last run took, so repeating it is a decision rather than a surprise.
  const job = project.job;
  const last = runUsage(job);
  const ms = job?.startedAt && job.finishedAt ? job.finishedAt - job.startedAt : null;
  const took = ms === null ? null : ms < 1000 ? "under a second" : fmtDuration(ms);
  const cost = last?.usage?.costUsd ?? null;
  const ai = status.data?.ai.available;
  const costNote = ai === undefined ? null : ai
    ? `With AI on, the AI review, formal proofs and documentation all run again${took || cost ? `; the last run took ${[took, cost ? `about ${fmtUsd(cost)} of AI usage` : null].filter(Boolean).join(" and ")}` : ""}.`
    : `AI is off, so only the deterministic analysis runs${took && !last?.model ? ` (the last run took ${took})` : ""}.`;

  const p = plan.data;
  const isUpload = p?.source === "upload";
  const kind = project.sourceType === "zip" ? "ZIP archive" : project.sourceType === "folder" ? "folder" : "files";

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-2 sm:p-6" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="reanalyze-title" tabIndex={-1} className="card flex max-h-full w-full max-w-[560px] flex-col overflow-hidden !rounded-2xl shadow-2xl" data-testid="reanalyze-dialog">
        <div className="flex items-start gap-3 border-b border-line bg-panel2 px-4 py-3">
          <h2 id="reanalyze-title" className="min-w-0 flex-1 font-serif text-lg font-bold text-deep">Re-analyze {project.name}</h2>
          <button className="icon-btn !h-8 !w-8" onClick={onClose} disabled={!!busy} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <div className="space-y-3 overflow-auto p-4 text-[14px]">
          {plan.loading && !p && <div className="flex items-center gap-2 text-muted"><Spinner />{project.sourceType === "github" ? `Checking ${project.owner ? `${project.owner}/` : ""}${project.name} for new commits…` : "Loading…"}</div>}
          {plan.error && <ErrorBox error={plan.error} onRetry={plan.reload} />}

          {isUpload && (
            <>
              <p><strong>{project.name}</strong> was uploaded from your computer, so Brody holds a snapshot of those files and cannot see changes made since. To analyze your latest code, choose the updated {kind}. Brody treats it as a new version of this project and shows what changed.</p>
              <input ref={folderInput} type="file" hidden onChange={(e) => choose("folder", e.target.files)} aria-label="Select updated folder" {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} />
              <input ref={zipInput} type="file" accept=".zip,application/zip" hidden onChange={(e) => choose("zip", e.target.files)} aria-label="Select updated ZIP archive" />
              <input ref={filesInput} type="file" multiple hidden onChange={(e) => choose("files", e.target.files)} aria-label="Select updated files" />
              <div className="flex flex-wrap gap-2">
                {(project.sourceType === "file" || project.sourceType === "files"
                  ? [["files", "Choose updated files"], ["folder", "Choose a folder"], ["zip", "Choose a ZIP"]]
                  : project.sourceType === "zip" ? [["zip", "Choose updated ZIP"], ["folder", "Choose a folder"]] : [["folder", "Choose updated folder"], ["zip", "Choose a ZIP"]]
                ).map(([m, label], i) => (
                  <button key={m} className={i === 0 ? "btn btn-primary" : "btn"} disabled={!!busy} onClick={() => (m === "folder" ? folderInput : m === "zip" ? zipInput : filesInput).current?.click()}>{label}</button>
                ))}
              </div>
              {picked && (
                <div className="rounded-xl border border-line bg-panel2 p-3">
                  <div className="font-semibold">{picked.mode === "zip" ? picked.files[0].name : `${picked.files.length.toLocaleString()} file${picked.files.length === 1 ? "" : "s"} selected`}</div>
                  {picked.skipped > 0 && <div className="text-xs text-muted">{picked.skipped.toLocaleString()} files in node_modules, dist, .venv and similar folders will not be uploaded.</div>}
                  {busy === "upload" ? (
                    <div className="mt-2" aria-live="polite">
                      <div className="h-1.5 overflow-hidden rounded-full bg-panel"><div className="h-full rounded-full" style={{ width: `${pct}%`, background: "var(--accent)" }} /></div>
                      <div className="mt-1 text-xs text-muted">{pct < 100 ? `Uploading… ${pct}%` : "Upload complete; starting the analysis…"}</div>
                    </div>
                  ) : (
                    <button className="btn btn-primary btn-cta mt-2" onClick={upload} data-testid="reanalyze-upload">Upload and analyze<span className="disc" aria-hidden>→</span></button>
                  )}
                </div>
              )}
              {costNote && <p className="text-xs text-muted">{costNote}</p>}
              <div className="border-t border-line pt-3 text-[13px]">
                <div className="text-muted">No code changes, and you want a fresh run anyway?{ai ? " AI results can differ a little between runs, even on unchanged code." : ""}</div>
                <button className="btn mt-1.5 text-xs" disabled={!!busy} onClick={rerun} data-testid="reanalyze-same">{busy === "rerun" ? "Starting…" : "Re-run on the same snapshot"}</button>
              </div>
            </>
          )}

          {p?.source === "github" && (
            <>
              {p.latest && !p.upToDate && <p>There is a new commit on <span className="mono">{p.latest.branch}</span>: <span className="mono">{short(p.latest.commit)}</span> (this analysis is of <span className="mono">{short(p.current.commit)}</span>). Brody analyzes it as a new version of this project and shows what changed.</p>}
              {p.latest && p.upToDate && <p>No new commits on <span className="mono">{p.latest.branch}</span> since <span className="mono">{short(p.current.commit)}</span>, which this analysis already covers. Re-running analyzes the same code again.</p>}
              {p.checkError && <p>Brody could not check GitHub for new commits: {p.checkError}</p>}
              {costNote && <p className="text-xs text-muted">{costNote}</p>}
              <button className={p.latest && !p.upToDate ? "btn btn-primary btn-cta" : "btn"} disabled={!!busy} onClick={rerun} data-testid="reanalyze-github">
                {busy === "rerun" ? "Starting…" : p.latest && !p.upToDate ? <>Analyze the latest commit<span className="disc" aria-hidden>→</span></> : p.checkError ? "Try anyway" : "Re-run on the same commit"}
              </button>
            </>
          )}
          {err && <ErrorBox error={err} />}
        </div>
      </div>
    </div>,
    document.body,
  );
}
