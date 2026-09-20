"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { BriefView } from "@/components/brief";
import { DownloadMenu } from "@/components/download";
import { Chip, Empty, ErrorBox, Evidence, Loading, SourceLink, Spinner } from "@/components/ui";
import { api, ApiError, useApi } from "@/lib/client";
import type { Architecture } from "@/lib/discover/types";
import type { AreaDoc, DocReport, DocSection, FileDoc, ModuleDoc, Statement, SymbolDoc } from "@/lib/docs/types";

function Origin({ o }: { o: string }) {
  return <span className="ml-1 align-middle text-[10px] uppercase tracking-wide text-muted" title={o === "ai" ? "Written by an AI model from indexed evidence" : "Assembled deterministically from the repository graph"}>{o === "ai" ? "AI" : "graph"}</span>;
}

function Statements({ id, items }: { id: string; items: Statement[] }) {
  return <div className="prose-doc">{items.map((s, i) => <p key={i}>{s.text}<Evidence projectId={id} items={s.evidence} /><Origin o={s.origin} /></p>)}</div>;
}

function Section({ id, anchor, title, children }: { id?: string; anchor: string; title: string; children: React.ReactNode }) {
  void id;
  return (
    <section id={anchor} className="scroll-mt-4 border-t border-line pt-5 first:border-t-0">
      <h2 className="mb-2 font-serif text-xl font-bold">{title}</h2>
      {children}
    </section>
  );
}

function DocSectionView({ id, sec }: { id: string; sec: DocSection }) {
  return <><Statements id={id} items={sec.paragraphs} />{sec.bullets && sec.bullets.length > 0 && <ul className="prose-doc list-disc pl-5">{sec.bullets.map((b, i) => <li key={i} className="mb-1">{b.text}<Evidence projectId={id} items={b.evidence} /></li>)}</ul>}</>;
}

function SymbolExplain({ id, s }: { id: string; s: SymbolDoc }) {
  return (
    <details className="card mb-1.5">
      <summary className="cursor-pointer px-3 py-1.5"><code>{s.name}</code> <span className="text-xs text-muted">{s.kind} · {s.path}:{s.startLine}-{s.endLine}</span><Origin o={s.origin} /></summary>
      <div className="space-y-1.5 border-t border-line p-3 text-[13px]">
        <div className="mono text-xs text-muted">{s.signature}</div>
        <p><SourceLink projectId={id} cite={`${s.path}:${s.startLine}-${s.endLine}`}>Open in the code explorer</SourceLink></p>
        <p><strong>Purpose.</strong> {s.purpose}</p>
        <p><strong>Inputs.</strong> {s.inputs}</p>
        <p><strong>Process.</strong> {s.process}</p>
        <p><strong>Outputs.</strong> {s.outputs}</p>
        <p><strong>Dependencies.</strong> {s.dependencies.join(", ") || "none indexed"}</p>
        <p><strong>Used by.</strong> {s.usedBy.join(", ") || "no known call sites"}</p>
        {s.businessMeaning && <p><strong>Business meaning.</strong> {s.businessMeaning}</p>}
        <p><strong>Important behavior.</strong> {s.importantBehavior}</p>
      </div>
    </details>
  );
}


type Scale = "system" | "collections" | "files" | "symbols";
const SCALES: { id: Scale; label: string; hint: string }[] = [
  { id: "system", label: "Whole system", hint: "What the product does and how it is built, end to end." },
  { id: "collections", label: "Groups of files", hint: "Functional areas and folders: how several files work together as one unit." },
  { id: "files", label: "Single files", hint: "One file at a time: what it does, what it uses and who uses it." },
  { id: "symbols", label: "Symbols", hint: "Individual functions, classes and endpoints." },
];
const SYSTEM_TOC: [string, string][] = [["exec", "Executive summary"], ["summary-evidence", "Summary evidence"], ["glance", "System at a glance"], ["arch", "Architecture overview"], ["runtime", "Primary runtime flow"], ["flows", "Data flow"], ["api", "API architecture"], ["data", "Data architecture"], ["integrations", "External integrations"], ["infra", "Infrastructure"], ["testing", "Testing strategy"], ["security", "Security model"], ["risks", "Engineering risks"], ["recs", "Recommendations"]];

interface FileRowData { path: string; role: string; lines?: number; purpose: string; note?: string }

