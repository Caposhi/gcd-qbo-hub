/**
 * Arcade bridge for the AI Report Assistant (§ chatService.ts).
 *
 * The Arcade shell has no NextAuth session with the hub — it's a separate
 * app that only ownership/management ever open — so this route is gated by a
 * standalone shared secret instead of `getSessionUser()`, same fail-closed
 * shape as /api/cron/sync's CRON_SECRET. gcd-arcade's BFF injects the secret
 * server-side; it never reaches the browser.
 *
 * All Arcade-originated conversations share ONE identity (ARCADE_USER_EMAIL)
 * distinct from any real hub user's own /assistant conversations — that's
 * what gives the Arcade panel "one shared, ongoing thread across every QBO
 * Hub page, with a history of past threads" rather than fragmenting by
 * whichever browser happened to open it.
 *
 * GET  ?conversationId=<id>  → that conversation's message history
 * GET  (no params)           → recent conversation list (id, title, updatedAt)
 * POST { conversationId?, message } → send a turn, return the reply
 */
import { NextResponse } from "next/server";
import { listConversations, getConversationMessages, sendMessage } from "@/lib/anthropic/chatService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

const ARCADE_USER_EMAIL = "arcade-bridge@germancardepot.com";

function authorized(req: Request): boolean {
  const secret = process.env.ARCADE_BRIDGE_SECRET;
  if (!secret) return false; // fail closed — never run unauthenticated
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const conversationId = url.searchParams.get("conversationId");
  if (conversationId) {
    const messages = await getConversationMessages(conversationId, ARCADE_USER_EMAIL);
    if (!messages) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ conversationId, messages });
  }

  const conversations = await listConversations(ARCADE_USER_EMAIL);
  return NextResponse.json({ conversations });
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { conversationId?: string; message?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const message = (body.message ?? "").trim();
  if (!message) return NextResponse.json({ error: "empty_message" }, { status: 400 });

  const result = await sendMessage(ARCADE_USER_EMAIL, body.conversationId ?? null, message);
  if (!result.ok) {
    if (result.error === "not_configured") return NextResponse.json({ error: "not_configured" }, { status: 503 });
    if (result.error === "empty_message") return NextResponse.json({ error: "empty_message" }, { status: 400 });
    return NextResponse.json({ conversationId: result.conversationId, error: result.error }, { status: 500 });
  }
  return NextResponse.json({ conversationId: result.conversationId, reply: result.reply });
}
