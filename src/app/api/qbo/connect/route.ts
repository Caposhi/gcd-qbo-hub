/**
 * Start the QBO OAuth connect flow (owner_admin only, §16, §18).
 * Redirects to Intuit's consent screen. State carries a CSRF nonce.
 */
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { buildAuthorizeUrl } from "@/lib/qbo/oauth";
import { requirePermission } from "@/lib/auth/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    await requirePermission("connect_qbo");
  } catch {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const state = randomUUID();
  const res = NextResponse.redirect(buildAuthorizeUrl(state));
  // Store the state nonce in an HttpOnly cookie to validate on callback.
  res.cookies.set("qbo_oauth_state", state, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 600, path: "/" });
  return res;
}
