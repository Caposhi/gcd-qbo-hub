export const dynamic = "force-dynamic";

export const metadata = {
  title: "Privacy Policy — GCD QBO Hub",
  description: "Privacy policy for the GCD QBO Hub.",
};

/**
 * Public Privacy Policy. Intentionally NOT behind auth — Intuit's
 * production-app checklist requires a publicly reachable privacy-policy URL.
 */
export default function PrivacyPage() {
  return (
    <article className="card" style={{ maxWidth: 760, margin: "2rem auto", lineHeight: 1.6 }}>
      <h1>Privacy Policy</h1>
      <p className="page-desc">
        This policy explains how <strong>GCD QBO Hub</strong> (&quot;the Application&quot;), operated by Alan Gelfand
        Inc. DBA German Car Depot (&quot;we&quot;), handles data. The Application is an internal tool for German Car
        Depot&apos;s own accounting automation. Last updated: 2026.
      </p>

      <h2>What we access</h2>
      <p>With your authorization, the Application connects to:</p>
      <ul>
        <li>
          <strong>QuickBooks Online</strong> (via the Intuit Accounting API): accounting records such as invoices,
          customer payments, deposits, accounts, and journal entries, in order to post the employee cash sheet and
          reconcile processor payouts.
        </li>
        <li>
          <strong>Google Sheets</strong> (via a service account): the employee cash-sheet workbook, to read rows and
          write back status.
        </li>
        <li>
          <strong>Processor exports</strong> (Chase Paymentech, Tekmetric/Stripe) that an administrator uploads, to
          reconstruct bank deposits.
        </li>
      </ul>

      <h2>How we use it</h2>
      <p>
        Data is used solely to provide the Application&apos;s accounting-automation features for German Car Depot. We
        do not sell it, and we do not share it with third parties except the service providers named above that the
        Application integrates with to function.
      </p>

      <h2>Storage &amp; security</h2>
      <p>
        Data is stored in the Application&apos;s private database. QuickBooks OAuth tokens are encrypted at rest.
        Access requires authentication and is restricted to authorized German Car Depot staff. We retain data only as
        needed for accounting operations and audit history.
      </p>

      <h2>Your choices</h2>
      <p>
        You may disconnect QuickBooks at any time from within QuickBooks or the Application, which revokes its access.
        To request deletion of stored data, contact us.
      </p>

      <h2>Contact</h2>
      <p>
        <a href="mailto:michaelc@germancardepot.com">michaelc@germancardepot.com</a>
      </p>
    </article>
  );
}
