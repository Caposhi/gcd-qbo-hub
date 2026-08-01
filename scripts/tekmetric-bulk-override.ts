/**
 * One-time bulk import of manual month corrections, from a folder of
 * End of Day Report screenshots that Claude read directly (vision, not the
 * live extraction API) — see REPORTS below for the extracted figures.
 * Ongoing corrections should go through the "Correct a month" upload button
 * in Ops History; this script exists only to clear a historical backlog in
 * one pass, so it should only ever need to run once.
 *
 * Same math as the UI's extractTekmetricReportAction/deriveOverrideFromReport:
 * gross profit = report Profit + report Labor Cost − QBO's real labor cost
 * for that month, so every corrected month lands on the same definition as
 * everywhere else. Car count isn't on the report — defaults to what's
 * already cached for that month (from the last backfill), falling back to a
 * live Tekmetric pull + VIN-matched count for any month with nothing cached
 * (e.g. a month the partial-month guard refused to snapshot).
 *
 * DRY RUN BY DEFAULT. Nothing is written to tek_month_overrides until you
 * pass --apply — review the printed table first.
 *
 * Run:
 *   npm run tekmetric:bulk-override -- you@example.com          # dry run
 *   npm run tekmetric:bulk-override -- you@example.com --apply  # writes
 */
import { isTekmetricConfigured, resolveShopIds, fetchRepairOrders } from "../src/lib/tekmetric/client";
import { fetchTekmetricRoster, readOperationsKpis } from "../src/lib/tekmetric/snapshot";
import { saveMonthOverride } from "../src/lib/tekmetric/overrides";
import { qboLaborCostForPeriod } from "../src/lib/tekmetric/labor-cost";
import { deriveOverrideFromReport } from "../src/lib/tekmetric/reportExtract";
import { computeKpis } from "../src/lib/tekmetric/normalize";

interface ReportMonth {
  periodStart: string;
  periodEnd: string;
  totalRepairOrders: number;
  grandNetSales: number;
  grandProfit: number;
  laborCost: number;
}

// Read directly off each month's Tekmetric End of Day Report screenshot
// (the "Total" row of the Profit Summary table, plus its Labor row's Cost) —
// Jul 2024 -> Jun 2026, 24 consecutive months, no gaps or duplicates.
const REPORTS: ReportMonth[] = [
  { periodStart: "2024-07-01", periodEnd: "2024-07-31", totalRepairOrders: 200, grandNetSales: 340307.56, grandProfit: 231077.60, laborCost: 51956.85 },
  { periodStart: "2024-08-01", periodEnd: "2024-08-31", totalRepairOrders: 198, grandNetSales: 252717.94, grandProfit: 167347.08, laborCost: 43541.68 },
  { periodStart: "2024-09-01", periodEnd: "2024-09-30", totalRepairOrders: 174, grandNetSales: 202162.65, grandProfit: 127074.99, laborCost: 35029.65 },
  { periodStart: "2024-10-01", periodEnd: "2024-10-31", totalRepairOrders: 182, grandNetSales: 235736.37, grandProfit: 151554.10, laborCost: 41734.84 },
  { periodStart: "2024-11-01", periodEnd: "2024-11-30", totalRepairOrders: 180, grandNetSales: 215904.24, grandProfit: 135420.45, laborCost: 42084.56 },
  { periodStart: "2024-12-01", periodEnd: "2024-12-31", totalRepairOrders: 200, grandNetSales: 257717.62, grandProfit: 157090.16, laborCost: 49913.86 },
  { periodStart: "2025-01-01", periodEnd: "2025-01-31", totalRepairOrders: 201, grandNetSales: 237092.05, grandProfit: 147713.42, laborCost: 48895.73 },
  { periodStart: "2025-02-01", periodEnd: "2025-02-28", totalRepairOrders: 163, grandNetSales: 215576.45, grandProfit: 138676.76, laborCost: 38896.41 },
  { periodStart: "2025-03-01", periodEnd: "2025-03-31", totalRepairOrders: 161, grandNetSales: 226046.40, grandProfit: 144218.13, laborCost: 41165.48 },
  { periodStart: "2025-04-01", periodEnd: "2025-04-30", totalRepairOrders: 191, grandNetSales: 219353.17, grandProfit: 144107.93, laborCost: 40426.54 },
  { periodStart: "2025-05-01", periodEnd: "2025-05-31", totalRepairOrders: 155, grandNetSales: 217689.19, grandProfit: 143020.86, laborCost: 36828.54 },
  { periodStart: "2025-06-01", periodEnd: "2025-06-30", totalRepairOrders: 180, grandNetSales: 222374.93, grandProfit: 141756.19, laborCost: 43698.67 },
  { periodStart: "2025-07-01", periodEnd: "2025-07-31", totalRepairOrders: 151, grandNetSales: 189140.93, grandProfit: 119750.86, laborCost: 34521.25 },
  { periodStart: "2025-08-01", periodEnd: "2025-08-31", totalRepairOrders: 164, grandNetSales: 213175.40, grandProfit: 137790.40, laborCost: 37478.95 },
  { periodStart: "2025-09-01", periodEnd: "2025-09-30", totalRepairOrders: 171, grandNetSales: 221871.88, grandProfit: 139998.21, laborCost: 37119.55 },
  { periodStart: "2025-10-01", periodEnd: "2025-10-31", totalRepairOrders: 181, grandNetSales: 222594.95, grandProfit: 143203.29, laborCost: 39217.10 },
  { periodStart: "2025-11-01", periodEnd: "2025-11-30", totalRepairOrders: 151, grandNetSales: 198402.40, grandProfit: 126159.81, laborCost: 34436.35 },
  { periodStart: "2025-12-01", periodEnd: "2025-12-31", totalRepairOrders: 192, grandNetSales: 192147.93, grandProfit: 124704.46, laborCost: 34762.65 },
  { periodStart: "2026-01-01", periodEnd: "2026-01-31", totalRepairOrders: 180, grandNetSales: 210715.28, grandProfit: 136996.16, laborCost: 38742.60 },
  { periodStart: "2026-02-01", periodEnd: "2026-02-28", totalRepairOrders: 158, grandNetSales: 210894.00, grandProfit: 139197.07, laborCost: 34180.15 },
  { periodStart: "2026-03-01", periodEnd: "2026-03-31", totalRepairOrders: 187, grandNetSales: 211061.05, grandProfit: 133594.41, laborCost: 37008.13 },
  { periodStart: "2026-04-01", periodEnd: "2026-04-30", totalRepairOrders: 198, grandNetSales: 199423.18, grandProfit: 130450.62, laborCost: 36978.16 },
  { periodStart: "2026-05-01", periodEnd: "2026-05-31", totalRepairOrders: 184, grandNetSales: 210263.98, grandProfit: 134108.36, laborCost: 40605.65 },
  { periodStart: "2026-06-01", periodEnd: "2026-06-30", totalRepairOrders: 167, grandNetSales: 197916.07, grandProfit: 126191.27, laborCost: 36567.75 },
];

