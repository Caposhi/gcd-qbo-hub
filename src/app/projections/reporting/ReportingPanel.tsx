/**
 * Reporting tab (Phase 1) — server component.
 *
 * Reads live (read-only) QBO actuals through the snapshot cache and renders the
 * bookkeeper-style KPI tiles (figure + up/down % and $ delta vs. the comparison
 * period, coloured good/bad) plus the interactive Recharts islands. Everything
 * recomputes from the active filters, which live in the URL search params.
 */
import { RefreshCw } from "lucide-react";
import { loadReporting, type ReportFilters } from "@/lib/projections/report-service";
import { formatValue, formatDelta, money } from "./format";
import { FilterBar, type FilterState } from "./FilterBar";
import { TrendChart, CategoryChart, AgingChart } from "./Charts";
import { refreshReportSnapshotsAction } from "../actions";

function KpiTiles({ kpis }: { kpis: import("@/lib/projections/reports").Kpi[] }) {
  return (
    <div className="kpi-grid">
      {kpis.map((k) => {
        // Color the delta by sentiment (good/bad), not by the sign of the number.
        const dir = k.delta.sentiment === "good" ? "up" : k.delta.sentiment === "bad" ? "down" : "";
        return (
          <div key={k.key} className="kpi-card">
            <div className="kpi-label">{k.label}</div>
            <div className="kpi-value">{formatValue(k.value, k.format)}</div>
            <div className="kpi-foot">
              <span className={`delta ${dir}`.trim()} title="vs. comparison period">
                {formatDelta(k.delta, k.format)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export async function ReportingPanel({
  filters,
  filterState,
  canRefresh,
}: {
  filters: ReportFilters;
  filterState: FilterState;
  canRefresh: boolean;
}) {
  const data = await loadReporting(filters, new Date());

  const RefreshForm = canRefresh ? (
    <form action={refreshReportSnapshotsAction}>
      <input type="hidden" name="preset" value={filterState.preset} />
      <input type="hidden" name="cmp" value={filterState.comparison} />
      <input type="hidden" name="method" value={filterState.method} />
      <input type="hidden" name="gran" value={filterState.granularity} />
      {filterState.customStart && <input type="hidden" name="start" value={filterState.customStart} />}
      {filterState.customEnd && <input type="hidden" name="end" value={filterState.customEnd} />}
      <button className="btn secondary" type="submit">
        <RefreshCw size={15} aria-hidden /> Refresh from QuickBooks
      </button>
    </form>
  ) : null;

  if (!data.connected) {
    return (
      <>
        <FilterBar state={filterState} />
        <div className="notice danger" style={{ marginTop: "1rem" }}>
          QuickBooks isn’t connected for this environment yet, and there’s no cached
          snapshot for this range. An owner needs to connect QBO before live actuals
          appear here.
        </div>
      </>
    );
  }

  return (
    <>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          gap: "1rem",
          flexWrap: "wrap",
        }}
      >
        <FilterBar state={filterState} />
      </div>

      <div
        className="row-actions"
        style={{ justifyContent: "space-between", alignItems: "center" }}
      >
        <p className="card-subtitle" style={{ margin: 0 }}>
          {data.range.start} → {data.range.end} ({filterState.method}) · vs {data.comparison.start} →{" "}
          {data.comparison.end} · snapshot {data.fetchedAt.toISOString().slice(0, 16).replace("T", " ")}Z
        </p>
        {RefreshForm}
      </div>

      <KpiTiles kpis={data.kpis} />

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))" }}>
        <TrendChart data={data.trend} />
        <CategoryChart
          title="Revenue by Service / Product"
          subtitle="From QBO Item Sales · click a bar for its share"
          data={data.revenueByItem}
        />
        <CategoryChart
          title="Revenue by Customer"
          subtitle="Top customers · click a bar for its share"
          data={data.revenueByCustomer}
        />
        <CategoryChart
          title="Operating Expense Breakdown"
          subtitle="From QBO P&L expense accounts"
          data={data.expenseBreakdown}
          unit="expenses"
        />
        <AgingChart title="A/R Aging" aging={data.arAging} entityLabel="Customer" />
        <AgingChart title="A/P Aging" aging={data.apAging} entityLabel="Vendor" />
      </div>

      <p className="card-subtitle" style={{ marginTop: "1rem" }}>
        Cash position {money(data.balanceSheet.cash, { compact: true })} · total assets{" "}
        {money(data.balanceSheet.totalAssets, { compact: true })}. Read-only from QuickBooks
        Online — no figures are ever written back.
      </p>
    </>
  );
}
