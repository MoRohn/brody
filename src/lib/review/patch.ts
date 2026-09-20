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
  oldStart: number;
  lines: { op: " " | "-" | "+"; text: string }[];
}

function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  for (const raw of diff.split("\n")) {
    const h = raw.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/);
    if (h) {
      cur = { oldStart: Number(h[1]), lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith("--- ") || raw.startsWith("+++ ")) continue;
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
    let pos = h.oldStart - 1 + offset;
    const matches = (at: number) => at >= 0 && at + oldLines.length <= lines.length && oldLines.every((l, i) => lines[at + i].trimEnd() === l.trimEnd());
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
