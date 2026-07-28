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
  console.log(`Columns: ${report.columns.map((c) => c.title).join(" | ")}`);
  console.log(`${report.rows.length} total row(s) across ${new Set(report.rows.map((r) => r.group[0] ?? "")).size} top-level section(s).\n`);

  // This report can be organized by BANK ACCOUNT (each section a register,
  // the offsetting account showing up only as a "Split" cell within a row)
  // rather than by the account we actually want — so match against every
  // cell in the row, not just the section header / label.
  const rowMatches = (r: (typeof report.rows)[number]) =>
    r.group.some((g) => g.toLowerCase().includes(accountFilter)) ||
    r.label.toLowerCase().includes(accountFilter) ||
    r.rawValues.some((v) => v.toLowerCase().includes(accountFilter));

  const matches = report.rows.filter(rowMatches);

  if (matches.length === 0) {
    const sections = [...new Set(report.rows.map((r) => r.group.join(" > ") || "(top level)"))];
    console.log(
      `No rows found matching "${accountArg || "Ask My Client"}" in any column, including "Split". ` +
        `Here are every section this report actually returned — check this list for the account's real ` +
        `name/spelling, then re-run with that exact substring as the 3rd argument:\n`
    );
    for (const s of sections) console.log(`  - ${s}`);
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
