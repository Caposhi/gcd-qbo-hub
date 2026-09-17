/**
 * Dump the QBO Profit & Loss report's payroll-related expense rows for one
 * period, and show which of the five labels `deriveLaborRateInputs`
 * (src/lib/tekmetric/labor-rate-bridge.ts) looks for — staff wages, owner
 * salary, payroll taxes, payroll fees, retirement plan — it can actually find.
 *
 * WHY THIS EXISTS
 *
 * gcd-attribution's TP1-d rate form pulled a full 12-month period through this
 * bridge and got a numerator (COGS labor wages) but a null
 * `quickbooksPayrollCents` and null `loadingFactor` — meaning at least one of
 * the five non-COGS accounts `findLineTotal` looks for wasn't found in
 * `pnl.expenseLines`. There are two different failure shapes that look
 * identical from the bridge's output alone, so this prints both checks
 * side by side instead of guessing which one it is:
 *
 *   1. NAMING MISMATCH — the account exists somewhere in the report, under
 *      a label that doesn't match the five regexes (e.g. "Officer
 *      Compensation" instead of "Owner Salary", or "SIMPLE IRA" instead of
 *      "Retirement"). Fix: adjust the regex in labor-rate-bridge.ts.
 *   2. REACHABILITY GAP — the account's row never makes it into
 *      `pnl.expenseLines` at all, because `detailLines()` in
 *      reports/normalize.ts only includes rows whose `groupCode` is
 *      EXACTLY "Expenses", with no group-PATH fallback (unlike
 *      `findLineByLabel`, which the COGS labor-wages lookup uses and which
 *      explicitly documents needing that fallback — see its comment). A
 *      nested subsection that carries its OWN QBO group code (distinct from
 *      "Expenses") would silently drop every row under it from
 *      `expenseLines`, even though the label itself is exactly right. Fix:
 *      give `detailLines()` the same group-path fallback `findLineByLabel`
 *      already has.
 *
 * Read-only — issues a single GET against the QBO Reports API (or reads the
 * cached proj_report_snapshot row if one's fresh); writes nothing.
 *
 * Run: `npm run qbo:diagnose-payroll -- 2025-09-01 2026-08-31`
 */
import { getContext } from "../src/lib/qbo/client";
import { getQboEnvironment } from "../src/lib/config-store";
import { fetchReport } from "../src/lib/qbo/reports";
import { parseQboReport } from "../src/lib/projections/reports/qbo";
import { normalizePnl } from "../src/lib/projections/reports/normalize";

const TARGETS: Array<{ name: string; pattern: RegExp }> = [
  { name: "staff wages", pattern: /staff.*wage/i },
  { name: "owner salary", pattern: /owner.*salary/i },
  { name: "payroll taxes", pattern: /payroll.*tax/i },
  { name: "payroll fees", pattern: /payroll.*fee/i },
  { name: "retirement plan", pattern: /retirement/i },
];

async function main() {
  const [start, end] = process.argv.slice(2);
  if (!start || !end) {
    console.error("Usage: npm run qbo:diagnose-payroll -- <start YYYY-MM-DD> <end YYYY-MM-DD>");
    process.exit(1);
  }

  const ctx = await getContext(await getQboEnvironment());
  const raw = await fetchReport("pnl", { startDate: start, endDate: end, method: "accrual" }, ctx);
  const report = parseQboReport(raw);
  const pnl = normalizePnl(report);

  console.log(`\n${report.reportName} — ${start} → ${end}`);
  console.log(`Columns: ${report.columns.map((c) => c.title).join(", ")}\n`);

  console.log("Every row anywhere in the report whose group PATH mentions 'expense'\n" +
    "(this is everything a human reading the P&L would call an expense line,\n" +
    "regardless of which QBO group code it carries):\n");
  const expenseAreaRows = report.rows.filter((r) => r.group.some((g) => /expense/i.test(g)));
  for (const r of expenseAreaRows) {
    console.log(
      `  [depth ${r.depth}] [${r.kind}] groupCode=${r.groupCode ?? "—"} group=${JSON.stringify(r.group)} ` +
        `label="${r.label}" id=${r.id ?? "—"} values=${JSON.stringify(r.values)}`
    );
  }

  console.log(`\n${pnl.expenseLines.length} row(s) actually reached pnl.expenseLines ` +
    `(what the bridge's findLineTotal searches):\n`);
  for (const line of pnl.expenseLines) {
    console.log(`  label="${line.label}" values=${JSON.stringify(line.values)}`);
  }

  console.log("\nMatch check for each of the five payroll fields:\n");
  for (const target of TARGETS) {
    const inExpenseLines = pnl.expenseLines.find((l) => target.pattern.test(l.label));
    const anywhereInReport = expenseAreaRows.find((r) => target.pattern.test(r.label));

    if (inExpenseLines) {
      console.log(`  ✓ ${target.name}: FOUND in expenseLines ("${inExpenseLines.label}") — this one is fine.`);
    } else if (anywhereInReport) {
      console.log(
        `  ✗ ${target.name}: label "${anywhereInReport.label}" EXISTS in the report ` +
          `(groupCode=${anywhereInReport.groupCode ?? "—"}) but never reached pnl.expenseLines — ` +
          `REACHABILITY GAP in detailLines(), not a naming problem.`
      );
    } else {
      console.log(
        `  ✗ ${target.name}: no row anywhere in the expense area matches /${target.pattern.source}/i — ` +
          `NAMING MISMATCH. Find the real label above and update the regex in labor-rate-bridge.ts.`
      );
    }
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
