/**
 * Dump the transaction-level detail behind a specific account for one
 * period, straight from QBO's General Ledger report — the same report as
 * QBO's own "Go to GL transactions" screen.
 *
 * This exists to answer one question: what specifically is sitting in an
 * account, so we can see whether it's payroll-related or something else —
 * rather than guessing from account-level totals alone.
 *
 * The GeneralLedger report's `account` filter (comma-separated account IDs,
 * per Intuit's Reports API reference) is what actually scopes this to one
 * account — omitting it makes QBO default to organizing the report by BANK
 * ACCOUNT REGISTER instead, which is what our first attempt at this script
 * got wrong. This looks up the account by name via the Accounting API
 * (`SELECT ... FROM Account`), then requests the report pre-filtered to
 * just that account's Id, with explicit transaction-level columns
 * (date, type, doc num, name, memo, split account, amount).
 *
 * Read-only — one Account query + one Reports API GET; writes nothing.
 * "GeneralLedger" isn't one of the app's normal report types (reports.ts's
 * QBO_REPORT_ENTITY), so this calls the raw QBO client directly rather than
 * touching that shared config for a one-off diagnostic.
 *
 * Run: `npm run qbo:diagnose-account -- 2026-05-01 2026-05-31 "Ask My Client"`
 *      (account name defaults to "Ask My Client"; matched case-insensitively
 *      against the live chart of accounts, so a typo/partial name still works
 *      as long as it's unambiguous)
 */
import { getContext, get, listAccounts } from "../src/lib/qbo/client";
import { getQboEnvironment } from "../src/lib/config-store";
import { parseQboReport } from "../src/lib/projections/reports/qbo";

const GL_COLUMNS = "tx_date,txn_type,doc_num,name,memo,split_acc,subt_nat_amount";

async function main() {
  const [start, end, accountArg] = process.argv.slice(2);
  const accountName = accountArg || "Ask My Client";
  if (!start || !end) {
    console.error('Usage: npm run qbo:diagnose-account -- <start YYYY-MM-DD> <end YYYY-MM-DD> ["account name"]');
    process.exit(1);
  }

  const ctx = await getContext(await getQboEnvironment());

  const accounts = await listAccounts(ctx);
  const needle = accountName.toLowerCase();
  const matches = accounts.filter(
    (a) => a.Name.toLowerCase().includes(needle) || a.FullyQualifiedName.toLowerCase().includes(needle)
  );

  if (matches.length === 0) {
    console.error(`No account found matching "${accountName}". Active accounts with similar names:`);
    for (const a of accounts.filter((a) => a.Name.toLowerCase().split(/\s+/).some((w) => needle.includes(w) || w.includes(needle)))) {
      console.error(`  - ${a.FullyQualifiedName} (id ${a.Id}, ${a.AccountType})`);
    }
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`"${accountName}" matches more than one account — re-run with a more specific name:`);
    for (const a of matches) console.error(`  - ${a.FullyQualifiedName} (id ${a.Id}, ${a.AccountType})`);
    process.exit(1);
  }

  const account = matches[0];
  console.log(`\nAccount: ${account.FullyQualifiedName} (id ${account.Id}, ${account.AccountType})`);

  const path =
    `reports/GeneralLedger?start_date=${start}&end_date=${end}&accounting_method=Accrual` +
    `&account=${account.Id}&columns=${GL_COLUMNS}`;
  const raw = await get<unknown>(ctx, path);
  const report = parseQboReport(raw);

  console.log(`${report.reportName || "General Ledger"} — ${start} → ${end}`);
  console.log(`Columns: ${report.columns.map((c) => c.title).join(" | ")}\n`);

  if (report.rows.length === 0) {
    console.log("No transactions posted to this account in this period.");
    return;
  }

  for (const r of report.rows) {
    if (r.kind === "section_summary") {
      console.log(`  — ${r.label || "Total"}: ${r.rawValues.join(" | ")} —`);
    } else {
      console.log(`  ${r.label ? r.label + " | " : ""}${r.rawValues.join(" | ")}`);
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
