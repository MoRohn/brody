"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { DECK_FORMAT_INFO, DeckFormatRow, deckUrl, type DeckFormat } from "@/components/deck";

const FORMATS: DeckFormat[] = ["pptx", "pdf", "html"];

export default function DeckPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <div className="mx-auto flex max-w-[1240px] flex-col gap-4 p-5 lg:flex-row">
      <div className="min-w-0 flex-1">
        <h1 className="font-serif text-2xl font-bold">Executive summary deck</h1>
        <p className="mt-1 max-w-[70ch] text-muted">A 13-slide briefing for leaders, built from the same analysis as the report: what the system does, how it is built, where the risk is, and what to do next. Each slide names the report section that holds the detail.</p>
        <div className="card mt-3 overflow-hidden" style={{ background: "var(--panel2)" }}>
          <iframe title="Executive summary deck preview" src={deckUrl(id, "html", true)} className="block h-[68vh] min-h-[420px] w-full border-0" data-testid="deck-preview" />
        </div>
        <p className="mt-2 text-xs text-muted">Use the arrow keys to move between slides, O for the overview and F for full screen.</p>
      </div>
      <aside className="w-full flex-none lg:w-[330px]" aria-label="Deck downloads">
        <section className="card p-4">
          <h2 className="text-[15px] font-semibold">Download</h2>
          <p className="mb-2 text-[13px] text-muted">The same slides in three formats. All three are drawn from one layout, so they look alike.</p>
          <div className="divide-y divide-line">{FORMATS.map((f) => <DeckFormatRow key={f} projectId={id} format={f} />)}</div>
        </section>
        <section className="card mt-3 p-4 text-[13px] text-muted">
          <h2 className="mb-1 text-[15px] font-semibold text-fg">Connected to the report</h2>
          Numbers, finding references (such as SEC-001) and section names are the ones used in the <Link href={`/p/${id}/reports`}>Repository Intelligence Report</Link>, so the deck and the report can be read side by side. The last slide maps every slide to its report section.
        </section>
        <p className="mt-3 text-xs text-muted">{FORMATS.map((f) => DECK_FORMAT_INFO[f].label).join(", ")}.</p>
      </aside>
    </div>
  );
}
