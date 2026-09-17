import { describe, it, expect } from "vitest";
import { deriveLaborRateInputs } from "@/lib/tekmetric/labor-rate-bridge";
import type { PnlNormalized } from "@/lib/projections/reports";

// Fixture shaped after the post-resend July 2026 P&L in gcd-attribution's
// docs/tekmetric-audit/02c-qbo-labor-cost-structure.md section 7.2, so the
// expected outputs below double as an independent check against a real,
// previously-published figure (loading factor 9.54%, not just an arbitrary
// round number).
function fixturePnl(overrides: Partial<PnlNormalized> = {}): PnlNormalized {
  return {
    periods: ["Jul 2026"],
    income: [233900.96],
    cogs: [70923.66],
    grossProfit: [162977.30],
    expenses: [144169.69],
    netOperatingIncome: [18807.61],
    netIncome: [17964.35],
    incomeLines: [],
    expenseLines: [
      { label: "STAFF wages", values: [25935.05] },
      { label: "OWNER Salary", values: [11500.00] },
      { label: "Payroll Taxes (941)", values: [4877.21] },
      { label: "Payroll Fees", values: [600.45] },
      { label: "Retirement Plan", values: [907.33] },
      { label: "Rent & Lease", values: [41031.03] },
    ],
    laborCost: [29458.92],
    ...overrides,
  };
}

describe("deriveLaborRateInputs", () => {
  it("extracts every payroll-related line by label", () => {
    const result = deriveLaborRateInputs(fixturePnl());

    expect(result.cogsLaborWagesCents).toBe(2945892);
    expect(result.staffWagesCents).toBe(2593505);
    expect(result.ownerSalaryCents).toBe(1150000);
    expect(result.payrollTaxesCents).toBe(487721);
    expect(result.payrollFeesCents).toBe(60045);
    expect(result.retirementPlanCents).toBe(90733);
    expect(result.totalExpensesCents).toBe(14416969);
  });

  it("computes the Option A loading factor matching the published 9.54%", () => {
    const result = deriveLaborRateInputs(fixturePnl());

    // wagesBase = 29458.92 + 25935.05 + 11500.00 = 66893.97
    // burden    = 4877.21 + 600.45 + 907.33      = 6384.99
    // factor    = 6384.99 / 66893.97             = 0.095461...
    expect(result.loadingFactor).not.toBeNull();
    expect(result.loadingFactor!).toBeCloseTo(0.0955, 3);
    expect(result.quickbooksPayrollCents).toBe(7327896); // 66,893.97 + 6,384.99 = 73,278.96
  });

  it("reports null rather than zero when a payroll line is absent", () => {
    const result = deriveLaborRateInputs(
      fixturePnl({
        expenseLines: [{ label: "Rent & Lease", values: [41031.03] }],
      })
    );

    expect(result.staffWagesCents).toBeNull();
    expect(result.ownerSalaryCents).toBeNull();
    expect(result.payrollTaxesCents).toBeNull();
    expect(result.payrollFeesCents).toBeNull();
    expect(result.retirementPlanCents).toBeNull();
    expect(result.loadingFactor).toBeNull();
    expect(result.quickbooksPayrollCents).toBeNull();
    // Total Expenses is a single QBO summary line, unaffected by a missing detail line.
    expect(result.totalExpensesCents).toBe(14416969);
  });

  it("reports null, not zero, when the company has no COGS labor line at all", () => {
    const result = deriveLaborRateInputs(fixturePnl({ laborCost: null }));

    expect(result.cogsLaborWagesCents).toBeNull();
    // Wage base can't be computed without it, so the loading factor is unknown too.
    expect(result.loadingFactor).toBeNull();
    expect(result.quickbooksPayrollCents).toBeNull();
  });

  it("does not divide by zero when the wage base is zero", () => {
    const result = deriveLaborRateInputs(
      fixturePnl({
        laborCost: [0],
        expenseLines: [
          { label: "STAFF wages", values: [0] },
          { label: "OWNER Salary", values: [0] },
          { label: "Payroll Taxes (941)", values: [0] },
          { label: "Payroll Fees", values: [0] },
          { label: "Retirement Plan", values: [0] },
        ],
      })
    );

    expect(result.loadingFactor).toBeNull();
  });
});
