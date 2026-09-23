"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { Chip, Empty, ErrorBox, Loading, SectionTitle, SourceLink, Stat } from "@/components/ui";
import { useApi } from "@/lib/client";
import type { FormalProperty, FormalReport, FormalTarget, PropertyOutcome } from "@/lib/formal/types";

const OUTCOME: Record<PropertyOutcome, { label: string; tone: "ok" | "danger" | "warn" | "info" | "neutral"; help: string }> = {
  defect: { label: "Defect proven", tone: "danger", help: "Lean proved a concrete input on which the code misbehaves, and the audit reproduced it on the source." },
  "confirms-claim": { label: "Claim confirmed", tone: "danger", help: "An AI review claim, confirmed by a machine-checked counterexample." },
  guarantee: { label: "Guarantee proven", tone: "ok", help: "Proved for every input the callers can pass." },
  "refutes-claim": { label: "Claim refuted", tone: "ok", help: "An AI review claim, disproved by a machine-checked proof and removed from the review." },
  disputed: { label: "Set aside", tone: "warn", help: "Lean accepted the proof, but the audit found that the model or the statement does not match the code, so it was not used." },
  unproven: { label: "Unproven", tone: "neutral", help: "No proof was accepted within the repair budget. This says nothing about whether the property holds." },
  refused: { label: "Refused", tone: "neutral", help: "The generated Lean used a construct that is not allowed, so it was not run." },
};
const ORDER: PropertyOutcome[] = ["defect", "confirms-claim", "refutes-claim", "guarantee", "disputed", "unproven", "refused"];

function Property({ id, t, p }: { id: string; t: FormalTarget; p: FormalProperty }) {
  const o = OUTCOME[p.outcome];
  return (
    <li className="min-w-0 border-t border-line py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={o.tone} title={o.help}>{o.label}</Chip>
        <span className="mono text-xs text-muted">{p.theorem}</span>
        {p.claimIndex !== null && t.claims[p.claimIndex] && <Chip title={t.claims[p.claimIndex].claim}>settles claim: {t.claims[p.claimIndex].title.slice(0, 60)}</Chip>}
        {p.findingCode && <Link className="text-xs" href={`/p/${id}/review?q=${encodeURIComponent(p.findingCode)}`}>Finding {p.findingCode} →</Link>}
      </div>
      <p className="mt-1">{p.claim}</p>
      {p.intent === "violated" && p.witness && <p className="mt-0.5 text-[13px]"><strong>Counterexample:</strong> {p.witness}</p>}
      <div className="mt-0.5 text-xs text-muted"><SourceLink projectId={id} cite={`${t.filePath}:${p.startLine}${p.endLine !== p.startLine ? `-${p.endLine}` : ""}`} />{p.proved && <> · axioms: <span className="mono">{p.axioms.join(", ") || "none"}</span></>}</div>
      {p.audit && <p className="mt-1 text-[13px] text-muted"><strong>Audit:</strong> {!p.audit.statementMatchesClaim && "statement does not match the claim. "}{!p.audit.hypothesesRealistic && "hypotheses are not realistic. "}{p.audit.witnessOnSource === "does_not_reproduce" && "the counterexample does not reproduce on the source. "}{p.audit.note}</p>}
      <details className="mt-1">
        <summary className="cursor-pointer text-xs text-muted">Lean theorem{p.errors.length ? " and Lean's errors" : ""}</summary>
        <pre tabIndex={0} className="mt-1 max-h-72 text-[12px]">{p.lean}</pre>
        {p.errors.length > 0 && <pre tabIndex={0} className="mt-1 max-h-48 text-[12px]" style={{ color: "var(--muted)" }}>{p.errors.join("\n\n")}</pre>}
      </details>
    </li>
  );
}

