import { getSessionUser } from "@/lib/auth/session";
import { RequireAuth } from "../components/RequireAuth";

export const dynamic = "force-dynamic";

/**
 * Deposit Reconciliation — planned module (see docs/DEPOSIT_RECONCILIATION.md).
 * The tested domain core (parsers, checksum reconcile engine, QBO deposit
 * payload) is committed; this page is the placeholder until the ingest + posting
 * flow is wired to production QBO.
 */
export default async function DepositReconciliationPage() {
  const user = await getSessionUser();
  if (!user) return <RequireAuth />;

  return (
    <>
      <h1>🏦 Deposit Reconciliation</h1>
      <p className="sub">
        Auto-builds the QBO Bank Deposit for each Tekmetric &amp; Chase Paymentech payout so QuickBooks matches the
        bank-feed line itself — replacing the manual match.
      </p>

      <div className="notice">
        <strong>Status: in build.</strong> The reconciliation core is done and tested (batch grouping, the exact-sum
        checksum, and the QBO deposit payload). What&apos;s left to turn it on:
      </div>

      <ul>
        <li>A Tekmetric payout export sample to finalize Tekmetric parsing.</li>
        <li>An ingest path (CSV drop, email, or API) for the daily payout files.</li>
        <li>The hub&apos;s QBO connection pointed at the live company, with Chase 9680 / Undeposited Funds / Credit
          Card Processing Fees resolved.</li>
        <li>A one-payout spike to confirm the Deposit <code>LinkedTxn</code> API shape.</li>
      </ul>

      <p className="muted">
        How it works: group each processor&apos;s settlement by batch/payout, locate the matching Undeposited-Funds
        payments (and Tekmetric fee entries), and — only when they sum exactly to the payout — create the deposit.
        Nothing posts on a mismatch, and a human still confirms the match. Full design in
        <code> docs/DEPOSIT_RECONCILIATION.md</code>.
      </p>
    </>
  );
}
