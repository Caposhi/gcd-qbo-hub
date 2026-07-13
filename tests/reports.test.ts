import { describe, it, expect } from "vitest";
import {
  parseAmount,
  parseQboReport,
  periodColumnIndices,
  normalizePnl,
  normalizeBalanceSheet,
  normalizeAging,
  normalizeSales,
  computeDelta,
  marginPct,
  sum,
  deriveKpis,
  resolveRange,
  comparisonRange,
  rollupSeries,
  parseReportPayload,
} from "@/lib/projections/reports";
import {
  PNL_MONTHLY,
  PNL_REALWORLD,
  BALANCE_SHEET,
  AR_AGING,
  CUSTOMER_SALES,
  ITEM_SALES,
  ITEM_SALES_AVG_PRICE_TRAP,
} from "./report-fixtures";

describe("parseAmount", () => {
  it("parses plain, thousands-separated, and currency-prefixed numbers", () => {
    expect(parseAmount("1000.00")).toBe(1000);
    expect(parseAmount("8,000.00")).toBe(8000);
    expect(parseAmount("$1,234.56")).toBe(1234.56);
    expect(parseAmount(42)).toBe(42);
  });
  it("treats parenthesised values as negative", () => {
    expect(parseAmount("(123.45)")).toBe(-123.45);
    expect(parseAmount("-99")).toBe(-99);
  });
  it("returns null for blanks and non-numeric placeholders", () => {
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("-")).toBeNull();
    expect(parseAmount("n/a")).toBeNull();
    expect(parseAmount(undefined)).toBeNull();
  });
});

describe("parseQboReport", () => {
  const report = parseQboReport(PNL_MONTHLY);

  it("drops the label column and identifies the grand-total column", () => {
    expect(report.columns.map((c) => c.title)).toEqual(["May 2026", "Jun 2026", "Total"]);
    expect(report.totalColumnIndex).toBe(2);
    expect(periodColumnIndices(report)).toEqual([0, 1]);
  });

  it("reads the accounting method from the header options", () => {
    expect(report.accountingMethod).toBe("Accrual");
  });

  it("flattens sections into data + section_summary rows with resolved group codes", () => {
    const labor = report.rows.find((r) => r.label === "Labor");
    expect(labor?.kind).toBe("data");
    expect(labor?.groupCode).toBe("Income");
    expect(labor?.id).toBe("79");
    expect(labor?.values).toEqual([10000, 12000, 22000]);

    const totalIncome = report.rows.find((r) => r.label === "Total Income");
    expect(totalIncome?.kind).toBe("section_summary");
    expect(totalIncome?.groupCode).toBe("Income");

    const gp = report.rows.find((r) => r.label === "Gross Profit");
    expect(gp?.groupCode).toBe("GrossProfit");
  });

  it("returns an empty report (never throws) for malformed input", () => {
    const empty = parseQboReport(null);
    expect(empty.rows).toEqual([]);
    expect(empty.columns).toEqual([]);
    expect(empty.totalColumnIndex).toBe(-1);
  });
});

describe("normalizePnl", () => {
  const pnl = normalizePnl(parseQboReport(PNL_MONTHLY));

  it("extracts period totals per metric, excluding the grand-total column", () => {
    expect(pnl.periods).toEqual(["May 2026", "Jun 2026"]);
    expect(pnl.income).toEqual([18000, 21000]);
    expect(pnl.cogs).toEqual([4000, 4500]);
    expect(pnl.grossProfit).toEqual([14000, 16500]);
    expect(pnl.expenses).toEqual([9000, 9500]);
    expect(pnl.netIncome).toEqual([5000, 7000]);
  });

  it("summed periods reconcile to the QBO grand-total column", () => {
    expect(sum(pnl.income)).toBe(39000);
    expect(sum(pnl.netIncome)).toBe(12000);
    expect(sum(pnl.expenses)).toBe(18500);
  });

  it("captures income and expense detail lines", () => {
    expect(pnl.incomeLines.map((l) => l.label)).toEqual(["Labor", "Parts"]);
    expect(pnl.expenseLines.map((l) => l.label)).toEqual(["Rent", "Wages"]);
    expect(pnl.expenseLines[1].values).toEqual([6000, 6500]);
  });
});

