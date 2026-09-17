/**
 * gcd-attribution bridge for Tekmetric Profit Intelligence's labor-rate admin
 * (TP1-d, in gcd-attribution's apps/api/src/services/labor-cost-rate.ts).
 *
 * Same standalone-secret trust boundary as the other /api/external/* bridges
 * (see reporting/route.ts's header comment) — but gated on its OWN secret,
 * ATTRIBUTION_BRIDGE_SECRET, distinct from ARCADE_BRIDGE_SECRET. Per
 * docs/SECURITY_AND_CONTINUITY.md, "shared bearer secrets... collapse
 * attribution to a service identity" and different callers must not share
 * one — gcd-attribution is a different service than gcd-arcade, so it gets a
 * different credential rather than reusing Arcade's.
 *
 * Read-only. Never posts, writes, or refreshes anything gcd-attribution can't
 * already see reflected back to it; this only reads the same cached,
 * normalized P&L the Reporting and Tekmetric Operations pages already use.
 *
 * GET ?start=YYYY-MM-DD&end=YYYY-MM-DD
 *   Fetch-through-cache read (auto-refreshes past the snapshot's own 6h TTL),
 *   same freshness as opening the hub's own Reporting page.
 *
 * The response reports each figure as null, never zero, when QuickBooks has
 * no matching line for it (see labor-rate-bridge.ts) or when QuickBooks isn't
 * connected at all (connected: false) — gcd-attribution's rate form must show
 * "unavailable," not silently treat a missing number as zero labor cost.
 */
import { NextResponse } from "next/server";
import { getReportSnapshot } from "@/lib/projections/report-service";
import { QboNotConnectedError, isQboConnectivityError } from "@/lib/qbo/client";
import { deriveLaborRateInputs } from "@/lib/tekmetric/labor-rate-bridge";
import type { PnlNormalized } from "@/lib/projections/reports";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

function authorized(req: Request): boolean {
  const secret = process.env.ATTRIBUTION_BRIDGE_SECRET;
  if (!secret) return false; // fail closed — never run unauthenticated
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${secret}`;
}

function isValidDate(value: string | null): value is string {
  return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(value).getTime());
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  if (!isValidDate(start) || !isValidDate(end)) {
    return NextResponse.json(
      { error: "invalid_range", message: "start and end are required, format YYYY-MM-DD" },
      { status: 400 }
    );
  }
  if (end <= start) {
    return NextResponse.json({ error: "invalid_range", message: "end must be after start" }, { status: 400 });
  }

  try {
    const { payload, fetchedAt } = await getReportSnapshot("pnl", { start, end }, { method: "accrual" });
    const inputs = deriveLaborRateInputs(payload as PnlNormalized);

    return NextResponse.json({
      connected: true,
      period: { start, end },
      fetchedAt: fetchedAt.toISOString(),
      ...inputs,
    });
  } catch (err) {
    // No credential, or QBO rejected the stored token (refresh token expired/
    // revoked). Reported distinctly so gcd-attribution's rate form can show
    // "QuickBooks not connected — enter manually" instead of a generic error.
    if (err instanceof QboNotConnectedError || isQboConnectivityError(err)) {
      const reason = err instanceof QboNotConnectedError ? "not_connected" : "reconnect_required";
      return NextResponse.json({ connected: false, reason }, { status: 200 });
    }
    return NextResponse.json({ error: "labor_rate_bridge_failed", message: String(err) }, { status: 500 });
  }
}
