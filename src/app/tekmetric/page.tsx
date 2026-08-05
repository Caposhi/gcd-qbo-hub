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
  shopToday,
  ytdComposableRange,
  monthRangeToKey,
  type ComparisonMode,
  type DatePreset,
} from "@/lib/tekmetric/periods";
import type { TekKpi, TekOperationsData, TekPeriod } from "@/lib/tekmetric/types";
import { findRepeatVehicleVisits, type TekRepeatVisit } from "@/lib/tekmetric/normalize";
import { composeOperationsRange, type MonthRef } from "@/lib/tekmetric/compose";
import { MAX_FILL_PER_CLICK } from "@/lib/tekmetric/fill-gaps";
import { TekCharts } from "./charts";
import { refreshTekmetricAction, fillMissingTekmetricMonthsAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Presets wide enough that a live "Refresh from Tekmetric" pull is never
 * offered for them — read via `composeOperationsRange` from the existing
 * per-month cache instead (see compose.ts). "Last 90 days" is deliberately
 * NOT here: at 90 days it (and its comparison, whichever mode) always stays
 * under `MAX_REFRESH_RANGE_DAYS` (100), so it keeps using the plain live
 * refresh unchanged — composing it would just be extra machinery for a
 * preset that was never actually part of the OOM this exists to avoid.
 */
const WIDE_PRESETS = new Set<DatePreset>(["ytd", "last_year"]);

const selectStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border-default)",
  background: "#fff",
  color: "var(--text-strong)",
  fontSize: 13,
  fontFamily: "var(--font-body)",
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

/**
 * House-format KPI tile: figure + up/down % and $/unit delta vs. comparison.
 * For every metric here (car/RO count, ARO, gross profit, margin) higher is
 * better, so a rise is favorable → `.delta.up` (green), a fall → `.delta.down`.
 */
function KpiTile({ label, kpi, format }: { label: string; kpi: TekKpi; format: KpiFormat }) {
  const hasDelta = kpi.deltaAbs !== null;
  const up = (kpi.deltaAbs ?? 0) >= 0;
  const deltaAbsStr = kpi.deltaAbs === null ? "" : fmt(Math.abs(kpi.deltaAbs), format);
  const deltaPctStr = kpi.deltaPct === null ? null : `${Math.abs(kpi.deltaPct).toFixed(1)}%`;

  return (
    <div className="kpi-card">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{fmt(kpi.value, format)}</div>
      <div className="kpi-foot">
        {hasDelta ? (
          <>
            <span className={"delta " + (up ? "up" : "down")}>
              {up ? "▲" : "▼"} {deltaPctStr ?? "—"}
            </span>
            {deltaAbsStr && <span className="card-subtitle">{deltaAbsStr}</span>}
          </>
        ) : (
          <span className="card-subtitle">no comparison</span>
        )}
      </div>
    </div>
  );
}

/** "10 of 12 months cached — missing: Mar 2025, Jul 2025" style summary,
 *  mirroring the health page's own phrasing for the same underlying gap. */
