import { describe, it, expect } from "vitest";
import { payeeTokens, nameSimilarity, bestVendorMatch, type VendorOption } from "@/lib/checks/match";

describe("payeeTokens", () => {
  it("uppercases, splits on non-alphanumerics, and drops corporate stopwords", () => {
    expect(payeeTokens("Interstate Batteries, Inc.")).toEqual(["INTERSTATE", "BATTERIES"]);
    expect(payeeTokens("The Gunther Co.")).toEqual(["GUNTHER"]);
  });
  it("is empty for blank input", () => {
    expect(payeeTokens("")).toEqual([]);
    expect(payeeTokens(null)).toEqual([]);
  });
});

describe("nameSimilarity", () => {
  it("scores exact normalized equality as 1", () => {
    expect(nameSimilarity("NAPA", "napa")).toBe(1);
  });
  it("scores containment high (read name inside the fuller QBO name)", () => {
    expect(nameSimilarity("Interstate Batteries", "Interstate Batteries, Inc.")).toBeGreaterThanOrEqual(0.9);
  });
  it("scores partial token overlap between 0 and 1", () => {
    const s = nameSimilarity("Lauderdale BMW", "Lauderdale Imports");
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(0.9);
  });
  it("scores unrelated names 0", () => {
    expect(nameSimilarity("NAPA", "Interstate Batteries")).toBe(0);
  });
});

describe("bestVendorMatch", () => {
  const vendors: VendorOption[] = [
    { id: "1", name: "Interstate Batteries, Inc." },
    { id: "2", name: "NAPA Auto Parts" },
    { id: "3", name: "Lauderdale BMW" },
    { id: "4", name: "Gunther Motor Company" },
  ];

  it("matches a read payee to the closest vendor despite suffix differences", () => {
    expect(bestVendorMatch("Interstate Batteries", vendors)?.id).toBe("1");
    expect(bestVendorMatch("NAPA", vendors)?.id).toBe("2");
    expect(bestVendorMatch("Lauderdale BMW", vendors)?.id).toBe("3");
    expect(bestVendorMatch("Gunther", vendors)?.id).toBe("4");
  });

  it("returns null when nothing clears the threshold", () => {
    expect(bestVendorMatch("Branif", vendors)).toBeNull();
    expect(bestVendorMatch("", vendors)).toBeNull();
  });

  it("is deterministic on ties", () => {
    const tie: VendorOption[] = [
      { id: "b", name: "Auto Shop B" },
      { id: "a", name: "Auto Shop A" },
    ];
    // Equal scores → lower name wins ("Auto Shop A").
    expect(bestVendorMatch("Auto Shop", tie)?.id).toBe("a");
  });
});
