/**
 * Dump the transaction-level detail behind a specific account (default:
 * "Ask My Client") for one period, straight from QBO's General Ledger
 * report — the same report as QBO's own "Go to GL transactions" screen.
 *
 * This exists to answer one question: what specifically is sitting in an
 * account that's supposed to net to zero (or close to it) once everything's
 * categorized, so we can see whether it's payroll-related or not — rather
 * than guessing from account-level totals alone.
 *
 * Read-only — a single GET against the QBO Reports API; writes nothing.
 * "GeneralLedger" isn't one of the app's normal report types (reports.ts's
 * QBO_REPORT_ENTITY), so this calls the raw QBO client directly rather than
 * touching that shared config for a one-off diagnostic.
 *
 * Run: `npm run qbo:diagnose-account -- 2026-05-01 2026-05-31 "Ask My Client"`
 *      (the account name is an optional case-insensitive substring match;
 *      omit it to default to "Ask My Client")
 */
import { getContext, get } from "../src/lib/qbo/client";
import { getQboEnvironment } from "../src/lib/config-store";
import { parseQboReport } from "../src/lib/projections/reports/qbo";

async function main() {
  const [start, end, accountArg] = process.argv.slice(2);
  const accountFilter = (accountArg || "Ask My Client").toLowerCase();
  if (!start || !end) {
    console.error('Usage: npm run qbo:diagnose-account -- <start YYYY-MM-DD> <end YYYY-MM-DD> ["account name substring"]');
    process.exit(1);
  }

  const ctx = await getContext(await getQboEnvironment());
  const path = `reports/GeneralLedger?start_date=${start}&end_date=${end}&accounting_method=Accrual`;
  const raw = await get<unknown>(ctx, path);
  const report = parseQboReport(raw);

  console.log(`\n${report.reportName || "General Ledger"} — ${start} → ${end}`);
  console.log(`Columns: ${report.columns.map((c) => c.title).join(" | ")}\n`);

  const matches = report.rows.filter(
    (r) => r.group.some((g) => g.toLowerCase().includes(accountFilter)) || r.label.toLowerCase().includes(accountFilter)
  );

  if (matches.length === 0) {
    console.log(`No rows found matching "${accountArg || "Ask My Client"}". Dumping the first 20 rows instead, so we can see the actual shape:\n`);
    for (const r of report.rows.slice(0, 20)) {
      console.log(`  [depth ${r.depth}] [${r.kind}] group=${JSON.stringify(r.group)} label="${r.label}" rawValues=${JSON.stringify(r.rawValues)}`);
    }
    return;
  }

  console.log(`${matches.length} matching row(s):\n`);
  for (const r of matches) {
    console.log(
      `  [depth ${r.depth}] [${r.kind}] group=${JSON.stringify(r.group)} label="${r.label}" id=${r.id ?? "—"} rawValues=${JSON.stringify(r.rawValues)}`
    );
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
