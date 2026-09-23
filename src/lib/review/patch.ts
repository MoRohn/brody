/**
 * Minimal unified-diff applier used to validate AI-suggested patches against
 * the real file before they are shown. A patch that does not apply cleanly is
 * discarded rather than presented as fact.
 */
export interface PatchResult {
  ok: boolean;
  result?: string;
  reason?: string;
}

interface Hunk {
  /** 1-based line the hunk starts at, or null for a header without line numbers ("@@"), as some models write them. */
  oldStart: number | null;
  lines: { op: " " | "-" | "+"; text: string }[];
}

function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  for (const raw of diff.split("\n")) {
    const h = raw.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/);
    if (h || /^@@(\s*@@)?(\s.*)?$/.test(raw)) {
      cur = { oldStart: h ? Number(h[1]) : null, lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    // File headers, and the envelope of the "*** Begin Patch" format, carry no content.
    if (raw.startsWith("--- ") || raw.startsWith("+++ ") || raw.startsWith("*** ")) continue;
    if (raw.startsWith("\\")) continue;
    const op = raw[0];
    if (op === " " || op === "-" || op === "+") cur.lines.push({ op, text: raw.slice(1) });
    else if (raw === "") cur.lines.push({ op: " ", text: "" });
  }
  return hunks.filter((x) => x.lines.length > 0);
}

export function applyUnifiedDiff(original: string, diff: string): PatchResult {
  const hunks = parseHunks(diff);
  if (hunks.length === 0) return { ok: false, reason: "no hunks found" };
  const lines = original.split("\n");
  let offset = 0;
  for (const h of hunks) {
    const oldLines = h.lines.filter((l) => l.op !== "+").map((l) => l.text);
    const newLines = h.lines.filter((l) => l.op !== "-").map((l) => l.text);
    if (!oldLines.some((l) => l.trim())) return { ok: false, reason: "hunk has no anchoring context" };
    const matches = (at: number) => at >= 0 && at + oldLines.length <= lines.length && oldLines.every((l, i) => lines[at + i].trimEnd() === l.trimEnd());
    if (h.oldStart === null) {
      // No line numbers: the removed and context lines must occur exactly once, so the patch cannot land in the wrong place.
      const at: number[] = [];
      for (let i = 0; i + oldLines.length <= lines.length && at.length < 2; i++) if (matches(i)) at.push(i);
      if (at.length === 0) return { ok: false, reason: "hunk does not match the file" };
      if (at.length > 1) return { ok: false, reason: "hunk without line numbers matches more than one place" };
      lines.splice(at[0], oldLines.length, ...newLines);
      offset += newLines.length - oldLines.length;
      continue;
    }
    let pos = h.oldStart - 1 + offset;
    if (!matches(pos)) {
      let found = -1;
      for (let d = 1; d <= 40 && found < 0; d++) {
        if (matches(pos - d)) found = pos - d;
        else if (matches(pos + d)) found = pos + d;
      }
      if (found < 0) return { ok: false, reason: `hunk at line ${h.oldStart} does not match the file` };
      pos = found;
    }
    lines.splice(pos, oldLines.length, ...newLines);
    offset += newLines.length - oldLines.length;
  }
  return { ok: true, result: lines.join("\n") };
}
