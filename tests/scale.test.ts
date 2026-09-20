import { describe, expect, it } from "vitest";
import { computeImportance } from "@/lib/graph/build";
import { maxOf, pushAll } from "@/lib/util/arrays";

/** Repository-sized inputs must not overflow the call stack (a spread of ~100k+ arguments does). */
describe("very large repositories", () => {
  it("ranks 300,000 symbols without 'Maximum call stack size exceeded'", () => {
    const ids = Array.from({ length: 300_000 }, (_, i) => `s${i}`);
    const rels = ids.slice(1).map((id, i) => ({ sourceId: id, targetId: "s0", kind: "CALLS", i })) as never[];
    const scores = computeImportance(rels, ids, 3);
    expect(scores.size).toBe(300_000);
    expect(scores.get("s0")).toBe(1); // the most-called symbol is normalised to 1
    expect(scores.get("s1")!).toBeLessThan(0.01);
  });

  it("the spread it replaced does overflow at this size, so the guard is real", () => {
    const big = Array.from({ length: 300_000 }, (_, i) => i);
    expect(() => Math.max(...big)).toThrow(RangeError);
    expect(maxOf(big)).toBe(299_999);
  });

  it("maxOf and pushAll handle empty, large and iterable inputs", () => {
    expect(maxOf([], 5)).toBe(5);
    expect(maxOf(new Set([3, 9, 4]).values(), 1e-9)).toBe(9);
    const target: number[] = [];
    pushAll(target, Array.from({ length: 500_000 }, (_, i) => i));
    expect(target).toHaveLength(500_000);
    expect(() => [].push(...(Array.from({ length: 500_000 }, (_, i) => i) as never[]))).toThrow(RangeError);
  });
});
