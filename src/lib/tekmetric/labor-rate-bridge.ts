/**
 * Pure derivation for the gcd-attribution labor-rate bridge
 * (see src/app/api/external/labor-rate/route.ts, the only I/O for this).
 *
 * WHY THIS EXISTS
 *
 * gcd-attribution's Tekmetric Profit Intelligence programme (TP1-d) computes a
 * blended shop labor cost rate that needs QuickBooks payroll figures it has no
 * other way to reach: gcd-attribution has no QuickBooks connection of its own,
 * and gcd-qbo-hub already holds one (src/lib/qbo/oauth.ts) plus the cached,
 * normalized P&L this reads from (getReportSnapshot("pnl", ...)). Rather than
 * stand up a second QuickBooks OAuth app, gcd-attribution's operator-facing
 * rate form calls this bridge to pre-fill the QuickBooks-derived numbers,
 * exactly as documented in gcd-attribution's
 * docs/tekmetric-audit/02c-qbo-labor-cost-structure.md (Option A).
 *
 * This module extracts and computes; it never fetches. That split is what
 * makes the loading-factor arithmetic testable without a QBO connection or a
 * database, matching this repo's normalize.ts convention.
 *
 * WHAT "loaded" MEANS HERE
 *
 * `COGS: LABOR Wages` is bare wages — employer payroll taxes, fees and
 * retirement sit in operating expenses, not COGS (confirmed against a real
 * July 2026 P&L in gcd-attribution's audit doc). The loading factor prorates
 * that employer burden across the wage base (COGS labor + non-billable staff
 * wages + owner salary) and applies it to the bare COGS figure, so Rate A
 * (direct_labor) doesn't understate true technician cost. Full absorption
 * (Rate B) needs no loading factor — the burden is already inside Total
 * Expenses there, so applying it again would double-count it. This module
 * only supplies the loaded numerator's ingredients; gcd-attribution's own
 * `deriveRatePerHourCents` (labor-cost-rate.ts) does the actual rate math and
 * decides which rate kind to build.
 *
 * WHY EVERYTHING IS NULLABLE
 *
 * A missing line is reported as null, never coerced to zero. On 2026-08-19 a
 * chart-of-accounts rename silently stopped ADP from posting to QuickBooks for
 * two of five payroll runs, and QuickBooks answered every query successfully
 * with no error — a rate built on a silently-zeroed line would have been
 * confidently wrong. A caller that wants a single number to display must
 * decide how to handle null, not have this module decide for it by guessing.
 */
import { sum, type PnlNormalized, type LineSeries } from "@/lib/projections/reports";

/** Sum of a matched expense line's per-period values, in dollars, or null if no line matches. */
function findLineTotal(lines: LineSeries[], labelPattern: RegExp): number | null {
  const match = lines.find((line) => labelPattern.test(line.label));
  return match ? sum(match.values) : null;
}

function toCents(dollars: number): number {
  return Math.round(dollars * 100);
}

export interface LaborRateBridgeResult {
  /** COGS "Labor Wages" — bare, pre-loading. Rate A's numerator input. */
  cogsLaborWagesCents: number | null;
  /** Non-billable staff wages, operating expenses (outside COGS). */
  staffWagesCents: number | null;
  /** Owner salary, operating expenses. */
  ownerSalaryCents: number | null;
  /** Employer payroll taxes (e.g. 941), operating expenses. */
  payrollTaxesCents: number | null;
  /** Payroll processing fees, operating expenses. */
  payrollFeesCents: number | null;
  /** Retirement plan employer contributions, operating expenses. */
  retirementPlanCents: number | null;
  /** QBO's own "Total Expenses" for the period. Rate B's second numerator term. */
  totalExpensesCents: number;
  /**
   * Sum of the six payroll-related accounts above, for TP1-d's ADP-vs-QBO
   * cross-check field. Null if any of the six lines couldn't be found —
   * a partial sum would silently understate the QBO side of that comparison.
   */
  quickbooksPayrollCents: number | null;
  /**
   * (Payroll Taxes + Fees + Retirement) / (COGS Labor + Staff Wages + Owner
   * Salary), matching 02c-qbo-labor-cost-structure.md Option A. Null if any
   * input is missing, or if the wage base is zero (an undefined ratio).
   */
  loadingFactor: number | null;
}

export function deriveLaborRateInputs(pnl: PnlNormalized): LaborRateBridgeResult {
  const cogsLaborWages = pnl.laborCost === null ? null : sum(pnl.laborCost);
  const staffWages = findLineTotal(pnl.expenseLines, /staff.*wage/i);
  const ownerSalary = findLineTotal(pnl.expenseLines, /owner.*salary/i);
  const payrollTaxes = findLineTotal(pnl.expenseLines, /payroll.*tax/i);
  const payrollFees = findLineTotal(pnl.expenseLines, /payroll.*fee/i);
  const retirementPlan = findLineTotal(pnl.expenseLines, /retirement/i);
  const totalExpenses = sum(pnl.expenses);

  const wagesBase =
    cogsLaborWages !== null && staffWages !== null && ownerSalary !== null
      ? cogsLaborWages + staffWages + ownerSalary
      : null;
  const employerBurden =
    payrollTaxes !== null && payrollFees !== null && retirementPlan !== null
      ? payrollTaxes + payrollFees + retirementPlan
      : null;

  const loadingFactor =
    wagesBase !== null && employerBurden !== null && wagesBase > 0
      ? employerBurden / wagesBase
      : null;

  const quickbooksPayrollCents =
    wagesBase !== null && employerBurden !== null ? toCents(wagesBase + employerBurden) : null;

  return {
    cogsLaborWagesCents: cogsLaborWages === null ? null : toCents(cogsLaborWages),
    staffWagesCents: staffWages === null ? null : toCents(staffWages),
    ownerSalaryCents: ownerSalary === null ? null : toCents(ownerSalary),
    payrollTaxesCents: payrollTaxes === null ? null : toCents(payrollTaxes),
    payrollFeesCents: payrollFees === null ? null : toCents(payrollFees),
    retirementPlanCents: retirementPlan === null ? null : toCents(retirementPlan),
    totalExpensesCents: toCents(totalExpenses),
    quickbooksPayrollCents,
    loadingFactor,
  };
}
