"use client";
import type { JobView } from "@/lib/explainer";
import { Icon } from "@/components/Icon";
import { useElapsed } from "@/components/ui";

/** The stages a viewer sees: meaningful workflow states, never model reasoning. */
const VISIBLE: { label: string; keys: string[] }[] = [
  { label: "Planning explanation", keys: ["planning"] },
  { label: "Writing narration", keys: ["scripting"] },
  { label: "Generating voice", keys: ["tts", "aligning"] },
  { label: "Designing scenes", keys: ["storyboarding"] },
  { label: "Rendering", keys: ["rendering"] },
  { label: "Finalizing", keys: ["muxing", "validating"] },
];

/** What has streamed in so far, in the order it arrives. */
const MILESTONES: { key: string; label: string }[] = [
  { key: "plan", label: "Explanation plan ready" },
  { key: "transcript", label: "Transcript ready" },
  { key: "audio", label: "Audio ready" },
  { key: "storyboard", label: "Storyboard ready: the interactive explainer can play now" },
  { key: "video", label: "Video ready" },
];

export function JobProgress({ job, onCancel, onRetry }: { job: JobView; onCancel?: () => void; onRetry?: () => void }) {
  const running = job.status === "running" || job.status === "queued";
  const elapsed = useElapsed(running);
  const stageOf = (keys: string[]) => {
    const st = job.stages.filter((s) => keys.includes(s.key));
    if (st.some((s) => s.status === "failed")) return "failed";
    if (st.some((s) => s.status === "running")) return "running";
    if (st.every((s) => s.status === "done" || s.status === "warning" || s.status === "skipped")) return "done";
    return "pending";
  };
  const detail = (keys: string[]) => job.stages.filter((s) => keys.includes(s.key)).map((s) => s.detail).filter(Boolean).pop();
  return (
    <div className="space-y-3" data-testid="explainer-progress" aria-live="polite">
      <ol className="space-y-1.5">
        {VISIBLE.map((v) => {
          const st = stageOf(v.keys);
          const isCurrent = st === "running";
          const frac = isCurrent && job.progress && v.keys.includes(job.progress.stage) ? job.progress.fraction : null;
          return (
            <li key={v.label} className="flex items-start gap-2.5 text-[13.5px]">
              <span className="mt-0.5 inline-flex h-5 w-5 flex-none items-center justify-center rounded-full border" style={{ borderColor: st === "done" ? "var(--ok)" : st === "failed" ? "var(--crit)" : st === "running" ? "var(--accent)" : "var(--line-strong)", color: st === "done" ? "var(--ok)" : st === "failed" ? "var(--crit)" : "var(--accent)" }}>
                {st === "done" ? <Icon name="check" size={12} /> : st === "failed" ? <Icon name="x" size={12} /> : st === "running" ? <span className="spinner !h-3 !w-3" /> : null}
              </span>
              <div className="min-w-0 flex-1">
                <div className={st === "pending" ? "text-muted" : "font-medium"}>{v.label}</div>
                {(isCurrent ? job.progress?.message : st !== "pending" ? detail(v.keys) : null) && <div className="text-xs text-muted">{isCurrent ? job.progress?.message : detail(v.keys)}</div>}
                {frac !== null && frac > 0 && <div className="progress running mt-1 max-w-xs"><div className="bar" style={{ width: `${Math.round(frac * 100)}%` }} /></div>}
              </div>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap gap-1.5">
        {MILESTONES.map((m) => {
          const ready = !!job.artifacts[m.key];
          return <span key={m.key} className="chip" style={{ color: ready ? "var(--ok)" : "var(--muted)", opacity: ready ? 1 : 0.6 }}>{ready ? "✓" : "○"} {m.label}</span>;
        })}
      </div>
      <div className="flex items-center gap-2 text-xs text-muted">
        {running && <span>{job.status === "queued" ? "Waiting for the worker" : "Working"} · {elapsed} s</span>}
        {running && onCancel && <button className="btn btn-danger ml-auto py-0.5 text-xs" onClick={onCancel}>Cancel</button>}
        {(job.status === "failed" || job.status === "cancelled") && onRetry && <button className="btn btn-primary py-0.5 text-xs" onClick={onRetry}><Icon name="refresh" size={13} />Retry (finished stages are reused)</button>}
      </div>
    </div>
  );
}
