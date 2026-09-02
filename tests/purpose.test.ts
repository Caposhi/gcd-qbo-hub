import { describe, it, expect } from "vitest";
import { normalizePurpose, resolvePurposeMapping, isKnownPurpose, effectivePurpose } from "@/lib/cashsheet/purpose";
import { buildSeedPurposeMappings } from "@/lib/cashsheet/seed-mappings";

const MAPPINGS = buildSeedPurposeMappings();

describe("purpose normalization & mapping (§5, §7)", () => {
  it("normalizes case and whitespace", () => {
    expect(normalizePurpose("  jose   pr ")).toBe("JOSE PR");
    expect(normalizePurpose("Part")).toBe("PART");
    expect(normalizePurpose("")).toBe("");
  });

  it("resolves seeded purposes flexibly", () => {
    expect(resolvePurposeMapping("part", MAPPINGS)?.qboAccountName).toBe("Cost of Goods Sold:Parts Cost");
    expect(resolvePurposeMapping("Jose PR", MAPPINGS)?.qboAccountName).toBe(
      "Cost of Goods Sold:LABOR Wages:OWNER - Contract Labor"
    );
    expect(resolvePurposeMapping("Friday Lunch", MAPPINGS)?.qboAccountName).toBe("Meals & Entertainment");
    expect(resolvePurposeMapping("INV", MAPPINGS)?.auditOnly).toBe(true);
  });

  it("employee loan mapping requires payee and manual approval", () => {
    const m = resolvePurposeMapping("Employee Loan", MAPPINGS);
    expect(m?.requiresPayee).toBe(true);
    expect(m?.requiresManualApproval).toBe(true);
  });

  it("unknown purpose does not resolve (§7, §22)", () => {
    expect(resolvePurposeMapping("MYSTERY THING", MAPPINGS)).toBeNull();
    expect(isKnownPurpose("MYSTERY THING", MAPPINGS)).toBe(false);
    expect(isKnownPurpose("", MAPPINGS)).toBe(false);
  });

  it("ignores inactive mappings", () => {
    const inactive = MAPPINGS.map((m) => ({ ...m, active: false }));
    expect(resolvePurposeMapping("PART", inactive)).toBeNull();
  });
});

describe("effectivePurpose — internal override fallback (real-world: JR SRVCS blank-purpose rows)", () => {
  it("the sheet's own purpose wins when it's non-blank", () => {
    expect(effectivePurpose("LOAN", "Should never be seen")).toBe("LOAN");
  });

  it("falls back to the override only when the sheet purpose is blank", () => {
    expect(effectivePurpose("", "JR SRVCS")).toBe("JR SRVCS");
    expect(effectivePurpose(null, "JR SRVCS")).toBe("JR SRVCS");
    expect(effectivePurpose(undefined, "JR SRVCS")).toBe("JR SRVCS");
  });

  it("whitespace-only sheet purpose counts as blank", () => {
    expect(effectivePurpose("   ", "JR SRVCS")).toBe("JR SRVCS");
  });

  it("blank sheet purpose with no override is still blank", () => {
    expect(effectivePurpose("", null)).toBe("");
    expect(effectivePurpose("", undefined)).toBe("");
  });

  it("an override resolves through the normal mapping table exactly like a sheet purpose would", () => {
    // Confirms the override is just a substitute input to the SAME resolution
    // path — not a bypass — so it still needs a real active mapping.
    expect(resolvePurposeMapping(effectivePurpose("", "Employee Loan"), MAPPINGS)?.requiresPayee).toBe(true);
    expect(resolvePurposeMapping(effectivePurpose("", "Some Made Up Thing"), MAPPINGS)).toBeNull();
  });
});
