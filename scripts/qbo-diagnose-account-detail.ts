/**
 * Dump the transaction-level detail behind a specific account for one
 * period, straight from QBO's Reports API — the same detail as QBO's own
 * "Go to GL transactions" screen or an Account QuickReport.
 *
 * This exists to answer one question: what specifically is sitting in an
 * account, so we can see whether it's payroll-related or something else —
 * rather than guessing from account-level totals alone.
 *
 * Tries GeneralLedger's `account` filter first (comma-separated account
 * IDs, per Intuit's Reports API reference — the same call that got the
 * "by bank register" default wrong before this filter was added). Intuit's
 * own GeneralLedger docs carry an explicit warning: "the General Ledger
 * report hierarchy is broken in certain circumstances when there are sub
 * accounts configured" — so if that comes back empty despite the account
 * having a real P&L balance for the period, this also checks whether the
 * account is itself a sub-account (which would point at that exact bug),
 * and falls back to the TransactionList report (a different report entity,
 * same `account` filter) before giving up.
 *
 * Read-only — one Account query + one or two Reports API GETs; writes nothing.
 * Neither report is one of the app's normal report types (reports.ts's
 * QBO_REPORT_ENTITY), so this calls the raw QBO client directly rather than
 * touching that shared config for a one-off diagnostic.
 *
 * Run: `npm run qbo:diagnose-account -- 2026-05-01 2026-05-31 "Ask My Client"`
 *      (account name defaults to "Ask My Client"; matched case-insensitively
 *      against the live chart of accounts, so a typo/partial name still works
 *      as long as it's unambiguous)
 */
import { getContext, get, query, listAccounts } from "../src/lib/qbo/client";
import { getQboEnvironment } from "../src/lib/config-store";
import { parseQboReport, type QboReport } from "../src/lib/projections/reports/qbo";

const GL_COLUMNS = "tx_date,txn_type,doc_num,name,memo,split_acc,subt_nat_amount";

function printReport(report: QboReport): void {
  console.log(`Columns: ${report.columns.map((c) => c.title).join(" | ")}\n`);
  for (const r of report.rows) {
    if (r.kind === "section_summary") {
      console.log(`  — ${r.label || "Total"}: ${r.rawValues.join(" | ")} —`);
    } else {
      console.log(`  ${r.label ? r.label + " | " : ""}${r.rawValues.join(" | ")}`);
    }
  }
}

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
    console.error(`No account found matching "${accountName}".`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`"${accountName}" matches more than one account — re-run with a more specific name:`);
    for (const a of matches) console.error(`  - ${a.FullyQualifiedName} (id ${a.Id}, ${a.AccountType})`);
    process.exit(1);
  }

  const account = matches[0];
  console.log(`\nAccount: ${account.FullyQualifiedName} (id ${account.Id}, ${account.AccountType})`);

  // Is this account itself a sub-account? Intuit's GeneralLedger docs warn
  // the report's hierarchy handling is broken in exactly that setup.
  const detail = await query<{ QueryResponse?: { Account?: Array<{ SubAccount?: boolean; ParentRef?: { value: string; name?: string } }> } }>(
    ctx,
    `select SubAccount, ParentRef from Account where Id = '${account.Id}'`
  );
  const acc = detail.QueryResponse?.Account?.[0];
  if (acc?.SubAccount) {
    console.log(
      `Note: this account is a SUB-ACCOUNT of "${acc.ParentRef?.name ?? acc.ParentRef?.value}" — Intuit's own docs warn ` +
        `the GeneralLedger report's hierarchy handling is broken in this exact setup, so an empty result below may be that bug, not an empty account.\n`
    );
  }

  const glPath =
    `reports/GeneralLedger?start_date=${start}&end_date=${end}&accounting_method=Accrual` +
    `&account=${account.Id}&columns=${GL_COLUMNS}`;
  const glRaw = await get<unknown>(ctx, glPath);
  const glReport = parseQboReport(glRaw);

  console.log(`GeneralLedger — ${start} → ${end}`);
  if (glReport.rows.length > 0) {
    printReport(glReport);
    return;
  }
  console.log("No transactions posted to this account in this period, per GeneralLedger.\n");

  console.log("Falling back to the TransactionList report (a different report entity) with the same account filter…\n");
  const tlPath =
    `reports/TransactionList?start_date=${start}&end_date=${end}&accounting_method=Accrual` +
    `&account=${account.Id}&columns=${GL_COLUMNS}`;
  const tlRaw = await get<unknown>(ctx, tlPath);
  const tlReport = parseQboReport(tlRaw);

  console.log(`TransactionList — ${start} → ${end}`);
  if (tlReport.rows.length > 0) {
    printReport(tlReport);
    return;
  }
  console.log(
    "Still nothing, from either report. If this account carries a real balance for this period in the P&L, " +
      "this is most likely the documented GeneralLedger/TransactionList hierarchy bug — the fastest way to see the " +
      "actual transactions at this point is QBO's own UI: Chart of Accounts → click the account's balance for this " +
      "period, or Reports → Account QuickReport, both of which don't go through this same API path."
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