describe("normalizePnl — real-world QBO shapes (regression for the live bugs)", () => {
  const pnl = normalizePnl(parseQboReport(PNL_REALWORLD));

  it("reads Total Expenses from the OUTERMOST summary, not a nested sub-total", () => {
    // Bug was $81.03 (the inner "Total Job Expenses"); correct is $9,081.03.
    expect(pnl.expenses).toEqual([9081.03]);
  });

  it("derives Gross Profit as income − COGS when QBO omits the Gross Profit row", () => {
    // No COGS section → GP falls back to income (COGS 0), not 0.
    expect(pnl.cogs).toEqual([0]);
    expect(pnl.grossProfit).toEqual([75000]);
  });

  it("captures Net Income from a summary-only row (previously dropped → 0)", () => {
    expect(pnl.netIncome).toEqual([65918.97]);
    expect(pnl.netOperatingIncome).toEqual([65918.97]); // derived: GP − expenses
  });

  it("still lists every expense detail line (breakdown reconciles to Total Expenses)", () => {
    expect(pnl.expenseLines.map((l) => l.label)).toEqual(["Contractors", "Building Rent", "STAFF wages"]);
    expect(sum(pnl.expenseLines.map((l) => l.values[0]))).toBe(9081.03);
  });

  it("KPIs now reflect the true figures", () => {
    const bs = normalizeBalanceSheet(parseQboReport(BALANCE_SHEET));
    const kpis = deriveKpis({
      pnl,
      pnlPrev: pnl,
      balanceSheet: bs,
      balanceSheetPrev: bs,
      arTotal: 0,
      arTotalPrev: 0,
      apTotal: 0,
      apTotalPrev: 0,
    });
    const byKey = Object.fromEntries(kpis.map((k) => [k.key, k]));
    expect(byKey.gross_profit.value).toBe(75000);
    expect(byKey.net_income.value).toBe(65918.97);
    expect(byKey.operating_expenses.value).toBe(9081.03);
  });
});

describe("normalizeBalanceSheet", () => {
  const bs = normalizeBalanceSheet(parseQboReport(BALANCE_SHEET));

  it("derives cash from the Bank Accounts total and lists the bank accounts", () => {
    expect(bs.cash).toBe(75000);
    expect(bs.bankAccounts.map((a) => a.label)).toEqual(["Operating Checking", "Savings"]);
  });

  it("pulls assets / liabilities / equity totals by label fallback", () => {
    expect(bs.totalAssets).toBe(87000);
    expect(bs.totalLiabilities).toBe(8000);
    expect(bs.totalEquity).toBe(79000);
  });
});

describe("normalizeAging", () => {
  const ar = normalizeAging(parseQboReport(AR_AGING));

  it("maps bucket labels from the columns and totals from the TOTAL row", () => {
    expect(ar.bucketLabels).toEqual(["Current", "1 - 30", "31 - 60", "61 - 90", "91 and over"]);
    expect(ar.totals).toEqual([1000, 500, 2000, 0, 500]);
    expect(ar.total).toBe(4000);
  });

  it("lists per-customer rows and excludes the grand-total row", () => {
    expect(ar.rows.map((r) => r.name)).toEqual(["Acme Autobody", "Bavarian Motors"]);
    const bav = ar.rows.find((r) => r.name === "Bavarian Motors")!;
    expect(bav.buckets[2]).toBe(2000); // 31 - 60
    expect(bav.total).toBe(2500);
  });
});

