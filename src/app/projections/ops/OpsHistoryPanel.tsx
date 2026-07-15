/**
 * Ops history tab (server component) — the trailing months of ACTUAL Tekmetric
 * operations, in the same chart + table shape as the Ops forecast.
 *
 * This is the visual counterpart to the forecast: instead of projecting forward,
 * it shows what was actually imported for each backfilled month so the data can
 * be eyeballed against Tekmetric right after a deploy. Any month whose figures
 * look like a partial/rate-limited pull (the Apr-2026-style corruption) is flagged
 * inline, so a bad import stands out instead of silently skewing the forecast.
 * Read-only over Tekmetric — reads the cache only, never fetches.
 */
import Link from "next/link";
import { isTekmetricConfigured } from "@/lib/tekmetric/client";
import { loadOpsHistory } from "@/lib/tekmetric/history-service";
import { shopToday } from "@/lib/tekmetric/periods";
import { looksLikePartialMonth, type OpsMonth } from "@/lib/tekmetric/forecast";
import { money } from "../reporting/format";
import { OpsForecastChart } from "./OpsForecastChart";

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export async function OpsHistoryPanel() {
  const configured = isTekmetricConfigured();
  const hist = await loadOpsHistory(shopToday(), 24);

  if (!hist.connected) {
    return (
      <div className="notice info">
        {configured ? (
          <>
            No Tekmetric history is cached yet (found {hist.found}{" "}
            {hist.found === 1 ? "month" : "months"}). An owner can backfill it with{" "}
            <code>npm run tekmetric:backfill</code>, or refresh recent months on the{" "}
            <Link href="/tekmetric">Tekmetric</Link> page.
          </>
        ) : (
          <>
            Tekmetric isn’t configured, so there’s no operational history to show. Set{" "}
            <code>TEKMETRIC_TOKEN</code> and <code>TEKMETRIC_SHOP_ID</code> to enable it.
          </>
        )}
      </div>
    );
  }

  const history = hist.history; // oldest → newest
  const suspect = (m: OpsMonth) =>
    looksLikePartialMonth({ roCount: m.roCount, grossMarginPct: m.grossMarginPct, aro: m.aro });
  const flagged = history.filter(suspect);

  const chartData = history.map((m) => ({ label: m.label, revenue: m.revenue, grossProfit: m.grossProfit }));

  // Summary over the months that look real, so one corrupt month can't skew the
  // headline averages the same way it would the forecast fit.
  const clean = history.filter((m) => !suspect(m));
  const basis = clean.length ? clean : history;
  const totalRevenue = basis.reduce((a, m) => a + m.revenue, 0);
  const totalGrossProfit = basis.reduce((a, m) => a + m.grossProfit, 0);
  const avgRo = avg(basis.map((m) => m.roCount));
  const avgMargin = avg(basis.map((m) => m.grossMarginPct));

  // Newest month first in the table — how people read recent history.
  const rows = [...history].reverse();

  return (
    <>
      <p className="page-desc">
        Actual monthly operations from your Tekmetric history ({history[0]?.label} →{" "}
        {history[history.length - 1]?.label}). This is the real imported data behind the Ops forecast —
        use it to sanity-check what was backfilled. Read-only; reads the cache, nothing is fetched.
      </p>

      {flagged.length > 0 && (
        <div className="notice warn">
          {flagged.length} {flagged.length === 1 ? "month looks" : "months look"} like a partial or
          rate-limited import ({flagged.map((m) => m.label).join(", ")}) and{" "}
          {flagged.length === 1 ? "is" : "are"} excluded from the forecast baseline. Re-run{" "}
          <code>npm run tekmetric:backfill</code> to re-pull{" "}
          {flagged.length === 1 ? "it" : "them"}.
        </div>
      )}

      {/* Summary of the actuals */}
      <div className="kpi-grid" style={{ marginTop: 16 }}>
        <div className="kpi-card">
          <div className="kpi-label">Revenue · {basis.length} mo</div>
          <div className="kpi-value">{money(totalRevenue)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Gross profit · {basis.length} mo</div>
          <div className="kpi-value">{money(totalGrossProfit)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Avg monthly ROs</div>
          <div className="kpi-value">{Math.round(avgRo).toLocaleString("en-US")}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Avg gross margin</div>
          <div className="kpi-value">{avgMargin.toFixed(1)}%</div>
        </div>
      </div>

      {/* History chart (actuals) */}
      <div className="card" style={{ marginTop: 16 }}>
        <h3 className="card-title" style={{ marginTop: 0 }}>Revenue &amp; gross profit — actuals</h3>
        <p className="card-subtitle">{history[0]?.label} → {history[history.length - 1]?.label}</p>
        <div style={{ marginTop: 12 }}>
          <OpsForecastChart data={chartData} />
        </div>
      </div>

      {/* Monthly table */}
      <div className="table-wrap" style={{ marginTop: 16 }}>
        <table className="gcd">
          <thead>
            <tr>
              <th>Month</th>
              <th className="num">RO count</th>
              <th className="num">Car count</th>
              <th className="num">ARO</th>
              <th className="num">Revenue</th>
              <th className="num">Gross profit</th>
              <th className="num">Margin</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => {
              const bad = suspect(m);
              return (
                <tr key={m.start}>
                  <td>{m.label}</td>
                  <td className="num">{Math.round(m.roCount).toLocaleString("en-US")}</td>
                  <td className="num">{Math.round(m.carCount).toLocaleString("en-US")}</td>
                  <td className="num">{money(m.aro)}</td>
                  <td className="num">{money(m.revenue)}</td>
                  <td className="num">{money(m.grossProfit)}</td>
                  <td className="num">{m.grossMarginPct.toFixed(1)}%</td>
                  <td>
                    <span className={`badge ${bad ? "danger" : "ok"}`}>{bad ? "suspect" : "ok"}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
