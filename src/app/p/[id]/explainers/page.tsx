"use client";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { ExplainerPanel } from "@/components/explainer/panel";
import { Chip, Empty, ErrorBox, Loading } from "@/components/ui";
import { Icon } from "@/components/Icon";
import { api, useApi } from "@/lib/client";
import type { ModeRecommendation } from "@/lib/explainer/types";

interface Row { id: string; sourceRunId: string; title: string; audience: string; router: ModeRecommendation; ready: { id: string; urls: Record<string, string | string[]>; durationMs?: number } | null; latest: { id: string; status: string } | null; updatedAt: number }
interface Settings { saved: Record<string, string>; effective: { execution: string; privacy: string; ttsProvider: string; renderer: string }; options: { execution: string[]; privacy: string[]; ttsProviders: string[] }; voices: { id: string; label: string; local: boolean; wordTimings: boolean; available: boolean; reason: string | null }[]; renderers: { id: string; label: string; available: boolean; reason: string | null }[] }

const SOURCE_LABEL: Record<string, string> = { question: "Ask answer", file: "File", area: "Functional area", module: "Folder", finding: "Finding", system: "Whole system" };
const EXEC: Record<string, string> = { local: "Local only: narration never leaves this machine", hybrid: "Hybrid: local voices first, cloud voices only when allowed", cloud: "Cloud: use a configured cloud voice when privacy allows" };
const PRIVACY: Record<string, string> = { "local-only": "Never send narration to a cloud service", ask: "Ask each time (a checkbox on the video form)", allow: "Allow configured cloud voices; secrets are always removed" };

function RoutingSettings() {
  const s = useApi<Settings>("/api/explainer/settings");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (s.error) return <ErrorBox error={s.error} />;
  if (!s.data) return <Loading label="Checking voices and renderers" />;
  const d = s.data;
  const save = async (patch: Record<string, string | null>) => { setBusy(true); setErr(""); try { await api("/api/explainer/settings", { method: "PUT", body: JSON.stringify(patch) }); s.reload(); } catch (e) { setErr((e as Error).message); } setBusy(false); };
  return (
    <div className="card space-y-3 p-4 text-[13px]" data-testid="explainer-settings">
      <div className="font-serif text-[16px] font-bold">Voice, privacy and rendering</div>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1"><span className="h-label">Where narration is spoken</span>
          <select className="input" value={d.effective.execution} disabled={busy} onChange={(e) => save({ execution: e.target.value })}>{d.options.execution.map((x) => <option key={x} value={x}>{EXEC[x]}</option>)}</select>
        </label>
        <label className="flex flex-col gap-1"><span className="h-label">Cloud voices and private code</span>
          <select className="input" value={d.effective.privacy} disabled={busy} onChange={(e) => save({ privacy: e.target.value })}>{d.options.privacy.map((x) => <option key={x} value={x}>{PRIVACY[x]}</option>)}</select>
        </label>
        <label className="flex flex-col gap-1"><span className="h-label">Preferred voice</span>
          <select className="input" value={d.effective.ttsProvider} disabled={busy} onChange={(e) => save({ ttsProvider: e.target.value === "auto" ? null : e.target.value })}><option value="auto">Best available for the mode</option>{d.voices.map((v) => <option key={v.id} value={v.id} disabled={!v.available}>{v.label}</option>)}</select>
        </label>
        <label className="flex flex-col gap-1"><span className="h-label">Animation engine</span>
          <select className="input" value={d.effective.renderer} disabled={busy} onChange={(e) => save({ renderer: e.target.value === "auto" ? null : e.target.value })}><option value="auto">Automatic per scene</option>{d.renderers.map((r) => <option key={r.id} value={r.id} disabled={!r.available}>{r.label}</option>)}</select>
        </label>
      </div>
      <table className="tbl">
        <thead><tr><th>Voice</th><th>Runs</th><th>Timing</th><th>Status</th></tr></thead>
        <tbody>{d.voices.map((v) => <tr key={v.id}><td>{v.label}</td><td>{v.local ? "on this machine" : "cloud"}</td><td>{v.wordTimings ? "word-level, measured" : "sentence-level"}</td><td>{v.available ? <Chip tone="ok">available</Chip> : <span className="text-muted">{v.reason}</span>}</td></tr>)}
          {d.renderers.map((r) => <tr key={r.id}><td>{r.label}</td><td>on this machine</td><td>renderer</td><td>{r.available ? <Chip tone="ok">available</Chip> : <span className="text-muted">{r.reason}</span>}</td></tr>)}</tbody>
      </table>
      <p className="text-xs text-muted">API keys are read from the environment only and are never shown, stored here or sent to the browser.</p>
      {err && <div role="alert" style={{ color: "var(--crit)" }}>{err}</div>}
    </div>
  );
}

export default function ExplainersPage() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const open = params.get("e");
  const list = useApi<{ explanations: Row[] }>(`/api/explanations?projectId=${id}`, { pollMs: 5000 });
  const [settings, setSettings] = useState(false);
  return (
    <div className="min-w-0 p-5">
      <div className="max-w-[1100px] space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="font-serif text-2xl font-bold">Explainers</h1>
          <button className="btn" aria-pressed={settings} onClick={() => setSettings(!settings)}><Icon name="gear" size={15} />Voice &amp; privacy</button>
        </div>
        <p className="text-sm text-muted">Every explanation Brody has made for this project: clear text, a diagram, an interactive explainer and a narrated video, all from the same grounded result. Use <strong>Explain</strong> on any answer in Ask Repository or on any level of the System Explanation to make a new one.</p>
        {settings && <RoutingSettings />}
        {open && <ExplainerPanel key={open} projectId={id} explanationId={open} initialTab="video" onClose={() => router.push(`/p/${id}/explainers`)} />}
        {list.error && <ErrorBox error={list.error} />}
        {list.loading && !list.data && <Loading />}
        {list.data && list.data.explanations.length === 0 && <Empty title="No explainers yet">Ask the repository a question, then choose Explain ▾ under the answer.</Empty>}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.data?.explanations.map((e) => (
            <button key={e.id} className={`card overflow-hidden text-left transition hover:border-[var(--accent)] ${open === e.id ? "!border-[var(--accent)]" : ""}`} onClick={() => router.push(`/p/${id}/explainers?e=${e.id}`)} data-testid="explainer-card">
              <div className="flex aspect-video items-center justify-center bg-[#0B1822]">{typeof e.ready?.urls.thumbnail === "string" ? (
                // eslint-disable-next-line @next/next/no-img-element -- a generated thumbnail served by the API
                <img src={e.ready.urls.thumbnail} alt="" className="h-full w-full object-cover" />
              ) : <Icon name="video" size={28} className="text-[#5CC6F0] opacity-60" />}</div>
              <div className="space-y-1 p-3">
                <div className="line-clamp-2 font-semibold">{e.title}</div>
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                  <span>{SOURCE_LABEL[e.sourceRunId.split(":")[0]] ?? e.sourceRunId}</span>
                  {e.ready ? <Chip tone="ok">video ready</Chip> : e.latest ? <Chip tone={e.latest.status === "failed" ? "danger" : "info"}>{e.latest.status}</Chip> : <Chip>no video</Chip>}
                  <span>video value {Math.round(e.router.videoValueScore * 100)}%</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
