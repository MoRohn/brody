"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  code: string;
  hint?: string;
  status: number;
  constructor(message: string, code: string, status: number, hint?: string) {
    super(message);
    this.code = code;
    this.status = status;
    this.hint = hint;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: init?.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json", ...init.headers } : init?.headers });
  } catch {
    throw new ApiError("Could not reach the server. Check that the application is running and your network connection.", "network", 0);
  }
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; hint?: string } } | null)?.error;
    throw new ApiError(err?.message ?? `Request failed with status ${res.status}.`, err?.code ?? "http_error", res.status, err?.hint);
  }
  return data as T;
}

const keyOf = (p: string) => p.replace(/([?&])k=\d+&?/, "$1").replace(/[?&]$/, "");

export function useApi<T>(path: string | null, opts: { pollMs?: number; stop?: (d: T) => boolean; keepPrevious?: boolean } = {}) {
  const [res, setRes] = useState<{ key: string | null; data: T | null; error: ApiError | null; done: boolean }>({ key: null, data: null, error: null, done: false });
  const [nonce, setNonce] = useState(0);
  const stopRef = useRef(opts.stop);
  useEffect(() => { stopRef.current = opts.stop; });
  const { pollMs } = opts;

  useEffect(() => {
    if (!path) return;
    const key = keyOf(path);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      let d: T | undefined;
      try {
        d = await api<T>(path);
        if (!cancelled) setRes({ key, data: d, error: null, done: true });
      } catch (e) {
        if (!cancelled) setRes((r) => ({ key, data: r.key === key ? r.data : null, error: e as ApiError, done: true }));
      }
      if (cancelled) return;
      if (pollMs && !(d !== undefined && stopRef.current?.(d))) timer = setTimeout(tick, pollMs);
    };
    void tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [path, pollMs, nonce]);

  const key = path ? keyOf(path) : null;
  const current = key !== null && res.key === key;
  const data = current ? res.data : opts.keepPrevious ? res.data : null;
  const error = current ? res.error : null;
  const loading = key !== null && !(current && res.done);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Parse "path:12-30" citations into a navigable link target. */
export function parseCite(c: string): { path: string; line?: number; end?: number } {
  const m = c.match(/^(.*?):(\d+)(?:-(\d+))?$/);
  return m ? { path: m[1], line: Number(m[2]), end: m[3] ? Number(m[3]) : undefined } : { path: c };
}
