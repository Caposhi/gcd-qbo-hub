/**
 * Best-effort QBO web-app deep links, so a row that already knows its
 * transaction id and type can jump straight to QBO instead of a human hunting
 * the register by hand. Read-only, cosmetic — never used for anything that
 * affects posting logic.
 *
 * QBO's web UI is session/company-scoped (no company id in the URL), so the
 * link only needs the right host for the environment plus a per-entity path.
 * Sandbox and live use different hosts; everything else is identical.
 */
const QBO_WEB_HOST: Record<"sandbox" | "live", string> = {
  sandbox: "https://app.sandbox.qbo.intuit.com",
  live: "https://qbo.intuit.com",
};

/** Entity path per QBO transaction type we ever post (§6, §9). Unknown types
 *  fall back to null — better to show no link than a wrong one. */
const ENTITY_PATH: Record<string, string> = {
  Purchase: "expense",
  Deposit: "bankdeposit",
  Transfer: "transfer",
};

export function qboWebUrl(
  qboTransactionType: string | null | undefined,
  qboTransactionId: string | null | undefined,
  environment: "sandbox" | "live" | null | undefined
): string | null {
  if (!qboTransactionId || !qboTransactionType || !environment) return null;
  const path = ENTITY_PATH[qboTransactionType];
  if (!path) return null;
  return `${QBO_WEB_HOST[environment]}/app/${path}?txnId=${encodeURIComponent(qboTransactionId)}`;
}
