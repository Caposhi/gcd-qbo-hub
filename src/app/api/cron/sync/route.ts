/**
 * Protected internal sync route (§1, §13).
 *
 * Called daily by the Render Cron Job (see render.yaml) with
 * `Authorization: Bearer $CRON_SECRET`. The route reads mode/stage from the DB
 * config, so the cron command never needs to know whether we're in dry-run,
 * sandbox, or live. Runs as the Node runtime (Prisma + network) and is allowed
 * a long timeout.
 */
import { NextResponse } from "next/server";
import { runSync } from "@/lib/cashsheet/engine";
import { pushConsole } from "@/lib/console/contract";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed — never run unauthenticated
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${secret}`;
}

export async function POST(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    pushConsole("cash-sheet-sync", "sync:start", "Daily sync started");
    const summary = await runSync();
    pushConsole(
      "cash-sheet-sync",
      "sync:done",
      `scanned ${summary.rowsScanned}, posted ${summary.rowsPosted}`,
      { syncRunId: summary.syncRunId }
    );
    return NextResponse.json({ ok: true, summary });
  } catch (err) {
    pushConsole("cash-sheet-sync", "sync:error", String(err));
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
