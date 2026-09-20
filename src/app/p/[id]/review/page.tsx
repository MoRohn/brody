"use client";
import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { DownloadMenu } from "@/components/download";
import { Chip, Empty, ErrorBox, Loading, OriginBadge, SeverityBadge, SourceLink } from "@/components/ui";
import { useApi } from "@/lib/client";
import type { FindingRow } from "@/lib/db/schema";

type Finding = Omit<FindingRow, "projectId">;
interface Resp { total: number; facets: Record<string, Record<string, number>>; findings: Finding[] }
const SEV = ["Critical", "High", "Medium", "Low", "Informational"];

function Diff({ patch }: { patch: string }) {
  return (
    <pre tabIndex={0} className="max-h-72">{patch.split("\n").map((l, i) => (
      <div key={i} style={{ color: l.startsWith("+") && !l.startsWith("+++") ? "var(--ok)" : l.startsWith("-") && !l.startsWith("---") ? "var(--crit)" : l.startsWith("@@") ? "var(--accent)" : undefined }}>{l || " "}</div>
    ))}</pre>
  );
}

function Facet({ title, name, values, selected, onToggle }: { title: string; name: string; values: Record<string, number>; selected: string[]; onToggle: (name: string, v: string) => void }) {
  const entries = Object.entries(values).sort((a, b) => (name === "severity" ? SEV.indexOf(a[0]) - SEV.indexOf(b[0]) : b[1] - a[1]));
  if (!entries.length) return null;
  return (
    <fieldset className="mb-3">
      <legend className="h-label mb-1">{title}</legend>
      {entries.map(([v, n]) => (
        <label key={v} className="flex cursor-pointer items-center gap-2 py-0.5 text-[13px]">
          <input type="checkbox" checked={selected.includes(v)} onChange={() => onToggle(name, v)} />
          <span className="min-w-0 flex-1 truncate">{name === "origin" ? (v === "static" ? "Static analyzer" : "AI-inferred") : name === "verification" ? (v === "verified" ? "Verified" : "Needs verification") : v}</span>
          <span className="tabular-nums text-muted">{n}</span>
        </label>
      ))}
    </fieldset>
  );
}

