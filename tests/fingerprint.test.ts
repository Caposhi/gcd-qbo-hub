import { describe, it, expect } from "vitest";
import { computeFingerprint, computeRowHash, fingerprintFields } from "@/lib/cashsheet/fingerprint";
import { parse } from "./fixtures";

const SS = "sheet123";

describe("row hash & fingerprint (§10, §11)", () => {
  it("is stable across row-number changes (identity ≠ position, §3, §22)", () => {
    const a = parse({ date: "7/7/2026", purpose: "PART", name: "Fusion", amountPaidOut: "100" }, 4);
    const b = parse({ date: "7/7/2026", purpose: "PART", name: "Fusion", amountPaidOut: "100" }, 42);
    expect(computeFingerprint(SS, "Jul", a)).toBe(computeFingerprint(SS, "Jul", b));
    expect(computeRowHash(SS, "Jul", a)).toBe(computeRowHash(SS, "Jul", b));
  });

  it("changes when a business field changes", () => {
    const a = parse({ date: "7/7/2026", purpose: "PART", amountPaidOut: "100" });
    const b = parse({ date: "7/7/2026", purpose: "PART", amountPaidOut: "150" });
    expect(computeFingerprint(SS, "Jul", a)).not.toBe(computeFingerprint(SS, "Jul", b));
  });

  it("differs across months even with identical amounts", () => {
    const r = parse({ date: "7/7/2026", purpose: "PART", amountPaidOut: "100" });
    expect(computeFingerprint(SS, "Jul", r)).not.toBe(computeFingerprint(SS, "Aug", r));
  });

  it("normalizes case/whitespace in fingerprint fields", () => {
    const a = parse({ date: "7/7/2026", purpose: "part", name: "  Fusion Auto ", amountPaidOut: "100" });
    const b = parse({ date: "7/7/2026", purpose: "PART", name: "FUSION AUTO", amountPaidOut: "100" });
    expect(computeFingerprint(SS, "Jul", a)).toBe(computeFingerprint(SS, "Jul", b));
  });

  it("row hash includes backup while fingerprint does not", () => {
    const a = parse({ date: "7/7/2026", purpose: "PART", amountPaidOut: "100", backup: "" });
    const b = parse({ date: "7/7/2026", purpose: "PART", amountPaidOut: "100", backup: "receipt.pdf" });
    expect(computeFingerprint(SS, "Jul", a)).toBe(computeFingerprint(SS, "Jul", b));
    expect(computeRowHash(SS, "Jul", a)).not.toBe(computeRowHash(SS, "Jul", b));
  });

  it("fingerprint tuple has the documented field count", () => {
    const r = parse({ date: "7/7/2026", purpose: "PART", amountPaidOut: "100" });
    expect(fingerprintFields(SS, "Jul", r)).toHaveLength(11);
  });
});
