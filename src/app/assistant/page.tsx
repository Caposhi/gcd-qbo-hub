import Link from "next/link";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/roles";
import { RequireAuth } from "../components/RequireAuth";
import { isAssistantConfigured } from "@/lib/anthropic/assistant";
import { AssistantChat } from "./AssistantChat";

export const dynamic = "force-dynamic";

export default async function AssistantPage({ searchParams }: { searchParams: { c?: string } }) {
  const user = await getSessionUser();
  if (!user) return <RequireAuth />;

  if (!can(user.role, "use_assistant")) {
    return (
      <div className="center">
        <div className="card" style={{ width: 420 }}>
          <h1>🤖 AI Report Assistant</h1>
          <p className="sub">Your role ({user.role}) doesn&apos;t have access to the assistant.</p>
        </div>
      </div>
    );
  }

  const configured = isAssistantConfigured();

  const conversations = await prisma.aiConversation.findMany({
    where: { userEmail: user.email },
    orderBy: { updatedAt: "desc" },
    take: 15,
  });

  const active = searchParams.c
    ? await prisma.aiConversation.findFirst({ where: { id: searchParams.c, userEmail: user.email } })
    : null;

  const initialMessages = active
    ? (
        await prisma.aiMessage.findMany({
          where: { conversationId: active.id },
          orderBy: { createdAt: "asc" },
        })
      ).map((m) => ({ role: m.role === "assistant" ? ("assistant" as const) : ("user" as const), content: m.content }))
    : [];

  return (
    <>
      <h1>🤖 AI Report Assistant</h1>
      <p className="sub">
        Ask Claude (claude-opus-4-8) about German Car Depot&apos;s books. The assistant reads the Cash Sheet
        Sync data through read-only tools — it can never post, edit, or delete anything.
      </p>

      {!configured && (
        <div className="notice danger">
          The assistant isn&apos;t configured yet — set <code>ANTHROPIC_API_KEY</code> in the environment. You can
          still open the page, but sending a message will return a &ldquo;not configured&rdquo; error.
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: "1rem", alignItems: "start" }}>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Conversations</h3>
          <div className="row-actions" style={{ flexDirection: "column", alignItems: "stretch" }}>
            <Link className="btn secondary" href="/assistant">
              + New
            </Link>
            {conversations.map((c) => (
              <Link
                key={c.id}
                href={`/assistant?c=${c.id}`}
                className={active && c.id === active.id ? "badge ok" : "badge muted"}
                style={{ textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {c.title}
              </Link>
            ))}
            {conversations.length === 0 && <span className="muted">No conversations yet.</span>}
          </div>
        </div>

        <AssistantChat initialConversationId={active?.id ?? null} initialMessages={initialMessages} />
      </div>
    </>
  );
}
