/**
 * Arcade bridge for the redesigned Financial Projections page.
 *
 * Same standalone-secret trust boundary as /api/external/assistant (see that
 * route's header comment) — gcd-arcade's BFF is the only caller, secret
 * injected server-side. Wraps the hub's own `loadReporting()` (the exact
 * function the /projections Reporting tab renders from) plus GCD Pal's
 * deterministic `projections` insights, so the Arcade tile and the hub's own
 * page can never show different numbers for the same filters.
 *
 * GET  ?preset=&comparison=&method=&granularity=&start=&end=
 *   Normal fetch-through-cache read (auto-refreshes past its own 6h TTL),
 *   same as opening the hub's own page without clicking "Refresh from
 *   QuickBooks".
 * POST (same query params)
 *   Forces a live QBO refetch, mirroring the hub's own
 *   refreshReportSnapshotsAction. No per-user role check happens here —
 *   the Arcade bridge has no user session to check a role against; access
 *   to the Arcade at all (ownership/management only, per the redesign
 *   brief) is the trust boundary this relies on instead.
 */
import { NextResponse } from "next/server";
import { loadReporting, type ReportFilters } from "@/lib/projections/report-service";
import { RANGE_PRESETS, type RangePreset, type ComparisonMode, type AccountingMethod, type Granularity } from "@/lib/projections/reports";
import { buildModuleInsights } from "@/lib/assistant/insights";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const RANGE_PRESET_VALUES: Set<string> = new Set(RANGE_PRESETS.map((p) => p.value));
const GRANULARITY_VALUES = new Set(["month", "quarter", "year"]);

function authorized(req: Request): boolean {
  const secret = process.env.ARCADE_BRIDGE_SECRET;
  if (!secret) return false; // fail closed — never run unauthenticated
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${secret}`;
}

function filtersFrom(q: URLSearchParams): ReportFilters {
  const preset: RangePreset = RANGE_PRESET_VALUES.has(q.get("preset") ?? "") ? (q.get("preset") as RangePreset) : "this_month";
  const comparison: ComparisonMode = q.get("comparison") === "prior_year" ? "prior_year" : "prior_period";
  const method: AccountingMethod = q.get("method") === "cash" ? "cash" : "accrual";
  const granularity: Granularity = GRANULARITY_VALUES.has(q.get("granularity") ?? "") ? (q.get("granularity") as Granularity) : "month";
  return {
    preset,
    comparison,
    method,
    granularity,
    customStart: q.get("start") ?? undefined,
    customEnd: q.get("end") ?? undefined,
  };
}

async function respond(filters: ReportFilters, opts: { forceRefresh?: boolean } = {}) {
  try {
    const [reporting, insights] = await Promise.all([
      loadReporting(filters, new Date(), opts),
      buildModuleInsights("projections"),
    ]);
    return NextResponse.json({ reporting, insights });
  } catch (err) {
    return NextResponse.json({ error: "reporting_failed", message: String(err) }, { status: 500 });
  }
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  return respond(filtersFrom(url.searchParams));
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  return respond(filtersFrom(url.searchParams), { forceRefresh: true });
}
