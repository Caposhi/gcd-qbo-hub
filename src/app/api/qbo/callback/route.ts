/**
 * QBO OAuth2 redirect URI handler (§16).
 *
 * Intuit redirects here with ?code, ?realmId, ?state. We validate the state
 * nonce, exchange the code for tokens, and persist them ENCRYPTED (per env +
 * realm). QBO_REDIRECT_URI in the Intuit developer dashboard must exactly match
 * this route on the deployed HTTPS URL (§16 sequencing note).
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { exchangeCode } from "@/lib/qbo/oauth";
import { requirePermission } from "@/lib/auth/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  // Behind Render's proxy, req.url is the internal http://localhost:10000/…
  // address, so a redirect resolved against it sends the browser to localhost.
  // Always build post-callback redirects against the public app URL instead.
  const base = process.env.PUBLIC_APP_URL || process.env.NEXTAUTH_URL || new URL(req.url).origin;
  const to = (path: string) => NextResponse.redirect(new URL(path, base));

  let email: string | undefined;
  try {
    const user = await requirePermission("connect_qbo");
    email = user.email;
  } catch {
    return to("/auth/signin");
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const realmId = url.searchParams.get("realmId");
  const state = url.searchParams.get("state");
  const expectedState = cookies().get("qbo_oauth_state")?.value;

  if (!code || !realmId) {
    return to("/cash-sheet-sync/settings?qbo=missing_params");
  }
  if (!state || !expectedState || state !== expectedState) {
    return to("/cash-sheet-sync/settings?qbo=bad_state");
  }

  try {
    await exchangeCode(code, realmId, email);
    return to("/cash-sheet-sync/settings?qbo=connected");
  } catch (err) {
    return to(`/cash-sheet-sync/settings?qbo=error&detail=${encodeURIComponent(String(err))}`);
  }
}
