/**
 * AI Report Assistant chat endpoint (prototype).
 *
 * POST { conversationId?, message } → persists the turn, runs the assistant
 * (read-only tools over the hub DB), persists the reply, returns it. Gated to
 * users with the `use_assistant` permission. Persistence + turn logic live in
 * chatService.ts, shared with the Arcade bridge route (§ external/assistant)
 * so a signed-in hub user and the Arcade panel can never run divergent logic.
 */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/roles";
import { sendMessage } from "@/lib/anthropic/chatService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user || !can(user.role, "use_assistant")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: { conversationId?: string; message?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const message = (body.message ?? "").trim();
  if (!message) return NextResponse.json({ error: "empty_message" }, { status: 400 });

  const result = await sendMessage(user.email, body.conversationId ?? null, message);
  if (!result.ok) {
    if (result.error === "not_configured") return NextResponse.json({ error: "not_configured" }, { status: 503 });
    if (result.error === "empty_message") return NextResponse.json({ error: "empty_message" }, { status: 400 });
    return NextResponse.json({ conversationId: result.conversationId, error: result.error }, { status: 500 });
  }
  return NextResponse.json({ conversationId: result.conversationId, reply: result.reply });
}
