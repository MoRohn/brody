"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { renderFrameSvg, sceneAt, sceneStateAt } from "@/lib/explainer/frame";
import type { ExplanationArtifactSpec, TranscriptEntry, VisualObject, VisualScenePlan } from "@/lib/explainer/types";
import { SourceLink } from "@/components/ui";
import { Icon } from "@/components/Icon";
import { fmtClock } from "./hooks";

/** The explainer faces, served by Brody, under names that cannot collide with anything installed on the viewer's machine. */
const FONT_CSS = `
@font-face { font-family: "BrodyExplainerSans"; src: url(/api/explainer/fonts/DejaVuSansCondensed.ttf) format("truetype"); font-weight: 400; font-display: block; }
@font-face { font-family: "BrodyExplainerSans"; src: url(/api/explainer/fonts/DejaVuSansCondensed-Bold.ttf) format("truetype"); font-weight: 700; font-display: block; }
@font-face { font-family: "BrodyExplainerMono"; src: url(/api/explainer/fonts/DejaVuSansMono.ttf) format("truetype"); font-weight: 400; font-display: block; }`;

export function ExplainerFonts() {
  return <style>{FONT_CSS}</style>;
}

function useJson<T>(url: string | undefined): T | null {
  const [v, setV] = useState<T | null>(null);
  useEffect(() => {
    if (!url) return;
    let live = true;
    fetch(url).then((r) => (r.ok ? r.json() : null)).then((j) => { if (live) setV(j as T); }).catch(() => {});
    return () => { live = false; };
  }, [url]);
  return v;
}

/** Topmost visible object under a point (frame coordinates) at a moment. */
function hit(plan: VisualScenePlan, ms: number, x: number, y: number): VisualObject | null {
  const at = sceneAt(plan.scenes, ms);
  if (!at) return null;
  const st = sceneStateAt(at.scene, at.local);
  const candidates = at.scene.objects.filter((o) => o.kind !== "connector" && o.kind !== "kicker" && (st.objs.get(o.id)?.opacity ?? 0) > 0.5 && x >= o.box.x && x <= o.box.x + o.box.w && y >= o.box.y && y <= o.box.y + o.box.h);
  return candidates.sort((a, b) => b.z - a.z)[0] ?? null;
}

export interface InteractiveProps {
  projectId: string;
  spec: ExplanationArtifactSpec;
  urls: Record<string, string | string[]>;
  style?: string;
}

/**
 * The interactive explainer: the narration audio drives the same frame function the video renderers use, so it plays
 * the same scenes in sync, available as soon as the storyboard exists (before the video has rendered). Every object on
 * screen can be clicked for what it is, the claims behind it and the source lines.
 */
