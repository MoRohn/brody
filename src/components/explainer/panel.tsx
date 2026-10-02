"use client";
import { useEffect, useMemo, useState } from "react";
import { api, useApi } from "@/lib/client";
import type { ExplanationView, JobView } from "@/lib/explainer";
import type { AudienceLevel, DurationMode, NarrationPlan, ValidationReport } from "@/lib/explainer/types";
import { MermaidView } from "@/components/mermaid";
import { Chip, Loading, SourceLink } from "@/components/ui";
import { Icon } from "@/components/Icon";
import { ACTIVE, errorText, fmtClock, useExplanation, useJob } from "./hooks";
import { InteractivePlayer } from "./interactive";
import { JobProgress } from "./progress";
import { VideoDownloads, VideoPlayer } from "./video";

export type ExplainTab = "text" | "diagram" | "interactive" | "video" | "sources" | "artifacts";
const TABS: { id: ExplainTab; label: string }[] = [
  { id: "text", label: "Explanation" },
  { id: "diagram", label: "Diagram" },
  { id: "interactive", label: "Interactive" },
  { id: "video", label: "Video" },
  { id: "sources", label: "Sources" },
  { id: "artifacts", label: "Artifacts" },
];
const MODE_LABEL: Record<string, string> = { text: "Text", diagram: "Diagram", interactive: "Interactive", video: "Video" };
const DURATIONS: { id: DurationMode; label: string; hint: string }[] = [
  { id: "quick", label: "Quick", hint: "30–60 s: one idea" },
  { id: "standard", label: "Standard", hint: "1–3 min: a system" },
  { id: "deep", label: "Deep", hint: "3–10 min: a walkthrough" },
];

export function ExplainerPanel({ projectId, explanationId, initialTab = "text", onClose }: { projectId: string; explanationId: string; initialTab?: ExplainTab; onClose?: () => void }) {
  const { explanation, error, reload } = useExplanation(explanationId);
  // Choosing another format from the Explain menu remounts the panel (see ExplainResult), so the first tab is the prop.
  const [tab, setTab] = useState<ExplainTab>(initialTab);
  const activeId = explanation?.latest && ACTIVE(explanation.latest) ? explanation.latest.id : null;
  const live = useJob(activeId, () => reload());
  const latest = live ?? explanation?.latest ?? null;
  if (error && !explanation) return <div role="alert" className="card mt-2 p-3 text-sm" style={{ color: "var(--crit)" }}>{error.message}</div>;
  if (!explanation) return <div className="card mt-2"><Loading label="Compiling the explanation" /></div>;
  const r = explanation.router;
  return (
    <section className="card animate-in mt-2 overflow-hidden" aria-label={`Explanation: ${explanation.title}`} data-testid="explainer-panel">
      <div className="flex flex-wrap items-start gap-2 border-b border-line bg-panel2 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="font-serif text-[15.5px] font-bold text-deep">{explanation.title}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <span title={r.reasons.join("; ")}>Recommended: {r.recommendedModes.map((m) => MODE_LABEL[m]).join(" · ")}</span>
            <Chip tone={r.videoValueScore >= 0.55 ? "ok" : "neutral"} title={`Video value ${r.videoValueScore}: ${r.reasons.join("; ")}`}>video value {Math.round(r.videoValueScore * 100)}%</Chip>
            <Chip tone="info" title="Share of the explanation's claims that resolve to source lines, weighted by confidence">grounded {Math.round(explanation.spec.confidence * 100)}%</Chip>
            <span>{explanation.spec.sources.length} sources</span>
          </div>
        </div>
        <AudienceSelect explanation={explanation} onChange={reload} />
        {onClose && <button className="icon-btn !h-8 !w-8" onClick={onClose} aria-label="Close explanation"><Icon name="x" size={16} /></button>}
      </div>
      <div className="tabs border-b border-line px-2 py-1.5" role="tablist">
        {TABS.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} className="tab !py-1 !text-[13px]" onClick={() => setTab(t.id)} data-testid={`explainer-tab-${t.id}`}>{t.label}{t.id === "video" && latest && ACTIVE(latest) && <span className="live-dot ml-1.5" aria-label="in progress" />}</button>)}
      </div>
      <div className="p-3">
        {tab === "text" && <ClearTextView projectId={projectId} explanation={explanation} />}
        {tab === "diagram" && (explanation.diagram ? <MermaidView code={explanation.diagram} title={explanation.title} /> : <p className="text-muted">This result has too few connected parts for a diagram; the explanation and the video still work.</p>)}
        {tab === "interactive" && <InteractiveTab projectId={projectId} explanation={explanation} latest={latest} onStarted={reload} />}
        {tab === "video" && <VideoTab projectId={projectId} explanation={explanation} latest={latest} reload={reload} openInteractive={() => setTab("interactive")} />}
        {tab === "sources" && <SourcesView projectId={projectId} explanation={explanation} />}
        {tab === "artifacts" && <ArtifactsView explanation={explanation} latest={latest} />}
      </div>
    </section>
  );
}

