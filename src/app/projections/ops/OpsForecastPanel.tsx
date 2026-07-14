/**
 * Ops forecast tab (server component) — projection scenarios grounded in the
 * backfilled 24-month Tekmetric history.
 *
 * Reads the cached monthly snapshots (no network), derives the operational
 * baseline (RO count, ARO, gross margin) by auditable regression, and projects
 * revenue and gross profit forward under editable scenario levers driven by URL
 * search params. Read-only over Tekmetric — nothing is written or refreshed here.
 */
import Link from "next/link";
import { isTekmetricConfigured } from "@/lib/tekmetric/client";
import { loadOpsHistory } from "@/lib/tekmetric/history-service";
import { shopToday } from "@/lib/tekmetric/periods";
import {
  deriveOpsBaseline,
  projectOps,
  summarizeOpsProjection,
  type OpsScenario,
} from "@/lib/tekmetric/forecast";
import type { Confidence } from "@/lib/projections/regression/ols";
import { money } from "../reporting/format";
import { OpsForecastChart } from "./OpsForecastChart";

export interface OpsScenarioInput {
  horizon?: string;
  aro?: string; // ARO growth, percent per month (e.g. "2" → +2%/mo)
  ro?: string; // RO-count growth, percent per month
  margin?: string; // fixed gross-margin override, percent
}

