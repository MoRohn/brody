"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";
import { AISettings } from "@/components/ai-settings";
import { Brand } from "@/components/Brand";
import { StatusChip } from "@/components/project";
import { Icon } from "@/components/Icon";
import { ThemeControl } from "@/components/ThemeControl";
import { api, ApiError, fmtBytes, useApi } from "@/lib/client";
import { DEFAULT_EXCLUDED_DIRS } from "@/lib/ingest/classify";
import { DownloadMenu } from "@/components/download";
import { Chip, Empty, ErrorBox, Loading, Spinner } from "@/components/ui";
import type { GitHubMetadata } from "@/lib/ingest/github";

type Mode = "files" | "folder" | "zip";
interface ProjectListItem { id: string; name: string; sourceType: string; sourceUrl: string | null; branch: string | null; commit: string | null; fileCount: number; status: string; updatedAt: number; languages: Record<string, number> }
interface Status { runtime?: "docker" | "local"; ai: { available: boolean; provider: string; model: string; reason?: string; checked?: boolean; ok?: boolean; problem?: { summary: string; hint: string } }; limits: { maxUploadBytes: number }; analyzers: { python: boolean; ruff: boolean; gofmt: boolean } }

function uploadWithProgress(form: FormData, onProgress: (pct: number) => void): Promise<{ project: { id: string }; warnings?: string[] }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/projects/upload");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onerror = () => reject(new ApiError("The upload could not reach the server. Check your connection and try again.", "network", 0));
    xhr.onload = () => {
      let body: { error?: { message?: string; code?: string; hint?: string } } & { project: { id: string } } | null = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300 && body) resolve(body);
      else reject(new ApiError(body?.error?.message ?? `Upload failed with status ${xhr.status}.`, body?.error?.code ?? "http_error", xhr.status, body?.error?.hint));
    };
    xhr.send(form);
  });
}

function LanguageBar({ languages }: { languages: Record<string, number> }) {
  const entries = Object.entries(languages).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((a, [, v]) => a + v, 0) || 1;
  const palette = ["#1b4965", "#006c96", "#3aa7c9", "#8fd0e0", "#c98a2b", "#8a6fd6", "#8a9099"];
  return (
    <div>
      <div className="flex h-2.5 overflow-hidden rounded-full border border-line" role="img" aria-label="Language distribution">
        {entries.slice(0, 7).map(([k, v], i) => <div key={k} style={{ width: `${(v / total) * 100}%`, background: palette[i % palette.length] }} title={`${k} ${((v / total) * 100).toFixed(1)}%`} />)}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted">
        {entries.slice(0, 6).map(([k, v], i) => <span key={k}><span aria-hidden style={{ color: palette[i % palette.length] }}>■</span> {k} {((v / total) * 100).toFixed(0)}%</span>)}
      </div>
    </div>
  );
}