function AudienceSelect({ explanation, onChange }: { explanation: ExplanationView; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <label className="flex items-center gap-1 text-xs"><span className="text-muted">Audience</span>
      <select className="input !w-auto !py-0.5 !text-xs" value={explanation.audience} disabled={busy} aria-label="Audience" onChange={async (e) => { setBusy(true); try { await api(`/api/explanations/${explanation.id}`, { method: "PATCH", body: JSON.stringify({ audience: e.target.value }) }); onChange(); } finally { setBusy(false); } }}>
        <option value="beginner">Beginner</option><option value="intermediate">Intermediate</option><option value="expert">Expert</option>
      </select>
    </label>
  );
}

function ClearTextView({ projectId, explanation }: { projectId: string; explanation: ExplanationView }) {
  const c = explanation.clear;
  const src = (ids: string[]) => ids.map((id) => explanation.spec.sources.find((s) => s.id === id)).filter((s) => s?.path);
  return (
    <div className="prose-doc text-[15px]">
      <p className="font-semibold">{c.summary}</p>
      {c.sections.map((s) => (
        <div key={s.id} className="mb-3">
          <div className="h-label mb-1 !text-[11px]">{s.title}</div>
          {s.paragraphs.map((p, i) => <p key={i} className="!mb-1.5">{p.text} <span className="whitespace-nowrap">{src(p.sourceIds).slice(0, 2).map((x) => <span key={x!.id} className="ml-1"><SourceLink projectId={projectId} cite={`${x!.path}:${x!.startLine}-${x!.endLine}`}>[{x!.path!.split("/").pop()}:{x!.startLine}]</SourceLink></span>)}</span></p>)}
        </div>
      ))}
      {c.uncertainties.length > 0 && <div className="mt-2 text-[13px] text-muted"><strong>Not established by the sources:</strong> {c.uncertainties.join(" ")}</div>}
      <p className="mt-2 font-sans text-xs text-muted">Written in controlled technical English from the same grounded claims as the diagram and the video. Unsupported claims are never shown.</p>
    </div>
  );
}