/** The files inside a group, each with its own one-line explanation and a way down to the single-file view. */
function FilesTable({ files, onOpenFile }: { files: FileRowData[]; onOpenFile: (path: string) => void }) {
  return (
    <div className="card overflow-x-auto">
      <table className="tbl">
        <thead><tr><th>File</th><th>Role</th>{files.some((f) => f.lines !== undefined) && <th className="text-right">Lines</th>}<th>What this file does on its own</th></tr></thead>
        <tbody>
          {files.map((f) => (
            <tr key={f.path}>
              <td className="align-top"><button className="mono text-left text-[12px] underline underline-offset-2" style={{ color: "var(--link)" }} onClick={() => onOpenFile(f.path)} title="Open the single-file explanation">{f.path}</button>{f.note && <div className="mt-0.5 text-[11px] text-muted">{f.note}</div>}</td>
              <td className="align-top text-muted">{f.role}</td>
              {files.some((x) => x.lines !== undefined) && <td className="align-top text-right tabular-nums">{f.lines?.toLocaleString() ?? ""}</td>}
              <td className="align-top">{f.purpose.length > 200 ? `${f.purpose.slice(0, 197)}…` : f.purpose}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Facts({ rows }: { rows: [string, React.ReactNode][] }) {
  return <div className="card overflow-hidden"><table className="tbl"><tbody>{rows.map(([k, v]) => <tr key={k}><td className="w-[170px] font-medium text-muted">{k}</td><td>{v}</td></tr>)}</tbody></table></div>;
}

/** The macro explanation of a folder or a hand-picked group of files. */
function CollectionBody({ id, c, docs, go }: { id: string; c: ModuleDoc; docs: DocReport; go: (n: { scale?: Scale; item?: string | null }) => void }) {
  const hubNotes = new Map(c.keyFiles.map((k) => [k.path, k.why]));
  const modules = docs.modules ?? [];
  const parent = c.parent ? modules.find((m) => m.path === c.parent) : undefined;
  const children = modules.filter((m) => c.children.includes(m.path));
  return (
    <div className="space-y-4">
      <div className="card p-4">
        <div className="h-label">What this group is for</div>
        <p className="prose-doc mt-1">{c.purpose}<Origin o={c.origin} /></p>
        <div className="h-label mt-4">How the files work together</div>
        <p className="prose-doc mt-1">{c.howFilesWork}</p>
        {c.evidence.length > 0 && <div className="mt-1 text-xs text-muted">Evidence: {c.evidence.map((e, i) => <span key={e}>{i > 0 && ", "}<SourceLink projectId={id} cite={e} /></span>)}</div>}
      </div>

      {c.internalLinks.length > 0 && (
        <div className="card p-3">
          <div className="h-label mb-1.5">Connections between these files</div>
          <ul className="mono space-y-0.5 text-[12px]">{c.internalLinks.map((l, i) => <li key={i}>{l.from.split("/").pop()} <span className="text-muted" aria-hidden>→</span><span className="sr-only"> imports </span> {l.to.split("/").pop()}</li>)}</ul>
        </div>
      )}

      <div>
        <div className="h-label mb-1.5">Files in this group ({c.fileCount})</div>
        <FilesTable files={c.files.map((f) => ({ ...f, note: hubNotes.get(f.path) }))} onOpenFile={(p) => go({ scale: "files", item: `file:${p}` })} />
      </div>

      <Facts rows={[
        ["Used from outside via", c.publicSurface.length ? <span className="space-x-2">{c.publicSurface.slice(0, 8).map((p) => <span key={p.name + p.path}><SourceLink projectId={id} cite={`${p.path}:${p.line}`}>{p.name}</SourceLink> <span className="text-xs text-muted">{p.kind}, {p.usedBy} caller file{p.usedBy === 1 ? "" : "s"}</span></span>)}</span> : "No symbol here is used by code outside the group."],
        ["Depends on", [...c.dependsOn, ...c.externalPackages].join(", ") || "nothing outside the group"],
        ["Used by", c.usedBy.join(", ") || "no other folder"],
        ["Data in", c.dataIn], ["Data out", c.dataOut],
        ["Functional areas", c.areas.length ? <span className="space-x-2">{c.areas.map((a) => { const ar = docs.areas.find((x) => x.name === a); return ar ? <button key={a} className="underline underline-offset-2" style={{ color: "var(--link)" }} onClick={() => go({ scale: "collections", item: `area:${ar.id}` })}>{a}</button> : <span key={a}>{a}</span>; })}</span> : "none assigned"],
        ["Review findings", c.findings.total ? <span>{c.findings.total} open: {Object.entries(c.findings.bySeverity).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(", ")}. <Link href={`/p/${id}/review`}>Open the review</Link></span> : "none"],
        ["Tests", c.tests.length ? c.tests.join(", ") : "no test file imports these files"],
        ...(parent ? [["Inside", <button key="p" className="mono underline underline-offset-2" style={{ color: "var(--link)" }} onClick={() => go({ item: `mod:${parent.path}` })}>{parent.path}/</button>] as [string, React.ReactNode]] : []),
        ...(children.length ? [["Contains folders", <span key="c" className="space-x-2">{children.map((m) => <button key={m.path} className="mono underline underline-offset-2" style={{ color: "var(--link)" }} onClick={() => go({ item: `mod:${m.path}` })}>{m.path}/</button>)}</span>] as [string, React.ReactNode]] : []),
      ]} />
    </div>
  );
}

/** A functional area: a capability delivered by several files. Same macro view, area-specific facts. */
function AreaDetail({ id, a, docs, go }: { id: string; a: AreaDoc; docs: DocReport; go: (n: { scale?: Scale; item?: string | null }) => void }) {
  const fileDocs = docs.files.filter((f) => a.files.includes(f.path));
  return (
    <div className="space-y-4">
      <div className="card p-4">
        <div className="h-label">What this area is for</div>
        <p className="prose-doc mt-1">{a.purpose}<Origin o={a.origin} /></p>
        <div className="h-label mt-4">Business function</div>
        <p className="prose-doc mt-1">{a.businessFunction}</p>
      </div>
      <Facts rows={[
        ["Primary components", a.components.length ? <span className="space-x-2">{a.components.slice(0, 8).map((c) => <span key={c.name + c.path}><SourceLink projectId={id} cite={`${c.path}:${c.line}`}>{c.name}</SourceLink> <span className="text-xs text-muted">{c.kind}</span></span>)}</span> : "none extracted"],
        ["Inputs", a.inputs], ["Processing", a.processing], ["Outputs", a.outputs],
        ["Dependencies", a.dependencies.join(", ") || "none"],
        ["Failure modes", a.failureModes.length ? <ul className="list-disc pl-4">{a.failureModes.map((f, i) => <li key={i}>{f}</li>)}</ul> : "none identified"],
        ["Important relationships", a.relationships],
      ]} />
      <div>
        <div className="h-label mb-1.5">Files in this area ({a.files.length})</div>
        {fileDocs.length > 0 ? <FilesTable files={fileDocs.map((f) => ({ path: f.path, role: f.role, purpose: f.purpose }))} onOpenFile={(p) => go({ scale: "files", item: `file:${p}` })} /> : <p className="text-sm text-muted">{a.files.length} files, none with an individual explanation.</p>}
      </div>
      <div className="text-xs text-muted">Evidence: {a.evidence.map((e, i) => <span key={e}>{i > 0 && ", "}<SourceLink projectId={id} cite={e} /></span>)}</div>
    </div>
  );
}

/** One file on its own, with where it sits in the larger structure. */
function FileDetail({ id, f, docs, go }: { id: string; f: FileDoc; docs: DocReport; go: (n: { scale?: Scale; item?: string | null }) => void }) {
  const area = docs.areas.find((a) => a.name === f.area);
  const folder = (docs.modules ?? []).filter((m) => f.path.startsWith(`${m.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
  return (
    <div className="space-y-4">
      <div className="card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mono text-[15px] font-bold" style={{ color: "var(--deep)" }}>{f.path}</h2>
          <Chip tone="info">{f.role}</Chip><Origin o={f.origin} />
        </div>
        <div className="mt-1 text-sm text-muted">
          Part of{folder ? <> the folder <button className="mono underline underline-offset-2" style={{ color: "var(--link)" }} onClick={() => go({ scale: "collections", item: `mod:${folder.path}` })}>{folder.path}/</button></> : " the repository root"}
          {area && <> and the <button className="underline underline-offset-2" style={{ color: "var(--link)" }} onClick={() => go({ scale: "collections", item: `area:${area.id}` })}>{area.name}</button> area</>}
          . <SourceLink projectId={id} cite={f.path}>Open in the code explorer</SourceLink>
        </div>
        <div className="h-label mt-4">What this file does</div>
        <p className="prose-doc mt-1">{f.purpose}</p>
      </div>
      <Facts rows={[
        ["Responsibilities", f.responsibilities.length ? <ul className="list-disc pl-4">{f.responsibilities.map((r, i) => <li key={i}>{r}</li>)}</ul> : "none listed"],
        ["Key symbols", f.keySymbols.length ? <span className="space-x-1">{f.keySymbols.map((k) => <code key={k}>{k}</code>)}</span> : "none"],
        ["How it operates", f.howItOperates],
        ["Called by", f.calledBy.length ? <span className="space-x-2">{f.calledBy.map((c) => <SourceLink key={c} projectId={id} cite={c} />)}</span> : "no indexed importers"],
        ["Depends on", f.dependsOn.join(", ") || "nothing indexed"],
        ["Data in", f.dataIn], ["Data out", f.dataOut],
        ...(f.engineeringNotes.length ? [["Engineering notes", f.engineeringNotes.join(" ")] as [string, React.ReactNode]] : []),
      ]} />
    </div>
  );
}

/** Explain any set of files or folders together, on demand. The structure is instant; the narrative can be written by the AI. */
function CustomGroup({ id, docs, aiAvailable, go }: { id: string; docs: DocReport; aiAvailable: boolean; go: (n: { scale?: Scale; item?: string | null }) => void }) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState<"plain" | "ai" | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [result, setResult] = useState<{ collection: ModuleDoc; ai: { requested: boolean; available: boolean; used: boolean; error?: { summary: string; hint: string } } } | null>(null);
  const shown = docs.files.filter((f) => !q || f.path.toLowerCase().includes(q.toLowerCase())).slice(0, 200);
  const toggle = (p: string) => setPicked((s) => (s.includes(p) ? s.filter((x) => x !== p) : [...s, p]));
  const run = async (ai: boolean) => {
    setBusy(ai ? "ai" : "plain"); setErr(null);
    try { setResult(await api(`/api/projects/${id}/explain`, { method: "POST", body: JSON.stringify({ paths: picked, ai }) })); } catch (e) { setErr(e as ApiError); }
    setBusy(null);
  };
  return (
    <div className="space-y-4">
      <div className="card p-4">
        <h2 className="font-serif text-xl font-bold">Explain your own group of files</h2>
        <p className="mt-1 text-sm text-muted">Pick any files, or type a folder such as <code>src/services</code>, and Brody explains them together: how they work as one unit, what depends on them and what they need.</p>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div>
            <label className="text-xs text-muted" htmlFor="grp-filter">Find files</label>
            <input id="grp-filter" className="input mt-0.5" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by path, for example services" />
            <div className="mt-1 flex items-center justify-between text-xs text-muted"><span>{shown.length} shown</span><button className="underline" onClick={() => setPicked((s) => [...new Set([...s, ...shown.map((f) => f.path)])].slice(0, 200))}>Select all shown</button></div>
            <ul className="mt-1 max-h-56 overflow-auto rounded-xl border border-line">{shown.map((f) => <li key={f.path}><label className="flex cursor-pointer items-center gap-2 px-2 py-1 text-[12px] hover:bg-panel2"><input type="checkbox" checked={picked.includes(f.path)} onChange={() => toggle(f.path)} /><span className="mono truncate">{f.path}</span></label></li>)}</ul>
            <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); const t = typed.trim(); if (t) { setPicked((s) => (s.includes(t) ? s : [...s, t])); setTyped(""); } }}>
              <input className="input" aria-label="Add a folder or file path" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Add a folder or file path" />
              <button className="btn" type="submit">Add</button>
            </form>
          </div>
          <div>
            <div className="h-label">Selected ({picked.length})</div>
            <div className="mt-1 flex max-h-56 flex-wrap gap-1.5 overflow-auto">{picked.length === 0 ? <span className="text-sm text-muted">Nothing selected yet.</span> : picked.map((p) => <button key={p} className="chip mono" style={{ color: "var(--fg2)" }} onClick={() => toggle(p)} title="Remove" aria-label={`Remove ${p}`}>{p} ×</button>)}</div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button className="btn btn-primary" disabled={picked.length === 0 || busy !== null} aria-busy={busy === "plain"} onClick={() => run(false)}>{busy === "plain" ? "Explaining…" : "Explain together"}</button>
              <button className="btn" disabled={picked.length === 0 || busy !== null || !aiAvailable} aria-busy={busy === "ai"} onClick={() => run(true)} title={aiAvailable ? "Have the AI write the explanation from the file summaries" : "Configure an AI provider in AI settings to enable this"}>{busy === "ai" ? "Writing with AI…" : "Explain with AI"}</button>
              {picked.length > 0 && <button className="btn" onClick={() => { setPicked([]); setResult(null); }}>Clear</button>}
            </div>
            {err && <div role="alert" className="mt-2 text-sm" style={{ color: "var(--crit)" }}>{err.message}{err.hint && <div className="text-muted">{err.hint}</div>}</div>}
          </div>
        </div>
      </div>
      {busy === "ai" && <div role="status" className="flex items-center gap-2 text-sm text-muted"><Spinner className="text-accent" />The AI is reading the file summaries and dependency graph…</div>}
      {result && (
        <>
          {result.ai.requested && !result.ai.used && <div role="status" className="card px-3 py-2 text-sm" style={{ borderColor: "var(--med)" }}>{result.ai.available ? `The AI explanation could not be written. ${result.ai.error?.summary ?? ""} ${result.ai.error?.hint ?? ""} The structural explanation is shown.` : "No AI provider is configured, so the structural explanation is shown."}</div>}
          <h2 className="font-serif text-xl font-bold">{result.collection.title}</h2>
          <CollectionBody id={id} c={result.collection} docs={docs} go={go} />
        </>
      )}
    </div>
  );
}

function ListButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick} aria-current={active ? "true" : undefined} className={`block w-full rounded-xl px-3 py-1.5 text-left text-[13px] transition-colors ${active ? "bg-fill text-on-fill" : "hover:bg-panel2"}`}>{children}</button>;
}

export default function ExplainPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const report = useApi<{ docs: DocReport | null }>(`/api/projects/${id}/report`);
  const arch = useApi<{ architecture: Architecture | null }>(`/api/projects/${id}/architecture`);
  const status = useApi<{ ai: { available: boolean } }>("/api/status");
  const [fq, setFq] = useState("");
  const [sq, setSq] = useState("");
  const docs = report.data?.docs;
  const scaleParam = sp.get("scale");
  const scale: Scale = SCALES.some((s) => s.id === scaleParam) ? (scaleParam as Scale) : "system";
  const rawItem = sp.get("item");
  const item = rawItem?.startsWith("module:") ? `mod:${rawItem.slice(7)}` : rawItem;
  const modules = useMemo(() => docs?.modules ?? [], [docs]);
  const files = useMemo(() => (docs?.files ?? []).filter((f) => !fq || `${f.path} ${f.purpose}`.toLowerCase().includes(fq.toLowerCase())), [docs, fq]);
  const symbols = useMemo(() => (docs?.symbols ?? []).filter((s) => !sq || `${s.name} ${s.purpose}`.toLowerCase().includes(sq.toLowerCase())), [docs, sq]);
  const missingFolder = scale === "collections" && item?.startsWith("mod:") && !modules.some((m) => m.path === item.slice(4)) ? item.slice(4) : null;
  const fetched = useApi<{ collection: ModuleDoc }>(missingFolder ? `/api/projects/${id}/explain?path=${encodeURIComponent(missingFolder)}` : null);

  const go = (n: { scale?: Scale; item?: string | null }) => {
    const q = new URLSearchParams(sp.toString());
    if (n.scale) q.set("scale", n.scale);
    if (n.item === null) q.delete("item"); else if (n.item !== undefined) q.set("item", n.item); else if (n.scale && n.scale !== scale) q.delete("item");
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
    if (typeof window !== "undefined") window.scrollTo?.({ top: 0 });
  };

  if (report.loading && !docs) return <Loading label="Loading documentation" />;
  if (report.error) return <ErrorBox error={report.error} onRetry={report.reload} />;
  if (!docs) return <Empty title="No documentation was generated" />;
  const a = arch.data?.architecture;
  const aiAvailable = !!status.data?.ai.available;
  const count: Record<Scale, number | null> = { system: null, collections: docs.areas.length + modules.length, files: docs.files.length, symbols: docs.symbols.length };

  // Groups: the selected area, folder or custom builder (defaults to the first area, else the first folder).
  const selected = item ?? (docs.areas[0] ? `area:${docs.areas[0].id}` : modules[0] ? `mod:${modules[0].path}` : "custom");
  const selArea = selected.startsWith("area:") ? docs.areas.find((x) => `area:${x.id}` === selected) : undefined;
  const selModule = selected.startsWith("mod:") ? modules.find((m) => `mod:${m.path}` === selected) ?? (fetched.data?.collection && `mod:${fetched.data.collection.path}` === selected ? fetched.data.collection : undefined) : undefined;
  const minDepth = modules.length ? Math.min(...modules.map((m) => m.depth)) : 1;
  const selFile = item?.startsWith("file:") ? docs.files.find((f) => `file:${f.path}` === item) : undefined;
  const fileSel = selFile ?? files[0];

  return (
    <div className="min-w-0 p-5">
      <div className="max-w-[1100px] space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><h1 className="font-serif text-2xl font-bold">{docs.title}</h1><DownloadMenu projectId={id} scope="explain" label="Download explanation" /></div>
        {docs.meta.notes.length > 0 && <div className="card px-3 py-2 text-xs text-muted">{docs.meta.notes.slice(0, 3).map((n, i) => <div key={i}>{n}</div>)}</div>}

        <div>
          <div role="tablist" aria-label="Level of detail" className="tabs">
            {SCALES.map((s) => (
              <button key={s.id} role="tab" id={`scale-${s.id}`} aria-selected={scale === s.id} aria-controls="scale-panel" className="tab" onClick={() => go({ scale: s.id })}>
                {s.label}{count[s.id] !== null && <span className="ml-1.5 text-[11px] font-semibold opacity-80">{count[s.id]}</span>}
              </button>
            ))}
          </div>
          <p className="mt-2 text-sm text-muted">{SCALES.find((s) => s.id === scale)!.hint} {docs.meta.aiUsed ? `Written by ${docs.meta.model} where marked AI, otherwise assembled from the dependency graph.` : "Assembled from the dependency graph; no AI provider was configured."} Bracketed links open the supporting code.</p>
        </div>

        <div id="scale-panel" role="tabpanel" aria-labelledby={`scale-${scale}`} className="pt-1">
          {scale === "system" && (
            <div className="flex gap-6">
              <nav className="sticky top-2 hidden h-fit w-[170px] flex-none text-[13px] xl:block" aria-label="Sections">
                <div className="h-label mb-2">On this page</div>
                {SYSTEM_TOC.map(([k, l]) => <a key={k} href={`#${k}`} className="block py-0.5 text-fg hover:text-deep">{l}</a>)}
              </nav>
              <div className="min-w-0 max-w-[900px] flex-1 space-y-5">
                  <Section anchor="exec" title="Executive summary">{docs.brief ? <BriefView id={id} brief={docs.brief} evidence={docs.executiveSummary} /> : <Statements id={id} items={docs.executiveSummary} />}</Section>
                  <Section anchor="glance" title="System at a glance"><div className="card overflow-hidden"><table className="tbl"><thead><tr><th>Area</th><th>Description</th></tr></thead><tbody>{docs.atAGlance.map((r) => <tr key={r.area}><td className="w-[160px] font-medium">{r.area}</td><td>{r.description}</td></tr>)}</tbody></table></div></Section>
                  <Section anchor="arch" title="Architecture overview"><DocSectionView id={id} sec={docs.architectureOverview} /><div className="mt-1 text-sm"><Link href={`/p/${id}/architecture`}>See the architecture map →</Link></div></Section>
                  <Section anchor="runtime" title="Primary runtime flow">
                    <Statements id={id} items={docs.runtimeFlow.narrative} />
                    <ol className="card divide-y divide-line">{docs.runtimeFlow.steps.map((s, i) => <li key={i} className="flex gap-3 px-3 py-1.5"><span className="mono w-5 text-muted">{i + 1}</span><div><strong>{s.label}</strong> <span className="text-muted">{s.detail}</span><Evidence projectId={id} items={s.evidence} /></div></li>)}</ol>
                  </Section>
                  <Section anchor="flows" title="Data flow">
                    {docs.flows.length === 0 && <p className="text-muted">No end-to-end flows could be traced through the dependency graph.</p>}
                    {docs.flows.slice(0, 15).map((f) => (
                      <div key={f.id} className="card mb-2 p-3">
                        <div className="flex items-center gap-2"><strong>{f.name}</strong><Origin o={f.origin} /></div>
                        <div className="mono mt-2 flex flex-wrap items-center gap-x-1 gap-y-1 text-[12px]">{f.steps.map((s, i) => <span key={i} className="inline-flex items-center gap-1">{i > 0 && <span className="text-muted" aria-hidden>→</span>}{s.path ? <SourceLink projectId={id} cite={`${s.path}:${s.line ?? 1}`}>{s.label}</SourceLink> : <span>{s.label}</span>}</span>)}</div>
                        <p className="mt-2">{f.narrative}<Evidence projectId={id} items={f.evidence} /></p>
                      </div>
                    ))}
                  </Section>
                  <Section anchor="api" title="API architecture">
                    <DocSectionView id={id} sec={docs.apiArchitecture} />
                    {a && a.routes.length > 0 && (
                      <div className="card mt-2 overflow-x-auto"><table className="tbl"><thead><tr><th>Method</th><th>Route</th><th>Handler</th><th>Authentication</th><th>Purpose / kind</th></tr></thead><tbody>
                        {a.routes.slice(0, 100).map((r, i) => <tr key={i}><td className="mono">{r.method}</td><td className="mono"><SourceLink projectId={id} cite={`${r.file}:${r.line}`}>{r.path}</SourceLink></td><td className="mono">{r.handler}</td><td>{r.auth === "authenticated" ? <Chip tone="ok">authenticated</Chip> : r.auth === "public" ? <Chip>public</Chip> : <Chip tone="warn" title="No check visible at the route definition">not visible</Chip>}</td><td className="text-muted">{r.kind} · {r.framework}</td></tr>)}
                      </tbody></table></div>
                    )}
                  </Section>
                  <Section anchor="data" title="Data architecture"><DocSectionView id={id} sec={docs.dataArchitecture} /></Section>
                  <Section anchor="integrations" title="External integrations">
                    {docs.integrations.length === 0 ? <p className="text-muted">No external services were detected.</p> : <div className="card overflow-x-auto"><table className="tbl"><thead><tr><th>Service</th><th>Where used</th><th>Why</th><th>If unavailable</th></tr></thead><tbody>{docs.integrations.map((i) => <tr key={i.name}><td><strong>{i.name}</strong><div className="text-xs text-muted">{i.category}</div></td><td>{i.where.slice(0, 3).map((w, k) => <span key={w}>{k > 0 && ", "}<SourceLink projectId={id} cite={w} /></span>)}</td><td>{i.why}</td><td>{i.ifUnavailable}</td></tr>)}</tbody></table></div>}
                  </Section>
                  <Section anchor="infra" title="Infrastructure and deployment"><DocSectionView id={id} sec={docs.infrastructure} /></Section>
                  <Section anchor="testing" title="Testing strategy"><DocSectionView id={id} sec={docs.testing} /></Section>
                  <Section anchor="security" title="Security model"><DocSectionView id={id} sec={docs.securityModel} /></Section>
                  <Section anchor="risks" title="Engineering risks">
                    <DocSectionView id={id} sec={docs.risks} />
                    {docs.conflicts.length > 0 && <div className="card mt-2 p-3"><div className="h-label mb-1">Contradictions found and re-checked against source</div>{docs.conflicts.map((c, i) => <div key={i} className="mb-2 text-[13px]"><strong>{c.subject}</strong><ul className="list-disc pl-5">{c.claims.map((cl, k) => <li key={k}>{cl}</li>)}</ul><div className="text-muted">Resolution ({c.preferred}): {c.resolution}<Evidence projectId={id} items={c.evidence} /></div></div>)}</div>}
                    <div className="mt-2 text-sm"><Link href={`/p/${id}/review`}>Open the full code review →</Link></div>
                  </Section>
                  <Section anchor="recs" title="Recommendations"><ol className="prose-doc list-decimal pl-5">{docs.recommendations.map((r, i) => <li key={i} className="mb-1">{r.text}<Evidence projectId={id} items={r.evidence} /></li>)}</ol></Section>
              </div>
            </div>
          )}

          {scale === "collections" && (
            <div className="flex flex-col gap-5 lg:flex-row">
              <nav className="w-full flex-none lg:sticky lg:top-2 lg:h-fit lg:max-h-[calc(100vh-120px)] lg:w-[280px] lg:overflow-auto" aria-label="Groups of files">
                <ListButton active={selected === "custom"} onClick={() => go({ item: "custom" })}><strong>Your own group…</strong><div className={`text-[11px] ${selected === "custom" ? "" : "text-muted"}`}>Pick files or a folder to explain together</div></ListButton>
                <div className="h-label mb-1 mt-3 px-3">Functional areas</div>
                {docs.areas.length === 0 && <div className="px-3 text-xs text-muted">None identified.</div>}
                {docs.areas.map((ar) => <ListButton key={ar.id} active={selected === `area:${ar.id}`} onClick={() => go({ item: `area:${ar.id}` })}>{ar.name}<span className="ml-1.5 text-[11px] opacity-70">{ar.files.length} file{ar.files.length === 1 ? "" : "s"}</span></ListButton>)}
                <div className="h-label mb-1 mt-3 px-3">Folders</div>
                {modules.length === 0 && <div className="px-3 text-xs text-muted">No folder holds several source files.</div>}
                {modules.map((m) => <ListButton key={m.path} active={selected === `mod:${m.path}`} onClick={() => go({ item: `mod:${m.path}` })}><span style={{ paddingLeft: Math.max(0, m.depth - minDepth) * 10 }} className="mono text-[12px]">{m.name}/</span><span className="ml-1.5 text-[11px] opacity-70">{m.fileCount}</span></ListButton>)}
              </nav>
              <div className="min-w-0 flex-1">
                {selected === "custom" && <CustomGroup id={id} docs={docs} aiAvailable={aiAvailable} go={go} />}
                {selArea && <><h2 className="mb-3 font-serif text-xl font-bold">{selArea.name}</h2><AreaDetail id={id} a={selArea} docs={docs} go={go} /></>}
                {selModule && <><h2 className="mb-3 font-serif text-xl font-bold"><span className="mono text-[17px]">{selModule.title}</span></h2><CollectionBody id={id} c={selModule} docs={docs} go={go} /></>}
                {!selArea && !selModule && selected !== "custom" && (fetched.loading ? <Loading label="Explaining this folder" /> : fetched.error ? <ErrorBox error={fetched.error} /> : <Empty title="Choose a group from the list" />)}
              </div>
            </div>
          )}

          {scale === "files" && (
            <div className="flex flex-col gap-5 lg:flex-row">
              <nav className="w-full flex-none lg:sticky lg:top-2 lg:h-fit lg:w-[320px]" aria-label="Files">
                <input className="input mb-2" placeholder={`Filter ${docs.files.length} files…`} value={fq} onChange={(e) => setFq(e.target.value)} aria-label="Filter file explanations" />
                <div className="max-h-64 overflow-auto lg:max-h-[calc(100vh-190px)]">
                  {files.slice(0, 200).map((f) => <ListButton key={f.path} active={fileSel?.path === f.path} onClick={() => go({ item: `file:${f.path}` })}><span className="mono block truncate text-[12px]">{f.path}</span></ListButton>)}
                  {files.length === 0 && <div className="px-3 text-sm text-muted">No file matches.</div>}
                  {files.length > 200 && <div className="px-3 text-xs text-muted">{files.length - 200} more; narrow the filter.</div>}
                </div>
              </nav>
              <div className="min-w-0 flex-1">{fileSel ? <FileDetail id={id} f={fileSel} docs={docs} go={go} /> : <Empty title="No file explanations were generated" />}</div>
            </div>
          )}

          {scale === "symbols" && (
            <div className="max-w-[900px]">
              <input className="input mb-2" placeholder={`Filter ${docs.symbols.length} symbols…`} value={sq} onChange={(e) => setSq(e.target.value)} aria-label="Filter symbol explanations" />
              {symbols.slice(0, 80).map((s) => <SymbolExplain key={s.symbolId} id={id} s={s} />)}
              {symbols.length > 80 && <div className="text-xs text-muted">{symbols.length - 80} more; narrow the filter.</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
