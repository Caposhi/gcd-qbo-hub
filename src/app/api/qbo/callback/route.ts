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
  let email: string | undefined;
  try {
    const user = await requirePermission("connect_qbo");
    email = user.email;
  } catch {
    return NextResponse.redirect(new URL("/auth/signin", req.url));
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const realmId = url.searchParams.get("realmId");
  const state = url.searchParams.get("state");
  const expectedState = cookies().get("qbo_oauth_state")?.value;

  if (!code || !realmId) {
    return NextResponse.redirect(new URL("/cash-sheet-sync/settings?qbo=missing_params", req.url));
  }
  if (!state || !expectedState || state !== expectedState) {
    return NextResponse.redirect(new URL("/cash-sheet-sync/settings?qbo=bad_state", req.url));
  }

  try {
    await exchangeCode(code, realmId, email);
    return NextResponse.redirect(new URL("/cash-sheet-sync/settings?qbo=connected", req.url));
  } catch (err) {
    return NextResponse.redirect(
      new URL(`/cash-sheet-sync/settings?qbo=error&detail=${encodeURIComponent(String(err))}`, req.url)
    );
  }
}
