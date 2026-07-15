/**
 * Financial Projections module (§1) — shell + tab router.
 *
 * Phase 1 turns this into a financial-reporting hub. Two sub-tabs live under the
 * one route so the scenario prototype stays reachable and nothing regresses:
 *   - Reporting (default): live, read-only QBO actuals with KPI deltas + charts.
 *   - Scenarios: the original manual-assumption cash-flow engine.
 *
 * Filters (date range, comparison, method, granularity) are URL search params so
 * the Reporting tab recomputes server-side on every change.
 */
import Link from "next/link";
import { getSessionUser } from "@/lib/auth/session";
import { RequireAuth } from "../components/RequireAuth";
import {
  isRangePreset,
  isComparisonMode,
  isAccountingMethod,
  type RangePreset,
  type ComparisonMode,
  type AccountingMethod,
  type Granularity,
} from "@/lib/projections/reports";
import type { ReportFilters } from "@/lib/projections/report-service";
import { can } from "@/lib/auth/roles";
import { ReportingPanel } from "./reporting/ReportingPanel";
import type { FilterState } from "./reporting/FilterBar";
import { ProjectionsPanel } from "./v2/ProjectionsPanel";
import { ScenariosPanel } from "./ScenariosPanel";
import { AiCouncilPanel } from "./ai/AiCouncilPanel";
import { OpsForecastPanel } from "./ops/OpsForecastPanel";
import { OpsHistoryPanel } from "./ops/OpsHistoryPanel";

export const dynamic = "force-dynamic";

type Tab = "reporting" | "projections" | "scenarios" | "ops" | "opshistory" | "council";

interface SP {
  tab?: string;
  scenario?: string;
  run?: string;
  preset?: string;
  cmp?: string;
  method?: string;
  gran?: string;
  start?: string;
  end?: string;
  // Ops forecast scenario levers
  horizon?: string;
  aro?: string;
  ro?: string;
  margin?: string;
}

function parseFilters(sp: SP): { filters: ReportFilters; state: FilterState } {
  const preset: RangePreset = isRangePreset(sp.preset) ? sp.preset : "this_month";
  const comparison: ComparisonMode = isComparisonMode(sp.cmp) ? sp.cmp : "prior_period";
  const method: AccountingMethod = isAccountingMethod(sp.method) ? sp.method : "accrual";
  const granularity: Granularity =
    sp.gran === "quarter" || sp.gran === "year" ? sp.gran : "month";
  const customStart = sp.start || undefined;
  const customEnd = sp.end || undefined;

  const filters: ReportFilters = { preset, comparison, method, granularity, customStart, customEnd };
  const state: FilterState = { preset, comparison, method, granularity, customStart, customEnd };
  return { filters, state };
}

function TabLink({ tab, active, children }: { tab: Tab; active: boolean; children: React.ReactNode }) {
  return (
    <Link className={active ? "active" : ""} href={`/projections?tab=${tab}`}>
      {children}
    </Link>
  );
}

export default async function ProjectionsPage({ searchParams }: { searchParams: SP }) {
  const user = await getSessionUser();
  if (!user) return <RequireAuth />;

  const canViewCouncil = can(user.role, "view_ai_council");
  const canViewOps = can(user.role, "view_tekmetric");
  const requested = searchParams.tab;
  const tab: Tab =
    requested === "scenarios"
      ? "scenarios"
      : requested === "projections"
        ? "projections"
        : requested === "ops" && canViewOps
          ? "ops"
          : requested === "opshistory" && canViewOps
            ? "opshistory"
            : requested === "council" && canViewCouncil
              ? "council"
              : "reporting";
  const { filters, state } = parseFilters(searchParams);
  const canRefresh = can(user.role, "view_projections");

  return (
    <>
      <div className="accent-bar" />
      <h1>Financial Projections</h1>
      <p className="page-desc">
        Interactive QBO reporting with period-over-period deltas, a derived-baseline projection engine, and the
        AI C-suite council. All read-only.
      </p>

      <div className="segmented" style={{ marginBottom: 18 }}>
        <TabLink tab="reporting" active={tab === "reporting"}>
          Reporting
        </TabLink>
        <TabLink tab="projections" active={tab === "projections"}>
          Projections
        </TabLink>
        <TabLink tab="scenarios" active={tab === "scenarios"}>
          Scenarios
        </TabLink>
        {canViewOps && (
          <TabLink tab="ops" active={tab === "ops"}>
            Ops forecast
          </TabLink>
        )}
        {canViewOps && (
          <TabLink tab="opshistory" active={tab === "opshistory"}>
            Ops history
          </TabLink>
        )}
        {canViewCouncil && (
          <TabLink tab="council" active={tab === "council"}>
            AI Council
          </TabLink>
        )}
      </div>

      {tab === "reporting" && (
        <ReportingPanel filters={filters} filterState={state} canRefresh={canRefresh} />
      )}
      {tab === "projections" && (
        <ProjectionsPanel user={user} selectedScenarioId={searchParams.scenario} />
      )}
      {tab === "scenarios" && (
        <ScenariosPanel user={user} selectedScenarioId={searchParams.scenario} />
      )}
      {tab === "ops" && canViewOps && (
        <OpsForecastPanel
          sp={{
            horizon: searchParams.horizon,
            aro: searchParams.aro,
            ro: searchParams.ro,
            margin: searchParams.margin,
          }}
        />
      )}
      {tab === "opshistory" && canViewOps && <OpsHistoryPanel />}
      {tab === "council" && canViewCouncil && (
        <AiCouncilPanel user={user} selectedRunId={searchParams.run} />
      )}
    </>
  );
}
