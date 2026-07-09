/**
 * Email via SendGrid (§17) — the same proven pattern as gcd-webhook-server,
 * NOT Gmail. Sends are best-effort and recorded in the css_alerts table so the
 * dashboard shows delivery status. A failed send never aborts a sync (§17).
 */
const SENDGRID_URL = "https://api.sendgrid.com/v3/mail/send";

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain-text body; we also send a minimal HTML wrapper. */
  text: string;
  html?: string;
}

export interface SendOutcome {
  ok: boolean;
  status?: number;
  error?: string;
}

export async function sendEmail(msg: EmailMessage): Promise<SendOutcome> {
  const apiKey = process.env.SENDGRID_API_KEY;
  const from = process.env.ALERT_FROM_EMAIL;
  if (!apiKey || !from) {
    return { ok: false, error: "SENDGRID_API_KEY / ALERT_FROM_EMAIL not configured" };
  }

  try {
    const res = await fetch(SENDGRID_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: msg.to }] }],
        from: { email: from, name: "GCD QBO Hub" },
        subject: msg.subject,
        content: [
          { type: "text/plain", value: msg.text },
          { type: "text/html", value: msg.html ?? `<pre style="font-family:ui-monospace,monospace">${escapeHtml(msg.text)}</pre>` },
        ],
        // These are transactional/security emails. Disable click + open
        // tracking so the sign-in link is NOT rewritten through a SendGrid
        // redirect domain — that rewrite hurts deliverability (looks phishy to
        // corporate filters) and lets link scanners follow the wrapped URL and
        // burn the single-use magic-link token before the human clicks.
        tracking_settings: {
          click_tracking: { enable: false, enable_text: false },
          open_tracking: { enable: false },
        },
      }),
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `SendGrid ${res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export const ALERT_RECIPIENTS = {
  errorSummary: () => process.env.ALERT_SUMMARY_RECIPIENT || "bills@germancardepot.com",
  critical: () => process.env.ALERT_CRITICAL_RECIPIENT || "michaelc@germancardepot.com",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
}
