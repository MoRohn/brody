import type { Node } from "./treesitter";

/** Node types that mark a branch for the rough complexity metric. */
export const BRANCH_TYPES = new Set([
  "if_statement", "for_statement", "for_in_statement", "while_statement", "do_statement", "switch_case", "case_clause", "catch_clause",
  "conditional_expression", "ternary_expression", "elif_clause", "except_clause", "match_arm", "when_entry", "for_range_loop", "foreach_statement",
  "expression_case", "type_case", "if_expression", "while_expression", "for_expression", "match_expression", "binary_expression",
]);

const BINARY_LOGICAL = /^(&&|\|\||and|or|\?\?)$/;

/**
 * Rough cyclomatic complexity for any node of one tree. The tree is walked once with a cursor (no per-node objects
 * cross the WebAssembly boundary) and every branch is recorded by source range; each later query is a binary search plus
 * a short scan (with one exact check for the rare node that shares its whole range with a branch). Asking per symbol instead re-walked nested code once for every enclosing symbol.
 */
export function createComplexity(root: Node): (n: Node) => number {
  let starts: number[] | undefined;
  let ends: number[] = [];
  let ids: number[] = [];
  let types: string[] = [];

  const build = () => {
    starts = [];
    ends = [];
    ids = [];
    types = [];
    const cur = root.walk();
    try {
      for (;;) {
        if (cur.nodeIsNamed && BRANCH_TYPES.has(cur.nodeType)) {
          let counts = true;
          if (cur.nodeType === "binary_expression") {
            const op = cur.currentNode.childForFieldName("operator");
            counts = !!op && BINARY_LOGICAL.test(op.type);
          }
          if (counts) { starts.push(cur.startIndex); ends.push(cur.endIndex); ids.push(cur.nodeId); types.push(cur.nodeType); }
        }
        if (cur.gotoFirstChild()) continue;
        while (!cur.gotoNextSibling()) if (!cur.gotoParent()) return;
      }
    } finally {
      cur.delete();
    }
  };

  return (n: Node): number => {
    if (!starts) build();
    const s = starts!;
    const from = n.startIndex;
    const to = n.endIndex;
    let lo = 0, hi = s.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (s[mid] < from) lo = mid + 1; else hi = mid; }
    let c = 1;
    for (let i = lo; i < s.length && s[i] < to; i++) {
      if (ends[i] > to) continue; // starts inside but ends outside: an ancestor that shares a start position
      if (s[i] === from && ends[i] === to) {
        // Same range as the queried node. It is either the node itself (not counted), an ancestor wrapping it exactly, or a
        // descendant that fills it exactly (a Rust `match` used as a statement). Only the last counts; ask the tree.
        if (ids[i] === n.id) continue;
        if (!n.descendantsOfType(types[i]).some((d) => d.id === ids[i])) continue;
      }
      c++;
    }
    return c;
  };
}
