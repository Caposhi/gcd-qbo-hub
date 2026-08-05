/**
 * Shared persistence + turn logic for the AI Report Assistant chat, factored
 * out so the hub's own session-gated page/route and the Arcade bridge route
 * (§ external/assistant) can't drift — one conversation model, one place that
 * calls `askAssistant`, two thin callers that differ only in who they trust.
 *
 * IO-only glue: talks to Prisma and `askAssistant`; no Anthropic call logic
 * of its own lives here (that stays in assistant.ts).
 */
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { askAssistant, isAssistantConfigured, type ChatTurn } from "./assistant";

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

/** Most recent conversations for a user (or the Arcade bridge's shared identity). */
export async function listConversations(userEmail: string, take = 15): Promise<ConversationSummary[]> {
  const rows = await prisma.aiConversation.findMany({
    where: { userEmail },
    orderBy: { updatedAt: "desc" },
    take,
  });
  return rows.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt.toISOString() }));
}

/** Full message history for one conversation, scoped to its owner. */
export async function getConversationMessages(
  conversationId: string,
  userEmail: string
): Promise<ConversationMessage[] | null> {
  const convo = await prisma.aiConversation.findFirst({ where: { id: conversationId, userEmail } });
  if (!convo) return null;
  const rows = await prisma.aiMessage.findMany({ where: { conversationId }, orderBy: { createdAt: "asc" } });
  return rows.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
    createdAt: m.createdAt.toISOString(),
  }));
}

export type SendMessageResult =
  | { ok: true; conversationId: string; reply: string }
  | { ok: false; conversationId: string; error: string }
  | { ok: false; conversationId: null; error: "not_configured" | "empty_message" };

/**
 * Post one user turn to a conversation (creating it if `conversationId` is
 * null/not owned by this identity), run the assistant, persist the reply.
 * Mirrors what the hub's own /api/assistant/chat route does for a signed-in
 * user, generalized to any `userEmail` scope — including the Arcade bridge's
 * shared sentinel identity.
 */
export async function sendMessage(
  userEmail: string,
  conversationId: string | null,
  message: string
): Promise<SendMessageResult> {
  const text = message.trim();
  if (!text) return { ok: false, conversationId: null, error: "empty_message" };
  if (!isAssistantConfigured()) return { ok: false, conversationId: null, error: "not_configured" };

  let conversation = conversationId
    ? await prisma.aiConversation.findFirst({ where: { id: conversationId, userEmail } })
    : null;
  if (!conversation) {
    conversation = await prisma.aiConversation.create({ data: { userEmail, title: text.slice(0, 60) } });
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

  await prisma.aiMessage.create({ data: { conversationId: conversation.id, role: "user", content: text } });

  try {
    const reply = await askAssistant(history, text);
    await prisma.aiMessage.create({
      data: {
        conversationId: conversation.id,
        role: "assistant",
        content: reply.text,
        usageJson: reply.usage as unknown as Prisma.InputJsonValue,
      },
    });
    await prisma.aiConversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });
    return { ok: true, conversationId: conversation.id, reply: reply.text };
  } catch (err) {
    return { ok: false, conversationId: conversation.id, error: String(err) };
  }
}
