/**
 * AI Report Assistant chat endpoint (prototype).
 *
 * POST { conversationId?, message } → persists the turn, runs the assistant
 * (read-only tools over the hub DB), persists the reply, returns it. Gated to
 * users with the `use_assistant` permission.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/roles";
import { askAssistant, isAssistantConfigured, type ChatTurn } from "@/lib/anthropic/assistant";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user || !can(user.role, "use_assistant")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!isAssistantConfigured()) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  let body: { conversationId?: string; message?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const message = (body.message ?? "").trim();
  if (!message) return NextResponse.json({ error: "empty_message" }, { status: 400 });

  // Load or create the conversation (scoped to this user).
  let conversation = body.conversationId
    ? await prisma.aiConversation.findFirst({ where: { id: body.conversationId, userEmail: user.email } })
    : null;
  if (!conversation) {
    conversation = await prisma.aiConversation.create({
      data: { userEmail: user.email, title: message.slice(0, 60) },
    });
  }

  const priorMessages = await prisma.aiMessage.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: "asc" },
    take: 40,
  });
  const history: ChatTurn[] = priorMessages.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));

  // Persist the user turn.
  await prisma.aiMessage.create({ data: { conversationId: conversation.id, role: "user", content: message } });

  try {
    const reply = await askAssistant(history, message);
    await prisma.aiMessage.create({
      data: {
        conversationId: conversation.id,
        role: "assistant",
        content: reply.text,
        usageJson: reply.usage as unknown as Prisma.InputJsonValue,
      },
    });
    await prisma.aiConversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });
    return NextResponse.json({ conversationId: conversation.id, reply: reply.text });
  } catch (err) {
    return NextResponse.json({ conversationId: conversation.id, error: String(err) }, { status: 500 });
  }
}
