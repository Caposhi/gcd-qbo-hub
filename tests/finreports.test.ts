import { describe, it, expect } from "vitest";
import { parseQboReport } from "@/lib/projections/reports/qbo";
import {
  buildStatement,
  withComparison,
  withPctOfRevenue,
  revenueBase,
  validateStatement,
  statementTies,
  pickStatementValueColumn,
  buildTabular,
  sumColumn,
  REPORTS,
  getReport,
  reportsForTab,
  availableReports,
  basisFor,
  capabilitiesFromCounts,
  parseCapabilities,
  capabilitiesStale,
  REPORT_TABS,
} from "@/lib/finreports";
import { buildEntityPath } from "@/lib/qbo/reports";

/**
 * A P&L shaped exactly like QBO's envelope: nested sections whose children are
 * followed by a Summary row, plus a statement-level NetIncome summary.
 */
const PNL_PAYLOAD = {
  Header: { ReportName: "ProfitAndLoss", StartPeriod: "2026-07-01", EndPeriod: "2026-07-31" },
  Columns: {
    Column: [
      { ColTitle: "", ColType: "Account" },
      { ColTitle: "Total", ColType: "Money", MetaData: [{ Name: "ColKey", Value: "total" }] },
    ],
  },
  Rows: {
    Row: [
      {
        group: "Income",
        Header: { ColData: [{ value: "Income" }, { value: "" }] },
        Rows: {
          Row: [
            { ColData: [{ value: "Labor Sales", id: "101" }, { value: "132117.46" }] },
            { ColData: [{ value: "Parts Sales", id: "102" }, { value: "98938.69" }] },
          ],
        },
        Summary: { ColData: [{ value: "Total Income" }, { value: "231056.15" }] },
      },
      {
        group: "Expenses",
        Header: { ColData: [{ value: "Expenses" }, { value: "" }] },
        Rows: {
          Row: [
            { ColData: [{ value: "Building Rent", id: "201" }, { value: "9500.00" }] },
            { ColData: [{ value: "Advertising", id: "202" }, { value: "3200.00" }] },
          ],
        },
        Summary: { ColData: [{ value: "Total Expenses" }, { value: "12700.00" }] },
      },
      { group: "NetIncome", Summary: { ColData: [{ value: "Net Income" }, { value: "218356.15" }] } },
    ],
  },
};

function pnl(payload: unknown = PNL_PAYLOAD) {
  return buildStatement({
    key: "pnl",
    title: "Profit & Loss",
    period: { start: "2026-07-01", end: "2026-07-31" },
    basis: "cash",
    report: parseQboReport(payload),
  });
}

describe("buildStatement", () => {
  it("preserves reading order and classifies each line", () => {
    const s = pnl();
    expect(s.lines.map((l) => `${l.kind}:${l.label}`)).toEqual([
      "section:Income",
      "detail:Labor Sales",
      "detail:Parts Sales",
      "subtotal:Total Income",
      "section:Expenses",
      "detail:Building Rent",
      "detail:Advertising",
      "subtotal:Total Expenses",
      "total:Net Income",
    ]);
  });

  it("reads values from the Total money column and keeps account ids", () => {
    const s = pnl();
    const labor = s.lines.find((l) => l.label === "Labor Sales")!;
    expect(labor.value).toBeCloseTo(132117.46, 2);
    expect(labor.accountId).toBe("101");
    expect(s.totals.NetIncome).toBeCloseTo(218356.15, 2);
  });

  it("never picks a quantity/percent column as the statement value", () => {
    const withQty = parseQboReport({
      Header: { ReportName: "X" },
      Columns: {
        Column: [
          { ColTitle: "", ColType: "Account" },
          { ColTitle: "Qty", ColType: "Numeric" },
          { ColTitle: "% of Sales", ColType: "Rate" },
          { ColTitle: "Total", ColType: "Money", MetaData: [{ Name: "ColKey", Value: "total" }] },
        ],
      },
      Rows: { Row: [{ ColData: [{ value: "A" }, { value: "1483.79" }, { value: "42.3" }, { value: "98938.69" }] }] },
    });
    expect(pickStatementValueColumn(withQty)).toBe(2); // 0-based over value columns → the Total column
    const s = buildStatement({
      key: "t",
      title: "T",
      period: { start: "2026-07-01", end: "2026-07-31" },
      basis: "cash",
      report: withQty,
    });
    expect(s.lines[0].value).toBeCloseTo(98938.69, 2);
  });
});