function monthsCoverageLabel(found: string[], missing: MonthRef[]): string {
  const total = found.length + missing.length;
  if (total === 0) return "no months in range";
  if (missing.length === 0) return `all ${total} month${total === 1 ? "" : "s"} cached`;
  return `${found.length} of ${total} month${total === 1 ? "" : "s"} cached — missing ${missing.map((m) => m.label).join(", ")}`;
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
          <h1>Tekmetric Operations</h1>
          <p className="card-subtitle">Your role ({user.role}) doesn&apos;t have access to this module.</p>
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

  const isWide = WIDE_PRESETS.has(preset);

  let data: TekOperationsData | null = null;
  let fetchedAt: Date | null = null;
  let repeatVisits: TekRepeatVisit[] = [];
  let repeatVisitsTotal = 0;
  let displayPeriod: TekPeriod = presetRange(preset, shopToday());
  let displayComparisonPeriod: TekPeriod | null = null;
  let ytdUnavailable = false;
  let coverage: { found: string[]; missing: MonthRef[]; comparisonFound: string[]; comparisonMissing: MonthRef[] } | null = null;

  if (isWide) {
    const range = preset === "ytd" ? ytdComposableRange(shopToday()) : presetRange("last_year", shopToday());
    if (!range) {
      // Only reachable for "ytd" while still in January — zero complete
      // months of the current year exist yet to compose from.
      ytdUnavailable = true;
    } else {
      displayPeriod = range;
      // "prior_period" on YTD's trimmed range would compare against
      // whatever whole months immediately precede it — which, for a
      // Jan-through-July-style range, spills into the PRIOR year's back
      // half (Jun–Dec) rather than the intuitive "same months, last year."
      // Only "last_year" (a full calendar year) makes "prior_period" and
      // "prior_year" coincide (see periods.ts test coverage) — for "ytd",
      // always use prior_year semantics once any comparison is wanted.
      const effectiveComparisonMode: ComparisonMode = preset === "ytd" && comparison !== "none" ? "prior_year" : comparison;
      displayComparisonPeriod = comparisonRange(range, effectiveComparisonMode);
      if (configured) {
        const composed = await composeOperationsRange(range, displayComparisonPeriod);
        if (!("error" in composed)) {
          coverage = {
            found: composed.monthsFound,
            missing: composed.monthsMissing,
            comparisonFound: composed.comparisonMonthsFound,
            comparisonMissing: composed.comparisonMonthsMissing,
          };
          // Nothing cached at all yet reads the same as the narrow-preset
          // "no cached data" case below, not as a real all-zero period.
          if (composed.monthsFound.length > 0) {
            data = composed.data;
            repeatVisits = composed.repeatVisits;
            repeatVisitsTotal = composed.repeatVisitsTotal;
          }
        }
        // The `{error: "not_month_aligned"}` case is an internal invariant
        // this branch's own construction should never violate; degrading to
        // "no data" rather than crashing is still the right fallback if it
        // somehow did.
      }
    }
  } else {
    const period = presetRange(preset, shopToday());
    const priorPeriod = comparisonRange(period, comparison);
    displayPeriod = period;
    displayComparisonPeriod = priorPeriod;
    const snap = configured ? await readOperationsSnapshot(period, comparison) : { data: null, fetchedAt: null };
    data = snap.data;
    fetchedAt = snap.fetchedAt;
    repeatVisits = data ? findRepeatVehicleVisits(data.repairOrders, data.vehicles) : [];
    repeatVisitsTotal = repeatVisits.length;
  }

  const fillBatch = coverage ? coverage.missing.slice(0, MAX_FILL_PER_CLICK) : [];
  const fillBatchKeys = fillBatch.map(monthRangeToKey).join(",");
  const totalMissing = coverage ? coverage.missing.length : 0;

  return (
    <>
      <div className="accent-bar" />
      <h1>Tekmetric Operations</h1>
      <p className="page-desc">
        Read-only shop-management KPIs from Tekmetric — ARO, gross profit, technician utilization, revenue by
        make, and service-advisor performance. Data is cached; use Refresh to pull the latest. The headline{" "}
        <strong>Gross profit</strong>/<strong>Gross margin</strong> subtract real labor cost from QBO&apos;s payroll
        ledger — the advisor/vehicle/make breakdowns below don&apos;t (payroll can&apos;t be attributed to one RO),
        so they won&apos;t sum to the headline figure.
      </p>

      {!configured && (
        <div className="notice info">
          Tekmetric is not configured. Set <code>TEKMETRIC_TOKEN</code> and{" "}
          <code>TEKMETRIC_SHOP_ID</code> (and <code>TEKMETRIC_BASE_URL</code>) to enable it.
        </div>
      )}

      {searchParams.error && (
        <div className="notice danger">
          {searchParams.error}. The last cached data (if any) is shown below.
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

      {isWide && (
        <p className="muted" style={{ fontSize: "0.8rem", marginTop: "-0.25rem" }}>
          {preset === "ytd"
            ? "Composed from the cached calendar months so far this year (not a live pull) — through the last fully completed month; comparison uses the same months last year."
            : "Composed from the cached calendar months making up the year (not a live pull)."}
        </p>
      )}

      <p className="muted" style={{ fontSize: "0.8rem", marginTop: "-0.25rem" }}>
        {displayPeriod.start} → {displayPeriod.end}
        {displayComparisonPeriod && ` · comparison ${displayComparisonPeriod.start} → ${displayComparisonPeriod.end}`}
        {fetchedAt && ` · cached ${fetchedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`}
      </p>

      {ytdUnavailable && (
        <div className="notice info">
          Not enough of this year has completed yet to compose a YTD view (at least one full month is needed).
          Try &quot;This month&quot; in the meantime.
        </div>
      )}

      {configured && !ytdUnavailable && !data && (
        <div className="notice info">
          No cached data for this period yet.{" "}
          {isWide
            ? canRefresh
              ? "Click Fill missing months below to pull it from Tekmetric."
              : "An owner needs to fill it first."
            : canRefresh
              ? "Click Refresh to pull it from Tekmetric."
              : "An owner needs to refresh it first."}
        </div>
      )}

      {!isWide && canRefresh && configured && (
        <form action={refreshTekmetricAction} className="row-actions">
          <input type="hidden" name="preset" value={preset} />
          <input type="hidden" name="comparison" value={comparison} />
          <button className="btn secondary" type="submit">
            ↻ Refresh from Tekmetric
          </button>
        </form>
      )}

      {isWide && configured && coverage && !ytdUnavailable && (
        <>
          <p className="muted" style={{ fontSize: "0.8rem" }}>
            {monthsCoverageLabel(coverage.found, coverage.missing)}
            {displayComparisonPeriod &&
              (coverage.comparisonMissing.length > 0 || coverage.comparisonFound.length > 0) &&
              ` · comparison: ${monthsCoverageLabel(coverage.comparisonFound, coverage.comparisonMissing)}`}
          </p>
          {totalMissing > 0 &&
            (canRefresh ? (
              <form action={fillMissingTekmetricMonthsAction} className="row-actions">
                <input type="hidden" name="preset" value={preset} />
                <input type="hidden" name="comparison" value={comparison} />
                <input type="hidden" name="months" value={fillBatchKeys} />
                <button className="btn secondary" type="submit">
                  ↻ Fill {fillBatch.length < totalMissing ? `next ${fillBatch.length} of ${totalMissing}` : `${totalMissing}`}{" "}
                  missing month{totalMissing === 1 ? "" : "s"}
                </button>
              </form>
            ) : (
              <p className="card-subtitle">An owner can fill the missing months from this page.</p>
            ))}
        </>
      )}

      {data && (
        <>
          <div className="kpi-grid">
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

          <h2 style={{ marginTop: "1.5rem", fontSize: 18 }}>Advisor performance</h2>
          {isWide && (
            <p className="card-subtitle">
              Per-advisor car count sums each cached month&apos;s distinct-vehicle count — a car serviced by the
              same advisor in two different months counts twice here, unlike the Car count KPI above (which is
              deduplicated across the whole period).
            </p>
          )}
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="gcd">
              <thead>
                <tr>
                  <th>Advisor</th>
                  <th className="num">ROs</th>
                  <th className="num">Cars</th>
                  <th className="num">Total sales</th>
                  <th className="num">ARO</th>
                  <th className="num">Gross profit</th>
                  <th className="num">Margin</th>
                </tr>
              </thead>
              <tbody>
                {data.advisorPerformance.map((a) => (
                  <tr key={a.advisorId}>
                    <td>{a.advisorName}</td>
                    <td className="num">{a.roCount}</td>
                    <td className="num">{a.carCount}</td>
                    <td className="num">{money(a.totalSales)}</td>
                    <td className="num">{money(a.aro)}</td>
                    <td className="num">{money(a.grossProfit)}</td>
                    <td className="num">{a.grossMarginPct.toFixed(1)}%</td>
                  </tr>
                ))}
                {data.advisorPerformance.length === 0 && (
                  <tr>
                    <td colSpan={7} className="card-subtitle">
                      No advisor activity in this period.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <h2 style={{ marginTop: "1.5rem", fontSize: 18 }}>Repeat visits this period</h2>
          <p className="card-subtitle">
            Vehicles with 2+ ROs in {displayPeriod.start} → {displayPeriod.end} — the gap between RO count (
            {data.kpis.roCount.value}) and car count ({data.kpis.carCount.value}). Matched by VIN when Tekmetric has
            one on file, else by the internal vehicle record.
            {repeatVisitsTotal > repeatVisits.length && ` Showing the top ${repeatVisits.length} of ${repeatVisitsTotal} by RO count.`}
          </p>
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="gcd">
              <thead>
                <tr>
                  <th>Vehicle</th>
                  <th>VIN</th>
                  <th className="num">ROs this period</th>
                </tr>
              </thead>
              <tbody>
                {repeatVisits.map((v) => (
                  <tr key={v.vehicleKey}>
                    <td>{[v.year, v.make, v.model].filter(Boolean).join(" ") || "Unknown vehicle"}</td>
                    <td>{v.vin ?? "—"}</td>
                    <td className="num">{v.roCount}</td>
                  </tr>
                ))}
                {repeatVisits.length === 0 && (
                  <tr>
                    <td colSpan={3} className="card-subtitle">
                      No vehicle had more than one RO in this period.
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
