/**
 * Monthly AI council cron (AI C-suite, Phase 3).
 *
 * Fired on the 1st of each month by a Render Cron Job (see render.yaml) with
 * `Authorization: Bearer $CRON_SECRET`. Runs the full multi-round meeting for the
 * PRIOR month and persists the board report + per-agent insights. Read-only over
 * QBO; the $15 budget cap is enforced inside the orchestrator.
 */
import { NextResponse } from "next/server";
import { runCouncil } from "@/lib/ai/orchestrator";
import { pushConsole } from "@/lib/console/contract";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed
  return (req.headers.get("authorization") ?? "") === `Bearer ${secret}`;
}

export async function POST(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    pushConsole("projections", "ai-council:start", "Monthly AI council run started");
    const result = await runCouncil({ now: new Date(), kind: "monthly" });
    pushConsole(
      "projections",
      "ai-council:done",
      `status ${result.status}, spent $${result.spentUsd.toFixed(2)}`,
      { runId: result.runId }
    );
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    pushConsole("projections", "ai-council:error", String(err));
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
