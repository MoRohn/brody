"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ExplanationArtifactSpec, TranscriptEntry } from "@/lib/explainer/types";
import type { JobView } from "@/lib/explainer";
import { SourceLink } from "@/components/ui";
import { Icon } from "@/components/Icon";
import { fmtClock } from "./hooks";

interface Transcript { entries: TranscriptEntry[]; sections: { id: string; title: string; role: string }[] }

function useTranscript(url: string | undefined): Transcript | null {
  const [v, setV] = useState<Transcript | null>(null);
  useEffect(() => {
    if (!url) return;
    let live = true;
    fetch(url).then((r) => (r.ok ? r.json() : null)).then((j) => { if (live) setV(j); }).catch(() => {});
    return () => { live = false; };
  }, [url]);
  return v;
}

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];

/**
 * The video result: native playback (play, pause, seek, fullscreen, picture in picture), captions from the measured
 * word timings, chapters, a transcript that seeks the video when clicked and follows it as it plays, the sources each
 * sentence rests on, speed, and downloads.
 */
export function VideoPlayer({ projectId, spec, job, onRegenerateSection }: { projectId: string; spec: ExplanationArtifactSpec; job: JobView; onRegenerateSection?: (sectionId: string, title: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [t, setT] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [captions, setCaptions] = useState(true);
  const transcript = useTranscript(job.urls.transcript as string);
  const listRef = useRef<HTMLOListElement>(null);
  const durationMs = Number(job.artifacts.durationMs ?? 0);
  const seek = (ms: number) => { const v = video.current; if (!v) return; v.currentTime = ms / 1000 + 0.001; void v.play().catch(() => {}); };

  useEffect(() => { if (video.current) video.current.playbackRate = speed; }, [speed]);
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    for (const tr of Array.from(v.textTracks)) if (tr.kind === "captions" || tr.kind === "subtitles") tr.mode = captions ? "showing" : "hidden";
  }, [captions, job.id]);
  const active = transcript?.entries.find((e) => t >= e.startMs && t < e.endMs + 200);
  useEffect(() => {
    if (!active || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-entry="${active.id}"]`);
    if (el && listRef.current) { const top = el.offsetTop - listRef.current.offsetTop; if (top < listRef.current.scrollTop || top > listRef.current.scrollTop + listRef.current.clientHeight - 40) listRef.current.scrollTo({ top: top - 40, behavior: "smooth" }); }
  }, [active]);
  const chapters = useMemo(() => {
    if (!transcript) return [];
    return transcript.sections.map((s) => ({ ...s, startMs: transcript.entries.find((e) => e.sectionId === s.id)?.startMs ?? 0 })).filter((c) => transcript.entries.some((e) => e.sectionId === c.id));
  }, [transcript]);
  const sourceOf = (id: string) => spec.sources.find((s) => s.id === id);

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div>
        <video ref={video} className="w-full rounded-xl border border-line bg-black" style={{ aspectRatio: "16 / 9" }} controls preload="metadata" poster={job.urls.thumbnail as string | undefined} crossOrigin="anonymous" onTimeUpdate={(e) => setT(e.currentTarget.currentTime * 1000)} data-testid="explainer-video">
          <source src={job.urls.video as string} type="video/mp4" />
          <track kind="captions" src={job.urls.captionsVtt as string} srcLang="en" label="English" default />
          <track kind="chapters" src={job.urls.chapters as string} srcLang="en" label="Chapters" />
        </video>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px]">
          <label className="flex items-center gap-1.5"><span className="text-muted">Speed</span>
            <select className="input !w-auto !py-0.5" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Playback speed">{SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}</select>
          </label>
          <button className="btn py-0.5 text-xs" aria-pressed={captions} onClick={() => setCaptions(!captions)}><Icon name="captions" size={14} />{captions ? "Captions on" : "Captions off"}</button>
          <button className="btn py-0.5 text-xs" onClick={() => void video.current?.requestFullscreen?.()}><Icon name="fullscreen" size={14} />Fullscreen</button>
          <span className="ml-auto mono text-xs text-muted">{fmtClock(t)} / {fmtClock(durationMs)}</span>
        </div>
        <div className="mt-3">
          <div className="h-label mb-1">Chapters</div>
          <ol className="grid gap-1 sm:grid-cols-2">
            {chapters.map((c, i) => {
              const on = t >= c.startMs && (chapters[i + 1]?.startMs ?? Infinity) > t;
              return (
                <li key={c.id} className={`flex items-center gap-1 rounded-lg border px-2 py-1 ${on ? "border-[var(--accent)] bg-panel2" : "border-line"}`}>
                  <button className="min-w-0 flex-1 truncate text-left text-[13px]" onClick={() => seek(c.startMs)} title={`Jump to ${c.title}`}><span className="mono mr-2 text-xs text-muted">{fmtClock(c.startMs)}</span>{c.role === "hook" ? "Opening" : c.title}</button>
                  {onRegenerateSection && <button className="icon-btn !h-7 !w-7" title={`Regenerate "${c.title}"`} aria-label={`Regenerate ${c.title}`} onClick={() => onRegenerateSection(c.id, c.role === "hook" ? "Opening" : c.title)}><Icon name="refresh" size={14} /></button>}
                </li>
              );
            })}
          </ol>
        </div>
      </div>
      <div className="flex min-h-0 flex-col">
        <div className="h-label mb-1">Transcript</div>
        <ol ref={listRef} className="max-h-[440px] min-h-0 flex-1 space-y-1 overflow-auto pr-1 text-[13.5px]" data-testid="transcript">
          {transcript?.entries.map((e) => (
            <li key={e.id} data-entry={e.id}>
              <button onClick={() => seek(e.startMs)} className={`w-full rounded-lg px-2 py-1 text-left hover:bg-panel2 ${active?.id === e.id ? "bg-panel2 font-medium" : ""}`}>
                <span className="mono mr-1.5 text-[11px] text-muted">{fmtClock(e.startMs)}</span>{e.text}
              </button>
              {e.sourceRefs.length > 0 && active?.id === e.id && (
                <div className="flex flex-wrap gap-x-2 px-2 pb-1 text-xs">{e.sourceRefs.slice(0, 4).map((id) => { const s = sourceOf(id); return s?.path ? <SourceLink key={id} projectId={projectId} cite={`${s.path}:${s.startLine}-${s.endLine}`} /> : null; })}</div>
              )}
            </li>
          )) ?? <li className="text-muted">Loading transcript…</li>}
        </ol>
      </div>
    </div>
  );
}

const DOWNLOADS: { key: string; label: string }[] = [
  { key: "video", label: "Video (MP4)" },
  { key: "captionsVtt", label: "Captions (WebVTT)" },
  { key: "captionsSrt", label: "Captions (SRT)" },
  { key: "transcript", label: "Transcript (JSON)" },
  { key: "audio", label: "Narration (WAV)" },
  { key: "manifest", label: "Artifact manifest (JSON)" },
];

export function VideoDownloads({ job }: { job: JobView }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {DOWNLOADS.filter((d) => typeof job.urls[d.key] === "string").map((d) => <a key={d.key} className="btn py-0.5 text-xs" href={`${job.urls[d.key]}?download=1`} download data-testid={`dl-explainer-${d.key}`}><Icon name="download" size={13} />{d.label}</a>)}
    </div>
  );
}
