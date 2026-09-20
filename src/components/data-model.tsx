"use client";
import { useMemo, useState } from "react";
import type { ModelInfo, ModelRelation } from "@/lib/discover/types";
import { MermaidView } from "./mermaid";
import { Chip, SourceLink } from "./ui";

const CARD: Record<ModelRelation["cardinality"], { glyph: string; label: string }> = {
  one: { glyph: "1", label: "exactly one" },
  many: { glyph: "*", label: "many" },
  optional: { glyph: "0..1", label: "zero or one" },
};

const idOf = (m: ModelInfo) => m.id ?? `${m.file}#${m.name}`;

/** Relations for a model, with a fallback for projects analysed before typed relations were recorded. */
function relationsOf(m: ModelInfo, all: ModelInfo[]): ModelRelation[] {
  if (m.relations) return m.relations;
  return m.references.flatMap((r) => { const t = all.find((x) => x.name === r); return t ? [{ target: idOf(t), targetName: t.name, via: "reference", cardinality: "one" as const, source: "foreign-key" as const }] : []; });
}

/** The data model map: an entity-relationship diagram, then every model with typed fields and both directions of its relationships. */
export function DataModelMap({ id, models, er }: { id: string; models: ModelInfo[]; er?: string }) {
  const [q, setQ] = useState("");
  const byId = useMemo(() => new Map(models.map((m) => [idOf(m), m])), [models]);
  const outgoing = useMemo(() => new Map(models.map((m) => [idOf(m), relationsOf(m, models)])), [models]);
  const incoming = useMemo(() => {
    const inc = new Map<string, { from: ModelInfo; rel: ModelRelation }[]>();
    for (const m of models) for (const r of outgoing.get(idOf(m)) ?? []) { const l = inc.get(r.target) ?? []; l.push({ from: m, rel: r }); inc.set(r.target, l); }
    return inc;
  }, [models, outgoing]);
  const total = [...outgoing.values()].reduce((n, l) => n + l.length, 0);
  const isolated = models.filter((m) => (outgoing.get(idOf(m))?.length ?? 0) === 0 && !(incoming.get(idOf(m))?.length)).length;
  const duplicated = new Set(models.filter((m) => models.filter((x) => x.name === m.name).length > 1).map((m) => m.name));
  const shown = models
    .filter((m) => !q || `${m.name} ${m.file} ${m.fields.join(" ")}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => ((outgoing.get(idOf(b))?.length ?? 0) + (incoming.get(idOf(b))?.length ?? 0)) - ((outgoing.get(idOf(a))?.length ?? 0) + (incoming.get(idOf(a))?.length ?? 0)) || a.name.localeCompare(b.name));

  const nameOf = (m: ModelInfo) => (duplicated.has(m.name) ? `${m.name} (${m.file.split("/").slice(-2).join("/")})` : m.name);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
        <span><strong className="text-fg">{models.length}</strong> model{models.length === 1 ? "" : "s"}</span>
        <span><strong className="text-fg">{total}</strong> relationship{total === 1 ? "" : "s"}</span>
        {isolated > 0 && <span>{isolated} with no relationships</span>}
        <span className="ml-auto flex flex-wrap items-center gap-2 text-xs" aria-label="Relationship legend">
          <span className="h-label">Legend</span>
          {Object.values(CARD).map((c) => <span key={c.label}><code>{c.glyph}</code> {c.label}</span>)}
        </span>
      </div>

      {er ? <MermaidView code={er} title="Entity relationships: each line is a field that points at another model" /> : <p className="text-sm text-muted">No diagram could be drawn.</p>}

      {models.length > 8 && <input className="input max-w-[320px]" placeholder={`Filter ${models.length} models…`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter data models" />}
      {/* relative: the screen-reader-only text in the cells is absolutely positioned and must be clipped by this scroller, not stretch the page */}
      <div className="card relative overflow-x-auto">
        <table className="tbl">
          <thead><tr><th>Model</th><th>Fields</th><th>Points to</th><th>Referenced by</th></tr></thead>
          <tbody>
            {shown.map((m) => {
              const out = outgoing.get(idOf(m)) ?? [];
              const inn = incoming.get(idOf(m)) ?? [];
              const relFields = new Set(out.map((r) => r.via));
              const typed = m.fieldTypes?.length ? m.fieldTypes : m.fields.map((n) => ({ name: n, type: "" }));
              return (
                <tr key={idOf(m)}>
                  <td className="min-w-[170px] align-top">
                    <SourceLink projectId={id} cite={`${m.file}:${m.line}-${m.endLine}`}>{m.name}</SourceLink>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1">{m.orm && <Chip tone="info">{m.orm.length > 26 ? `${m.orm.slice(0, 24)}…` : m.orm}</Chip>}{!m.orm && <Chip>{m.kind}</Chip>}</div>
                    <div className="mono mt-0.5 break-all text-[11px] text-muted">{m.file}</div>
                  </td>
                  <td className="min-w-[260px] align-top">
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[12px]">
                      {typed.slice(0, 14).map((f) => (
                        <span key={f.name} className="mono whitespace-nowrap" style={relFields.has(f.name) ? { color: "var(--link)", fontWeight: 600 } : undefined}>{f.name}{f.type && <span className="text-muted">: {f.type.length > 28 ? `${f.type.slice(0, 26)}…` : f.type}</span>}</span>
                      ))}
                      {typed.length > 14 && <span className="text-muted">+{typed.length - 14} more</span>}
                      {typed.length === 0 && <span className="text-muted">fields not detected</span>}
                    </div>
                  </td>
                  <td className="min-w-[170px] align-top">
                    {out.length === 0 ? <span className="text-muted">nothing</span> : <ul className="space-y-0.5 text-[12px]">{out.map((r, i) => <li key={i}><span className="mono">{r.via}</span> <span className="text-muted" aria-hidden>→</span><span className="sr-only"> points to </span> <strong>{byId.get(r.target) ? nameOf(byId.get(r.target)!) : r.targetName}</strong> <span className="text-muted" title={CARD[r.cardinality].label}>[{CARD[r.cardinality].glyph}]</span></li>)}</ul>}
                  </td>
                  <td className="min-w-[150px] align-top">
                    {inn.length === 0 ? <span className="text-muted">nothing</span> : <ul className="space-y-0.5 text-[12px]">{inn.map((x, i) => <li key={i}><strong>{nameOf(x.from)}</strong> <span className="text-muted">via</span> <span className="mono">{x.rel.via}</span></li>)}</ul>}
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && <tr><td colSpan={4} className="text-muted">No model matches.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
