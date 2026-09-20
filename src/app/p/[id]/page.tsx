"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Chip, Empty, ErrorBox, Evidence, Loading, SectionTitle, SeverityBadge, Stat, OriginBadge } from "@/components/ui";
import { FormatRow } from "@/components/download";
import { useApi } from "@/lib/client";
import type { Architecture } from "@/lib/discover/types";
import { BriefView } from "@/components/brief";
import type { ExecutiveBrief, Statement } from "@/lib/docs/types";

interface Overview {
  ready: boolean;
  ai: { available: boolean; provider: string; model: string; reason?: string };
  aiProblem: { summary: string; hint: string; failures: number; first: string } | null;
  executiveSummary: Statement[]; brief: ExecutiveBrief | null;
  atAGlance: { area: string; description: string }[];
  architecture: Pick<Architecture, "pattern" | "applicationType" | "stack" | "stats" | "layers" | "entryPoints"> & { externalServices: { name: string; category: string; purpose: string }[] } | null;
  review: { total: number; bySeverity: Record<string, number>; byCategory: Record<string, number>; byOrigin: Record<string, number>; byVerification: Record<string, number>; top: { id: string; code: string; title: string; severity: string; category: string; origin: string; verification: string; filePath: string | null; startLine: number | null }[]; testing: string[]; security: string[]; risks: string[] };
  pipeline: { analyzers?: { name: string; status: string; detail: string; findings: number }[]; usage?: { inputTokens: number; outputTokens: number; calls: number }; aiFailures?: { task: string; error: string }[]; ai?: { ran: boolean; passes: { label: string; calls: number; findings: number; failed: number }[]; reviewedFiles: number } } | null;
  inventory: { total: number; included: number; excluded: number; binary: number; large: number; duplicates: number; tests: number; generated: number } | null;
  docMeta: { aiUsed: boolean; model?: string; notes: string[]; droppedUngrounded: number; aiSections: number } | null;
  project: { incremental: { changed: number; unchanged: number; added: number; removed: number } | null; previousProjectId: string | null; languages: Record<string, number> };
}

const SEV = ["Critical", "High", "Medium", "Low", "Informational"];