function SourcesView({ projectId, explanation }: { projectId: string; explanation: ExplanationView }) {
  const spec = explanation.spec;
  return (
    <ol className="space-y-1.5" data-testid="explainer-sources">
      {spec.sources.map((s) => {
        const claims = spec.claims.filter((c) => c.supported && c.sourceIds.includes(s.id));
        return (
          <li key={s.id} className="rounded-lg border border-line">
            <details>
              <summary className="cursor-pointer px-2.5 py-1.5 text-[13px]">{s.path ? <SourceLink projectId={projectId} cite={`${s.path}:${s.startLine}-${s.endLine}`} /> : s.label}{s.note && <span className="ml-2 text-muted">{s.note}</span>}<span className="ml-2 text-xs text-muted">supports {claims.length} claim{claims.length === 1 ? "" : "s"}</span></summary>
              {s.snippet && <pre tabIndex={0} className="!m-1.5 !mt-0 max-h-56 overflow-auto text-[11.5px]">{s.snippet.split("\n").map((l, i) => `${(s.startLine ?? 1) + i}: ${l}`).join("\n")}</pre>}
              {claims.length > 0 && <ul className="list-disc px-7 pb-2 text-[13px]">{claims.slice(0, 6).map((c) => <li key={c.id}>{c.text}</li>)}</ul>}
            </details>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------------------------------------------------
interface SettingsState { effective: { execution: string; privacy: string; ttsProvider: string }; voices: { id: string; label: string; local: boolean; wordTimings: boolean; available: boolean; reason: string | null }[]; renderers: { id: string; label: string; available: boolean; reason: string | null }[] }

function CreateVideoForm({ explanation, onStarted, compact = false }: { explanation: ExplanationView; onStarted: (job: JobView) => void; compact?: boolean }) {
  const settings = useApi<SettingsState>("/api/explainer/settings");
  const [duration, setDuration] = useState<DurationMode>(explanation.router.suggestedDuration);
  const [execution, setExecution] = useState<string>("");
  const [voice, setVoice] = useState<string>("auto");
  const [renderer, setRenderer] = useState<string>("auto");
  const [allowExternal, setAllowExternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const s = settings.data;
  const exec = execution || s?.effective.execution || "local";
  const voices = (s?.voices ?? []).filter((v) => (exec === "local" ? v.local : exec === "cloud" ? !v.local : true));
  const cloudChosen = exec !== "local" && voices.some((v) => !v.local && v.available) && s?.effective.privacy !== "allow";
  const start = async () => {
    setBusy(true); setErr("");
    try {
      const r = await api<{ job: JobView }>(`/api/explanations/${explanation.id}/video`, { method: "POST", body: JSON.stringify({ duration, execution: exec, ...(voice !== "auto" ? { ttsProvider: voice } : {}), renderer, ...(allowExternal ? { allowExternal: true } : {}) }) });
      onStarted(r.job);
    } catch (e) { setErr(errorText(e)); }
    setBusy(false);
  };
  return (
    <div className="space-y-3" data-testid="create-video">
      {!compact && <p className="text-[13.5px]">Brody narrates this explanation, measures when every word is spoken, and cuts an animation to the voice. {explanation.router.videoValueScore >= 0.55 ? `Recommended here: ${explanation.router.reasons.slice(0, 3).join(", ")}.` : "Video is optional for this result; the explanation and diagram may be enough."}</p>}
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Length">
        {DURATIONS.map((d) => <button key={d.id} role="radio" aria-checked={duration === d.id} className={`btn !rounded-xl !py-1 text-left ${duration === d.id ? "btn-deep" : ""}`} onClick={() => setDuration(d.id)}><span><span className="block">{d.label}{d.id === explanation.router.suggestedDuration ? " (suggested)" : ""}</span><span className="block text-[11px] font-normal opacity-80">{d.hint}</span></span></button>)}
      </div>
      <div className="grid gap-2 text-[13px] sm:grid-cols-3">
        <label className="flex flex-col gap-0.5"><span className="h-label">Run</span>
          <select className="input !py-1" value={exec} onChange={(e) => setExecution(e.target.value)} aria-label="Where it runs"><option value="local">Local only (private)</option><option value="hybrid">Hybrid (local first)</option><option value="cloud">Cloud voice</option></select>
        </label>
        <label className="flex flex-col gap-0.5"><span className="h-label">Voice</span>
          <select className="input !py-1" value={voice} onChange={(e) => setVoice(e.target.value)} aria-label="Voice"><option value="auto">Best available</option>{voices.map((v) => <option key={v.id} value={v.id} disabled={!v.available}>{v.label}{!v.available ? " (unavailable)" : v.wordTimings ? "" : " (sentence timing)"}</option>)}</select>
        </label>
        <label className="flex flex-col gap-0.5"><span className="h-label">Animation</span>
          <select className="input !py-1" value={renderer} onChange={(e) => setRenderer(e.target.value)} aria-label="Renderer"><option value="auto">Automatic per scene</option>{(s?.renderers ?? []).map((r) => <option key={r.id} value={r.id} disabled={!r.available}>{r.label}{r.available ? "" : " (not installed)"}</option>)}</select>
        </label>
      </div>
      {cloudChosen && <label className="flex items-start gap-2 text-[13px]"><input type="checkbox" className="mt-1" checked={allowExternal} onChange={(e) => setAllowExternal(e.target.checked)} /><span>Send the narration text to the cloud voice provider. It describes this repository, which may be private. Detected secrets are never sent.</span></label>}
      <div className="flex items-center gap-2">
        <button className="btn btn-primary btn-cta" onClick={start} disabled={busy} aria-busy={busy} data-testid="start-video"><Icon name="video" size={15} />Create video<span className="disc" aria-hidden>→</span></button>
        <span className="text-xs text-muted">Runs in the background; the explanation stays usable. About {Math.round(explanation.router.estimate.videoSeconds / 60 * 10) / 10} min of video.</span>
      </div>
      {err && <div role="alert" className="text-[13px]" style={{ color: "var(--crit)" }}>{err}</div>}
    </div>
  );
}

const REFINE_EXAMPLES = ["Make this shorter.", "Explain it for a beginner.", "Remove the intro.", "Make the visuals less animated.", "Use a local voice.", "Redo just the final section and show how the fix works."];

function RefineBox({ explanation, onStarted }: { explanation: ExplanationView; onStarted: (job: JobView) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [understood, setUnderstood] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const send = async (req: string) => {
    if (req.trim().length < 3) return;
    setBusy(true); setErr(""); setUnderstood([]);
    try {
      const r = await api<{ refine: { understood: string[] }; job: JobView }>(`/api/explanations/${explanation.id}/refine`, { method: "POST", body: JSON.stringify({ request: req }) });
      setUnderstood(r.refine.understood); setText(""); onStarted(r.job);
    } catch (e) { setErr(errorText(e)); }
    setBusy(false);
  };
  return (
    <div className="space-y-1.5" data-testid="refine-box">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
        <input className="input !rounded-full !py-1.5" value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask for a change: shorter, for a beginner, focus on a part, redo a section…" aria-label="Change the video" maxLength={600} />
        <button className="btn btn-primary" type="submit" disabled={busy || text.trim().length < 3} aria-busy={busy}><Icon name="sparkle" size={14} />Apply</button>
      </form>
      <div className="flex flex-wrap gap-1">{REFINE_EXAMPLES.map((x) => <button key={x} className="btn !px-2.5 !py-0 text-[11.5px]" onClick={() => setText(x)}>{x}</button>)}</div>
      {understood.length > 0 && <div className="text-[13px]"><span className="text-muted">Understood:</span> {understood.join(" ")}</div>}
      {err && <div role="alert" className="text-[13px]" style={{ color: "var(--crit)" }}>{err}</div>}
    </div>
  );
}

function NarrationEditor({ job, explanation, onStarted }: { job: JobView; explanation: ExplanationView; onStarted: (job: JobView) => void }) {
  const [plan, setPlan] = useState<NarrationPlan | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { void fetch(job.urls.plan as string).then((r) => r.json()).then((p: NarrationPlan) => { setPlan(p); setDrafts(Object.fromEntries(p.sections.map((s) => [s.id, s.narration]))); }).catch(() => setErr("The narration could not be loaded.")); }, [job.urls.plan]);
  if (!plan) return <div className="text-muted">{err || "Loading narration…"}</div>;
  const changed = plan.sections.filter((s) => drafts[s.id] !== undefined && drafts[s.id].trim() !== s.narration.trim());
  const save = async () => {
    setBusy(true); setErr("");
    try { const r = await api<{ job: JobView }>(`/api/explanations/${explanation.id}/narration`, { method: "PUT", body: JSON.stringify({ narration: Object.fromEntries(changed.map((s) => [s.id, drafts[s.id]])) }) }); onStarted(r.job); }
    catch (e) { setErr(errorText(e)); }
    setBusy(false);
  };
  return (
    <div className="space-y-2" data-testid="narration-editor">
      {plan.sections.map((s) => (
        <label key={s.id} className="block">
          <span className="h-label">{s.role === "hook" ? "Opening" : s.title}</span>
          <textarea className="input mt-0.5 min-h-[64px] text-[13.5px]" value={drafts[s.id] ?? ""} onChange={(e) => setDrafts({ ...drafts, [s.id]: e.target.value })} maxLength={4000} />
        </label>
      ))}
      <div className="flex items-center gap-2"><button className="btn btn-primary" disabled={!changed.length || busy} aria-busy={busy} onClick={save}>Re-voice {changed.length || ""} changed section{changed.length === 1 ? "" : "s"}</button><span className="text-xs text-muted">Only edited sections are spoken and rendered again.</span></div>
      {err && <div role="alert" className="text-[13px]" style={{ color: "var(--crit)" }}>{err}</div>}
    </div>
  );
}

function VideoTab({ projectId, explanation, latest, reload, openInteractive }: { projectId: string; explanation: ExplanationView; latest: JobView | null; reload: () => void; openInteractive: () => void }) {
  const ready = explanation.ready;
  const [mode, setMode] = useState<"watch" | "edit" | "new">("watch");
  const [regen, setRegen] = useState<{ id: string; title: string } | null>(null);
  const [instruction, setInstruction] = useState("");
  const [err, setErr] = useState("");
  const started = () => { setMode("watch"); setRegen(null); reload(); };
  const act = async (url: string) => { setErr(""); try { await api(url, { method: "POST" }); reload(); } catch (e) { setErr(errorText(e)); } };
  const showProgress = latest && (ACTIVE(latest) || ((latest.status === "failed" || latest.status === "cancelled") && latest.id !== ready?.id));
  return (
    <div className="space-y-4">
      {showProgress && latest && (
        <div className="rounded-xl border border-line p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2"><span className="font-semibold">{ACTIVE(latest) ? (latest.kind === "video" ? "Making the video" : "Updating the video") : latest.status === "cancelled" ? "Cancelled" : "The video could not be finished"}</span>{ready && ACTIVE(latest) && <span className="text-xs text-muted">The current video stays available below until the new one is ready.</span>}</div>
          {latest.error && <div role="alert" className="mb-2 rounded-lg p-2 text-[13px]" style={{ background: "color-mix(in srgb, var(--crit) 8%, var(--panel))", color: "var(--crit)" }}>{latest.error} <span className="text-muted">The answer, explanation, diagram and sources are unaffected.</span></div>}
          <JobProgress job={latest} onCancel={() => act(`/api/video-jobs/${latest.id}/cancel`)} onRetry={() => act(`/api/video-jobs/${latest.id}/retry`)} />
          {Array.isArray(latest.urls.storyboard) && latest.urls.storyboard.length > 0 && !latest.urls.video && (
            <div className="mt-3">
              <div className="mb-1 flex items-center gap-2"><span className="h-label">Storyboard</span><button className="btn py-0.5 text-xs" onClick={openInteractive}><Icon name="play" size={12} />Play the interactive explainer now</button></div>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">{(latest.urls.storyboard as string[]).map((u, i) => (
                // eslint-disable-next-line @next/next/no-img-element -- generated storyboard stills served by the API; nothing to optimise
                <img key={u} src={u} alt={`Storyboard scene ${i + 1}`} className="rounded-md border border-line" loading="lazy" />
              ))}</div>
            </div>
          )}
          {typeof latest.urls.audio === "string" && !latest.urls.video && <audio className="mt-2 w-full" controls src={latest.urls.audio} aria-label="Narration audio" />}
        </div>
      )}
      {ready ? (
        <>
          <VideoPlayer projectId={projectId} spec={explanation.spec} job={ready} onRegenerateSection={(id, title) => setRegen({ id, title })} />
          {regen && (
            <form className="flex flex-wrap items-center gap-2 rounded-xl border border-line p-2" onSubmit={async (e) => { e.preventDefault(); setErr(""); try { await api(`/api/video-jobs/${ready.id}/regenerate-section`, { method: "POST", body: JSON.stringify({ sectionId: regen.id, ...(instruction.trim() ? { instruction: instruction.trim() } : {}) }) }); setInstruction(""); started(); } catch (er) { setErr(errorText(er)); } }}>
              <span className="text-[13px]">Regenerate <strong>{regen.title}</strong></span>
              <input className="input min-w-[200px] flex-1 !py-1" value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="Optional: what should change (empty re-renders the scene)" aria-label="What should change" />
              <button className="btn btn-primary" type="submit" disabled={ACTIVE(latest)}>Regenerate section</button>
              <button className="btn" type="button" onClick={() => setRegen(null)}>Cancel</button>
            </form>
          )}
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <VideoDownloads job={ready} />
            <div className="ml-auto flex gap-1.5">
              <button className="btn py-0.5 text-xs" aria-pressed={mode === "edit"} onClick={() => setMode(mode === "edit" ? "watch" : "edit")}>Edit narration</button>
              <button className="btn py-0.5 text-xs" aria-pressed={mode === "new"} onClick={() => setMode(mode === "new" ? "watch" : "new")}><Icon name="refresh" size={13} />New version</button>
            </div>
          </div>
          {!ACTIVE(latest) && <RefineBox explanation={explanation} onStarted={started} />}
          {mode === "edit" && !ACTIVE(latest) && <NarrationEditor job={ready} explanation={explanation} onStarted={started} />}
          {mode === "new" && !ACTIVE(latest) && <CreateVideoForm explanation={explanation} onStarted={started} compact />}
          <TimingNote job={ready} />
        </>
      ) : !showProgress && <CreateVideoForm explanation={explanation} onStarted={started} />}
      {err && <div role="alert" className="text-[13px]" style={{ color: "var(--crit)" }}>{err}</div>}
    </div>
  );
}

function TimingNote({ job }: { job: JobView }) {
  const [m, setM] = useState<{ ttsProvider: string; voice: string; timing: { source: string; granularity: string }; renderers: Record<string, number>; durationMs: number } | null>(null);
  useEffect(() => { if (typeof job.urls.manifest === "string") void fetch(job.urls.manifest).then((r) => r.json()).then(setM).catch(() => {}); }, [job.urls.manifest]);
  if (!m) return null;
  const how = m.timing.source === "provider" ? "word timings reported by the voice engine" : m.timing.source === "aligned" ? "word timings aligned from the audio" : m.timing.source === "synthetic" ? "a synthetic test voice" : "sentence-level timing only (this voice reports no word timings)";
  return <p className="text-xs text-muted">{fmtClock(m.durationMs)} · voice {m.ttsProvider}{m.voice ? ` (${m.voice.split(".").pop()})` : ""}, cut to {how} · rendered with {Object.entries(m.renderers).map(([k, v]) => `${k} (${v} scene${v === 1 ? "" : "s"})`).join(" and ")}.</p>;
}

function InteractiveTab({ projectId, explanation, latest, onStarted }: { projectId: string; explanation: ExplanationView; latest: JobView | null; onStarted: () => void }) {
  // The interactive explainer needs narration timing and a scene plan: the latest job that has a storyboard.
  const job = latest?.urls.scenePlan && latest.urls.audio ? latest : explanation.ready;
  if (!job?.urls.scenePlan) {
    return ACTIVE(latest) ? <div className="text-[13.5px]"><p className="mb-2">The interactive explainer plays as soon as the narration is timed and the scenes are designed.</p>{latest && <JobProgress job={latest} />}</div> : (
      <div className="space-y-2"><p className="text-[13.5px]">The interactive explainer is the video&apos;s scenes, drawn live in the page and driven by the narration, so you can pause anywhere and click any part for its claims and sources.</p><CreateVideoForm explanation={explanation} onStarted={onStarted} compact /></div>
    );
  }
  return <InteractivePlayer key={job.id} projectId={projectId} spec={explanation.spec} urls={job.urls} />;
}

// ---------------------------------------------------------------------------------------------------------------------
// Artifacts: internal observability
// ---------------------------------------------------------------------------------------------------------------------
function ArtifactsView({ explanation, latest }: { explanation: ExplanationView; latest: JobView | null }) {
  const job = explanation.ready ?? latest;
  const validation = job?.validation as ValidationReport | null;
  const summary = job?.summary as { metrics?: { stage: string; ms: number; reused: boolean; detail?: string; costUsd?: number }[]; aiUsage?: { costUsd: number | null; inputTokens: number; outputTokens: number }; tts?: { chars: number; costUsd: number } } | null;
  const compile = explanation.compile as { ai?: boolean; model?: string | null; dropped?: string[] } | null;
  const files = useMemo(() => Object.entries(job?.urls ?? {}).filter(([, v]) => typeof v === "string") as [string, string][], [job]);
  return (
    <div className="space-y-4 text-[13px]" data-testid="explainer-artifacts">
      <div>
        <div className="h-label mb-1">Explanation IR</div>
        <p>{explanation.spec.claims.length} claims ({explanation.spec.claims.filter((c) => c.supported).length} grounded), {explanation.spec.concepts.length} concepts, {explanation.spec.relationships.length} relationships, {explanation.spec.sources.length} sources; compiled {compile?.ai ? `with ${compile.model}` : "deterministically"}.{compile?.dropped?.length ? ` The grounding guard dropped ${compile.dropped.length} item(s): ${compile.dropped.slice(0, 3).join("; ")}.` : ""}</p>
      </div>
      {!job ? <p className="text-muted">No video job yet.</p> : (
        <>
          {validation && (
            <div>
              <div className="h-label mb-1">Validation {validation.ok ? "passed" : "failed"}</div>
              <table className="tbl"><tbody>{validation.checks.map((c) => <tr key={c.id}><td className="w-6" style={{ color: c.status === "pass" ? "var(--ok)" : c.status === "warn" ? "var(--med)" : "var(--crit)" }}>{c.status === "pass" ? "✓" : c.status === "warn" ? "!" : "✕"}</td><td>{c.label}</td><td className="text-muted">{c.detail}</td></tr>)}</tbody></table>
            </div>
          )}
          {summary?.metrics && (
            <div>
              <div className="h-label mb-1">Stages</div>
              <table className="tbl"><thead><tr><th>Stage</th><th>Time</th><th>Reused</th><th>Detail</th></tr></thead><tbody>{summary.metrics.map((m, i) => <tr key={i}><td>{m.stage}</td><td className="tabular-nums">{(m.ms / 1000).toFixed(1)} s</td><td>{m.reused ? "yes" : ""}</td><td className="text-muted">{m.detail}</td></tr>)}</tbody></table>
              <p className="mt-1 text-muted">AI {summary.aiUsage ? `${summary.aiUsage.inputTokens.toLocaleString()} in / ${summary.aiUsage.outputTokens.toLocaleString()} out tokens${summary.aiUsage.costUsd !== null ? `, $${summary.aiUsage.costUsd.toFixed(4)}` : ""}` : "not used"} · voice {summary.tts ? `${summary.tts.chars.toLocaleString()} characters, $${summary.tts.costUsd.toFixed(4)}` : "n/a"}</p>
            </div>
          )}
          <div>
            <div className="h-label mb-1">Files</div>
            <ul className="grid gap-x-4 sm:grid-cols-2">{files.map(([k, u]) => <li key={k}><a href={u} target="_blank" rel="noreferrer" className="mono text-[12px]">{k}</a></li>)}</ul>
          </div>
          <details><summary className="cursor-pointer text-muted">Job log</summary><pre className="max-h-64 overflow-auto text-[11.5px]">{job.log.join("\n")}</pre></details>
        </>
      )}
    </div>
  );
}

export type { AudienceLevel };
