import { describe, expect, it } from "vitest";
import { calculateTotal, toCents } from "../src/utils/pricing";

describe("pricing", () => {
  it("adds tax to the subtotal", () => {
    expect(calculateTotal([{ sku: "a", unitPrice: 10, quantity: 2 }], 0.1)).toBeCloseTo(22);
  });
  it("converts dollars to cents", () => {
    expect(toCents(1.99)).toBe(199);
  });
});