describe("validateStatement — the subtotal checksum", () => {
  it("ties when every subtotal equals the sum of its details", () => {
    expect(validateStatement(pnl())).toEqual([]);
    expect(statementTies(pnl())).toBe(true);
  });

  it("flags a subtotal that does not equal its children", () => {
    const broken = JSON.parse(JSON.stringify(PNL_PAYLOAD));
    // Total Income says 231,056.15 but the details now sum to 231,000.00.
    broken.Rows.Row[0].Rows.Row[1].ColData[1].value = "98882.54";
    const issues = validateStatement(pnl(broken));
    expect(issues).toHaveLength(1);
    expect(issues[0].label).toBe("Total Income");
    expect(issues[0].kind).toBe("subtotal_mismatch");
    expect(issues[0].diff).toBeCloseTo(56.15, 2);
    expect(statementTies(pnl(broken))).toBe(false);
  });

  it("tolerates cent-level rounding but not a real difference", () => {
    const rounded = JSON.parse(JSON.stringify(PNL_PAYLOAD));
    rounded.Rows.Row[0].Summary.ColData[1].value = "231056.16"; // 1 cent
    expect(validateStatement(pnl(rounded))).toEqual([]);
    rounded.Rows.Row[0].Summary.ColData[1].value = "231056.20"; // 5 cents
    expect(validateStatement(pnl(rounded))).toHaveLength(1);
  });
});

describe("withComparison", () => {
  const current = pnl();
  const priorPayload = JSON.parse(JSON.stringify(PNL_PAYLOAD));
  priorPayload.Rows.Row[0].Rows.Row[0].ColData[1].value = "120000.00"; // labor was lower
  priorPayload.Rows.Row[0].Rows.Row[1].ColData[1].value = "90000.00";
  priorPayload.Rows.Row[0].Summary.ColData[1].value = "210000.00";
  const prior = buildStatement({
    key: "pnl",
    title: "Profit & Loss",
    period: { start: "2026-06-01", end: "2026-06-30" },
    basis: "cash",
    report: parseQboReport(priorPayload),
  });

  it("joins prior values and computes deltas", () => {
    const joined = withComparison(current, prior);
    const labor = joined.lines.find((l) => l.label === "Labor Sales")!;
    expect(labor.priorValue).toBeCloseTo(120000, 2);
    expect(labor.deltaAbs).toBeCloseTo(12117.46, 2);
    expect(labor.deltaPct).toBeCloseTo(10.1, 1);
    expect(joined.comparison).toEqual({ start: "2026-06-01", end: "2026-06-30" });
  });

  it("leaves priorValue null for a line absent from the prior period (not 0)", () => {
    const trimmed = { ...prior, lines: prior.lines.filter((l) => l.label !== "Advertising") };
    const joined = withComparison(current, trimmed);
    const adv = joined.lines.find((l) => l.label === "Advertising")!;
    expect(adv.priorValue).toBeNull();
    // A fabricated 0 would have produced a bogus delta; assert we didn't.
    expect(adv.deltaPct).toBeNull();
    expect(adv.deltaAbs).toBeNull();
  });
});

describe("percent of revenue", () => {
  it("uses Total Income as the base", () => {
    const s = withPctOfRevenue(pnl());
    expect(revenueBase(pnl())).toBeCloseTo(231056.15, 2);
    const rent = s.lines.find((l) => l.label === "Building Rent")!;
    expect(rent.pctOfRevenue).toBeCloseTo(4.11, 2);
  });

  it("is a no-op when the statement has no revenue concept", () => {
    const bs = buildStatement({
      key: "balance_sheet",
      title: "Balance Sheet",
      period: { start: "2026-07-01", end: "2026-07-31" },
      basis: "accrual",
      report: parseQboReport({
        Header: { ReportName: "BalanceSheet" },
        Columns: { Column: [{ ColTitle: "" }, { ColTitle: "Total", ColType: "Money" }] },
        Rows: { Row: [{ ColData: [{ value: "Chase Checking" }, { value: "187160.20" }] }] },
      }),
    });
    expect(revenueBase(bs)).toBeNull();
    expect(withPctOfRevenue(bs).lines[0].pctOfRevenue).toBeUndefined();
  });
});

describe("buildTabular", () => {
  const tb = buildTabular({
    key: "trial_balance",
    title: "Trial Balance",
    period: { start: "2026-07-01", end: "2026-07-31" },
    basis: "accrual",
    labelColumn: "Account",
    report: parseQboReport({
      Header: { ReportName: "TrialBalance" },
      Columns: {
        Column: [
          { ColTitle: "", ColType: "Account" },
          { ColTitle: "Debit", ColType: "Money" },
          { ColTitle: "Credit", ColType: "Money" },
        ],
      },
      Rows: {
        Row: [
          { ColData: [{ value: "Chase Checking" }, { value: "187160.20" }, { value: "" }] },
          { ColData: [{ value: "Accounts Payable" }, { value: "" }, { value: "12000.00" }] },
        ],
      },
    }),
  });

  it("keeps every column and re-adds the label column", () => {
    expect(tb.columns.map((c) => c.label)).toEqual(["Account", "Debit", "Credit"]);
    expect(tb.columns.map((c) => c.type)).toEqual(["text", "money", "money"]);
    expect(tb.rows).toHaveLength(2);
    expect(tb.rows[0].cells.label).toBe("Chase Checking");
    expect(tb.rows[0].cells.c0).toBeCloseTo(187160.2, 2);
    expect(tb.rows[0].cells.c1).toBeNull();
  });

  it("sums a money column across non-summary rows", () => {
    expect(sumColumn(tb, "c0")).toBeCloseTo(187160.2, 2);
    expect(sumColumn(tb, "c1")).toBeCloseTo(12000, 2);
  });
});

