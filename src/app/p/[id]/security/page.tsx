"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { FormatRow } from "@/components/download";
import { Chip, Empty, ErrorBox, Loading, SectionTitle, SeverityBadge, SourceLink, Stat } from "@/components/ui";
import type { Assurance, Control, FindingRef, PrivacyAssessment, SecurityAssessment } from "@/lib/assurance/types";
import { useApi } from "@/lib/client";

type Tone = "neutral" | "ok" | "warn" | "info" | "danger";
const RATING_TONE: Record<SecurityAssessment["rating"], Tone> = { Critical: "danger", High: "danger", Elevated: "warn", Moderate: "info", Low: "ok" };
const STATUS_TONE: Record<PrivacyAssessment["status"], Tone> = { "High exposure": "danger", "Needs attention": "warn", "Controls in place": "ok", "Limited personal data": "info", "No personal data detected": "neutral" };
const CONTROL: Record<Control["status"], { label: string; tone: Tone }> = { present: { label: "In place", tone: "ok" }, partial: { label: "Partial", tone: "warn" }, missing: { label: "Not found", tone: "warn" }, gap: { label: "Weakness found", tone: "danger" }, na: { label: "Not applicable", tone: "neutral" } };
const SENS: Record<string, { label: string; tone: Tone }> = { special: { label: "Special category", tone: "danger" }, high: { label: "High", tone: "danger" }, moderate: { label: "Moderate", tone: "warn" }, low: { label: "Low", tone: "neutral" } };
const TONE_VAR: Record<Tone, string> = { danger: "var(--high)", warn: "var(--med)", info: "var(--info)", ok: "var(--line)", neutral: "var(--line)" };
const cite = (p: { path: string; line?: number }) => `${p.path}${p.line ? `:${p.line}` : ""}`;

function Verdict({ label, value, tone, reasons }: { label: string; value: string; tone: Tone; reasons: string[] }) {
  return (
    <div className="card p-4" style={{ borderColor: TONE_VAR[tone] }} role="status">
      <div className="flex flex-wrap items-center gap-2"><span className="h-label">{label}</span><Chip tone={tone}>{value}</Chip></div>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-[13.5px]">{reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
    </div>
  );
}

function Controls({ id, controls }: { id: string; controls: Control[] }) {
  return (
    <div className="card overflow-x-auto">
      <table className="tbl"><thead><tr><th>Control</th><th>Status</th><th>What was found</th></tr></thead><tbody>
        {controls.map((c) => (
          <tr key={c.key}>
            <td className="font-medium">{c.name}</td>
            <td><Chip tone={CONTROL[c.status].tone}>{CONTROL[c.status].label}</Chip></td>
            <td className="text-[13px]">{c.detail}{c.evidence.length > 0 && <div className="mt-0.5 flex flex-wrap gap-x-2">{c.evidence.slice(0, 3).map((e) => <SourceLink key={cite(e)} projectId={id} cite={cite(e)} />)}</div>}</td>
          </tr>
        ))}
      </tbody></table>
    </div>
  );
}

function Findings({ id, list, empty }: { id: string; list: FindingRef[]; empty: string }) {
  if (!list.length) return <div className="card"><Empty title={empty} /></div>;
  return (
    <div className="card overflow-x-auto">
      <table className="tbl"><thead><tr><th>ID</th><th>Finding</th><th>Severity</th><th>OWASP · CWE</th></tr></thead><tbody>
        {list.slice(0, 60).map((f) => (
          <tr key={f.code}>
            <td className="mono whitespace-nowrap"><Link href={`/p/${id}/review?q=${encodeURIComponent(f.code)}`}>{f.code}</Link></td>
            <td>{f.title}<div className="text-xs text-muted">{f.location !== "repository-wide" ? <SourceLink projectId={id} cite={f.location} /> : "repository-wide"} · {f.origin === "static" ? "static analyzer" : f.origin === "formal" ? "proved (Lean 4)" : "AI-inferred"}{f.verification === "verified" ? "" : ", needs verification"}</div></td>
            <td><SeverityBadge severity={f.severity} /></td>
            <td className="mono whitespace-nowrap text-xs">{[f.owasp, f.cwe].filter(Boolean).join(" · ") || "—"}</td>
          </tr>
        ))}
      </tbody></table>
    </div>
  );
}

