/**
 * Text and diagram renderings of an ExplanationArtifactSpec. They read the same spec as the video, so the prose, the
 * diagram, the interactive player and the video say the same things about the same parts. Browser-safe.
 */
import { controlNarration, splitSentences } from "./speech";
import type { ExplanationArtifactSpec } from "./types";

export interface ClearSection { id: string; title: string; paragraphs: { text: string; claimIds: string[]; sourceIds: string[] }[] }
export interface ClearText { title: string; summary: string; objectives: string[]; sections: ClearSection[]; caveats: string[]; uncertainties: string[] }

/** Clear explanation: the spec's sections in teaching order, each claim rewritten as controlled technical English. */
export function clearText(spec: ExplanationArtifactSpec, opts: { controlled?: boolean } = {}): ClearText {
  const byId = new Map(spec.claims.map((c) => [c.id, c]));
  const controlled = opts.controlled ?? true;
  const seen = new Set<string>();
  const sections: ClearSection[] = spec.narrative.sections.map((s) => ({
    id: s.id,
    title: s.title,
    paragraphs: s.claimIds.map((id) => byId.get(id)).filter((c) => !!c && c.supported && !seen.has(c.id)).map((c) => {
      seen.add(c!.id);
      return { text: controlled ? controlNarration(c!.text, { maxWords: 24 }) : c!.text, claimIds: [c!.id], sourceIds: c!.sourceIds };
    }),
  })).filter((s) => s.paragraphs.length);
  return {
    title: spec.title,
    summary: controlled ? splitSentences(controlNarration(spec.summary, { maxWords: 24 })).slice(0, 3).join(" ") : spec.summary,
    objectives: spec.objectives,
    sections,
    caveats: spec.caveats ?? [],
    uncertainties: (spec.uncertainties ?? []).map((u) => u.text),
  };
}

const mid = (id: string) => id.replace(/[^A-Za-z0-9_]/g, "_");
const label = (s: string) => s.replace(/["`<>{}|[\]]/g, "'").slice(0, 48);

/** A Mermaid flowchart of the concepts and relationships, with containment as subgraphs. */
export function mermaidDiagram(spec: ExplanationArtifactSpec): string | null {
  const concepts = spec.concepts.filter((k) => k.kind !== "idea" || spec.relationships.some((r) => r.from === k.id || r.to === k.id));
  if (concepts.length < 2) return null;
  const lines = ["flowchart LR"];
  const parents = new Set(concepts.map((k) => k.parentId).filter((x): x is string => !!x));
  const emit = (k: (typeof concepts)[number], indent: string) => {
    const name = `${label(k.name)}${k.count ? ` ×${k.count}` : ""}`;
    lines.push(`${indent}${mid(k.id)}${k.glyph === "database" ? `[("${name}")]` : k.glyph === "user" ? `(["${name}"])` : `["${name}"]`}`);
  };
  for (const k of concepts.filter((x) => !x.parentId || !concepts.some((p) => p.id === x.parentId))) {
    if (parents.has(k.id)) {
      lines.push(`  subgraph ${mid(k.id)}_group["${label(k.name)}"]`);
      for (const c of concepts.filter((x) => x.parentId === k.id)) emit(c, "    ");
      lines.push("  end");
    } else emit(k, "  ");
  }
  const ids = new Set(concepts.map((k) => k.id));
  for (const r of spec.relationships) {
    if (!ids.has(r.from) || !ids.has(r.to) || r.kind === "contains") continue;
    const from = parents.has(r.from) ? `${mid(r.from)}_group` : mid(r.from);
    const to = parents.has(r.to) ? `${mid(r.to)}_group` : mid(r.to);
    const arrow = r.kind === "blocks" || r.kind === "contends_with" ? "-.->" : "-->";
    lines.push(`  ${from} ${arrow}|"${label(r.label)}"| ${to}`);
  }
  return lines.join("\n");
}