describe("catalog", () => {
  it("has unique keys and a known tab for every report", () => {
    const keys = REPORTS.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    const tabIds = new Set(REPORT_TABS.map((t) => t.id));
    for (const r of REPORTS) expect(tabIds.has(r.tab)).toBe(true);
  });

  it("applies the owner's basis rule: cash for P&L-style, accrual for balance-sheet-style", () => {
    expect(getReport("pnl")!.defaultBasis).toBe("cash");
    expect(getReport("cash_flow")!.defaultBasis).toBe("cash");
    expect(getReport("item_sales")!.defaultBasis).toBe("cash");
    expect(getReport("balance_sheet")!.defaultBasis).toBe("accrual");
    expect(getReport("trial_balance")!.defaultBasis).toBe("accrual");
    expect(getReport("general_ledger")!.defaultBasis).toBe("accrual");
    // Agings are point-in-time and take no basis at all.
    expect(getReport("ar_aging")!.defaultBasis).toBeNull();
  });

  it("basisFor honours an override but never invents one for basis-less reports", () => {
    expect(basisFor(getReport("pnl")!)).toBe("cash");
    expect(basisFor(getReport("pnl")!, "accrual")).toBe("accrual");
    expect(basisFor(getReport("ar_aging")!, "accrual")).toBeNull();
  });

  it("hides capability-gated reports until the company has that feature", () => {
    expect(reportsForTab("sales").map((r) => r.key)).not.toContain("class_sales");
    expect(reportsForTab("sales", { classes: true }).map((r) => r.key)).toContain("class_sales");
    expect(availableReports().some((r) => r.requires)).toBe(false);
    expect(availableReports({ budgets: true, inventory: true, classes: true }).length).toBe(REPORTS.length);
  });

  it("ships the three core statements as validated statement shapes", () => {
    for (const key of ["pnl", "balance_sheet", "cash_flow"]) {
      expect(getReport(key)!.shape).toBe("statement");
    }
  });
});

describe("capabilities", () => {
  it("treats a feature as in use only when an active record exists", () => {
    expect(capabilitiesFromCounts({ activeClasses: 0, budgets: 0, inventoryItems: 0 })).toMatchObject({
      classes: false,
      budgets: false,
      inventory: false,
    });
    expect(capabilitiesFromCounts({ activeClasses: 3, budgets: 1, inventoryItems: 250 })).toMatchObject({
      classes: true,
      budgets: true,
      inventory: true,
    });
  });

  it("degrades a corrupt cache row to no optional reports", () => {
    expect(parseCapabilities(null)).toMatchObject({ classes: false, budgets: false, inventory: false });
    expect(parseCapabilities({ classes: "yes" })).toMatchObject({ classes: false });
    expect(parseCapabilities({ classes: true, probedAt: "2026-08-01T00:00:00Z" }).classes).toBe(true);
  });

  it("re-probes when never probed or stale", () => {
    const now = new Date("2026-08-04T00:00:00Z");
    expect(capabilitiesStale({ classes: false, budgets: false, inventory: false }, now)).toBe(true);
    expect(capabilitiesStale({ classes: true, budgets: false, inventory: false, probedAt: "2026-08-03T00:00:00Z" }, now)).toBe(false);
    expect(capabilitiesStale({ classes: true, budgets: false, inventory: false, probedAt: "2026-07-01T00:00:00Z" }, now)).toBe(true);
  });
});

describe("buildEntityPath — per-report QBO params", () => {
  const p = { startDate: "2026-07-01", endDate: "2026-07-31" };

  it("sends a date range + basis for period reports", () => {
    const path = buildEntityPath("ProfitAndLoss", { ...p, method: "cash" });
    expect(path).toContain("start_date=2026-07-01");
    expect(path).toContain("end_date=2026-07-31");
    expect(path).toContain("accounting_method=Cash");
  });

  it("sends only report_date for point-in-time reports", () => {
    const path = buildEntityPath("BalanceSheet", { ...p, method: "accrual" });
    expect(path).toContain("report_date=2026-07-31");
    expect(path).not.toContain("start_date");
    expect(path).toContain("accounting_method=Accrual");
  });

  it("omits accounting_method for reports that take none", () => {
    expect(buildEntityPath("AgedReceivables", { ...p, method: "accrual" })).not.toContain("accounting_method");
    expect(buildEntityPath("AgedReceivables", { ...p })).toContain("report_date=2026-07-31");
  });

  it("passes summarize_column_by when asked", () => {
    expect(buildEntityPath("ProfitAndLoss", { ...p, method: "cash", summarizeColumnBy: "Month" })).toContain(
      "summarize_column_by=Month"
    );
  });
});