describe("normalizeSales", () => {
  it("sorts customers by amount desc and excludes the total row", () => {
    const cust = normalizeSales(parseQboReport(CUSTOMER_SALES));
    expect(cust.rows.map((r) => r.name)).toEqual(["Acme Autobody", "Bavarian Motors"]);
    expect(cust.rows[0].amount).toBe(20000);
    expect(cust.total).toBe(39000);
  });

  it("picks the Amount column for item sales when there is no total column", () => {
    const item = normalizeSales(parseQboReport(ITEM_SALES));
    expect(item.rows.map((r) => r.name)).toEqual(["Labor", "Parts"]);
    expect(item.rows[0].amount).toBe(22000);
    expect(item.total).toBe(39000); // summed when no summary row present
  });

  it("picks Sales dollars, not Avg Price or Qty, when there is no Amount/Total column", () => {
    // Regression for the live "Revenue by Service/Product" bug: the picker used
    // to fall to the last money column (Avg Price) and chart per-unit prices.
    const item = normalizeSales(parseQboReport(ITEM_SALES_AVG_PRICE_TRAP));
    expect(item.rows.map((r) => r.name)).toEqual([
      "TEK Sales-Parts Sales",
      "TEK Sales-Labor Sales",
    ]);
    expect(item.rows[0].amount).toBe(45000); // Sales column, not 150 (Avg Price) or 300 (Qty)
    expect(item.total).toBe(75000);
  });
});

describe("computeDelta", () => {
  it("computes absolute + pct and marks a favourable rise as good", () => {
    const d = computeDelta(21000, 18000, "higher_better");
    expect(d.absolute).toBe(3000);
    expect(d.pct).toBeCloseTo(0.1667, 3);
    expect(d.direction).toBe("up");
    expect(d.sentiment).toBe("good");
  });

  it("marks a rise in a lower-is-better metric (e.g. A/P) as bad", () => {
    const d = computeDelta(8000, 5000, "lower_better");
    expect(d.direction).toBe("up");
    expect(d.sentiment).toBe("bad");
  });

  it("returns null pct when the previous value is zero", () => {
    const d = computeDelta(500, 0, "higher_better");
    expect(d.pct).toBeNull();
    expect(d.direction).toBe("up");
  });

  it("treats sub-cent moves as flat/neutral", () => {
    const d = computeDelta(1000.001, 1000, "higher_better");
    expect(d.direction).toBe("flat");
    expect(d.sentiment).toBe("neutral");
  });
});

describe("marginPct", () => {
  it("is a safe ratio, zero when the denominator is ~0", () => {
    expect(marginPct(30500, 39000)).toBeCloseTo(0.782, 3);
    expect(marginPct(100, 0)).toBe(0);
  });
});

describe("deriveKpis", () => {
  const pnl = normalizePnl(parseQboReport(PNL_MONTHLY));
  const bs = normalizeBalanceSheet(parseQboReport(BALANCE_SHEET));
  // A flat prior period (half the revenue) to exercise deltas.
  const pnlPrev = {
    ...pnl,
    income: [9000, 10500],
    grossProfit: [7000, 8250],
    netIncome: [2500, 3500],
    expenses: [4500, 4750],
  };
  const kpis = deriveKpis({
    pnl,
    pnlPrev,
    balanceSheet: bs,
    balanceSheetPrev: { ...bs, cash: 60000 },
    arTotal: 4000,
    arTotalPrev: 5000,
    apTotal: 8000,
    apTotalPrev: 6000,
  });
  const byKey = Object.fromEntries(kpis.map((k) => [k.key, k]));

  it("produces the full standard KPI set", () => {
    expect(kpis.map((k) => k.key)).toEqual([
      "total_revenue",
      "gross_profit",
      "gross_margin_pct",
      "net_income",
      "net_margin_pct",
      "operating_expenses",
      "ar_total",
      "ap_total",
      "cash",
    ]);
  });

  it("sums revenue across periods and flags growth as good", () => {
    expect(byKey.total_revenue.value).toBe(39000);
    expect(byKey.total_revenue.delta.sentiment).toBe("good");
  });

  it("computes gross margin as a fraction", () => {
    expect(byKey.gross_margin_pct.value).toBeCloseTo(30500 / 39000, 4);
    expect(byKey.gross_margin_pct.format).toBe("percent");
  });

  it("treats falling A/R as good and rising A/P as bad", () => {
    expect(byKey.ar_total.delta.sentiment).toBe("good");
    expect(byKey.ap_total.delta.sentiment).toBe("bad");
  });

  it("reads cash from the balance sheet", () => {
    expect(byKey.cash.value).toBe(75000);
    expect(byKey.cash.delta.absolute).toBe(15000);
  });
});

