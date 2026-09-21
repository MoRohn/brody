import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { bulkInsert, bulkUpdate, closeDatabase, getDb, projectRows, schema } from "@/lib/db/client";
import { computeImportance } from "@/lib/graph/build";
import { getFileContents } from "@/lib/ingest/store";
import { getCachedParses, parseCacheKey, putCachedParses } from "@/lib/parse/cache";
import { createComplexity } from "@/lib/parse/complexity";
import { grammarKeyFor, parseWithTreeSitter, type Node } from "@/lib/parse/treesitter";
import { emptyParse } from "@/lib/parse";
import { analyze, fixtureFiles, freshDb } from "./helpers";

let pid: string;
beforeAll(async () => {
  freshDb();
  pid = (await analyze(fixtureFiles(), "sample-shop")).projectId;
});

describe("bulk database access returns exactly what the ORM does", () => {
  it("projectRows matches db.select() for every table the pipeline reads", () => {
    const db = getDb();
    for (const table of [schema.files, schema.symbols, schema.relationships, schema.findings, schema.indexEntries] as const) {
      const viaOrm = db.select().from(table).where(eq(table.projectId, pid)).all();
      const viaBulk = projectRows(table, pid);
      expect(viaBulk.length).toBeGreaterThan(0);
      expect(viaBulk).toEqual(viaOrm);
    }
  });

  it("bulkInsert stores values that read back identically, and applies column defaults", () => {
    const db = getDb();
    const originals = db.select().from(schema.symbols).where(eq(schema.symbols.projectId, pid)).all().slice(0, 25);
    const copies = originals.map((s, i) => ({ ...s, id: `copy_${i}`, projectId: "prj_copy" }));
    bulkInsert(schema.symbols, copies);
    const back = db.select().from(schema.symbols).where(eq(schema.symbols.projectId, "prj_copy")).all();
    expect(back.map((r) => ({ ...r, id: "", projectId: "" }))).toEqual(originals.map((r) => ({ ...r, id: "", projectId: "" })));
    expect(originals.some((s) => s.meta && Object.keys(s.meta).length > 0) || originals.some((s) => s.exported)).toBe(true); // json and boolean columns were exercised

    const { inboundCount: _in, outboundCount: _out, ...partial } = originals[0]; // omitted columns fall back to their declared defaults
    void _in; void _out;
    bulkInsert(schema.symbols, [{ ...partial, id: "defaults_1", projectId: "prj_copy" }]);
    const d = db.select().from(schema.symbols).where(eq(schema.symbols.id, "defaults_1")).get()!;
    expect([d.inboundCount, d.outboundCount, d.importance >= 0]).toEqual([0, 0, true]);
    db.delete(schema.symbols).where(eq(schema.symbols.projectId, "prj_copy")).run();
  });

  it("bulkInsert can ignore conflicts and bulkUpdate changes only the named columns", () => {
    const db = getDb();
    const before = db.select().from(schema.files).where(eq(schema.files.projectId, pid)).all();
    const f = before[0];
    bulkUpdate(schema.files, ["id"], ["area", "role"], [{ id: f.id, area: "Renamed Area", role: "service" }]);
    const after = db.select().from(schema.files).where(eq(schema.files.id, f.id)).get()!;
    expect(after).toEqual({ ...f, area: "Renamed Area", role: "service" });
    bulkUpdate(schema.files, ["id"], ["area", "role"], [{ id: f.id, area: f.area, role: f.role }]);
    bulkInsert(schema.blobs, [{ hash: "dup", content: "one", size: 3 }], { ignoreConflicts: true });
    bulkInsert(schema.blobs, [{ hash: "dup", content: "two", size: 3 }], { ignoreConflicts: true });
    expect(db.select().from(schema.blobs).where(eq(schema.blobs.hash, "dup")).get()!.content).toBe("one");
  });

  it("parse cache round-trips in batches and treats unreadable entries as misses", () => {
    const a = { ...emptyParse("ast", "TypeScript"), identifiers: new Set(["alpha", "beta"]) };
    const keys = [parseCacheKey("TypeScript", "a.ts", "h1"), parseCacheKey("TypeScript", "b.ts", "h2")];
    putCachedParses([{ key: keys[0], parsed: a }, { key: keys[1], parsed: emptyParse("text", "none") }]);
    putCachedParses([{ key: keys[0], parsed: emptyParse("skipped", "none") }]); // a second write to the same key is ignored, as before
    getDb().insert(schema.parseCache).values({ key: "bad", payload: "{not json", createdAt: 1 }).run();
    const got = getCachedParses([...keys, "bad", "absent"]);
    expect([...got.keys()].sort()).toEqual([...keys].sort());
    expect(got.get(keys[0])!.identifiers).toEqual(new Set(["alpha", "beta"]));
    expect(got.get(keys[0])!.status).toBe("ast");
  });

  it("serves repeated blob reads from memory and forgets them when the database closes", () => {
    const hashes = projectRows(schema.files, pid).slice(0, 5).map((f) => f.hash);
    const first = getFileContents(hashes);
    expect(getFileContents(hashes)).toEqual(first);
    const other = "priming-check";
    bulkInsert(schema.blobs, [{ hash: other, content: "x", size: 1 }], { ignoreConflicts: true });
    expect(getFileContents([other]).get(other)).toBe("x");
    getDb().delete(schema.blobs).where(eq(schema.blobs.hash, other)).run();
    expect(getFileContents([other]).get(other)).toBe("x"); // content-addressed: a cached copy can never be stale
    closeDatabase();
    freshDb();
    expect(getFileContents([other]).size).toBe(0);
  });
});