function Target({ id, t }: { id: string; t: FormalTarget }) {
  const props = [...t.properties].sort((a, b) => ORDER.indexOf(a.outcome) - ORDER.indexOf(b.outcome));
  return (
    <section className="card min-w-0 p-4 [overflow-wrap:anywhere]" id={t.id} aria-label={`Formal model of ${t.symbol}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mono text-[15px] font-bold">{t.symbol}</h2>
        <span className="text-xs text-muted">{t.kind} · {t.language} · complexity {t.complexity}</span>
        {t.status === "checked" ? (t.modelFaithful === false ? <Chip tone="warn" title={t.divergences.join("\n")}>model diverges from the source</Chip> : t.modelFaithful ? <Chip tone="ok">model audited as faithful</Chip> : null) : <Chip>{t.status === "not-modelable" ? "not modelable" : "not checked"}</Chip>}
        {t.cached && <Chip tone="info" title="The function is unchanged since the last analysis, so its proofs were reused">reused</Chip>}
      </div>
      <div className="mt-0.5 text-sm"><SourceLink projectId={id} cite={`${t.filePath}:${t.startLine}-${t.endLine}`} /> <span className="text-xs text-muted">· chosen for: {t.reasons.join(", ")}</span></div>
      {t.note && <p className="mt-1 text-[13px] text-muted">{t.note}</p>}
      {t.assumptions.length > 0 && <div className="mt-2 text-[13px]"><span className="h-label">Modelling assumptions</span><ul className="list-disc pl-5 text-muted">{t.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul></div>}
      {t.divergences.length > 0 && <div className="mt-2 text-[13px]"><span className="h-label">Divergences found by the audit</span><ul className="list-disc pl-5 text-muted">{t.divergences.map((a, i) => <li key={i}>{a}</li>)}</ul></div>}
      {props.length > 0 && <ul className="mt-2">{props.map((p) => <Property key={p.theorem} id={id} t={t} p={p} />)}</ul>}
      {t.lean && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-muted">Complete Lean file checked ({t.rounds} round{t.rounds === 1 ? "" : "s"}, {(t.ms / 1000).toFixed(1)} s)</summary>
          <pre tabIndex={0} className="mt-1 max-h-[480px] text-[12px]">{t.lean}</pre>
        </details>
      )}
    </section>
  );
}

export default function ProofsPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading, reload } = useApi<{ formal: FormalReport | null }>(`/api/projects/${id}/formal`);
  const [show, setShow] = useState<"all" | "findings">("all");
  const f = data?.formal;
  const targets = useMemo(() => (f?.targets ?? []).filter((t) => show === "all" || t.properties.some((p) => ["defect", "confirms-claim", "refutes-claim"].includes(p.outcome))), [f, show]);
  if (loading && !data) return <Loading label="Loading formal verification" />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;

  return (
    <div className="mx-auto max-w-[1100px] space-y-3 p-5">
      <h1 className="font-serif text-2xl font-bold">Formal Proofs</h1>
      <p className="max-w-[820px] text-[14px] text-muted">
        The most complex and riskiest functions are modelled in Lean 4, and properties about them are checked by Lean&apos;s proof kernel. A result is used only when Lean proves it with nothing beyond its standard axioms, and an audit confirms that the model matches the source and that every counterexample reproduces on the original code. Defects proven here are exact: they come with the input that triggers them.
      </p>
      {!f ? <Empty title="No formal verification for this analysis">Re-analyse the project to run it.</Empty> : f.status === "skipped" ? (
        <Empty title="Formal verification did not run">{f.reason}</Empty>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Stat label="Functions modelled" value={f.totals.checked} sub={`of ${f.totals.targets} chosen · Lean ${f.lean}`} />
            <Stat label="Theorems proved" value={f.totals.proved} sub={`${f.totals.guarantees} guarantees`} />
            <Stat label="Defects proven" value={f.totals.defects + f.totals.claimsConfirmed} sub={`${f.totals.claimsConfirmed} confirm AI review claims`} />
            <Stat label="False positives removed" value={f.totals.claimsRefuted} sub={f.totals.disputed ? `${f.totals.disputed} proofs set aside by the audit` : "AI claims disproved"} />
          </div>
          <SectionTitle right={<label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={show === "findings"} onChange={(e) => setShow(e.target.checked ? "findings" : "all")} />Only results that changed the review</label>}>Modelled functions ({targets.length})</SectionTitle>
          {targets.length === 0 ? <Empty title="Nothing to show">{show === "findings" ? "No proof changed the review." : "No function qualified for a formal model."}</Empty> : targets.map((t) => <Target key={t.id} id={id} t={t} />)}
          <p className="text-xs text-muted">Models written by {f.model}. Lean checks the proofs; the model and the statements are checked by the audit, which is a judgement, so every proof shows the assumptions it rests on.</p>
        </>
      )}
    </div>
  );
}
