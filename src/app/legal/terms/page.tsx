export const dynamic = "force-dynamic";

export const metadata = {
  title: "Terms of Use / EULA — GCD QBO Hub",
  description: "End-user license agreement for the GCD QBO Hub.",
};

/**
 * Public End-User License Agreement. Intentionally NOT behind auth — Intuit's
 * production-app checklist requires a publicly reachable EULA URL. This is an
 * internal-use tool operated by German Car Depot for its own QuickBooks company.
 */
export default function TermsPage() {
  return (
    <article className="card" style={{ maxWidth: 760, margin: "2rem auto", lineHeight: 1.6 }}>
      <h1>Terms of Use &amp; End-User License Agreement</h1>
      <p className="page-desc">
        <strong>GCD QBO Hub</strong> (&quot;the Application&quot;) is an internal software tool operated by Alan
        Gelfand Inc. DBA German Car Depot (&quot;German Car Depot&quot;, &quot;we&quot;) for its own accounting
        automation with QuickBooks Online. Last updated: 2026.
      </p>

      <h2>1. Acceptance</h2>
      <p>
        By accessing or using the Application you agree to these Terms. The Application is provided for use by German
        Car Depot&apos;s authorized staff only; it is not offered to the general public.
      </p>

      <h2>2. License</h2>
      <p>
        German Car Depot grants authorized users a limited, non-exclusive, non-transferable, revocable license to use
        the Application for internal business purposes. You may not copy, resell, sublicense, reverse-engineer, or use
        the Application outside German Car Depot&apos;s business.
      </p>

      <h2>3. QuickBooks Online</h2>
      <p>
        The Application connects to Intuit QuickBooks Online using OAuth 2.0 and the Intuit Accounting API to read and
        post accounting transactions on behalf of the connected company. You must have authority to connect the
        QuickBooks company you authorize. You can disconnect at any time from within QuickBooks or the Application.
      </p>

      <h2>4. Acceptable use</h2>
      <p>
        Use the Application only for lawful accounting and reconciliation activities. Do not attempt to gain
        unauthorized access, disrupt the service, or misuse connected financial data.
      </p>

      <h2>5. No warranty; limitation of liability</h2>
      <p>
        The Application is provided &quot;as is&quot; without warranties of any kind. It assists with bookkeeping but
        does not replace professional accounting judgment; users are responsible for reviewing entries it proposes or
        posts. To the maximum extent permitted by law, German Car Depot is not liable for indirect or consequential
        damages arising from use of the Application.
      </p>

      <h2>6. Changes &amp; termination</h2>
      <p>
        We may modify or discontinue the Application or these Terms at any time. Continued use after changes constitutes
        acceptance.
      </p>

      <h2>7. Contact</h2>
      <p>
        Questions: <a href="mailto:michaelc@germancardepot.com">michaelc@germancardepot.com</a>.
      </p>
    </article>
  );
}
