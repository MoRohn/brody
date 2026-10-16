"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { DeckFormatRow, deckUrl } from "@/components/deck";
import { Icon } from "@/components/Icon";
import { useApi } from "@/lib/client";
import type { DeckOutline } from "@/lib/deck";

/** The executive deck: a live presenter, the slide list (which follows the presenter), and the downloads. */
export default function DeckPage() {
  const { id } = useParams<{ id: string }>();
  // The project's own branding is used when its repository has some; this switch draws the deck in Brody's style instead.
  const [brand, setBrand] = useState(true);
  const { data } = useApi<DeckOutline>(deckUrl(id, "outline", false, brand));
  const frame = useRef<HTMLIFrameElement>(null);
  const [current, setCurrent] = useState(0);

  // The presenter inside the frame reports which slide it is showing.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const m = (e.data as { brodyDeck?: { index: number } } | null)?.brodyDeck;
      if (m && Number.isInteger(m.index)) setCurrent(m.index);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  const go = (n: number) => { if (frame.current) frame.current.src = `${deckUrl(id, "html", true, brand)}#s${n}`; setCurrent(n - 1); };

  return (
    <div className="mx-auto max-w-[1320px] p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="h-label">Leadership briefing</div>
          <h1 className="font-serif text-[28px] font-bold leading-tight text-deep">Executive summary deck</h1>
          <p className="mt-1 max-w-[68ch] text-muted">{data ? `${data.slides.length} slides` : "A briefing"} built from the same analysis as the report: the bottom line, a health scorecard, how the system is built, where the risk is and what to do next. Each slide names the report section behind it.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <a className="btn btn-primary" href={deckUrl(id, "pptx", false, brand)} data-testid="deck-hero-pptx"><Icon name="download" size={15} /> PowerPoint</a>
          <a className="btn" href={deckUrl(id, "pdf", false, brand)}><Icon name="download" size={15} /> PDF</a>
          <a className="btn" href={deckUrl(id, "html", true, brand)} target="_blank" rel="noreferrer">Open full page</a>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_330px]">
        <div className="min-w-0">
          <div className="overflow-hidden rounded-2xl border border-line shadow-[0_18px_50px_-24px_rgba(11,36,54,0.55)]" style={{ background: "#0b2436" }}>
            <iframe ref={frame} title="Executive summary deck preview" src={deckUrl(id, "html", true, brand)} className="block h-[72vh] min-h-[460px] w-full border-0" data-testid="deck-preview" allow="fullscreen" />
          </div>
          <p className="mt-2 text-xs text-muted">Arrow keys move between slides · O overview · N speaker notes · F full screen</p>
        </div>

        <aside className="flex min-w-0 flex-col gap-3" aria-label="Deck contents and downloads">
          <section className="card overflow-hidden">
            <h2 className="border-b border-line px-4 py-2.5 text-[15px] font-semibold">In this deck</h2>
            <ol className="max-h-[46vh] overflow-auto py-1" data-testid="deck-outline">
              {(data?.slides ?? []).map((s) => (
                <li key={s.id}>
                  <button className={`flex w-full items-start gap-2.5 px-4 py-1.5 text-left transition-colors hover:bg-panel2 ${current === s.n - 1 ? "bg-panel2" : ""}`} aria-current={current === s.n - 1 ? "step" : undefined} onClick={() => go(s.n)}>
                    <span className="mono mt-0.5 w-5 flex-none text-right text-xs text-muted">{s.n}</span>
                    <span className="min-w-0"><span className={`block truncate text-[13px] ${current === s.n - 1 ? "font-semibold text-deep" : ""}`}>{s.title}</span>{s.ref && <span className="block truncate text-[11px] text-muted">Report {s.ref}</span>}</span>
                  </button>
                </li>
              ))}
              {!data && <li className="px-4 py-3 text-[13px] text-muted">Loading the slide list…</li>}
            </ol>
          </section>
          <section className="card p-4">
            <h2 className="text-[15px] font-semibold">Download</h2>
            <div className="mt-1 divide-y divide-line">{(["pptx", "pdf", "html"] as const).map((f) => <DeckFormatRow key={f} projectId={id} format={f} brand={brand} />)}</div>
          </section>
          {data && <BrandingCard outline={data} brand={brand} onChange={setBrand} />}
          <section className="card p-4 text-[13px] text-muted">
            <h2 className="mb-1 text-[15px] font-semibold text-fg">Connected to the report</h2>
            Figures, finding references (such as SEC-001) and section names are the ones in the <Link href={`/p/${id}/reports`}>Repository Intelligence Report</Link>, so the two can be read side by side.
          </section>
        </aside>
      </div>
    </div>
  );
}

/** What branding the repository supplied, where it came from, and the switch between it and Brody's style. */
function BrandingCard({ outline, brand, onChange }: { outline: DeckOutline; brand: boolean; onChange: (on: boolean) => void }) {
  const b = outline.brand;
  if (!b) {
    return (
      <section className="card p-4 text-[13px] text-muted" data-testid="deck-branding">
        <h2 className="mb-1 text-[15px] font-semibold text-fg">Branding</h2>
        No logo, brand colours or screenshots were found in the repository, so the deck uses Brody&rsquo;s style. A logo file (such as <span className="mono">public/logo.svg</span>), a <span className="mono">--primary</span> or <span className="mono">--brand</span> colour, or screenshots under <span className="mono">docs/screenshots/</span> are picked up on the next analysis.
      </section>
    );
  }
  const found = [b.logo ? "logo" : "", b.colors.length ? (b.colors.length > 1 ? "colours" : "colour") : "", b.screens ? `${b.screens} screenshot${b.screens > 1 ? "s" : ""}` : ""].filter(Boolean);
  return (
    <section className="card p-4 text-[13px]" data-testid="deck-branding">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold">Branding</h2>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
          <input type="checkbox" role="switch" checked={brand} onChange={(e) => onChange(e.target.checked)} aria-label="Use the project's own branding in the deck" data-testid="deck-brand-switch" />
          Project&rsquo;s own
        </label>
      </div>
      <p className="mt-1 text-muted">{brand ? `The deck uses the project's ${found.join(", ").replace(/, ([^,]*)$/, " and $1")} from its repository.` : "The deck uses Brody's style. Switch on to use the project's own branding."}</p>
      {b.colors.length > 0 && (
        <div className="mt-2 flex items-center gap-1.5" aria-label="Brand colours">
          {b.colors.map((c) => <span key={c} className="inline-block h-5 w-5 rounded-md border border-line" style={{ background: c }} title={c} />)}
          <span className="mono text-xs text-muted">{b.colors.join(" · ")}</span>
        </div>
      )}
      <ul className="mt-2 space-y-0.5">{b.sources.slice(0, 6).map((p) => <li key={p} className="mono truncate text-xs text-muted" title={p}>{p}</li>)}</ul>
    </section>
  );
}
