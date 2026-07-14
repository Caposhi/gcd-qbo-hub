/**
 * QBO read path for the "Ask My Client" import — STRICTLY READ-ONLY.
 *
 * Resolves the configured account by name and fetches the transactions posted to
 * it via the QBO TransactionList report (GET /reports/*). Never posts, edits, or
 * deletes — the hub only reads; an owner reclassifies in QBO by hand.
 */
import { get, listAccounts, type QboContext } from "@/lib/qbo/client";
import { normalizeTransactionList, type AmcTransaction } from "./transactions";

/** The QBO account name to pull from; overridable per deployment. */
export function askMyClientAccountName(): string {
  return process.env.COWORKER_QBO_ACCOUNT_NAME || "Ask My Client";
}

/** Find the configured account's id by (case-insensitive) name / fully-qualified name. */
export async function resolveAmcAccountId(ctx: QboContext): Promise<string | null> {
  const target = askMyClientAccountName().trim().toLowerCase();
  const accounts = await listAccounts(ctx);
  const match = accounts.find(
    (a) =>
      (a.Name ?? "").trim().toLowerCase() === target ||
      (a.FullyQualifiedName ?? "").trim().toLowerCase() === target
  );
  return match?.Id ?? null;
}

/**
 * Fetch the transactions posted to the account over [start, end]. We omit the
 * `columns` param and let QBO return its default TransactionList columns — the
 * normalizer maps by column title, so it's robust to the exact set returned.
 */
export async function fetchAmcTransactions(
  ctx: QboContext,
  accountId: string,
  range: { start: string; end: string }
): Promise<AmcTransaction[]> {
  const q = new URLSearchParams();
  q.set("start_date", range.start);
  q.set("end_date", range.end);
  q.set("account", accountId);
  const raw = await get<unknown>(ctx, `reports/TransactionList?${q.toString()}`);
  return normalizeTransactionList(raw);
}