function confBadge(c: Confidence): string {
  return c === "strong" ? "ok" : c === "moderate" ? "warn" : "muted";
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

const pctMo = (frac: number): string => `${(frac * 100).toFixed(1)}%/mo`;

export async function OpsForecastPanel({ sp }: { sp: OpsScenarioInput }) {
  const configured = isTekmetricConfigured();
  const hist = await loadOpsHistory(shopToday(), 24);

  if (!hist.connected) {
    return (
      <div className="notice info">
        {configured ? (
          <>
            Not enough Tekmetric history yet to build an operations forecast (found {hist.found}{" "}
            {hist.found === 1 ? "month" : "months"}; need at least 3). An owner can backfill it with{" "}
            <code>npm run tekmetric:backfill</code>, or refresh recent months on the{" "}
            <Link href="/tekmetric">Tekmetric</Link> page.
          </>
        ) : (
          <>
            Tekmetric isn’t configured, so there’s no operational history to forecast from. Set{" "}
            <code>TEKMETRIC_TOKEN</code> and <code>TEKMETRIC_SHOP_ID</code> to enable it.
          </>
        )}
      </div>
    );
  }

  const baseline = deriveOpsBaseline(hist.history);

  // Scenario from URL params. Growth inputs are percent-per-month → fractions;
  // blank fields fall back to the derived trend.
  const horizon = Math.max(1, Math.min(24, Math.round(num(sp.horizon) ?? 12)));
  const aroPct = num(sp.aro);
  const roPct = num(sp.ro);
  const marginOverride = num(sp.margin);
  const scenario: OpsScenario = {
    horizonMonths: horizon,
    aroMonthlyGrowthPct: aroPct !== undefined ? aroPct / 100 : undefined,
    roMonthlyGrowthPct: roPct !== undefined ? roPct / 100 : undefined,
    grossMarginPct: marginOverride,
  };

  const rows = projectOps(baseline, scenario);
  const summary = summarizeOpsProjection(rows);
  const chartData = rows.map((r) => ({ label: r.label, revenue: r.revenue, grossProfit: r.grossProfit }));

  const trends: Array<{ label: string; t: (typeof baseline)["roCount"]; fmt: (n: number) => string }> = [
    { label: "RO count / mo", t: baseline.roCount, fmt: (n) => Math.round(n).toLocaleString("en-US") },
    { label: "ARO", t: baseline.aro, fmt: (n) => money(n) },
    { label: "Gross margin", t: baseline.grossMarginPct, fmt: (n) => `${n.toFixed(1)}%` },
  ];

  return (
    <>
      <p className="page-desc">
        Forward operations scenarios derived from {hist.months} months of your own Tekmetric history
        ({baseline.lastLabel} is the latest). Baseline trends are fitted by regression and shown as
        editable defaults — override any lever below. Read-only; nothing is written to Tekmetric.
      </p>

      {/* Derived baseline trends */}
      <div className="card">
        <h3 className="card-title" style={{ marginTop: 0 }}>Derived baseline</h3>
        <p className="card-subtitle">
          Fitted over {baseline.months} months. Confidence reflects fit quality (R²) and sample size.
        </p>
        <div className="kpi-grid" style={{ marginTop: 12 }}>
          {trends.map((row) => (
            <div className="kpi-card" key={row.label}>
              <div className="kpi-label">{row.label}</div>
              <div className="kpi-value">{row.fmt(row.t.current)}</div>
              <div className="kpi-foot">
                <span className={`badge ${confBadge(row.t.confidence)}`}>{row.t.confidence}</span>
                <span className="card-subtitle">
                  {row.t.monthlyGrowthPct >= 0 ? "+" : ""}
                  {pctMo(row.t.monthlyGrowthPct)} · R² {row.t.r2.toFixed(2)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Scenario levers */}
      <form method="GET" action="/projections" className="card" style={{ marginTop: 16 }}>
        <input type="hidden" name="tab" value="ops" />
        <h3 className="card-title" style={{ marginTop: 0 }}>Scenario</h3>
        <p className="card-subtitle">Leave a field blank to use the derived trend.</p>
        <div className="grid" style={{ marginTop: 12 }}>
          <div className="field">
            <label>Horizon (months)</label>
            <select className="input" name="horizon" defaultValue={String(horizon)}>
              {[6, 12, 18, 24].map((h) => (
                <option key={h} value={h}>{h}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>ARO growth (%/mo)</label>
            <input
              className="input"
              name="aro"
              type="number"
              step="0.1"
              defaultValue={sp.aro ?? ""}
              placeholder={(baseline.aro.monthlyGrowthPct * 100).toFixed(1)}
            />
          </div>
          <div className="field">
            <label>RO-count growth (%/mo)</label>
            <input
              className="input"
              name="ro"
              type="number"
              step="0.1"
              defaultValue={sp.ro ?? ""}
              placeholder={(baseline.roCount.monthlyGrowthPct * 100).toFixed(1)}
            />
          </div>
          <div className="field">
            <label>Gross margin (%)</label>
            <input
              className="input"
              name="margin"
              type="number"
              step="0.1"
              defaultValue={sp.margin ?? ""}
              placeholder={baseline.grossMarginPct.current.toFixed(1)}
            />
          </div>
        </div>
        <div className="row-actions">
          <button className="btn primary" type="submit">Recompute</button>
          <Link className="btn ghost" href="/projections?tab=ops">Reset to trend</Link>
        </div>
      </form>

      {/* Summary */}
      <div className="kpi-grid" style={{ marginTop: 16 }}>
        <div className="kpi-card">
          <div className="kpi-label">Revenue · next {summary.horizonMonths} mo</div>
          <div className="kpi-value">{money(summary.totalRevenue)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Gross profit · next {summary.horizonMonths} mo</div>
          <div className="kpi-value">{money(summary.totalGrossProfit)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Ending monthly revenue</div>
          <div className="kpi-value">{money(summary.endingMonthlyRevenue)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Ending ARO</div>
          <div className="kpi-value">{money(summary.endingAro)}</div>
        </div>
      </div>

      {/* Projection chart */}
      <div className="card" style={{ marginTop: 16 }}>
        <h3 className="card-title" style={{ marginTop: 0 }}>Projected revenue &amp; gross profit</h3>
        <p className="card-subtitle">{baseline.lastLabel} → {rows[rows.length - 1]?.label}</p>
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
              <th className="num">ARO</th>
              <th className="num">Revenue</th>
              <th className="num">Gross profit</th>
              <th className="num">Margin</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.monthIndex}>
                <td>{r.label}</td>
                <td className="num">{Math.round(r.roCount).toLocaleString("en-US")}</td>
                <td className="num">{money(r.aro)}</td>
                <td className="num">{money(r.revenue)}</td>
                <td className="num">{money(r.grossProfit)}</td>
                <td className="num">{r.grossMarginPct.toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