/** The original implementation, kept here as the reference the fast one must reproduce. */
function referenceImportance(rels: { sourceId: string; targetId: string }[], nodeIds: string[], iterations = 20): Map<string, number> {
  const nodes = new Set(nodeIds);
  const out = new Map<string, string[]>();
  for (const r of rels) {
    if (!nodes.has(r.sourceId) || !nodes.has(r.targetId)) continue;
    const list = out.get(r.sourceId) ?? [];
    list.push(r.targetId);
    out.set(r.sourceId, list);
  }
  const n = nodes.size || 1;
  let rank = new Map<string, number>([...nodes].map((id) => [id, 1 / n]));
  const d = 0.85;
  for (let i = 0; i < iterations; i++) {
    const next = new Map<string, number>([...nodes].map((id) => [id, (1 - d) / n]));
    for (const id of nodes) {
      const targets = out.get(id);
      const r = rank.get(id) ?? 0;
      if (!targets || targets.length === 0) continue;
      const share = (d * r) / targets.length;
      for (const t of targets) next.set(t, (next.get(t) ?? 0) + share);
    }
    rank = next;
  }
  let max = 1e-9;
  for (const v of rank.values()) if (v > max) max = v;
  return new Map([...rank].map(([id, v]) => [id, v / max]));
}

describe("importance scores", () => {
  it("are bit-for-bit what the map-based PageRank produced", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const ids = Array.from({ length: 400 }, (_, i) => `n${i}`);
    const rels = Array.from({ length: 1500 }, () => ({ kind: "CALLS", sourceType: "symbol" as const, sourceId: ids[Math.floor(rnd() * 420)] ?? "ghost", targetType: "symbol" as const, targetId: ids[Math.floor(rnd() * 420)] ?? "ghost", confidence: 1 }));
    expect([...computeImportance(rels, ids)]).toEqual([...referenceImportance(rels, ids)]);
    expect([...computeImportance([], ["a", "b"])]).toEqual([...referenceImportance([], ["a", "b"])]);
    expect([...computeImportance(rels, [...ids, ...ids.slice(0, 50)], 5)]).toEqual([...referenceImportance(rels, [...ids, ...ids.slice(0, 50)], 5)]);
  });
});

const BRANCHES = new Set(["if_statement", "for_statement", "for_in_statement", "while_statement", "do_statement", "switch_case", "case_clause", "catch_clause", "conditional_expression", "ternary_expression", "elif_clause", "except_clause", "match_arm", "when_entry", "for_range_loop", "foreach_statement", "expression_case", "type_case", "if_expression", "while_expression", "for_expression", "match_expression", "binary_expression"]);
function referenceComplexity(n: Node): number {
  let c = 1;
  const stack: Node[] = [n];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const ch of cur.namedChildren) {
      if (BRANCHES.has(ch.type)) {
        if (ch.type === "binary_expression") { const op = ch.children.find((k) => !k.isNamed); if (op && /^(&&|\|\||and|or|\?\?)$/.test(op.text)) c++; } else c++;
      }
      stack.push(ch);
    }
  }
  return c;
}

describe("complexity metric", () => {
  const samples: [string, string, string][] = [
    ["TypeScript", "a.ts", "export function f(a: number, b?: number) {\n  if (a > 1 && b) { for (const x of [1]) { if (x || a) return x ?? 2; } }\n  const g = () => (a ? b : a) || 3;\n  try { g(); } catch (e) { return 0; }\n  switch (a) { case 1: return 1; case 2: return 2; default: return 3; }\n}\nclass K { m(x: number) { while (x) { x--; } return x > 1 ? 1 : 2; } }\n"],
    ["Python", "a.py", "def f(a, b):\n    if a and b:\n        for x in b:\n            if x or a:\n                return x\n    try:\n        pass\n    except ValueError:\n        return 0\n    return [y for y in b if y]\n"],
    ["Go", "a.go", "package main\nfunc f(a int, b int) int {\n\tif a > 1 && b > 2 {\n\t\tfor i := 0; i < a; i++ {\n\t\t\tif i == 3 || b == i { return i }\n\t\t}\n\t}\n\tswitch a { case 1: return 1; case 2: return 2 }\n\treturn 0\n}\n"],
    ["Java", "A.java", "class A { int f(int a, int b) { if (a > 1 && b > 2) { for (int i = 0; i < a; i++) { if (i == 3 || b == i) return i; } } try { return a > b ? a : b; } catch (Exception e) { return 0; } } }\n"],
    ["Rust", "a.rs", "fn f(a: i32, b: i32) -> i32 { if a > 1 && b > 2 { for i in 0..a { if i == 3 || b == i { return i; } } } match a { 1 => 1, 2 => 2, _ => 0 } }\n"],
  ];
  for (const [language, file, source] of samples) {
    it(`matches the node-by-node walk on every node of a ${language} file`, async () => {
      const key = grammarKeyFor(language, file)!;
      const tree = (await parseWithTreeSitter(key, source))!;
      const fast = createComplexity(tree.rootNode);
      const stack: Node[] = [tree.rootNode];
      let checked = 0;
      while (stack.length) {
        const n = stack.pop()!;
        expect(fast(n), `${n.type} @${n.startIndex}`).toBe(referenceComplexity(n));
        checked++;
        stack.push(...n.namedChildren);
      }
      expect(checked).toBeGreaterThan(20);
      tree.delete();
    });
  }
});