export default function ReviewPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [q, setQ] = useState(sp.get("q") ?? "");
  const [showFilters, setShowFilters] = useState(false);
  const filters = useMemo(() => {
    const f: Record<string, string[]> = {};
    for (const k of ["severity", "category", "origin", "verification", "area", "confidence"]) f[k] = (sp.get(k) ?? "").split(",").filter(Boolean);
    return f;
  }, [sp]);
  const query = useMemo(() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v.length) p.set(k, v.join(","));
    if (q.trim()) p.set("q", q.trim());
    return p.toString();
  }, [filters, q]);
  const { data, error, loading, reload } = useApi<Resp>(`/api/projects/${id}/findings?${query}`, { keepPrevious: true });
  const all = useApi<Resp>(`/api/projects/${id}/findings?limit=1`);
  const selectedId = sp.get("finding");
  const inList = data?.findings.find((f) => f.id === selectedId) ?? null;
  // A deep link may point at a finding hidden by the current filters; look it up separately.
  const lookup = useApi<Resp>(selectedId && data && !inList ? `/api/projects/${id}/findings?limit=1000` : null);
  const selected: Finding | null = inList ?? lookup.data?.findings.find((f) => f.id === selectedId) ?? (selectedId ? null : (data?.findings[0] ?? null));

  const setParam = (name: string, value: string[]) => {
    const p = new URLSearchParams(sp.toString());
    if (value.length) p.set(name, value.join(",")); else p.delete(name);
    p.delete("finding");
    router.replace(`${pathname}?${p}`);
  };
  const toggle = (name: string, v: string) => setParam(name, filters[name].includes(v) ? filters[name].filter((x) => x !== v) : [...filters[name], v]);
  const choose = (f: Finding) => { const p = new URLSearchParams(sp.toString()); p.set("finding", f.id); router.replace(`${pathname}?${p}`, { scroll: false }); };
  const active = Object.values(filters).some((v) => v.length) || q.trim();

  if (loading && !data) return <Loading label="Loading findings" />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const facets = all.data?.facets ?? data?.facets ?? {};

  return (
    <div className="flex flex-col lg:h-full lg:min-h-0 lg:flex-row">
      <aside className="flex-none border-b border-line bg-panel p-3 lg:w-[220px] lg:overflow-auto lg:border-b-0 lg:border-r" aria-label="Finding filters">
        <div className="flex gap-2"><input className="input mb-3 lg:mb-3" placeholder="Filter findings…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter findings by text" /><button className="btn mb-3 lg:hidden" aria-expanded={showFilters} onClick={() => setShowFilters(!showFilters)}>Filters{active ? " •" : ""}</button></div>
        <div className={showFilters ? "block" : "hidden lg:block"}>
        <Facet title="Severity" name="severity" values={facets.severity ?? {}} selected={filters.severity} onToggle={toggle} />
        <Facet title="Category" name="category" values={facets.category ?? {}} selected={filters.category} onToggle={toggle} />
        <Facet title="Source" name="origin" values={facets.origin ?? {}} selected={filters.origin} onToggle={toggle} />
        <Facet title="Status" name="verification" values={facets.verification ?? {}} selected={filters.verification} onToggle={toggle} />
        <Facet title="Confidence" name="confidence" values={facets.confidence ?? {}} selected={filters.confidence} onToggle={toggle} />
        <Facet title="Functional area" name="area" values={facets.area ?? {}} selected={filters.area} onToggle={toggle} />
        {active && <button className="btn w-full" onClick={() => { setQ(""); router.replace(pathname); }}>Clear filters</button>}
        </div>
      </aside>
      <section className="max-h-[55vh] w-full flex-none overflow-auto border-b border-line lg:max-h-none lg:w-[42%] lg:min-w-[300px] lg:border-b-0 lg:border-r" aria-label="Findings list">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-line bg-panel px-3 py-1.5 text-[13px]"><span><strong>{data?.total ?? 0}</strong> finding{data?.total === 1 ? "" : "s"}{active ? " match the filters" : ""}</span><DownloadMenu projectId={id} scope="review" label="Review report" small align="left" /></div>
        {!data?.findings.length ? <Empty title={active ? "No findings match these filters" : "No findings"}>{active ? "Clear a filter to see more." : "The analyzers found nothing to report."}</Empty> : (
          <ul>
            {data.findings.map((f) => (
              <li key={f.id}>
                <button onClick={() => choose(f)} aria-current={selected?.id === f.id} className="block w-full border-b border-line px-3 py-2 text-left hover:bg-panel2" style={selected?.id === f.id ? { background: "var(--accent-soft)" } : undefined}>
                  <div className="flex items-center gap-2"><span className="mono text-xs text-muted">{f.code}</span><SeverityBadge severity={f.severity} /><span className="text-xs text-muted">{f.category}</span></div>
                  <div className="mt-0.5 font-medium">{f.title}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted"><span className="mono truncate">{f.filePath ?? "repository-wide"}{f.startLine ? `:${f.startLine}` : ""}</span><OriginBadge origin={f.origin} verification={f.verification} /></div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="min-w-0 flex-1 p-4 lg:overflow-auto" aria-label="Finding detail">
        {!selected ? <Empty title="Select a finding" /> : (
          <article className="max-w-[820px]">
            <div className="flex flex-wrap items-center gap-2"><span className="mono text-sm text-muted">{selected.code}</span><SeverityBadge severity={selected.severity} /><Chip title="How confident the finding is">Confidence: {selected.confidence}</Chip><Chip>{selected.category}</Chip><OriginBadge origin={selected.origin} verification={selected.verification} /></div>
            <h1 className="mt-2 font-serif text-xl font-bold">{selected.title}</h1>
            {selected.filePath && <div className="mt-1 text-sm"><SourceLink projectId={id} cite={`${selected.filePath}${selected.startLine ? `:${selected.startLine}${selected.endLine && selected.endLine !== selected.startLine ? `-${selected.endLine}` : ""}` : ""}`} /> {selected.area && <span className="text-muted">· {selected.area}</span>} · <Link href={`/p/${id}/map?impactFile=${encodeURIComponent(selected.filePath)}`}>Change impact</Link></div>}
            {selected.analyzer && <div className="mt-1 text-xs text-muted">Produced by <span className="mono">{selected.analyzer}</span>{selected.origin === "static" ? " (deterministic analysis)" : " (AI judgement, checked against the source)"}</div>}
            {selected.evidence && <><div className="h-label mb-1 mt-4">Evidence</div><pre tabIndex={0}>{selected.evidence}</pre></>}
            <div className="h-label mb-1 mt-4">What happens</div><p>{selected.whatHappens}</p>
            <div className="h-label mb-1 mt-3">Why it matters</div><p>{selected.whyItMatters}</p>
            {selected.businessImpact && <><div className="h-label mb-1 mt-3">Business impact</div><p>{selected.businessImpact}</p></>}
            <div className="h-label mb-1 mt-3">Recommended remediation</div><p>{selected.remediation}</p>
            {selected.patch && <><div className="h-label mb-1 mt-3">Suggested patch <span className="normal-case tracking-normal text-muted">(applies cleanly to the current file)</span></div><Diff patch={selected.patch} /></>}
            {selected.relatedComponents.length > 0 && <><div className="h-label mb-1 mt-3">Related components</div><div className="flex flex-wrap gap-1">{selected.relatedComponents.map((c) => <Chip key={c}><span className="mono">{c}</span></Chip>)}</div></>}
            {selected.verificationNote && <><div className="h-label mb-1 mt-3">How this was verified</div><p className="text-[13px] text-muted">{selected.verificationNote}</p></>}
          </article>
        )}
      </section>
    </div>
  );
}