export default function OverviewPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading, reload } = useApi<Overview>(`/api/projects/${id}/overview`);
  if (loading && !data) return <Loading label="Loading overview" />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data?.ready || !data.architecture) return <Empty title="Analysis results are not available yet" />;
  const a = data.architecture;
  const r = data.review;
  const maxSev = Math.max(1, ...SEV.map((s) => r.bySeverity[s] ?? 0));
  const langTotal = Object.values(a.stack.languages.reduce<Record<string, number>>((m, l) => { m[l.name] = l.bytes; return m; }, {})).reduce((x, y) => x + y, 0) || 1;
  const stackFrameworks = a.stack.frameworks.filter((f) => !["tooling", "testing"].includes(f.category));

  return (
    <div className="mx-auto max-w-[1100px] p-5">
      <div className="card mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3" role="region" aria-label="Report ready" data-testid="report-ready">
        <div className="min-w-[200px]"><div className="font-semibold">Your report is ready</div><div className="text-xs text-muted">View it here, or take it with you as PDF, Word or Markdown.</div></div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
          {(["pdf", "docx", "md"] as const).map((f) => <div key={f} className="min-w-[210px]"><FormatRow projectId={id} scope="full" format={f} compact /></div>)}
        </div>
        <Link href={`/p/${id}/reports`} className="ml-auto text-sm">All reports →</Link>
      </div>
      {data.aiProblem && (
        <div role="alert" className="card mb-4 px-3 py-2 text-sm" style={{ borderColor: "var(--high)" }}>
          <strong>AI analysis did not complete.</strong> {data.aiProblem.summary} {data.aiProblem.hint} <span className="text-muted">({data.aiProblem.failures} failed request{data.aiProblem.failures === 1 ? "" : "s"}.) Everything shown is deterministic; after fixing the cause, use Re-analyze.</span>
        </div>
      )}
      {!data.ai.available && (
        <div className="card mb-4 px-3 py-2 text-sm" style={{ borderColor: "var(--med)" }}>
          <strong>This report is fully deterministic.</strong> {data.ai.reason} Findings below come from static analyzers and structural checks only, and explanations are assembled from the repository graph rather than written by a model.
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
        <Stat label="Files" value={a.stats.files.toLocaleString()} sub={`${a.stats.sourceFiles} source`} />
        <Stat label="Lines" value={a.stats.lines.toLocaleString()} />
        <Stat label="Symbols" value={a.stats.symbols.toLocaleString()} sub={`${a.stats.relationships.toLocaleString()} relations`} />
        <Stat label="Routes" value={a.stats.routes} />
        <Stat label="Models" value={a.stats.models} />
        <Stat label="Dependencies" value={a.stats.dependencies} />
        <Stat label="Test files" value={a.stats.testFiles} />
        <Stat label="Findings" value={r.total} sub={`${(r.bySeverity.Critical ?? 0) + (r.bySeverity.High ?? 0)} critical/high`} />
      </div>

      <SectionTitle>Executive summary</SectionTitle>
      {data.brief ? <BriefView id={id} brief={data.brief} evidence={data.executiveSummary} compact /> : (
        <div className="card prose-doc p-4">
          {data.executiveSummary.map((s, i) => (
            <p key={i}>{s.text}<Evidence projectId={id} items={s.evidence} />{s.origin === "ai" && <span className="ml-1 text-[11px] text-muted" title="Written by an AI model from indexed evidence">AI</span>}</p>
          ))}
        </div>
      )}
      <div className="mt-2 text-xs text-muted"><Link href={`/p/${id}/explain`}>Read the full system explanation →</Link></div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <SectionTitle>System at a glance</SectionTitle>
          <div className="card overflow-hidden">
            <table className="tbl"><tbody>{data.atAGlance.map((row) => <tr key={row.area}><td className="w-[140px] font-medium text-muted">{row.area}</td><td>{row.description}</td></tr>)}</tbody></table>
          </div>
        </div>
        <div>
          <SectionTitle>Technology</SectionTitle>
          <div className="card space-y-3 p-4">
            <div>
              <div className="h-label mb-1">Languages</div>
              <div className="flex h-2.5 overflow-hidden rounded-full border border-line" role="img" aria-label="Language share by size">
                {a.stack.languages.slice(0, 8).map((l, i) => <div key={l.name} style={{ width: `${(l.bytes / langTotal) * 100}%`, background: ["#1b4965", "#006c96", "#3aa7c9", "#8fd0e0", "#c98a2b", "#8a6fd6", "#8a9099", "#b0b45a"][i] }} title={`${l.name}: ${(l.bytes / langTotal * 100).toFixed(1)}%`} />)}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted">{a.stack.languages.slice(0, 8).map((l) => <span key={l.name}>{l.name} {(l.bytes / langTotal * 100).toFixed(0)}% · {l.files} files</span>)}</div>
            </div>
            {stackFrameworks.length > 0 && <div><div className="h-label mb-1">Frameworks and libraries</div><div className="flex flex-wrap gap-1">{stackFrameworks.map((f) => <Chip key={f.name} title={f.category}>{f.name}</Chip>)}</div></div>}
            {a.stack.databases.length > 0 && <div><div className="h-label mb-1">Databases</div><div className="flex flex-wrap gap-1">{a.stack.databases.map((d) => <Chip key={d}>{d}</Chip>)}</div></div>}
            {a.stack.infrastructure.length > 0 && <div><div className="h-label mb-1">Infrastructure</div><div className="flex flex-wrap gap-1">{a.stack.infrastructure.map((d) => <Chip key={d}>{d}</Chip>)}</div></div>}
            {a.externalServices.length > 0 && <div><div className="h-label mb-1">External services</div><div className="flex flex-wrap gap-1">{a.externalServices.map((s) => <Chip key={s.name} tone="info" title={s.purpose}>{s.name}</Chip>)}</div></div>}
            <div className="text-xs text-muted">Architecture: <strong className="text-fg">{a.pattern.label}</strong> ({a.pattern.confidence} confidence)</div>
          </div>
        </div>
      </div>

      <SectionTitle right={<Link href={`/p/${id}/review`} className="text-sm">Open code review →</Link>}>Engineering review</SectionTitle>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_1fr]">
        <div className="card p-3">
          <div className="h-label mb-2">Findings by severity</div>
          {SEV.map((s) => (
            <Link key={s} href={`/p/${id}/review?severity=${s}`} className="mb-1 flex items-center gap-2 hover:no-underline">
              <span className="w-[92px]"><SeverityBadge severity={s} /></span>
              <span className="h-2 flex-1 rounded-full bg-panel2"><span className="block h-2 rounded-full" style={{ width: `${((r.bySeverity[s] ?? 0) / maxSev) * 100}%`, background: `var(--${s === "Critical" ? "crit" : s === "High" ? "high" : s === "Medium" ? "med" : s === "Low" ? "low" : "info"})` }} /></span>
              <span className="w-6 text-right tabular-nums">{r.bySeverity[s] ?? 0}</span>
            </Link>
          ))}
          <div className="mt-3 text-xs text-muted">{r.byOrigin.static ?? 0} from static analyzers · {r.byOrigin.ai ?? 0} AI-inferred · {r.byVerification.needs_verification ?? 0} need verification</div>
        </div>
        <div className="card overflow-hidden">
          {r.top.length === 0 ? <Empty title="No critical or high-severity findings" /> : (
            <table className="tbl"><thead><tr><th>ID</th><th>Finding</th><th>Severity</th><th>Source</th></tr></thead><tbody>
              {r.top.map((f) => (
                <tr key={f.id}>
                  <td className="mono whitespace-nowrap"><Link href={`/p/${id}/review?finding=${f.id}`}>{f.code}</Link></td>
                  <td>{f.title}{f.filePath && <div className="mono text-xs text-muted">{f.filePath}{f.startLine ? `:${f.startLine}` : ""}</div>}</td>
                  <td><SeverityBadge severity={f.severity} /></td>
                  <td><OriginBadge origin={f.origin} verification={f.verification} /></td>
                </tr>
              ))}
            </tbody></table>
          )}
        </div>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        {[["Testing", r.testing], ["Security", r.security], ["Risks and maintainability", r.risks]].map(([title, paras]) => (
          <div key={title as string} className="card p-3"><div className="h-label mb-1">{title as string}</div>{(paras as string[]).slice(0, 3).map((t, i) => <p key={i} className="mb-1.5 text-[13px]">{t}</p>)}</div>
        ))}
      </div>

      <SectionTitle>How this analysis was produced</SectionTitle>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card overflow-hidden">
          <table className="tbl"><thead><tr><th>Analyzer</th><th>Status</th><th>Findings</th></tr></thead><tbody>
            {(data.pipeline?.analyzers ?? []).map((an) => <tr key={an.name}><td title={an.detail}><span className="mono">{an.name}</span><div className="text-xs text-muted">{an.detail}</div></td><td><Chip tone={an.status === "ran" ? "ok" : an.status === "error" ? "danger" : "neutral"}>{an.status}</Chip></td><td className="tabular-nums">{an.findings}</td></tr>)}
            <tr><td><span className="mono">ai-review</span><div className="text-xs text-muted">{data.pipeline?.ai?.ran ? `${data.pipeline.ai.passes.reduce((x, p) => x + p.calls, 0)} model calls over ${data.pipeline.ai.reviewedFiles} files; every finding is verified against the source` : "No AI provider configured"}</div></td><td><Chip tone={data.pipeline?.ai?.ran ? "ok" : "neutral"}>{data.pipeline?.ai?.ran ? "ran" : "skipped"}</Chip></td><td className="tabular-nums">{r.byOrigin.ai ?? 0}</td></tr>
          </tbody></table>
        </div>
        <div className="card p-3 text-[13px]">
          {data.inventory && <p className="mb-2"><strong>{data.inventory.included.toLocaleString()}</strong> files analysed, <strong>{data.inventory.excluded.toLocaleString()}</strong> excluded by default (dependencies, build output, ignored). {data.inventory.binary} binary, {data.inventory.large} unusually large, {data.inventory.duplicates} duplicate. <Link href={`/p/${id}/files?excluded=1`}>Inspect excluded files</Link>.</p>}
          {data.project.incremental && data.project.previousProjectId && <p className="mb-2">Compared with the previous analysis: <strong>{data.project.incremental.changed}</strong> changed, <strong>{data.project.incremental.unchanged}</strong> unchanged, <strong>{data.project.incremental.added}</strong> added, <strong>{data.project.incremental.removed}</strong> removed. Parsing and AI explanations were reused for unchanged files.</p>}
          {data.pipeline?.usage && data.pipeline.usage.calls > 0 && <p className="mb-2">AI usage: {data.pipeline.usage.calls} calls, {data.pipeline.usage.inputTokens.toLocaleString()} input and {data.pipeline.usage.outputTokens.toLocaleString()} output tokens.</p>}
          {data.docMeta && <p className="mb-2">Documentation: {data.docMeta.aiUsed ? `AI-written (${data.docMeta.model})` : "deterministic"}; {data.docMeta.droppedUngrounded} generated statement(s) were dropped because their evidence could not be verified.</p>}
          {(data.pipeline?.aiFailures?.length ?? 0) > 0 && <p style={{ color: "var(--high)" }}>{data.pipeline!.aiFailures!.length} AI request(s) failed: {data.pipeline!.aiFailures![0].error.slice(0, 160)}</p>}
          {data.docMeta?.notes.slice(0, 3).map((n, i) => <p key={i} className="text-xs text-muted">{n}</p>)}
        </div>
      </div>
      <div className="h-8" />
    </div>
  );
}
