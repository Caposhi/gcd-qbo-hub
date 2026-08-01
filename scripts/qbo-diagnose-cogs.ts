/**
 * Dump the QBO Profit & Loss report's COGS-section rows for one period, so we
 * can see EXACTLY how "Cost of Goods Sold: Labor Wages" and its sub-account
 * "Cost of Goods Sold: Labor Wages: OWNER - Contract Labor" are represented —
 * as one already-summed parent total, or as two sibling rows that need to be
 * added together. Guessing this wrong would silently double- or under-count
 * labor cost everywhere it feeds gross profit, so read this output before
 * wiring the two account names into any calculation.
 *
 * Read-only — issues a single GET against the QBO Reports API (or reads the
 * cached proj_report_snapshot row if one's fresh); writes nothing.
 *
 * Run: `npm run qbo:diagnose-cogs -- 2026-06-01 2026-06-30`
 */
import { getContext } from "../src/lib/qbo/client";
import { getQboEnvironment } from "../src/lib/config-store";
import { fetchReport } from "../src/lib/qbo/reports";
import { parseQboReport } from "../src/lib/projections/reports/qbo";

async function main() {
  const [start, end] = process.argv.slice(2);
  if (!start || !end) {
    console.error("Usage: npm run qbo:diagnose-cogs -- <start YYYY-MM-DD> <end YYYY-MM-DD>");
    process.exit(1);
  }

  const ctx = await getContext(await getQboEnvironment());
  const raw = await fetchReport("pnl", { startDate: start, endDate: end, method: "accrual" }, ctx);
  const report = parseQboReport(raw);

  console.log(`\n${report.reportName} — ${start} → ${end}`);
  console.log(`Columns: ${report.columns.map((c) => c.title).join(", ")}\n`);

  const cogsRows = report.rows.filter(
    (r) => (r.groupCode ?? "").toLowerCase() === "cogs" || r.group.some((g) => /cost of goods sold/i.test(g))
  );

  if (cogsRows.length === 0) {
    console.log("No COGS-section rows found — this company's P&L may have no COGS section, " +
      "or the group-code detection needs adjusting. Dumping ALL rows whose label mentions 'labor' instead:\n");
    for (const r of report.rows) {
      if (/labor/i.test(r.label)) {
        console.log(
          `  [depth ${r.depth}] [${r.kind}] group=${JSON.stringify(r.group)} label="${r.label}" id=${r.id ?? "—"} values=${JSON.stringify(r.values)}`
        );
      }
    }
    return;
  }

  console.log(`${cogsRows.length} COGS-section row(s):\n`);
  for (const r of cogsRows) {
    console.log(
      `  [depth ${r.depth}] [${r.kind}] group=${JSON.stringify(r.group)} label="${r.label}" id=${r.id ?? "—"} values=${JSON.stringify(r.values)}`
    );
  }

  console.log(
    "\nLook for rows whose label mentions 'Labor Wages' or 'Contract Labor'. If a 'Labor Wages' row's " +
      "value already equals (or exceeds) the 'OWNER - Contract Labor' row's value, the parent total is " +
      "already inclusive — sum only the OUTERMOST (lowest-depth) 'Labor Wages' row. If the two are separate, " +
      "unrelated-looking figures, they're likely sibling leaf accounts and should be added together."
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
