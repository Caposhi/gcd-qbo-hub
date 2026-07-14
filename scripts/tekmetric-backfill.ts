/**
 * Tekmetric history backfill (Build Phase 4).
 *
 * Snapshots the trailing 24 full calendar months (matching the QBO backfill
 * window) into `tek_snapshot`, one row per month, so the Operations trends and
 * the projections engine have an operational history to work with. Read-only
 * over Tekmetric; the per-month refresh is the same gated code path the UI uses,
 * just run for many periods.
 *
 * Run: `npm run tekmetric:backfill` (optionally `-- <months>` to override 24).
 * Requires TEKMETRIC_TOKEN / TEKMETRIC_SHOP_ID (and DATABASE_URL) in the env.
 */
import { isTekmetricConfigured } from "../src/lib/tekmetric/client";
import { refreshOperations } from "../src/lib/tekmetric/snapshot";
import { comparisonRange, monthRangesBack, shopToday } from "../src/lib/tekmetric/periods";

const DEFAULT_MONTHS = 24;

async function main() {
  if (!isTekmetricConfigured()) {
    console.error("Tekmetric is not configured (TEKMETRIC_TOKEN / TEKMETRIC_SHOP_ID missing).");
    process.exit(1);
  }
  const argMonths = Number(process.argv[2]);
  const months = Number.isFinite(argMonths) && argMonths > 0 ? Math.floor(argMonths) : DEFAULT_MONTHS;

  const ranges = monthRangesBack(shopToday(), months);
  console.log(`Tekmetric backfill: ${ranges.length} months (${ranges[0]?.label} → ${ranges[ranges.length - 1]?.label}).\n`);

  let ok = 0;
  for (const r of ranges) {
    const period = { start: r.start, end: r.end };
    try {
      const data = await refreshOperations(period, "prior_period", comparisonRange(period, "prior_period"));
      ok += 1;
      console.log(`  ✓ ${r.label}: ${data.kpis.roCount.value} ROs, GP $${Math.round(data.kpis.grossProfit.value)}`);
    } catch (err) {
      console.error(`  ✗ ${r.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\nDone: ${ok}/${ranges.length} months snapshotted.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
