/**
 * Per-RO gross-profit breakdown for one calendar month — for diagnosing a
 * month whose cached KPIs look wrong (e.g. a suspiciously low margin flagged
 * by `looksLikePartialMonth`) even after repeated backfill reruns.
 *
 * Reuses the EXACT same cost/revenue math production uses
 * (roRevenuePreTaxCents / roPartsCostCents / roSubletCostCents /
 * roGrossProfitCents from normalize.ts) rather than a reimplementation that
 * could subtly diverge, so what this prints is guaranteed to match what the
 * cached snapshot's margin is built from.
 *
 * For each RO it prints revenue, parts cost, sublet cost, gross profit/margin,
 * and flags any part line where cost >= retail (cost at or above what the
 * customer was charged — a strong signal of a data-entry error rather than a
 * real low-margin job). Cross-check the flagged ROs' numbers against
 * Tekmetric's own report for the same period.
 *
 * Run: `npm run tekmetric:diagnose -- 2026-04-01 2026-04-30`
 * Requires TEKMETRIC_TOKEN / TEKMETRIC_SHOP_ID in the env. Read-only over
 * Tekmetric — this never writes to `tek_snapshot` or anything else.
 */
import { isTekmetricConfigured, resolveShopIds, fetchRepairOrders } from "../src/lib/tekmetric/client";
import {
  isDeleted,
  roRevenuePreTaxCents,
  roPartsCostCents,
  roSubletCostCents,
  roGrossProfitCents,
  centsToDollars,
} from "../src/lib/tekmetric/normalize";
import type { TekRawRepairOrder } from "../src/lib/tekmetric/raw";

function fmt(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

async function main() {
  if (!isTekmetricConfigured()) {
    console.error("Tekmetric is not configured (TEKMETRIC_TOKEN / TEKMETRIC_SHOP_ID missing).");
    process.exit(1);
  }
  const [start, end] = process.argv.slice(2);
  if (!start || !end) {
    console.error("Usage: npm run tekmetric:diagnose -- <start YYYY-MM-DD> <end YYYY-MM-DD>");
    process.exit(1);
  }

  const shopIds = await resolveShopIds();
  const ros: TekRawRepairOrder[] = [];
  for (const shopId of shopIds) {
    ros.push(...(await fetchRepairOrders(shopId, { start, end })));
  }
  const live = ros.filter((ro) => !isDeleted(ro));

  console.log(`\n${start} → ${end}: ${ros.length} ROs fetched, ${live.length} live (not deleted/void)\n`);

  let totalRevenueCents = 0;
  let totalPartsCostCents = 0;
  let totalSubletCostCents = 0;
  let totalGrossProfitCents = 0;
  const suspectRos: Array<{ id: number; revenue: number; partsCost: number; margin: number }> = [];
  const suspectPartLines: Array<{ roId: number; part: string; cost: number; retail: number }> = [];

  for (const ro of live) {
    const revenueCents = roRevenuePreTaxCents(ro);
    const partsCostCents = roPartsCostCents(ro);
    const subletCostCents = roSubletCostCents(ro);
    const gpCents = roGrossProfitCents(ro);
    const marginPct = revenueCents > 0 ? (gpCents / revenueCents) * 100 : 0;

    totalRevenueCents += revenueCents;
    totalPartsCostCents += partsCostCents;
    totalSubletCostCents += subletCostCents;
    totalGrossProfitCents += gpCents;

    if (marginPct < 20) {
      suspectRos.push({
        id: ro.id,
        revenue: centsToDollars(revenueCents),
        partsCost: centsToDollars(partsCostCents),
        margin: Math.round(marginPct * 10) / 10,
      });
    }

    for (const job of ro.jobs ?? []) {
      for (const p of job.parts ?? []) {
        if (p.cost >= p.retail && p.retail > 0) {
          suspectPartLines.push({
            roId: ro.id,
            part: p.name || p.partNumber || `part #${p.id}`,
            cost: centsToDollars(p.cost),
            retail: centsToDollars(p.retail),
          });
        }
      }
    }
  }

  const totalRevenue = centsToDollars(totalRevenueCents);
  const totalGrossProfit = centsToDollars(totalGrossProfitCents);
  const marginPct = totalRevenueCents > 0 ? (totalGrossProfitCents / totalRevenueCents) * 100 : 0;

  console.log("=== Month totals (same math as the cached snapshot) ===");
  console.log(`  Revenue:      ${fmt(totalRevenue)}`);
  console.log(`  Parts cost:   ${fmt(centsToDollars(totalPartsCostCents))}`);
  console.log(`  Sublet cost:  ${fmt(centsToDollars(totalSubletCostCents))}`);
  console.log(`  Gross profit: ${fmt(totalGrossProfit)}`);
  console.log(`  Margin:       ${marginPct.toFixed(1)}%`);

  console.log(`\n=== ${suspectRos.length} RO(s) under 20% margin ===`);
  for (const r of suspectRos.slice(0, 30)) {
    console.log(`  RO ${r.id}: revenue ${fmt(r.revenue)}, parts cost ${fmt(r.partsCost)}, margin ${r.margin}%`);
  }
  if (suspectRos.length > 30) console.log(`  … and ${suspectRos.length - 30} more`);

  console.log(`\n=== ${suspectPartLines.length} part line(s) with cost >= retail (likely data-entry errors) ===`);
  for (const p of suspectPartLines.slice(0, 30)) {
    console.log(`  RO ${p.roId}: "${p.part}" — cost ${fmt(p.cost)} vs retail ${fmt(p.retail)}`);
  }
  if (suspectPartLines.length > 30) console.log(`  … and ${suspectPartLines.length - 30} more`);

  console.log(
    "\nCompare the totals above against Tekmetric's own End of Day / Sales report for the same range. " +
      "If the totals here already look wrong vs. Tekmetric's own report, the RO/part-line lists above are " +
      "where to look first."
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
