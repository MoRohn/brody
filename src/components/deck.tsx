"use client";
import { useState } from "react";
import { saveReport } from "./download";
import { Icon } from "./Icon";

export type DeckFormat = "pptx" | "pdf" | "html";

export const DECK_FORMAT_INFO: Record<DeckFormat, { label: string; ext: string; hint: string; view: boolean }> = {
  pptx: { label: "PowerPoint", ext: ".pptx", hint: "Editable slides with speaker notes and real tables", view: false },
  pdf: { label: "PDF", ext: ".pdf", hint: "One slide per page, ready to send or print", view: true },
  html: { label: "Web page", ext: ".html", hint: "Present it in a browser: arrow keys, full screen, overview", view: true },
};

export const deckUrl = (projectId: string, format: DeckFormat, inline = false) => `/api/projects/${projectId}/deck?format=${format}${inline ? "&download=0" : ""}`;

/** One row per deck format, in the same style as the report's download rows. */
export function DeckFormatRow({ projectId, format }: { projectId: string; format: DeckFormat }) {
  const info = DECK_FORMAT_INFO[format];
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");
  const [err, setErr] = useState("");
  const go = async () => {
    setState("busy"); setErr("");
    try { await saveReport(deckUrl(projectId, format), `executive-summary${info.ext}`); setState("idle"); } catch (e) { setErr((e as Error).message); setState("error"); }
  };
  return (
    <div className="flex items-center gap-2 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{info.label} <span className="mono text-xs font-normal text-muted">{info.ext}</span></div>
        <div className="text-xs text-muted">{info.hint}</div>
        {state === "error" && <div role="alert" className="text-xs" style={{ color: "var(--crit)" }}>{err}</div>}
      </div>
      {info.view && <a data-testid={`view-deck-${format}`} className="btn py-0.5 text-xs" href={deckUrl(projectId, format, true)} target="_blank" rel="noreferrer">View</a>}
      <button data-testid={`dl-deck-${format}`} className="btn btn-primary py-0.5 text-xs" onClick={go} disabled={state === "busy"} aria-busy={state === "busy"} aria-label={`Download the executive deck as ${info.label}`}>
        <Icon name="download" size={14} /> {state === "busy" ? "Preparing" : "Download"}
      </button>
    </div>
  );
}
