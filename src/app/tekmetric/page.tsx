import { getSessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/roles";
import { RequireAuth } from "../components/RequireAuth";
import { isTekmetricConfigured } from "@/lib/tekmetric/client";
import { readOperationsSnapshot } from "@/lib/tekmetric/snapshot";
import {
  COMPARISON_MODES,
  DATE_PRESETS,
  DEFAULT_COMPARISON,
  DEFAULT_PRESET,
  comparisonRange,
  presetRange,
  type ComparisonMode,
  type DatePreset,
} from "@/lib/tekmetric/periods";
import type { TekKpi } from "@/lib/tekmetric/types";
import { TekCharts } from "./charts";
import { refreshTekmetricAction } from "./actions";

export const dynamic = "force-dynamic";

const selectStyle: React.CSSProperties = {
  padding: "0.35rem 0.5rem",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--panel-2)",
  color: "var(--text)",
};

type KpiFormat = "money" | "count" | "percent";

function money(v: number): string {
  return v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function fmt(v: number, format: KpiFormat): string {
  if (format === "money") return money(v);
  if (format === "percent") return `${v.toFixed(1)}%`;
  return Math.round(v).toLocaleString("en-US");
}

/** House-format KPI tile: figure + up/down % and $/unit delta vs. comparison. */
function KpiTile({ label, kpi, format }: { label: string; kpi: TekKpi; format: KpiFormat }) {
  const hasDelta = kpi.deltaAbs !== null;
  const up = (kpi.deltaAbs ?? 0) >= 0;
  const arrow = up ? "▲" : "▼";
  const color = up ? "var(--ok)" : "var(--danger)";
  const deltaAbsStr = kpi.deltaAbs === null ? "" : fmt(Math.abs(kpi.deltaAbs), format);
  const deltaPctStr = kpi.deltaPct === null ? null : `${Math.abs(kpi.deltaPct).toFixed(1)}%`;

  return (
    <div className="tile">
      <div className="n">{fmt(kpi.value, format)}</div>
      <div className="l">{label}</div>
      {hasDelta ? (
        <div style={{ marginTop: 6, fontSize: "0.8rem", color }}>
          {arrow} {deltaPctStr ?? "—"} {deltaAbsStr && <span style={{ color: "var(--muted)" }}>({deltaAbsStr})</span>}
        </div>
      ) : (
        <div style={{ marginTop: 6, fontSize: "0.8rem", color: "var(--muted)" }}>no comparison</div>
      )}
    </div>
  );
}

export default async function TekmetricPage({
  searchParams,
}: {
  searchParams: { preset?: string; comparison?: string; error?: string };
}) {
  const user = await getSessionUser();
  if (!user) return <RequireAuth />;

  if (!can(user.role, "view_tekmetric")) {
    return (
      <div className="center">
        <div className="card" style={{ width: 420 }}>
          <h1>🔧 Tekmetric Operations</h1>
          <p className="sub">Your role ({user.role}) doesn&apos;t have access to this module.</p>
        </div>
      </div>
    );
  }

  const canRefresh = can(user.role, "refresh_tekmetric");
  const configured = isTekmetricConfigured();

  const presetValues = DATE_PRESETS.map((p) => p.value);
  const comparisonValues = COMPARISON_MODES.map((c) => c.value);
  const preset: DatePreset = presetValues.includes(searchParams.preset as DatePreset)
    ? (searchParams.preset as DatePreset)
    : DEFAULT_PRESET;
  const comparison: ComparisonMode = comparisonValues.includes(searchParams.comparison as ComparisonMode)
    ? (searchParams.comparison as ComparisonMode)
    : DEFAULT_COMPARISON;

  const period = presetRange(preset, new Date());
  const priorPeriod = comparisonRange(period, comparison);

  const { data, fetchedAt } = configured ? await readOperationsSnapshot(period) : { data: null, fetchedAt: null };

  return (
    <>
      <h1>🔧 Tekmetric Operations</h1>
      <p className="sub">
        Read-only shop-management KPIs from Tekmetric — ARO, gross profit, technician utilization, revenue by
        make, and service-advisor performance. Data is cached; use Refresh to pull the latest.
      </p>

      {!configured && (
        <div className="notice">
          Tekmetric is not configured. Set <code>TEKMETRIC_TOKEN</code> and{" "}
          <code>TEKMETRIC_SHOP_ID</code> (and <code>TEKMETRIC_BASE_URL</code>) to enable it.
        </div>
      )}

      {searchParams.error && (
        <div className="notice danger">
          Refresh failed: {searchParams.error}. The last cached data (if any) is shown below.
        </div>
      )}

      {/* Filter bar — a GET form drives the selected period + comparison. */}
      <form method="GET" className="row-actions" style={{ alignItems: "center" }}>
        <label className="kv" style={{ gridTemplateColumns: "auto auto", alignItems: "center" }}>
          <span className="muted">Period</span>
          <select name="preset" defaultValue={preset} style={selectStyle}>
            {DATE_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="kv" style={{ gridTemplateColumns: "auto auto", alignItems: "center" }}>
          <span className="muted">Compare</span>
          <select name="comparison" defaultValue={comparison} style={selectStyle}>
            {COMPARISON_MODES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <button className="btn secondary" type="submit">
          Apply
        </button>
      </form>

      <p className="muted" style={{ fontSize: "0.8rem", marginTop: "-0.25rem" }}>
        {period.start} → {period.end}
        {priorPeriod && ` · comparison ${priorPeriod.start} → ${priorPeriod.end}`}
        {fetchedAt && ` · cached ${fetchedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`}
      </p>

      {configured && !data && (
        <div className="notice">
          No cached data for this period yet.{" "}
          {canRefresh ? "Click Refresh to pull it from Tekmetric." : "An owner needs to refresh it first."}
        </div>
      )}

      {canRefresh && configured && (
        <form action={refreshTekmetricAction} className="row-actions">
          <input type="hidden" name="preset" value={preset} />
          <input type="hidden" name="comparison" value={comparison} />
          <button className="btn" type="submit">
            ↻ Refresh from Tekmetric
          </button>
        </form>
      )}

      {data && (
        <>
          <div className="tiles">
            <KpiTile label="Car count" kpi={data.kpis.carCount} format="count" />
            <KpiTile label="RO count" kpi={data.kpis.roCount} format="count" />
            <KpiTile label="ARO (avg RO)" kpi={data.kpis.aro} format="money" />
            <KpiTile label="Gross profit" kpi={data.kpis.grossProfit} format="money" />
            <KpiTile label="Gross margin" kpi={data.kpis.grossMarginPct} format="percent" />
          </div>

          <TekCharts
            techUtilization={data.techUtilization}
            revenueByMake={data.revenueByMake}
            advisorPerformance={data.advisorPerformance}
          />

          <h2 style={{ marginTop: "1.5rem" }}>Advisor performance</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Advisor</th>
                  <th>ROs</th>
                  <th>Cars</th>
                  <th>Total sales</th>
                  <th>ARO</th>
                  <th>Gross profit</th>
                  <th>Margin</th>
                </tr>
              </thead>
              <tbody>
                {data.advisorPerformance.map((a) => (
                  <tr key={a.advisorId}>
                    <td>{a.advisorName}</td>
                    <td>{a.roCount}</td>
                    <td>{a.carCount}</td>
                    <td>{money(a.totalSales)}</td>
                    <td>{money(a.aro)}</td>
                    <td>{money(a.grossProfit)}</td>
                    <td>{a.grossMarginPct.toFixed(1)}%</td>
                  </tr>
                ))}
                {data.advisorPerformance.length === 0 && (
                  <tr>
                    <td colSpan={7} className="muted">
                      No advisor activity in this period.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
