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

export interface UploadRequest {
  mode: "file" | "files" | "folder" | "zip" | "bundle";
  files: File[];
  /** Each file's path in the project (webkitRelativePath for a folder); defaults to that, or the file name. */
  paths?: string[];
  name?: string;
  /** The project this upload is a new version of (Re-analyze). */
  previous?: string;
}
export interface UploadResult { project: { id: string }; warnings?: string[]; imported?: boolean }

/** Requests sent at once, and the most small files sent together in one request. */
const UPLOAD_CONCURRENCY = 4;
const UPLOAD_BATCH_FILES = 400;
const RETRY_DELAYS_MS = [1000, 3000, 8000];

interface Piece { index: number; offset: number; blob: Blob }

/** PUT one batch of pieces, reporting the bytes of it sent so far. */
function sendPieces(url: string, pieces: Piece[], onSent: (bytes: number) => void): Promise<void> {
  const bytes = pieces.reduce((a, p) => a + p.blob.size, 0);
  const form = new FormData();
  for (const p of pieces) { form.append("index", String(p.index)); form.append("offset", String(p.offset)); form.append("data", p.blob, "piece"); }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && e.total) onSent(Math.round((bytes * e.loaded) / e.total)); };
    xhr.onerror = () => reject(new ApiError("The upload could not reach the server. Check your connection and try again.", "network", 0));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let body: { error?: { message?: string; code?: string; hint?: string } } | null = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      reject(new ApiError(body?.error?.message ?? `Upload failed with status ${xhr.status}.`, body?.error?.code ?? "http_error", xhr.status, body?.error?.hint));
    };
    xhr.send(form);
  });
}

/** A dropped connection or a server hiccup is worth another try; a refusal (a 4xx, or a full disk) is not. */
const retryable = (e: unknown) => e instanceof ApiError && (e.status === 0 || e.status === 408 || e.status === 429 || (e.status >= 500 && e.status !== 507));

/**
 * Upload a project of any size up to the server's limit (10 GB by default). The server checks the file list first, so a
 * project over a limit is refused before anything is sent. The files then go in pieces of at most the size the server
 * names, several requests at once, each retried if the connection drops; the server writes them to disk as they arrive
 * and ingests them on finish. `onProgress` gets the percentage of bytes sent: 100 means all arrived and the server is
 * reading the files.
 */
export async function uploadProject(req: UploadRequest, onProgress: (pct: number) => void): Promise<UploadResult> {
  const { files } = req;
  const paths = req.paths ?? files.map((f) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name);
  const session = await api<{ id: string; pieceBytes: number }>("/api/projects/upload/sessions", {
    method: "POST",
    body: JSON.stringify({ mode: req.mode, name: req.name, previous: req.previous, files: files.map((f, i) => ({ path: paths[i], size: f.size })) }),
  });
  const base = `/api/projects/upload/sessions/${session.id}`;

  // Units of work, each a sequence of requests: a batch of whole small files, or the pieces of one large file in order.
  const units: Piece[][][] = [];
  let batch: Piece[] = [];
  let batchBytes = 0;
  const flush = () => { if (batch.length) units.push([batch]); batch = []; batchBytes = 0; };
  files.forEach((f, index) => {
    if (f.size === 0) return; // Nothing to send: the server knows the file is empty from the list.
    if (f.size > session.pieceBytes) {
      const requests: Piece[][] = [];
      for (let offset = 0; offset < f.size; offset += session.pieceBytes) requests.push([{ index, offset, blob: f.slice(offset, offset + session.pieceBytes) }]);
      units.push(requests);
      return;
    }
    if (batchBytes + f.size > session.pieceBytes || batch.length >= UPLOAD_BATCH_FILES) flush();
    batch.push({ index, offset: 0, blob: f });
    batchBytes += f.size;
  });
  flush();

  const total = files.reduce((a, f) => a + f.size, 0) || 1;
  let sent = 0;
  const sending = new Map<number, number>();
  let lastPct = -1;
  const report = () => {
    let bytes = sent;
    for (const b of sending.values()) bytes += b;
    const pct = Math.min(99, Math.floor((bytes / total) * 100));
    if (pct !== lastPct) { lastPct = pct; onProgress(pct); }
  };
  let nextUnit = 0;
  let requestNo = 0;
  let failed = false;
  const send = async (pieces: Piece[]) => {
    const id = requestNo++;
    for (let attempt = 0; ; attempt++) {
      try {
        await sendPieces(base, pieces, (b) => { sending.set(id, b); report(); });
        sending.delete(id);
        sent += pieces.reduce((a, p) => a + p.blob.size, 0);
        report();
        return;
      } catch (e) {
        sending.delete(id);
        if (failed || attempt >= RETRY_DELAYS_MS.length || !retryable(e)) throw e;
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
    }
  };
  const worker = async () => {
    try {
      while (!failed && nextUnit < units.length) {
        for (const pieces of units[nextUnit++]) {
          if (failed) return;
          await send(pieces);
        }
      }
    } catch (e) {
      failed = true;
      throw e;
    }
  };

  try {
    onProgress(0);
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, units.length) }, worker));
    onProgress(100);
    return await api<UploadResult>(`${base}/finish`, { method: "POST" });
  } catch (e) {
    // Free the server's disk space; the session is gone already if finish ran.
    void fetch(base, { method: "DELETE" }).catch(() => undefined);
    throw e;
  }
}