function endOfMonth(startIso: string): string {
  const [y, m] = startIso.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

async function main() {
  const email = process.argv[2];
  const apply = process.argv.includes("--apply");
  if (!email || !email.includes("@")) {
    console.error("Usage: npm run tekmetric:bulk-override -- you@example.com [--apply]");
    process.exit(1);
  }
  if (!isTekmetricConfigured()) {
    console.error("Tekmetric is not configured (TEKMETRIC_TOKEN / TEKMETRIC_SHOP_ID missing).");
    process.exit(1);
  }

  console.log(
    `Tekmetric bulk override: ${REPORTS.length} months (${REPORTS[0].periodStart} → ${REPORTS[REPORTS.length - 1].periodEnd}).`
  );
  console.log(
    apply
      ? "APPLY MODE — this will write to tek_month_overrides.\n"
      : "DRY RUN — nothing will be saved. Re-run with --apply once this looks right.\n"
  );

  // Shared vehicle roster for the live car-count fallback, so a month with no
  // cached snapshot doesn't need its own roster pull.
  const roster = await fetchTekmetricRoster();
  const shopIds = await resolveShopIds();

  for (const r of REPORTS) {
    // Same guard the UI upload uses — reject anything that isn't a clean full
    // calendar month before trusting the rest of the row.
    const isFirstOfMonth = r.periodStart.slice(8, 10) === "01";
    if (!isFirstOfMonth || r.periodEnd !== endOfMonth(r.periodStart)) {
      console.error(`  ✗ ${r.periodStart}..${r.periodEnd}: not a clean full calendar month — skipping.`);
      continue;
    }

    const qboLaborCost = await qboLaborCostForPeriod(r.periodStart, r.periodEnd);
    const derived = deriveOverrideFromReport(
      {
        totalRepairOrders: r.totalRepairOrders,
        grandNetSales: r.grandNetSales,
        grandProfit: r.grandProfit,
        laborCost: r.laborCost,
      },
      qboLaborCost
    );

    let carCount: number;
    let carCountSource: "cached" | "live";
    const cached = await readOperationsKpis({ start: r.periodStart, end: r.periodEnd }, "prior_period");
    if (cached) {
      carCount = Math.round(cached.carCount);
      carCountSource = "cached";
    } else {
      const ros = [];
      for (const shopId of shopIds) {
        ros.push(...(await fetchRepairOrders(shopId, { start: r.periodStart, end: r.periodEnd })));
      }
      carCount = Math.round(computeKpis(ros, null, roster.vehicles).carCount.value);
      carCountSource = "live";
    }

    console.log(
      `  ${r.periodStart}..${r.periodEnd}: RO ${derived.roCount}, ARO ${money(derived.aro)}, ` +
        `GP ${money(derived.grossProfit)} (${derived.grossMarginPct.toFixed(1)}%), cars ${carCount} [${carCountSource}], ` +
        `QBO labor ${qboLaborCost === null ? "unavailable — used report's own labor line" : money(qboLaborCost)}`
    );

    if (apply) {
      await saveMonthOverride({
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        roCount: derived.roCount,
        carCount,
        aro: derived.aro,
        grossProfit: derived.grossProfit,
        note: "Bulk-corrected from uploaded End of Day Report screenshots (24-month backlog).",
        byEmail: email,
      });
      console.log("    → saved.");
    }
  }

  console.log(apply ? "\nDone — all months saved." : "\nDry run complete. Re-run with --apply to save these.");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
