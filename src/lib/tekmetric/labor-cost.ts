/**
 * Real labor cost for a Tekmetric Operations period, sourced from QBO's own
 * ledger (`Cost of Goods Sold: Labor Wages`, which already rolls up its
 * `OWNER - Contract Labor` sub-account) instead of treating labor as free.
 *
 * WHY: the Tekmetric API never exposes technician wages, so normalize.ts's
 * `roGrossProfitCents` deliberately can't count a labor cost per RO — that's
 * still true and unchanged. This fills the gap at the MONTHLY level: payroll
 * is a lump-sum QBO figure with no honest way to attribute it back to
 * individual ROs/technicians, so it's subtracted only from the headline
 * monthly gross profit (see computeKpis's `laborCost` param), never from
 * per-RO/job/tech/advisor figures — those intentionally stay parts+sublet-only,
 * so don't expect them to sum to the headline number anymore.
 *
 * Reuses Reporting's fetch-through P&L cache (6h TTL) so a Tekmetric refresh
 * or backfill doesn't hit QBO on every call — most months will already be
 * cached from Reporting's own use, or get cached here for next time.
 */
import { getReportSnapshot } from "@/lib/projections/report-service";
import { sum, type PnlNormalized } from "@/lib/projections/reports";

/**
 * Real labor cost (dollars) for one period, or null when QBO isn't connected/
 * reachable and nothing is cached, or the company's chart of accounts has no
 * matching COGS line. Callers should treat null as "unknown," not zero — it
 * means we couldn't get a real number, not that labor cost is actually zero.
 */
export async function qboLaborCostForPeriod(start: string, end: string): Promise<number | null> {
  try {
    const { payload } = await getReportSnapshot("pnl", { start, end }, { method: "accrual" });
    const pnl = payload as PnlNormalized;
    if (pnl.laborCost === null) return null; // no matching COGS line — unknown, not zero
    const total = sum(pnl.laborCost);
    return Number.isFinite(total) ? total : null;
  } catch {
    return null;
  }
}