function Plan({ rows }: { rows: { priority: string; action: string; refs?: string[]; why?: string }[] }) {
  if (!rows.length) return <div className="card"><Empty title="Nothing needs remediation" /></div>;
  return (
    <div className="card overflow-x-auto">
      <table className="tbl"><thead><tr><th>Priority</th><th>Action</th><th>{rows.some((r) => r.why) ? "Why" : "Findings"}</th></tr></thead><tbody>
        {rows.map((r, i) => <tr key={i}><td><Chip tone={r.priority === "Now" ? "danger" : r.priority === "Next" ? "warn" : "neutral"}>{r.priority}</Chip></td><td className="text-[13px]">{r.action}</td><td className="text-[13px] text-muted">{r.why ?? (r.refs?.length ? r.refs.join(", ") : "control gap")}</td></tr>)}
      </tbody></table>
    </div>
  );
}

function SecurityView({ id, a }: { id: string; a: SecurityAssessment }) {
  const s = a.surface;
  return (
    <section aria-labelledby="sec-h">
      <h2 id="sec-h" className="font-serif text-xl font-bold">Security assessment</h2>
      <div className="mt-2"><Verdict label="Overall security risk" value={a.rating} tone={RATING_TONE[a.rating]} reasons={a.rationale} /></div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        <Stat label="Critical" value={a.counts.Critical} /><Stat label="High" value={a.counts.High} /><Stat label="Medium" value={a.counts.Medium} /><Stat label="Low" value={a.counts.Low} />
        <Stat label="API routes" value={s.apiRoutes} sub={`${s.unverifiedApi} without a visible check`} /><Stat label="External services" value={s.externalServices} /><Stat label="Committed secrets" value={s.secrets} />
      </div>
      {s.unauthenticatedWrites.length > 0 && (
        <>
          <SectionTitle>State-changing routes with no visible authentication</SectionTitle>
          <div className="card overflow-x-auto"><table className="tbl"><thead><tr><th>Method</th><th>Route</th><th>Location</th></tr></thead><tbody>
            {s.unauthenticatedWrites.map((r) => <tr key={r.location + r.method}><td className="mono">{r.method}</td><td className="mono">{r.path}</td><td><SourceLink projectId={id} cite={r.location} /></td></tr>)}
          </tbody></table></div>
          <p className="mt-1 text-xs text-muted">Authentication applied by shared middleware or a gateway is not visible at the route; confirm each one is meant to be public.</p>
        </>
      )}
      <SectionTitle>OWASP Top 10 (2021) coverage</SectionTitle>
      <div className="grid gap-2 sm:grid-cols-2">
        {a.owasp.map((o) => (
          <div key={o.id} className="card p-3" style={{ borderColor: o.status === "issues" ? TONE_VAR.danger : undefined }}>
            <div className="flex flex-wrap items-center gap-2"><span className="mono text-xs font-bold">{o.id}</span><span className="font-semibold">{o.name}</span>
              <span className="ml-auto">{o.status === "issues" ? <SeverityBadge severity={o.worst ?? "Medium"} /> : <Chip tone={o.status === "clear" ? "ok" : "neutral"}>{o.status === "clear" ? "No issues detected" : "Limited coverage"}</Chip>}</span></div>
            <p className="mt-1 text-[13px] text-muted">{o.note}</p>
            {o.findings.length > 0 && <div className="mt-1 flex flex-wrap gap-x-2 text-xs">{o.findings.slice(0, 6).map((f) => <Link key={f.code} className="mono" href={`/p/${id}/review?q=${encodeURIComponent(f.code)}`}>{f.code}</Link>)}</div>}
          </div>
        ))}
      </div>
      <SectionTitle>Security controls</SectionTitle>
      <Controls id={id} controls={a.controls} />
      <SectionTitle right={<Link href={`/p/${id}/review?category=Security`} className="text-sm">Open in Code Review →</Link>}>Security findings</SectionTitle>
      <Findings id={id} list={a.findings} empty="No security findings" />
      <SectionTitle>Remediation plan</SectionTitle>
      <Plan rows={a.plan} />
      <ul className="mt-2 list-disc pl-5 text-xs text-muted">{a.coverage.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
    </section>
  );
}

function PrivacyView({ id, p }: { id: string; p: PrivacyAssessment }) {
  return (
    <section aria-labelledby="pii-h">
      <h2 id="pii-h" className="font-serif text-xl font-bold">Privacy and personal data (PII)</h2>
      <div className="mt-2"><Verdict label="Personal data status" value={p.status} tone={STATUS_TONE[p.status]} reasons={p.rationale} /></div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        <Stat label="PII fields" value={p.counts.fields} /><Stat label="Data models" value={p.counts.models} /><Stat label="Special category" value={p.counts.special} /><Stat label="High sensitivity" value={p.counts.high} />
        <Stat label="Unprotected sensitive" value={p.counts.unprotectedSensitive} /><Stat label="Third parties" value={p.counts.recipients} /><Stat label="Findings" value={p.counts.findings} />
      </div>
      <SectionTitle>Personal data inventory</SectionTitle>
      {p.fields.length === 0 ? <div className="card"><Empty title="No data-model field was recognised as personal data" /></div> : (
        <div className="card overflow-x-auto">
          <table className="tbl"><thead><tr><th>Data element</th><th>Category</th><th>Sensitivity</th><th>Protection</th><th>Location</th></tr></thead><tbody>
            {p.fields.slice(0, 200).map((f) => (
              <tr key={`${f.model}.${f.field}@${f.path}`}>
                <td className="mono">{f.model}.{f.field}</td><td className="text-[13px]">{f.categoryLabel}</td>
                <td><Chip tone={SENS[f.sensitivity].tone}>{SENS[f.sensitivity].label}</Chip></td>
                <td className="text-[13px]">{f.protection === "none" ? <span className={f.sensitivity === "special" || f.sensitivity === "high" ? "font-semibold" : "text-muted"}>None visible</span> : f.protection === "tokenised" ? "Tokenised or masked" : f.protection === "hashed" ? "Hashed" : "Encrypted"}</td>
                <td><SourceLink projectId={id} cite={cite(f)} /></td>
              </tr>
            ))}
          </tbody></table>
        </div>
      )}
      <p className="mt-1 text-xs text-muted">Recognised from field names in models, schemas and migrations. No stored values are read.</p>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <SectionTitle>Data subjects and third parties</SectionTitle>
          <div className="card p-3 text-[13px]">
            <p><strong>Data subjects:</strong> {p.subjects.join(", ") || "none identified"}</p>
            {p.recipients.length ? <ul className="mt-2 space-y-1.5">{p.recipients.map((r) => <li key={r.name}><strong>{r.name}</strong> <span className="text-muted">({r.category})</span>: {r.why}{r.evidence[0] && <> · <SourceLink projectId={id} cite={cite(r.evidence[0])} /></>}</li>)}</ul> : <p className="mt-2 text-muted">No third-party service that typically receives personal data was detected.</p>}
          </div>
        </div>
        <div>
          <SectionTitle>Regulatory considerations</SectionTitle>
          <div className="card p-3 text-[13px]">
            {p.regimes.length ? <ul className="space-y-1.5">{p.regimes.map((r) => <li key={r.name}><strong>{r.name}.</strong> {r.why}</li>)}</ul> : <p className="text-muted">No regulatory indicators were found.</p>}
            <p className="mt-2 text-xs text-muted">Indicators from the code, not legal advice.</p>
          </div>
        </div>
      </div>
      <SectionTitle>Privacy controls</SectionTitle>
      <Controls id={id} controls={p.controls} />
      <SectionTitle right={<Link href={`/p/${id}/review?category=Privacy`} className="text-sm">Open in Code Review →</Link>}>Privacy findings</SectionTitle>
      <Findings id={id} list={p.findings} empty="No privacy findings" />
      <SectionTitle>Recommendations</SectionTitle>
      <Plan rows={p.recommendations} />
    </section>
  );
}

export default function SecurityPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading, reload } = useApi<Assurance>(`/api/projects/${id}/assurance`);
  if (loading && !data) return <Loading label="Loading security and privacy assessment" />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Empty title="The assessment is not available yet" />;
  return (
    <div className="mx-auto max-w-[1100px] p-5 [overflow-wrap:anywhere]">
      <h1 className="font-serif text-2xl font-bold">Security &amp; Privacy</h1>
      <p className="mt-1 max-w-[75ch] text-muted">A security assessment and a personal-data (PII) review, built from the same evidence-backed findings as the Code Review, with OWASP Top 10 and CWE mapping, the controls found in the code, and what to fix first.</p>
      <nav className="mt-2 flex flex-wrap gap-3 text-sm" aria-label="On this page"><a href="#sec-h">Security assessment</a><a href="#pii-h">Privacy and PII</a></nav>
      <div className="card mt-3 grid gap-x-6 px-4 py-2 md:grid-cols-2">
        {(["security", "privacy"] as const).map((scope) => <div key={scope}>{(["pdf", "docx"] as const).map((f) => <FormatRow key={f} projectId={id} scope={scope} format={f} compact />)}</div>)}
      </div>
      <div className="mt-5"><SecurityView id={id} a={data.security} /></div>
      <div className="mt-8"><PrivacyView id={id} p={data.privacy} /></div>
      <div className="h-8" />
    </div>
  );
}