export function InteractivePlayer({ projectId, spec, urls }: InteractiveProps) {
  const plan = useJson<VisualScenePlan>(urls.scenePlan as string);
  const transcript = useJson<{ entries: TranscriptEntry[]; sections: { id: string; title: string; role: string }[] }>(urls.transcript as string);
  const audio = useRef<HTMLAudioElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [picked, setPicked] = useState<VisualObject | null>(null);
  const raf = useRef(0);

  const draw = useCallback((ms: number) => {
    if (!plan || !stage.current) return;
    const at = sceneAt(plan.scenes, ms);
    if (!at) return;
    stage.current.innerHTML = renderFrameSvg(at.scene, at.local, { style: plan.style, fontSans: "BrodyExplainerSans", fontMono: "BrodyExplainerMono" }).replace("<svg ", '<svg role="img" aria-label="Explainer animation" style="width:100%;height:auto;display:block" ');
  }, [plan]);

  useEffect(() => { draw(t); }, [draw, t]);
  useEffect(() => {
    const loop = () => {
      const a = audio.current;
      if (a && !a.paused) { const ms = a.currentTime * 1000; setT(ms); }
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf.current);
  }, []);

  const seek = (ms: number) => { if (audio.current) audio.current.currentTime = ms / 1000; setT(ms); };
  const toggle = () => { const a = audio.current; if (!a) return; if (a.paused) void a.play(); else a.pause(); };
  const duration = plan?.durationMs ?? 0;
  const chapters = useMemo(() => (plan && transcript ? plan.scenes.map((s) => ({ id: s.sectionId, title: transcript.sections.find((x) => x.id === s.sectionId)?.title ?? s.sectionId, role: transcript.sections.find((x) => x.id === s.sectionId)?.role, startMs: s.startMs })) : []), [plan, transcript]);
  const current = transcript?.entries.find((e) => t >= e.startMs && t < e.endMs + 250);

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!plan || !stage.current) return;
    const r = stage.current.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * plan.canvas.width, y = ((e.clientY - r.top) / r.height) * plan.canvas.height;
    setPicked(hit(plan, t, x, y));
  };

  if (!plan || !transcript) return <div className="p-4 text-muted">Loading the interactive explainer<span className="dots ml-1"><i /><i /><i /></span></div>;
  const pickedRefs = picked ? picked.refs : [];
  const concepts = spec.concepts.filter((k) => pickedRefs.includes(k.id));
  const metric = (spec.metrics ?? []).filter((m) => pickedRefs.includes(m.id));
  const rels = spec.relationships.filter((r) => pickedRefs.includes(r.id));
  const claimIds = [...new Set([...concepts.flatMap((k) => k.claimIds), ...metric.flatMap((m) => m.claimIds), ...rels.flatMap((r) => r.claimIds)])];
  const claims = spec.claims.filter((c) => claimIds.includes(c.id) && c.supported);
  const sources = spec.sources.filter((s) => claims.some((c) => c.sourceIds.includes(s.id)) || pickedRefs.includes(s.id));

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div>
        <ExplainerFonts />
        <div ref={stage} onClick={onClick} className="cursor-pointer overflow-hidden rounded-xl border border-line bg-[#0B1822]" style={{ aspectRatio: "16 / 9" }} data-testid="interactive-stage" title="Click anything for what it is and where it comes from" />
        <audio ref={audio} src={urls.audio as string} preload="auto" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onSeeked={() => setT((audio.current?.currentTime ?? 0) * 1000)} />
        <div className="mt-2 flex items-center gap-2">
          <button className="btn py-1" onClick={toggle} aria-label={playing ? "Pause" : "Play"} data-testid="interactive-play"><Icon name={playing ? "pause" : "play"} size={14} />{playing ? "Pause" : "Play"}</button>
          <input type="range" className="flex-1" min={0} max={Math.max(1, duration)} step={33} value={Math.min(t, duration)} onChange={(e) => seek(Number(e.target.value))} aria-label="Position" />
          <span className="mono text-xs text-muted">{fmtClock(t)} / {fmtClock(duration)}</span>
        </div>
        <div className="mt-2 min-h-[2.6em] rounded-lg bg-panel2 px-3 py-1.5 text-[14px]" aria-live="polite">{current?.text ?? " "}</div>
      </div>
      <div className="space-y-3 text-[13px]">
        <div>
          <div className="h-label mb-1">Chapters</div>
          <ol className="space-y-0.5">{chapters.map((c, i) => <li key={c.id}><button className={`w-full rounded-lg px-2 py-1 text-left hover:bg-panel2 ${t >= c.startMs && (chapters[i + 1]?.startMs ?? Infinity) > t ? "bg-panel2 font-semibold" : ""}`} onClick={() => seek(c.startMs)}><span className="mono mr-2 text-xs text-muted">{fmtClock(c.startMs)}</span>{c.role === "hook" ? "Opening" : c.title}</button></li>)}</ol>
        </div>
        <div className="card p-2.5" data-testid="interactive-inspector">
          {!picked ? <p className="text-muted">Click any part of the picture to see what it is, the claims behind it and the source lines.</p> : (
            <div className="space-y-1.5">
              <div className="font-semibold">{concepts[0]?.name ?? metric[0]?.label ?? rels[0]?.label ?? picked.lines.join(" ")}</div>
              {concepts[0]?.definition && <p>{concepts[0].definition}</p>}
              {claims.slice(0, 4).map((c) => <p key={c.id} className="text-fg2">{c.text}</p>)}
              {sources.length > 0 && <div className="flex flex-wrap gap-x-2 gap-y-1">{sources.slice(0, 5).map((s) => s.path ? <SourceLink key={s.id} projectId={projectId} cite={`${s.path}:${s.startLine}-${s.endLine}`} /> : null)}</div>}
              {!claims.length && !sources.length && <p className="text-muted">No sourced claim is attached to this mark.</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
