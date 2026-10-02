"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, useApi } from "@/lib/client";
import type { ExplanationSource, ExplanationView, JobView } from "@/lib/explainer";

export const ACTIVE = (j: JobView | null | undefined) => !!j && (j.status === "queued" || j.status === "running");

/** An explanation, reloaded when its job finishes. */
export function useExplanation(id: string | null) {
  const [nonce, setNonce] = useState(0);
  const r = useApi<{ explanation: ExplanationView }>(id ? `/api/explanations/${id}?k=${nonce}` : null, { keepPrevious: true });
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...r, explanation: r.data?.explanation ?? null, reload };
}

/**
 * Follow a job live. Server-sent events carry every change (stage, progress, a new artifact); if the stream cannot be
 * opened (a proxy that buffers, an old browser) it falls back to polling the same endpoint.
 */
export function useJob(jobId: string | null, onEnd?: (job: JobView) => void) {
  // Keyed by job id, so a stale job is never shown for a new id and no state is reset inside the effect.
  const [state, setState] = useState<{ id: string; job: JobView } | null>(null);
  const setJob = useCallback((j: JobView) => setState({ id: j.id, job: j }), []);
  const endRef = useRef(onEnd);
  useEffect(() => { endRef.current = onEnd; });
  useEffect(() => {
    if (!jobId) return;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let es: EventSource | null = null;
    const finish = (j: JobView) => { if (!closed && ["ready", "failed", "cancelled"].includes(j.status)) endRef.current?.(j); };
    const poll = async () => {
      try {
        const r = await api<{ job: JobView }>(`/api/video-jobs/${jobId}`);
        if (closed) return;
        setJob(r.job);
        if (["ready", "failed", "cancelled"].includes(r.job.status)) { finish(r.job); return; }
      } catch { /* transient; try again */ }
      timer = setTimeout(poll, 1200);
    };
    if (typeof EventSource !== "undefined") {
      es = new EventSource(`/api/video-jobs/${jobId}/events`);
      es.addEventListener("job", (e) => { const j = JSON.parse((e as MessageEvent).data) as JobView; setJob(j); });
      es.addEventListener("end", () => { es?.close(); void api<{ job: JobView }>(`/api/video-jobs/${jobId}`).then((r) => { setJob(r.job); finish(r.job); }); });
      es.onerror = () => { es?.close(); es = null; if (!closed) void poll(); };
    } else void poll();
    return () => { closed = true; es?.close(); if (timer) clearTimeout(timer); };
  }, [jobId, setJob]);
  return state && state.id === jobId ? state.job : null;
}

export async function openExplanation(projectId: string, source: ExplanationSource, audience?: string): Promise<ExplanationView> {
  const r = await api<{ explanation: ExplanationView }>("/api/explanations", { method: "POST", body: JSON.stringify({ projectId, source, ...(audience ? { audience } : {}) }) });
  return r.explanation;
}

export function errorText(e: unknown): string {
  return e instanceof ApiError ? `${e.message}${e.hint ? ` ${e.hint}` : ""}` : (e as Error)?.message ?? String(e);
}

export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
