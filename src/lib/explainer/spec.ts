/**
 * Integrity of an ExplanationArtifactSpec. A spec is valid when every reference resolves (section → claim → evidence →
 * source, concept → parent, relationship → concepts, metric → claims) and nothing a renderer will show rests on an
 * unsupported claim. Browser-safe.
 */
import type { ExplanationArtifactSpec } from "./types";

export interface SpecIssue { path: string; message: string; severity: "error" | "warning" }

export function validateSpec(spec: ExplanationArtifactSpec): { ok: boolean; issues: SpecIssue[] } {
  const issues: SpecIssue[] = [];
  const err = (path: string, message: string) => issues.push({ path, message, severity: "error" });
  const warn = (path: string, message: string) => issues.push({ path, message, severity: "warning" });
  const unique = (kind: string, ids: string[]) => { const seen = new Set<string>(); for (const id of ids) { if (seen.has(id)) err(kind, `duplicate id ${id}`); seen.add(id); } return seen; };

  if (!spec.title.trim()) err("title", "empty title");
  if (!spec.sourceRunId) err("sourceRunId", "missing source result");
  const sources = unique("sources", spec.sources.map((s) => s.id));
  const evidence = unique("evidence", spec.evidence.map((e) => e.id));
  const claims = unique("claims", spec.claims.map((c) => c.id));
  const concepts = unique("concepts", spec.concepts.map((c) => c.id));
  unique("sections", spec.narrative.sections.map((s) => s.id));
  const claimById = new Map(spec.claims.map((c) => [c.id, c]));

  for (const s of spec.sources) if (s.kind === "code" && (!s.path || !s.startLine || !s.endLine || s.endLine < s.startLine)) err(`sources.${s.id}`, "code source without a valid line range");
  for (const e of spec.evidence) if (!sources.has(e.sourceId)) err(`evidence.${e.id}`, `unknown source ${e.sourceId}`);
  for (const c of spec.claims) {
    for (const s of c.sourceIds) if (!sources.has(s)) err(`claims.${c.id}`, `unknown source ${s}`);
    for (const e of c.evidenceIds) if (!evidence.has(e)) err(`claims.${c.id}`, `unknown evidence ${e}`);
    if (c.supported && c.sourceIds.length === 0) err(`claims.${c.id}`, "marked supported but cites no source");
  }
  const checkClaims = (path: string, ids: string[], mustBeSupported = true) => {
    for (const id of ids) {
      const c = claimById.get(id);
      if (!c) err(path, `unknown claim ${id}`);
      else if (mustBeSupported && !c.supported) err(path, `rests on unsupported claim ${id}`);
    }
  };
  for (const k of spec.concepts) {
    if (k.parentId && !concepts.has(k.parentId)) err(`concepts.${k.id}`, `unknown parent ${k.parentId}`);
    if (k.parentId === k.id) err(`concepts.${k.id}`, "is its own parent");
    checkClaims(`concepts.${k.id}`, k.claimIds);
  }
  for (const r of spec.relationships) {
    if (!concepts.has(r.from) || !concepts.has(r.to)) err(`relationships.${r.id}`, `connects unknown concept ${concepts.has(r.from) ? r.to : r.from}`);
    checkClaims(`relationships.${r.id}`, r.claimIds);
  }
  for (const m of spec.metrics ?? []) { checkClaims(`metrics.${m.id}`, m.claimIds); if (!m.claimIds.length) err(`metrics.${m.id}`, "a metric must be stated by a claim"); }
  for (const p of spec.processes) for (const st of p.steps) checkClaims(`processes.${p.id}.${st.id}`, st.claimIds);
  for (const c of spec.comparisons ?? []) checkClaims(`comparisons.${c.id}`, c.claimIds);
  for (const code of spec.codeReferences ?? []) if (!sources.has(code.sourceId)) err(`codeReferences.${code.id}`, `unknown source ${code.sourceId}`);
  if (!spec.narrative.sections.length) err("narrative.sections", "no sections to explain");
  for (const s of spec.narrative.sections) {
    if (!s.claimIds.length) err(`narrative.${s.id}`, "a section must explain at least one claim");
    checkClaims(`narrative.${s.id}`, s.claimIds);
    for (const k of s.conceptIds) if (!concepts.has(k)) err(`narrative.${s.id}`, `unknown concept ${k}`);
  }
  if (spec.confidence < 0 || spec.confidence > 1) err("confidence", "must be between 0 and 1");
  if (spec.claims.length && spec.claims.every((c) => !c.supported)) warn("claims", "no claim resolves to a source");
  void claims;
  return { ok: !issues.some((i) => i.severity === "error"), issues };
}
