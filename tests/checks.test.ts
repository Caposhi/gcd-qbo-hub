import { describe, it, expect } from "vitest";
import {
  normalizePayee,
  findPayeeMapping,
  classifyExtractedCheck,
  type ExtractedCheck,
  type PayeeMappingLike,
} from "@/lib/checks/classify";

const MAPPING: PayeeMappingLike = {
  normalizedPayee: "BOBSAUTOPARTS",
  payeeDisplay: "Bob's Auto Parts",
  qboVendorId: "42",
  qboVendorName: "Bob's Auto Parts",
  categoryAccountId: "77",
  categoryAccountName: "Parts & Supplies",
};

function check(overrides: Partial<ExtractedCheck> = {}): ExtractedCheck {
  return {
    page: 1,
    checkNumber: "1042",
    amount: 250.0,
    date: "2026-07-01",
    payee: "Bob's Auto Parts",
    memo: "brake pads",
    confidence: "high",
    ...overrides,
  };
}

describe("normalizePayee", () => {
  it("collapses case, punctuation, and spacing to one key", () => {
    expect(normalizePayee("Bob's Auto Parts, LLC")).toBe("BOBSAUTOPARTSLLC");
    expect(normalizePayee("BOB'S AUTO PARTS, LLC")).toBe("BOBSAUTOPARTSLLC");
    expect(normalizePayee("  bobs   auto  parts llc ")).toBe("BOBSAUTOPARTSLLC");
  });

  it("is empty for blank / nullish input", () => {
    expect(normalizePayee("")).toBe("");
    expect(normalizePayee(null)).toBe("");
    expect(normalizePayee(undefined)).toBe("");
  });
});

describe("findPayeeMapping", () => {
  it("matches ignoring punctuation and case", () => {
    expect(findPayeeMapping([MAPPING], "BOBS AUTO PARTS")).toBe(MAPPING);
    expect(findPayeeMapping([MAPPING], "bob's auto parts")).toBe(MAPPING);
  });

  it("returns undefined for an unknown or blank payee", () => {
    expect(findPayeeMapping([MAPPING], "Napa")).toBeUndefined();
    expect(findPayeeMapping([MAPPING], "")).toBeUndefined();
    expect(findPayeeMapping([], "Bob's Auto Parts")).toBeUndefined();
  });
});

describe("classifyExtractedCheck", () => {
  it("marks ready and pre-fills vendor+category when a complete mapping matches a good read", () => {
    const r = classifyExtractedCheck(check(), MAPPING);
    expect(r.status).toBe("ready");
    expect(r.qboVendorId).toBe("42");
    expect(r.categoryAccountId).toBe("77");
    expect(r.payeeResolved).toBe("Bob's Auto Parts");
  });

  it("needs review when there is no learned mapping (first check to a payee)", () => {
    const r = classifyExtractedCheck(check(), undefined);
    expect(r.status).toBe("needs_review");
    expect(r.reason).toMatch(/no learned payee mapping/);
    // Falls back to the raw payee so the confirm form is pre-filled.
    expect(r.payeeResolved).toBe("Bob's Auto Parts");
    expect(r.qboVendorId).toBeNull();
  });

  it("needs review on a low-confidence read even with a mapping", () => {
    const r = classifyExtractedCheck(check({ confidence: "low" }), MAPPING);
    expect(r.status).toBe("needs_review");
    expect(r.reason).toMatch(/low-confidence/);
  });

  it("needs review when the check number or amount could not be read", () => {
    expect(classifyExtractedCheck(check({ checkNumber: null }), MAPPING).status).toBe("needs_review");
    expect(classifyExtractedCheck(check({ amount: null }), MAPPING).status).toBe("needs_review");
    expect(classifyExtractedCheck(check({ amount: 0 }), MAPPING).status).toBe("needs_review");
  });

  it("needs review when the mapping is incomplete (missing vendor or category)", () => {
    const partial = { ...MAPPING, categoryAccountId: null };
    const r = classifyExtractedCheck(check(), partial);
    expect(r.status).toBe("needs_review");
    expect(r.reason).toMatch(/incomplete/);
  });
});
