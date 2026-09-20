"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { DownloadMenu } from "@/components/download";
import { Legend } from "@/components/legend";
import { GraphCanvas } from "@/components/graph";
import { DataModelMap } from "@/components/data-model";
import type { Graph } from "@/lib/map";
import { Chip, Empty, ErrorBox, Loading, SectionTitle, SourceLink } from "@/components/ui";
import { useApi } from "@/lib/client";
import type { Architecture } from "@/lib/discover/types";

interface Resp { architecture: Architecture | null; diagram: { text: string; mermaid: string; er: string | null } }

export default function ArchitecturePage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading, reload } = useApi<Resp>(`/api/projects/${id}/architecture`);
  const areaGraph = useApi<{ graph: Graph }>(`/api/projects/${id}/graph?type=area`);
  const [rq, setRq] = useState("");
  const [dq, setDq] = useState("");
  const [showDev, setShowDev] = useState(false);
  const a = data?.architecture;
  const routes = useMemo(() => (a?.routes ?? []).filter((r) => !rq || `${r.method} ${r.path} ${r.handler} ${r.file}`.toLowerCase().includes(rq.toLowerCase())), [a, rq]);
  const deps = useMemo(() => (a?.dependencies ?? []).filter((d) => (showDev || !d.dev) && (!dq || d.name.toLowerCase().includes(dq.toLowerCase()))).sort((x, y) => y.usedBy - x.usedBy || x.name.localeCompare(y.name)), [a, dq, showDev]);
  if (loading && !data) return <Loading label="Loading architecture" />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!a || !data) return <Empty title="No architecture data" />;

  return (
    <div className="mx-auto max-w-[1180px] space-y-2 p-5">
      <div className="flex items-center justify-between"><h1 className="font-serif text-2xl font-bold">Architecture</h1><DownloadMenu projectId={id} scope="architecture" label="Download architecture" /></div>
      <div className="card p-3">
        <div className="text-[15px]"><strong>{a.pattern.label}</strong> <Chip tone={a.pattern.confidence === "high" ? "ok" : "warn"}>{a.pattern.confidence} confidence</Chip></div>
        <ul className="mt-1 list-disc pl-5 text-[13px] text-muted">{a.pattern.reasoning.map((r, i) => <li key={i}>{r}</li>)}</ul>
      </div>

      <SectionTitle>System map</SectionTitle>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="card overflow-hidden"><div className="border-b border-line bg-panel2 px-3 py-1 text-xs text-muted">Layered view generated from detected relationships</div><pre tabIndex={0} className="!border-0 !rounded-none !bg-transparent" style={{ fontSize: 11 }}>{data.diagram.text}</pre></div>
        <div><div className="mb-1 text-xs text-muted">Functional-area dependencies. Open the Code Map to drill down.</div>{areaGraph.data ? <GraphCanvas graph={areaGraph.data.graph} height={420} /> : <Loading label="Drawing diagram" />}</div>
      </div>
      <div className="text-sm"><Link href={`/p/${id}/map`}>Explore the interactive code map →</Link></div>
      <Legend />

      <SectionTitle>Entry points</SectionTitle>
      <div className="card overflow-x-auto"><table className="tbl"><thead><tr><th>Kind</th><th>File</th><th>Why it is an entry point</th></tr></thead><tbody>
        {a.entryPoints.map((e, i) => <tr key={i}><td><Chip>{e.kind}</Chip></td><td><SourceLink projectId={id} cite={`${e.path}${e.line ? `:${e.line}` : ""}`} /></td><td className="text-muted">{e.reason}</td></tr>)}
        {a.entryPoints.length === 0 && <tr><td colSpan={3} className="text-muted">No entry points detected.</td></tr>}
      </tbody></table></div>

      <SectionTitle right={<input className="input w-[220px]" placeholder="Filter routes…" value={rq} onChange={(e) => setRq(e.target.value)} aria-label="Filter routes" />}>API map ({a.routes.length})</SectionTitle>
      <div className="card max-h-[420px] overflow-auto"><table className="tbl"><thead><tr><th>Method</th><th>Route</th><th>Handler</th><th>Authentication</th><th>Kind</th></tr></thead><tbody>
        {routes.map((r, i) => <tr key={i}><td className="mono">{r.method}</td><td className="mono"><SourceLink projectId={id} cite={`${r.file}:${r.line}`}>{r.path}</SourceLink></td><td className="mono">{r.handler}</td><td>{r.auth === "authenticated" ? <Chip tone="ok">authenticated</Chip> : r.auth === "public" ? <Chip>public</Chip> : <Chip tone="warn" title="No authentication check visible at the route definition">not visible</Chip>}</td><td className="text-muted">{r.kind} · {r.framework}</td></tr>)}
        {routes.length === 0 && <tr><td colSpan={5} className="text-muted">No routes {rq ? "match" : "detected"}.</td></tr>}
      </tbody></table></div>

      <SectionTitle>Data model map ({a.models.length})</SectionTitle>
      {a.models.length === 0 ? <p className="text-muted">No data models or schemas were detected.</p> : <DataModelMap id={id} models={a.models} er={data.diagram.er ?? undefined} />}

      <SectionTitle>External services and integrations ({a.externalServices.length})</SectionTitle>
      <div className="card overflow-x-auto"><table className="tbl"><thead><tr><th>Service</th><th>Category</th><th>Evidence</th><th>What fails if unavailable</th></tr></thead><tbody>
        {a.externalServices.map((s) => <tr key={s.name}><td><strong>{s.name}</strong><div className="text-xs text-muted">{s.purpose}</div></td><td>{s.category}</td><td>{s.evidence.slice(0, 3).map((e, i) => <span key={i}>{i > 0 && ", "}<SourceLink projectId={id} cite={`${e.path}${e.line ? `:${e.line}` : ""}`} /></span>)}<div className="text-xs text-muted">{s.via.slice(0, 3).join("; ")}</div></td><td>{s.failureImpact}</td></tr>)}
        {a.externalServices.length === 0 && <tr><td colSpan={4} className="text-muted">No external services detected.</td></tr>}
      </tbody></table></div>

      <SectionTitle>Functional areas and internal dependencies</SectionTitle>
      <div className="card overflow-x-auto"><table className="tbl"><thead><tr><th>Area</th><th>Files</th><th>Depends on</th><th>Used by</th></tr></thead><tbody>
        {a.areas.map((ar) => <tr key={ar.id}><td className="font-medium">{ar.name}<div className="text-xs font-normal text-muted">{ar.description}</div></td><td className="tabular-nums">{ar.files.length}</td><td>{ar.dependsOn.join(", ") || "—"}</td><td>{ar.usedBy.join(", ") || "—"}</td></tr>)}
      </tbody></table></div>

      <SectionTitle right={<span className="flex items-center gap-3 text-sm"><label className="flex items-center gap-1"><input type="checkbox" checked={showDev} onChange={(e) => setShowDev(e.target.checked)} /> include dev</label><input className="input w-[200px]" placeholder="Filter packages…" value={dq} onChange={(e) => setDq(e.target.value)} aria-label="Filter packages" /></span>}>External dependencies ({a.dependencies.filter((d) => showDev || !d.dev).length})</SectionTitle>
      <div className="card max-h-[360px] overflow-auto"><table className="tbl"><thead><tr><th>Package</th><th>Version</th><th>Ecosystem</th><th>Files importing it</th><th>Manifest</th></tr></thead><tbody>
        {deps.slice(0, 300).map((d) => <tr key={d.ecosystem + d.name}><td className="mono">{d.name}{d.dev && <span className="ml-1 text-xs text-muted">dev</span>}</td><td className="mono text-xs">{d.version ?? "—"}</td><td>{d.ecosystem}</td><td className="tabular-nums">{d.usedBy}</td><td className="text-xs text-muted">{d.manifest}</td></tr>)}
      </tbody></table></div>

      <SectionTitle>Configuration map</SectionTitle>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="card max-h-[360px] overflow-auto"><table className="tbl"><thead><tr><th>Environment variable</th><th>Read in</th><th>Declared in</th></tr></thead><tbody>
          {a.envVars.map((e) => <tr key={e.name}><td className="mono">{e.name}{e.sensitive && <span className="ml-1 text-xs" style={{ color: "var(--high)" }} title="Name suggests a secret">sensitive</span>}</td><td className="text-xs">{e.files.slice(0, 2).map((f, i) => <span key={i}>{i > 0 && ", "}<SourceLink projectId={id} cite={`${f.path}:${f.line ?? 1}`} /></span>)}</td><td className="text-xs text-muted">{e.declaredIn.join(", ") || "not documented"}</td></tr>)}
          {a.envVars.length === 0 && <tr><td colSpan={3} className="text-muted">No environment variables detected.</td></tr>}
        </tbody></table></div>
        <div className="card p-3 text-[13px]">
          <div className="h-label mb-1">Ports</div><div className="mb-2">{a.ports.length ? a.ports.map((p) => <Chip key={p.value + p.path}>{p.value}</Chip>) : <span className="text-muted">none detected</span>}</div>
          <div className="h-label mb-1">Feature flags</div><div className="mb-2">{a.featureFlags.length ? a.featureFlags.slice(0, 20).map((f) => <Chip key={f.name}><span className="mono">{f.name}</span></Chip>) : <span className="text-muted">none detected</span>}</div>
          <div className="h-label mb-1">Configuration files</div><div className="mono text-xs">{a.configFiles.slice(0, 20).join(", ") || "none"}</div>
          <div className="mt-2 text-xs text-muted">Variable names only; values are never read or shown.</div>
        </div>
      </div>

      <SectionTitle>Infrastructure</SectionTitle>
      <div className="card overflow-x-auto"><table className="tbl"><tbody>
        {a.infra.map((i, k) => <tr key={k}><td className="w-[160px]"><Chip>{i.kind}</Chip></td><td><SourceLink projectId={id} cite={i.path} /></td><td className="text-muted">{i.detail}</td></tr>)}
        {a.infra.length === 0 && <tr><td className="text-muted">No infrastructure or CI configuration detected.</td></tr>}
      </tbody></table></div>

      <SectionTitle>Test map</SectionTitle>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="card max-h-[320px] overflow-auto"><table className="tbl"><thead><tr><th>Test file</th><th>Kind</th><th>Exercises</th></tr></thead><tbody>
          {a.tests.files.map((t) => <tr key={t.path}><td><SourceLink projectId={id} cite={t.path} /><div className="text-xs text-muted">{t.framework}</div></td><td>{t.kind}</td><td className="text-xs">{t.targets.slice(0, 3).map((x, i) => <span key={x}>{i > 0 && ", "}<SourceLink projectId={id} cite={x} /></span>)}{t.targets.length === 0 && <span className="text-muted">not resolved</span>}</td></tr>)}
          {a.tests.files.length === 0 && <tr><td colSpan={3} className="text-muted">No tests found.</td></tr>}
        </tbody></table></div>
        <div className="card p-3 text-[13px]">
          <div className="h-label mb-1">Important components with no tests</div>
          {a.tests.untestedCritical.length ? <ul className="mb-2 list-disc pl-5">{a.tests.untestedCritical.slice(0, 10).map((u) => <li key={u.path}><SourceLink projectId={id} cite={u.path} /></li>)}</ul> : <p className="mb-2 text-muted">None flagged.</p>}
          <div className="h-label mb-1">Source files covered by tests, per area</div>
          {Object.entries(a.tests.coverageByArea).map(([k, v]) => <div key={k} className="flex items-center gap-2"><span className="w-[160px] truncate">{k}</span><span className="h-1.5 flex-1 rounded-sm bg-panel2"><span className="block h-1.5 rounded-sm bg-accent" style={{ width: `${v.total ? (v.tested / v.total) * 100 : 0}%` }} /></span><span className="tabular-nums text-muted">{v.tested}/{v.total}</span></div>)}
          <div className="mt-1 text-xs text-muted">Counts files that a test imports or calls; it is not line coverage.</div>
        </div>
      </div>
      {a.ai.length > 0 && <>
        <SectionTitle>AI components</SectionTitle>
        <div className="card overflow-x-auto"><table className="tbl"><tbody>{a.ai.map((c, i) => <tr key={i}><td><Chip>{c.kind}</Chip></td><td><SourceLink projectId={id} cite={`${c.path}${c.line ? `:${c.line}` : ""}`} /></td><td className="text-muted">{c.detail}</td></tr>)}</tbody></table></div>
      </>}
      <div className="h-6" />
    </div>
  );
}
