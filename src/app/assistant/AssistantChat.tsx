"use client";

import { useRef, useState } from "react";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

export function AssistantChat({
  initialConversationId,
  initialMessages,
}: {
  initialConversationId: string | null;
  initialMessages: Msg[];
}) {
  const [conversationId, setConversationId] = useState<string | null>(initialConversationId);
  const [messages, setMessages] = useState<Msg[]>(initialMessages);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const message = input.trim();
    if (!message || busy) return;
    setError(null);
    setBusy(true);
    setMessages((m) => [...m, { role: "user", content: message }]);
    setInput("");
    try {
      const res = await fetch("/api/assistant/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, message }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error === "not_configured" ? "The assistant is not configured yet (ANTHROPIC_API_KEY unset)." : `Error: ${data.error ?? res.status}`);
      } else {
        setConversationId(data.conversationId);
        setMessages((m) => [...m, { role: "assistant", content: data.reply }]);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
      requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: "smooth" }));
    }
  }

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", height: "60vh" }}>
      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        {messages.length === 0 && (
          <p className="muted">
            Ask about the cash sheet — e.g. &ldquo;How did the last sync go?&rdquo;, &ldquo;List July parts
            purchases&rdquo;, or &ldquo;Which rows need review?&rdquo;
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              alignSelf: m.role === "user" ? "flex-end" : "flex-start",
              maxWidth: "80%",
              background: m.role === "user" ? "var(--accent)" : "var(--panel-2)",
              color: m.role === "user" ? "#04222b" : "var(--text)",
              padding: "0.6rem 0.8rem",
              borderRadius: 10,
              whiteSpace: "pre-wrap",
            }}
          >
            {m.content}
          </div>
        ))}
        {busy && <div className="muted">Thinking…</div>}
        <div ref={endRef} />
      </div>
      {error && <div className="notice danger">{error}</div>}
      <form onSubmit={send} style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about the books…"
          disabled={busy}
          style={{
            flex: 1,
            padding: "0.5rem",
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: "var(--panel-2)",
            color: "var(--text)",
          }}
        />
        <button className="btn" type="submit" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