export default function Home() {
  const router = useRouter();
  const status = useApi<Status>("/api/status?check=1");
  const projects = useApi<{ projects: ProjectListItem[] }>("/api/projects", { pollMs: 4000 });
  const [tab, setTab] = useState<Mode>("files");
  const [aiOpen, setAiOpen] = useState(false);
  const [openUpload, setOpenUpload] = useState(true);
  const [openImport, setOpenImport] = useState(false);
  const [openBundle, setOpenBundle] = useState(false);
  const [bundleFile, setBundleFile] = useState<File | null>(null);
  const [bundleBusy, setBundleBusy] = useState(false);
  const [bundleErr, setBundleErr] = useState<ApiError | null>(null);
  const [bundleDrag, setBundleDrag] = useState(false);
  const bundleInput = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [err, setErr] = useState<ApiError | null>(null);
  const [drag, setDrag] = useState(false);
  const [includeExcluded, setIncludeExcluded] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);

  const [ghUrl, setGhUrl] = useState("");
  const [ghRef, setGhRef] = useState("");
  const [ghToken, setGhToken] = useState("");
  const [ghMeta, setGhMeta] = useState<GitHubMetadata | null>(null);
  const [ghBusy, setGhBusy] = useState<"validate" | "start" | null>(null);
  const [ghErr, setGhErr] = useState<ApiError | null>(null);

  const relPath = (f: File) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
  // Folder uploads skip dependency and build directories in the browser so they are never transferred.
  const inExcludedDir = useCallback((f: File) => tab === "folder" && relPath(f).split("/").slice(0, -1).some((seg) => DEFAULT_EXCLUDED_DIRS.includes(seg)), [tab]);
  const toSend = useMemo(() => (tab === "folder" && !includeExcluded ? picked.filter((f) => !inExcludedDir(f)) : picked), [picked, tab, includeExcluded, inExcludedDir]);
  const skipped = picked.length - toSend.length;

  const startUpload = useCallback(async () => {
    if (toSend.length === 0) { setErr(new ApiError("Choose at least one file, a folder or a ZIP archive first.", "empty", 400)); return; }
    setBusy(true); setErr(null); setPct(0);
    const form = new FormData();
    form.set("mode", tab === "files" ? (toSend.length === 1 ? "file" : "files") : tab);
    for (const f of toSend) {
      form.append("files", f);
      form.append("paths", (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name);
    }
    try {
      const res = await uploadWithProgress(form, setPct);
      router.push(`/p/${res.project.id}`);
    } catch (e) {
      setErr(e as ApiError);
      setBusy(false);
    }
  }, [toSend, router, tab]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDrag(false);
    const files = [...e.dataTransfer.files];
    if (files.length) { setPicked(files); if (files.length === 1 && /\.zip$/i.test(files[0].name)) setTab("zip"); }
  };

  const validate = async () => {
    setGhBusy("validate"); setGhErr(null); setGhMeta(null);
    try { setGhMeta((await api<{ metadata: GitHubMetadata }>("/api/github/validate", { method: "POST", body: JSON.stringify({ url: ghUrl, ref: ghRef || undefined, token: ghToken || undefined }) })).metadata); }
    catch (e) { setGhErr(e as ApiError); }
    setGhBusy(null);
  };
  const startGithub = async () => {
    setGhBusy("start"); setGhErr(null);
    try {
      const res = await api<{ project: { id: string } }>("/api/projects/github", { method: "POST", body: JSON.stringify({ url: ghUrl, ref: ghRef || undefined, token: ghToken || undefined }) });
      router.push(`/p/${res.project.id}`);
    } catch (e) { setGhErr(e as ApiError); setGhBusy(null); }
  };
  const remove = async (id: string, name: string) => {
    if (!confirm(`Delete "${name}" and all of its analysis? This cannot be undone.`)) return;
    try { await api(`/api/projects/${id}`, { method: "DELETE" }); projects.reload(); } catch (e) { alert((e as Error).message); }
  };

  const tabs: { key: Mode; label: string }[] = [{ key: "files", label: "Files" }, { key: "folder", label: "Folder" }, { key: "zip", label: "ZIP archive" }];
  const openBundleFile = async () => {
    if (!bundleFile) return;
    setBundleBusy(true); setBundleErr(null);
    try {
      const form = new FormData();
      form.append("file", bundleFile);
      const r = await api<{ project: { id: string } }>("/api/projects/import-bundle", { method: "POST", body: form });
      router.push(`/p/${r.project.id}`);
    } catch (e) { setBundleErr(e as ApiError); }
    setBundleBusy(false);
  };
  const totalBytes = toSend.reduce((a, f) => a + f.size, 0);

  return (
    <div className="min-h-screen">
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line bg-panel px-3 py-2 sm:px-5 sm:py-3">
        <Brand />
        <div className="flex items-center gap-1.5 text-xs sm:gap-2">
          {status.data && (
            <>
              <button type="button" className="btn" style={{ padding: "4px 12px 4px 10px" }} aria-expanded={aiOpen} aria-controls="ai-settings" aria-label={`AI settings. Current: ${!status.data.ai.available ? "not configured" : status.data.ai.ok === false ? "key problem" : status.data.ai.model}`} title={status.data.ai.problem ? `${status.data.ai.problem.summary} ${status.data.ai.problem.hint}` : "Open AI settings: enter or change your API key, choose the provider and model"} onClick={() => setAiOpen((o) => !o)}>
                <Icon name="gear" size={16} />
                <span>AI settings</span>
                <span className="inline-flex items-center gap-1.5 font-medium" style={{ color: !status.data.ai.available ? "var(--med)" : status.data.ai.ok === false ? "var(--crit)" : "var(--ok)" }}>
                  <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: "currentColor" }} />
                  {!status.data.ai.available ? "AI not configured" : status.data.ai.ok === false ? "AI key problem" : `AI: ${status.data.ai.model}`}
                </span>
              </button>
            </>
          )}
          <ThemeControl />
        </div>
      </header>

      <main className="mx-auto max-w-[1180px] px-5 py-6">
        <h1 className="font-serif text-3xl font-extrabold tracking-tight sm:text-4xl">Understand any codebase</h1>
        <p className="mt-2 max-w-[68ch] text-[15px] text-muted">Import code, and Brody indexes it, reviews it, explains what it does in plain language, and maps how it fits together. Imported code is treated as untrusted data and is never executed.</p>
        {aiOpen && <AISettings onChanged={status.reload} onClose={() => setAiOpen(false)} />}
        {status.data?.ai.available && status.data.ai.ok === false && status.data.ai.problem && (
          <div role="alert" className="card mt-4 px-3 py-2 text-sm" style={{ borderColor: "var(--crit)" }}>
            <strong>The AI provider is configured but not working.</strong> {status.data.ai.problem.summary} {status.data.ai.problem.hint} Fix the key in <code>.env</code> and run <code>{status.data.runtime === "docker" ? "docker compose up -d" : "brody restart"}</code>, then check it under <button type="button" className="underline" onClick={() => setAiOpen(true)}>AI settings</button>. Analysis will still run with deterministic results only.
          </div>
        )}
        {status.data && !status.data.ai.available && (
          <div className="card mt-4 px-3 py-2 text-sm" style={{ borderColor: "var(--med)" }}>
            <strong>AI is not configured.</strong> Deterministic analysis, static analyzers and the code map still run. Set <code>ANTHROPIC_API_KEY</code> or <code>OPENAI_API_KEY</code> in <code>.env</code> to add AI review and narrative documentation, then run <code>{status.data.runtime === "docker" ? "docker compose up -d" : "brody restart"}</code>. Choose the provider and model under the gear icon, <button type="button" className="underline" onClick={() => setAiOpen(true)}>AI settings</button>.
          </div>
        )}

        {/* One section, two options. Each collapses independently and Upload starts open. Panels stay mounted so nothing typed is lost. */}
        <section className="card mt-6 overflow-hidden" aria-labelledby="select-h">
          <div className="px-5 pb-3 pt-5">
            <h2 id="select-h" className="font-serif text-xl font-bold">Select your code</h2>
            <p className="mt-0.5 text-sm text-muted">Bring in code from your computer or from GitHub. Open the option you need; both stay available.</p>
          </div>
          <div className="divide-y divide-line border-t border-line">
            <div>
              <h3 id="upload-h">
                <button type="button" id="upload-toggle" className="accordion-head" aria-expanded={openUpload} aria-controls="upload-panel" onClick={() => setOpenUpload((o) => !o)}>
                  <span className="accordion-icon"><Icon name="upload" size={18} /></span>
                  <span className="min-w-0 flex-1"><span className="block font-serif text-[17px] font-bold" style={{ color: "var(--deep)" }}>Upload code</span><span className="block text-[13px] font-normal text-muted">Files, a folder or a ZIP archive from your computer</span></span>
                  {!openUpload && toSend.length > 0 && <Chip tone="info">{toSend.length.toLocaleString()} file{toSend.length > 1 ? "s" : ""} ready</Chip>}
                  <Icon name="chevron" size={18} className={`text-muted transition-transform ${openUpload ? "rotate-180" : ""}`} />
                </button>
              </h3>
              <div id="upload-panel" role="region" aria-labelledby="upload-toggle" hidden={!openUpload} className="px-5 pb-5">
            <div role="tablist" className="tabs mt-3">
              {tabs.map((t) => (
                <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => { setTab(t.key); setPicked([]); setErr(null); }} className="tab">{t.label}</button>
              ))}
            </div>
            <div
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
              className="mt-3 flex min-h-[140px] flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed p-4 text-center transition-colors"
              style={{ borderColor: drag ? "var(--accent)" : "var(--line-strong)", background: drag ? "var(--accent-soft)" : "color-mix(in srgb, var(--bg) 45%, transparent)" }}
            >
              <div className="text-muted">{tab === "files" ? "Drop one or more source files, or" : tab === "folder" ? "Choose a project folder" : "Drop a ZIP archive, or"}</div>
              <button className="btn" onClick={() => (tab === "files" ? fileInput : tab === "folder" ? folderInput : zipInput).current?.click()}>
                {tab === "files" ? "Select files" : tab === "folder" ? "Select folder" : "Select ZIP"}
              </button>
              <input ref={fileInput} type="file" multiple hidden onChange={(e) => setPicked([...(e.target.files ?? [])])} aria-label="Select files" />
              <input ref={folderInput} type="file" hidden onChange={(e) => setPicked([...(e.target.files ?? [])])} aria-label="Select folder" {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} />
              <input ref={zipInput} type="file" accept=".zip,application/zip" hidden onChange={(e) => setPicked([...(e.target.files ?? [])])} aria-label="Select ZIP archive" />
              {toSend.length > 0 && <div className="text-sm"><strong>{toSend.length.toLocaleString()}</strong> file{toSend.length > 1 ? "s" : ""} selected ({fmtBytes(totalBytes)}){toSend.length === 1 ? `: ${toSend[0].name}` : ""}</div>}
              {tab === "folder" && picked.length > 0 && (skipped > 0 || includeExcluded) && <div className="text-xs text-muted">{includeExcluded ? "Including dependency and build folders." : `${skipped.toLocaleString()} files in node_modules, dist, .venv and similar folders will not be uploaded.`}</div>}
              {tab === "folder" && <label className="flex items-center gap-1 text-xs text-muted"><input type="checkbox" checked={includeExcluded} onChange={(e) => setIncludeExcluded(e.target.checked)} /> include dependency and build folders</label>}
            </div>
            {busy && (
              <div className="mt-3" role="progressbar" aria-label="Upload progress" aria-valuenow={pct < 100 ? pct : undefined} aria-valuemin={0} aria-valuemax={100}>
                <div className={`progress ${pct < 100 ? "running" : "indeterminate"}`}><div className="bar" style={pct < 100 ? { width: `${Math.max(3, pct)}%` } : undefined} /></div>
                <div role="status" className="mt-1.5 flex items-center gap-2 text-xs text-muted"><Spinner className="text-accent" />{pct < 100 ? `Uploading ${pct}%` : "Upload received. Reading and indexing your files, then starting the analysis…"}</div>
              </div>
            )}
            {err && <div role="alert" className="mt-3 text-sm" style={{ color: "var(--crit)" }}>{err.message}{err.hint && <div className="text-muted">{err.hint}</div>}</div>}
            <div className="mt-3 flex items-center justify-between">
              <span className="text-xs text-muted">{status.data ? `Limit ${fmtBytes(status.data.limits.maxUploadBytes)}. ` : ""}node_modules, .git, dist, build and similar folders are excluded by default and stay inspectable.</span>
              <button className="btn btn-primary btn-cta" onClick={startUpload} disabled={busy || toSend.length === 0} aria-busy={busy}>{busy ? "Uploading…" : "Analyze"}<span className="disc" aria-hidden>→</span></button>
            </div>
              </div>
            </div>
            <div>
              <h3 id="gh-h">
                <button type="button" id="import-toggle" className="accordion-head" aria-expanded={openImport} aria-controls="import-panel" onClick={() => setOpenImport((o) => !o)}>
                  <span className="accordion-icon"><Icon name="github" size={18} /></span>
                  <span className="min-w-0 flex-1"><span className="block font-serif text-[17px] font-bold" style={{ color: "var(--deep)" }}>Import repository</span><span className="block text-[13px] font-normal text-muted">A public or private GitHub repository, by URL</span></span>
                  {!openImport && ghUrl.trim() && <span className="mono hidden max-w-[220px] truncate text-xs text-muted sm:inline">{ghUrl.trim().replace(/^https?:\/\/(www\.)?github\.com\//, "")}</span>}
                  <Icon name="chevron" size={18} className={`text-muted transition-transform ${openImport ? "rotate-180" : ""}`} />
                </button>
              </h3>
              <div id="import-panel" role="region" aria-labelledby="import-toggle" hidden={!openImport} className="px-5 pb-5">
            <label className="mt-3 block text-xs text-muted" htmlFor="gh-url">GitHub URL</label>
            <input id="gh-url" className="input mono" placeholder="https://github.com/owner/repository" value={ghUrl} onChange={(e) => { setGhUrl(e.target.value); setGhMeta(null); }} />
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <div>
                <label className="block text-xs text-muted" htmlFor="gh-ref">Branch, tag or commit</label>
                <input id="gh-ref" className="input mono" placeholder="default branch" value={ghRef} onChange={(e) => { setGhRef(e.target.value); setGhMeta(null); }} />
              </div>
              <div>
                <label className="block text-xs text-muted" htmlFor="gh-token">Access token (private repositories)</label>
                <input id="gh-token" type="password" autoComplete="off" className="input mono" placeholder="optional" value={ghToken} onChange={(e) => { setGhToken(e.target.value); setGhMeta(null); }} />
              </div>
            </div>
            <div className="mt-1 text-xs text-muted">A token is sent only to this server, encrypted with AES-256-GCM, never logged, and used solely to download the repository.</div>
            {ghErr && <div role="alert" className="mt-3 text-sm" style={{ color: "var(--crit)" }}>{ghErr.message}{ghErr.hint && <div className="text-muted">{ghErr.hint}</div>}</div>}
            {ghMeta && (
              <div className="mt-3 rounded-xl border border-line bg-bg/40 p-3 text-sm">
                <div className="flex items-center gap-2"><strong>{ghMeta.fullName}</strong>{ghMeta.isPrivate && <Chip tone="warn">private</Chip>}</div>
                {ghMeta.description && <div className="text-muted">{ghMeta.description}</div>}
                <dl className="mt-2 grid grid-cols-[110px_1fr] gap-y-0.5 text-[13px]">
                  <dt className="text-muted">Owner</dt><dd>{ghMeta.owner}</dd>
                  <dt className="text-muted">Branch</dt><dd className="mono">{ghMeta.branch}{ghMeta.branch === ghMeta.defaultBranch ? " (default)" : ""}</dd>
                  <dt className="text-muted">Latest commit</dt><dd className="mono">{ghMeta.commit.slice(0, 10)} <span className="font-sans text-muted">{ghMeta.commitMessage}</span></dd>
                  <dt className="text-muted">Files</dt><dd>{ghMeta.approximateFileCount === null ? "unknown" : `${ghMeta.approximateFileCount < 0 ? "at least " : "about "}${Math.abs(ghMeta.approximateFileCount).toLocaleString()}`}</dd>
                  <dt className="text-muted">Size</dt><dd>{fmtBytes(ghMeta.sizeKb * 1024)}</dd>
                </dl>
                {Object.keys(ghMeta.languages).length > 0 && <div className="mt-2"><LanguageBar languages={ghMeta.languages} /></div>}
              </div>
            )}
            <div className="mt-3 flex justify-end gap-2">
              <button className="btn" onClick={validate} disabled={!ghUrl.trim() || ghBusy !== null} aria-busy={ghBusy === "validate"}>{ghBusy === "validate" ? "Checking…" : "Validate"}</button>
              <button className="btn btn-primary btn-cta" onClick={startGithub} disabled={!ghUrl.trim() || ghBusy !== null} aria-busy={ghBusy === "start"}>{ghBusy === "start" ? "Starting…" : "Import and analyze"}<span className="disc" aria-hidden>→</span></button>
            </div>
              </div>
            </div>
            <div>
              <h3 id="bundle-h">
                <button type="button" id="bundle-toggle" className="accordion-head" aria-expanded={openBundle} aria-controls="bundle-panel" onClick={() => setOpenBundle((o) => !o)}>
                  <span className="accordion-icon"><Icon name="reports" size={18} /></span>
                  <span className="min-w-0 flex-1"><span className="block font-serif text-[17px] font-bold" style={{ color: "var(--deep)" }}>Open a Brody export</span><span className="block text-[13px] font-normal text-muted">A .zip made with Export &gt; Brody bundle: opens with the full interface, no re-analysis</span></span>
                  {!openBundle && bundleFile && <span className="mono hidden max-w-[220px] truncate text-xs text-muted sm:inline">{bundleFile.name}</span>}
                  <Icon name="chevron" size={18} className={`text-muted transition-transform ${openBundle ? "rotate-180" : ""}`} />
                </button>
              </h3>
              <div id="bundle-panel" role="region" aria-labelledby="bundle-toggle" hidden={!openBundle} className="px-5 pb-5">
                <div
                  onDragOver={(e) => { e.preventDefault(); setBundleDrag(true); }} onDragLeave={() => setBundleDrag(false)}
                  onDrop={(e) => { e.preventDefault(); setBundleDrag(false); const f = [...e.dataTransfer.files].find((x) => /\.zip$/i.test(x.name)); if (f) { setBundleFile(f); setBundleErr(null); } }}
                  className="flex min-h-[110px] flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed p-4 text-center transition-colors"
                  style={{ borderColor: bundleDrag ? "var(--accent)" : "var(--line-strong)", background: bundleDrag ? "var(--accent-soft)" : "color-mix(in srgb, var(--bg) 45%, transparent)" }}
                >
                  <div className="text-muted">{bundleFile ? <><strong className="text-fg">{bundleFile.name}</strong> ({fmtBytes(bundleFile.size)})</> : "Drop a Brody export (.zip) here, or"}</div>
                  <button className="btn" onClick={() => bundleInput.current?.click()}>{bundleFile ? "Choose a different file" : "Select export"}</button>
                  <input ref={bundleInput} type="file" accept=".zip,application/zip" hidden aria-label="Select Brody export" onChange={(e) => { setBundleFile(e.target.files?.[0] ?? null); setBundleErr(null); }} />
                </div>
                {bundleErr && <div role="alert" className="mt-3 text-sm" style={{ color: "var(--crit)" }}>{bundleErr.message}{bundleErr.hint && <div className="text-muted">{bundleErr.hint}</div>}</div>}
                <div className="mt-3 flex items-center justify-between gap-3">
                  <span className="text-xs text-muted">The unzipped folder also has a launcher (&ldquo;Open in Brody&rdquo;) that does this in one double-click while Brody is running.</span>
                  <button className="btn btn-primary btn-cta" onClick={openBundleFile} disabled={!bundleFile || bundleBusy} aria-busy={bundleBusy}>{bundleBusy ? "Opening…" : "Open export"}<span className="disc" aria-hidden>→</span></button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <h2 className="mt-9 font-serif text-xl font-bold">Projects</h2>
        <div className="card mt-2 overflow-hidden">
          {projects.loading && !projects.data ? <Loading /> : projects.error ? <ErrorBox error={projects.error} onRetry={projects.reload} /> : !projects.data?.projects.length ? <Empty title="No projects yet">Upload code or import a repository to begin.</Empty> : (
            <table className="tbl">
              <thead><tr><th>Project</th><th>Source</th><th>Files</th><th>Status</th><th>Updated</th><th /></tr></thead>
              <tbody>
                {projects.data.projects.map((p) => (
                  <tr key={p.id}>
                    <td><Link href={`/p/${p.id}`} className="font-medium">{p.name}</Link>{p.commit && <span className="mono ml-2 text-xs text-muted">{p.commit.slice(0, 8)}</span>}</td>
                    <td className="text-muted">{p.sourceType}{p.branch ? ` · ${p.branch}` : ""}</td>
                    <td className="tabular-nums">{p.fileCount.toLocaleString()}</td>
                    <td><StatusChip status={p.status} /></td>
                    <td className="text-muted">{new Date(p.updatedAt).toLocaleString()}</td>
                    <td className="whitespace-nowrap text-right">{p.status === "ready" && <span className="mr-2 inline-block align-middle"><DownloadMenu projectId={p.id} scope="full" label="Report" small /></span>}<button className="btn btn-danger" onClick={() => remove(p.id, p.name)} aria-label={`Delete ${p.name}`}>Delete</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </div>
  );
}
