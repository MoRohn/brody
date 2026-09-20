"use client";
import { useParams } from "next/navigation";
import { FormatRow } from "@/components/download";
import { SCOPES, type ReportScope } from "@/lib/export/scopes";

const ORDER: ReportScope[] = ["full", "complete", "review", "explain", "architecture", "map", "ask"];
const FOR: Record<ReportScope, ("pdf" | "docx" | "md" | "html" | "json" | "print" | "bundle")[]> = {
  full: ["pdf", "docx", "md", "html", "json", "bundle"],
  complete: ["pdf", "docx", "md", "html"],
  review: ["pdf", "docx", "md", "html"],
  explain: ["pdf", "docx", "md", "html"],
  architecture: ["pdf", "docx", "md", "html"],
  map: ["pdf", "docx", "md", "html"],
  ask: ["pdf", "docx", "md", "html"],
};

export default function ReportsPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <div className="mx-auto max-w-[1000px] p-5">
      <h1 className="font-serif text-2xl font-bold">Reports and downloads</h1>
      <p className="mt-1 max-w-[70ch] text-muted">Every result can be viewed in the browser or downloaded as PDF, Word or Markdown. Reports are generated on demand from the latest analysis, so they always match what you see in the app and include the same evidence as file and line references.</p>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {ORDER.map((scope) => (
          <section key={scope} className="card p-4" aria-labelledby={`r-${scope}`}>
            <h2 id={`r-${scope}`} className="text-[15px] font-semibold">{SCOPES[scope].title}</h2>
            <p className="mb-2 text-[13px] text-muted">{SCOPES[scope].description}</p>
            <div className="divide-y divide-line">
              {FOR[scope].map((f) => <FormatRow key={f} projectId={id} scope={scope} format={f} />)}
            </div>
          </section>
        ))}
      </div>
      <p className="mt-4 text-xs text-muted">The PDF has a cover, a contents list with page numbers, bookmarks and page footers. The Word file uses real heading styles, tables and lists, so it can be restyled or converted. The Markdown file is the source for both.</p>
    </div>
  );
}
