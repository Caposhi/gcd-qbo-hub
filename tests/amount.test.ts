import { describe, it, expect } from "vitest";
import { parseCurrency, parsePositiveAmount, hasAmount } from "@/lib/cashsheet/amount";

describe("amount parsing (§5)", () => {
  it("parses common formats", () => {
    expect(parseCurrency("$1,080.00")).toBe(1080);
    expect(parseCurrency("1080")).toBe(1080);
    expect(parseCurrency("1,080")).toBe(1080);
    expect(parseCurrency("800.00")).toBe(800);
    expect(parseCurrency(800)).toBe(800);
  });

  it("treats accounting parentheses and minus as negative", () => {
    expect(parseCurrency("(1,080.00)")).toBe(-1080);
    expect(parseCurrency("-50")).toBe(-50);
  });

  it("returns null for empty / non-numeric cells", () => {
    expect(parseCurrency("")).toBeNull();
    expect(parseCurrency("   ")).toBeNull();
    expect(parseCurrency(null)).toBeNull();
    expect(parseCurrency(undefined)).toBeNull();
    expect(parseCurrency("abc")).toBeNull();
    expect(parseCurrency("1.2.3")).toBeNull();
  });

  it("requires strictly positive amounts for transactions", () => {
    expect(parsePositiveAmount("$1,080.00")).toBe(1080);
    expect(parsePositiveAmount("0")).toBeNull();
    expect(parsePositiveAmount("(50)")).toBeNull();
    expect(parsePositiveAmount("-50")).toBeNull();
  });

  it("hasAmount detects any parseable value including zero", () => {
    expect(hasAmount("0")).toBe(true);
    expect(hasAmount("$5")).toBe(true);
    expect(hasAmount("")).toBe(false);
  });
});
