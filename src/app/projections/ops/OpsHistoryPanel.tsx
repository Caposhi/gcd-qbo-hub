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
 *
 * Owners (`override_tekmetric_ops`) can manually correct a month whose pull is
 * REPRODUCIBLY wrong (re-running the backfill doesn't help — see
 * looksLikePartialMonth's doc comment) after cross-checking the real figures
 * against Tekmetric's own report. The correction is stored in
 * `tek_month_overrides` and read by `readOperationsKpis`, so it flows through
 * this table AND the Ops forecast baseline with no separate recalculation step.
 */
import Link from "next/link";
import { prisma } from "@/lib/db";
import { isTekmetricConfigured } from "@/lib/tekmetric/client";
import { loadOpsHistory } from "@/lib/tekmetric/history-service";
import { shopToday } from "@/lib/tekmetric/periods";
import { looksLikePartialMonth, type OpsMonth } from "@/lib/tekmetric/forecast";
import { money } from "../reporting/format";
import { OpsForecastChart } from "./OpsForecastChart";
import {
  saveTekmetricOverrideAction,
  clearTekmetricOverrideAction,
  extractTekmetricReportAction,
} from "./actions";

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Last day of the calendar month a "YYYY-MM-DD" (1st-of-month) start falls in. */
function endOfMonth(startIso: string): string {
  const [y, m] = startIso.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** Pre-filled values for the correction form, from an uploaded End of Day Report. */
export interface OverrideDraft {
  start: string;
  end: string;
  roCount: string;
  aro: string;
  grossProfit: string;
  netSales: string;
  reportProfit: string;
  laborCost: string;
  /** Real QBO labor cost for this month, or null when QBO wasn't reachable/connected. */
  qboLaborCost: string | null;
}

export async function OpsHistoryPanel({
  canOverride = false,
  error,
  draft,
}: {
  canOverride?: boolean;
  error?: string;
  draft?: OverrideDraft;
}) {
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
    !m.overridden && looksLikePartialMonth({ roCount: m.roCount, grossMarginPct: m.grossMarginPct, aro: m.aro });
  const flagged = history.filter(suspect);

  // Overridden-month detail (who/when/note) for display only — the KPI values
  // themselves already came through readOperationsKpis via loadOpsHistory. A
  // small, indexed query over a tiny table — cheap enough to always run.
  const overrides = await prisma.tekMonthOverride.findMany({ where: { active: true } });
  const overrideByStart = new Map<string, (typeof overrides)[number]>();
  for (const o of overrides) overrideByStart.set(o.periodStart.toISOString().slice(0, 10), o);

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

  // Car count isn't on the End of Day Report, but we already compute it
  // independently (VIN-matched against live Tekmetric data) for every month
  // in `history` — pre-fill the correction form with that existing figure
  // instead of leaving it blank, while still letting the owner override it.
  const draftCarCount = draft ? history.find((m) => m.start === draft.start)?.carCount : undefined;

  return (
    <>
      <p className="page-desc">
        Actual monthly operations from your Tekmetric history ({history[0]?.label} →{" "}
        {history[history.length - 1]?.label}). This is the real imported data behind the Ops forecast —
        use it to sanity-check what was backfilled. Read-only; reads the cache, nothing is fetched. Gross profit
        subtracts real labor cost from QBO&apos;s payroll ledger for that month — a re-backfill is needed to
        apply this to months snapshotted before this changed.
      </p>

      {error && <div className="notice danger">{error}</div>}

      {flagged.length > 0 && (
        <div className="notice warn">
          {flagged.length} {flagged.length === 1 ? "month looks" : "months look"} like a partial or
          rate-limited import ({flagged.map((m) => m.label).join(", ")}) and{" "}
          {flagged.length === 1 ? "is" : "are"} excluded from the forecast baseline. Re-running{" "}
          <code>npm run tekmetric:backfill</code> won&apos;t fix a month whose real Tekmetric pull is
          consistently this shape
          {canOverride ? (
            <>
              {" "}
              — cross-check it against Tekmetric&apos;s own report and correct it below.
            </>
          ) : (
            "."
          )}
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
              const status = m.overridden ? "overridden" : bad ? "suspect" : "ok";
              const badgeClass = m.overridden ? "info" : bad ? "danger" : "ok";
              const ov = overrideByStart.get(m.start);
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
                    <span
                      className={`badge ${badgeClass}`}
                      title={ov ? `Corrected by ${ov.overriddenByEmail}${ov.note ? `: ${ov.note}` : ""}` : undefined}
                    >
                      {status}
                    </span>
                    {canOverride && m.overridden && (
                      <form action={clearTekmetricOverrideAction} style={{ display: "inline", marginLeft: 8 }}>
                        <input type="hidden" name="periodStart" value={m.start} />
                        <button type="submit" className="btn ghost" style={{ padding: "2px 8px", fontSize: 12 }}>
                          clear
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {canOverride && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3 className="card-title" style={{ marginTop: 0 }}>Correct a month</h3>
          <p className="card-subtitle">
            For a month whose live Tekmetric pull is reproducibly wrong (re-running the backfill won&apos;t
            change it). Upload that month&apos;s End of Day Report and the figures below pre-fill automatically —
            or enter them by hand. Revenue and gross margin are always computed (RO count × ARO, and gross
            profit ÷ that revenue), so they can never drift out of tie-out.
          </p>

          <form
            action={extractTekmetricReportAction}
            style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}
          >
            <input type="file" name="reportFile" accept=".pdf,application/pdf,image/png,image/jpeg,image/webp" required />
            <button type="submit" className="btn secondary">
              Read report &amp; pre-fill below
            </button>
          </form>

          {draft && (
            <div className="notice info" style={{ marginTop: 12 }}>
              <strong>From your uploaded report ({draft.start} → {draft.end}):</strong> Net Sales {money(Number(draft.netSales) || 0)},
              report Profit {money(Number(draft.reportProfit) || 0)}, report Labor Cost {money(Number(draft.laborCost) || 0)}
              {draft.qboLaborCost !== null ? (
                <>
                  , QBO&apos;s actual labor cost for this month {money(Number(draft.qboLaborCost) || 0)}. Gross profit = report
                  Profit + report Labor Cost − QBO Labor Cost ={" "}
                </>
              ) : (
                <>
                  . <strong>QBO&apos;s payroll figures weren&apos;t reachable for this month</strong> — gross profit falls back
                  to report Profit + report Labor Cost (labor treated as free, same as before this month is corrected) ={" "}
                </>
              )}
              {money(Number(draft.grossProfit) || 0)}. Check the pre-filled figures below against the report image before saving.
              Revenue below is RO count × ARO, not the report&apos;s Net Sales directly — expect a penny-level rounding gap.{" "}
              {draftCarCount !== undefined ? (
                <>Car count is pre-filled from what we already compute for this month (VIN-matched, not from the report) — double-check it.</>
              ) : (
                <>
                  <strong>Car count needs to be entered by hand</strong> — it isn&apos;t on the report, and we don&apos;t have an
                  existing figure for this month to suggest.
                </>
              )}
            </div>
          )}

          <form action={saveTekmetricOverrideAction} style={{ display: "grid", gap: 12, maxWidth: 560, marginTop: 16 }}>
            <label>
              Month
              <select name="period" className="input" required defaultValue={draft ? `${draft.start}|${draft.end}` : ""}>
                <option value="" disabled>
                  Select a month…
                </option>
                {draft && !history.some((m) => m.start === draft.start) && (
                  <option value={`${draft.start}|${draft.end}`}>{draft.start} → {draft.end} (from upload)</option>
                )}
                {[...history].reverse().map((m) => (
                  <option key={m.start} value={`${m.start}|${endOfMonth(m.start)}`}>
                    {m.label} {m.overridden ? "(already corrected)" : suspect(m) ? "(suspect)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <label>
                RO count
                <input type="number" name="roCount" className="input" min={0} step={1} required defaultValue={draft?.roCount} />
              </label>
              <label>
                Car count
                <input
                  type="number"
                  name="carCount"
                  className="input"
                  min={0}
                  step={1}
                  required
                  defaultValue={draftCarCount !== undefined ? Math.round(draftCarCount) : undefined}
                />
              </label>
              <label>
                ARO ($)
                <input type="number" name="aro" className="input" min={0} step="0.01" required defaultValue={draft?.aro} />
              </label>
              <label>
                Gross profit ($)
                <input
                  type="number"
                  name="grossProfit"
                  className="input"
                  step="0.01"
                  required
                  defaultValue={draft?.grossProfit}
                />
              </label>
            </div>
            <label>
              Note (optional)
              <input
                type="text"
                name="note"
                className="input"
                placeholder="e.g. cross-checked vs. Tekmetric End of Day Report"
                defaultValue={draft ? "Cross-checked vs. uploaded Tekmetric End of Day Report" : undefined}
              />
            </label>
            <div className="row-actions">
              <button type="submit" className="btn primary">
                Save correction
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
