import Link from "next/link";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/roles";
import { RequireAuth } from "../components/RequireAuth";
import { isAssistantConfigured } from "@/lib/anthropic/assistant";
import { AssistantChat } from "./AssistantChat";

export const dynamic = "force-dynamic";

export default async function AssistantPage({ searchParams }: { searchParams: { c?: string; q?: string } }) {
  const user = await getSessionUser();
  if (!user) return <RequireAuth />;

  if (!can(user.role, "use_assistant")) {
    return (
      <div className="center">
        <div className="card" style={{ width: 420 }}>
          <h1>AI Report Assistant</h1>
          <p className="card-subtitle">Your role ({user.role}) doesn&apos;t have access to the assistant.</p>
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
      <div className="accent-bar" />
      <h1>AI Report Assistant</h1>
      <p className="page-desc">
        Ask Claude about German Car Depot&apos;s books. The assistant reads the data through read-only
        tools — it can never post, edit, or delete anything.
      </p>

      {!configured && (
        <div className="notice warn" style={{ marginBottom: 18 }}>
          The assistant isn&apos;t configured yet — set <code>ANTHROPIC_API_KEY</code> in the environment. You can
          still open the page, but sending a message will return a &ldquo;not configured&rdquo; error.
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "240px 1fr", gap: "1rem", alignItems: "start" }}>
        <div className="card" style={{ padding: "18px 18px" }}>
          <h3 className="card-title" style={{ marginBottom: 12 }}>Conversations</h3>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 6 }}>
            <Link className="btn ghost" href="/assistant" style={{ justifyContent: "flex-start" }}>
              + New chat
            </Link>
            {conversations.map((c) => {
              const isActive = active && c.id === active.id;
              return (
                <Link
                  key={c.id}
                  href={`/assistant?c=${c.id}`}
                  className="nav-item"
                  style={{
                    fontSize: 13,
                    background: isActive ? "var(--powder-blue-100)" : "transparent",
                    color: isActive ? "var(--royal-blue)" : "var(--text-body)",
                    fontWeight: isActive ? 700 : 500,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {c.title}
                </Link>
              );
            })}
            {conversations.length === 0 && <span className="card-subtitle">No conversations yet.</span>}
          </div>
        </div>

        <AssistantChat
          initialConversationId={active?.id ?? null}
          initialMessages={initialMessages}
          initialPrompt={searchParams.q ?? null}
        />
      </div>
    </>
  );
}