describe("resolveRange", () => {
  const now = new Date(Date.UTC(2026, 6, 13)); // 2026-07-13

  it("resolves calendar presets deterministically", () => {
    expect(resolveRange("this_month", now)).toEqual({ start: "2026-07-01", end: "2026-07-31" });
    expect(resolveRange("last_month", now)).toEqual({ start: "2026-06-01", end: "2026-06-30" });
    expect(resolveRange("this_quarter", now)).toEqual({ start: "2026-07-01", end: "2026-09-30" });
    expect(resolveRange("ytd", now)).toEqual({ start: "2026-01-01", end: "2026-07-31" });
    expect(resolveRange("trailing_12", now)).toEqual({ start: "2025-08-01", end: "2026-07-31" });
  });

  it("orders and falls back for custom ranges", () => {
    expect(resolveRange("custom", now, "2026-03-31", "2026-01-01")).toEqual({
      start: "2026-01-01",
      end: "2026-03-31",
    });
    // Missing custom dates fall back to the current month.
    expect(resolveRange("custom", now)).toEqual({ start: "2026-07-01", end: "2026-07-31" });
  });
});

describe("comparisonRange", () => {
  it("prior_period is the equal-length span ending the day before start", () => {
    expect(comparisonRange({ start: "2026-06-01", end: "2026-06-30" }, "prior_period")).toEqual({
      start: "2026-05-02",
      end: "2026-05-31",
    });
  });

  it("prior_year shifts the same calendar dates back a year", () => {
    expect(comparisonRange({ start: "2026-06-01", end: "2026-06-30" }, "prior_year")).toEqual({
      start: "2025-06-01",
      end: "2025-06-30",
    });
  });

  it("clamps a Feb-29 prior_year to Feb 28", () => {
    expect(comparisonRange({ start: "2024-02-01", end: "2024-02-29" }, "prior_year")).toEqual({
      start: "2023-02-01",
      end: "2023-02-28",
    });
  });
});

describe("rollupSeries", () => {
  const periods = ["Jan 2026", "Feb 2026", "Mar 2026", "Apr 2026"];
  const values = [100, 200, 300, 400];

  it("passes months through unchanged", () => {
    expect(rollupSeries(periods, values, "month")).toEqual([
      { label: "Jan 2026", value: 100 },
      { label: "Feb 2026", value: 200 },
      { label: "Mar 2026", value: 300 },
      { label: "Apr 2026", value: 400 },
    ]);
  });

  it("rolls months up into quarters", () => {
    expect(rollupSeries(periods, values, "quarter")).toEqual([
      { label: "Q1 2026", value: 600 },
      { label: "Q2 2026", value: 400 },
    ]);
  });

  it("rolls months up into years", () => {
    expect(rollupSeries(periods, values, "year")).toEqual([{ label: "2026", value: 1000 }]);
  });

  it("passes unparseable labels (e.g. Total) through as their own bucket", () => {
    expect(rollupSeries(["Total"], [999], "quarter")).toEqual([{ label: "Total", value: 999 }]);
  });
});

describe("parseReportPayload (stored-JSON validation)", () => {
  it("round-trips a normalized P&L payload", () => {
    const pnl = normalizePnl(parseQboReport(PNL_MONTHLY));
    const round = parseReportPayload("pnl", JSON.parse(JSON.stringify(pnl)));
    expect(round).toEqual(pnl);
  });

  it("coerces a malformed payload to a safe empty shape (never throws)", () => {
    const pnl = parseReportPayload("pnl", { income: "not an array", periods: null });
    expect(pnl).toMatchObject({ income: [], periods: [], incomeLines: [] });

    const aging = parseReportPayload("ar_aging", "garbage");
    expect(aging).toMatchObject({ total: 0, totals: [], rows: [] });

    const sales = parseReportPayload("customer_sales", null);
    expect(sales).toEqual({ total: 0, rows: [] });
  });
});
