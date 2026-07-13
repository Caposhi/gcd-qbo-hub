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
  it("scores unrelated names well below the match threshold", () => {
    // A small char-level floor is fine; it must stay far under bestVendorMatch's
    // 0.68 threshold so unrelated vendors never auto-suggest.
    expect(nameSimilarity("NAPA", "Interstate Batteries")).toBeLessThan(0.4);
  });
});

describe("bestVendorMatch", () => {
  // The real QBO names as they actually differ from the handwritten reads
  // (from the owner's July check batch).
  const vendors: VendorOption[] = [
    { id: "1", name: "Interstate Battery" }, // read as "Interstate Batteries"
    { id: "2", name: "Napa" }, // read as "NAPA"
    { id: "3", name: "Ft. Lauderdale BMW" }, // read as "Lauderdale BMW"
    { id: "4", name: "Gunther Motor Company" }, // read as "Gunther"
    { id: "5", name: "Branif Enterprises" }, // read as "Branif"
  ];

  it("matches reads to existing vendors despite plural/partial/spelling drift", () => {
    expect(bestVendorMatch("Interstate Batteries", vendors)?.id).toBe("1");
    expect(bestVendorMatch("NAPA", vendors)?.id).toBe("2");
    expect(bestVendorMatch("Lauderdale BMW", vendors)?.id).toBe("3");
    expect(bestVendorMatch("Gunther", vendors)?.id).toBe("4");
    expect(bestVendorMatch("Branif", vendors)?.id).toBe("5");
  });

  it("returns null when nothing clears the threshold", () => {
    expect(bestVendorMatch("Home Depot", vendors)).toBeNull();
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
