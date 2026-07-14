"use client";

import { useEffect, useRef, useState } from "react";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

export function AssistantChat({
  initialConversationId,
  initialMessages,
  initialPrompt = null,
}: {
  initialConversationId: string | null;
  initialMessages: Msg[];
  /** Seeded question from GCD Pal (?q=…); auto-sent once on mount. */
  initialPrompt?: string | null;
}) {
  const [conversationId, setConversationId] = useState<string | null>(initialConversationId);
  const [messages, setMessages] = useState<Msg[]>(initialMessages);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);
  const autoSent = useRef(false);

  async function submit(message: string) {
    const text = message.trim();
    if (!text || busyRef.current) return;
    busyRef.current = true;
    setError(null);
    setBusy(true);
    setMessages((m) => [...m, { role: "user", content: text }]);
    setInput("");
    try {
      const res = await fetch("/api/assistant/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, message: text }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(
          data.error === "not_configured"
            ? "The assistant is not configured yet (ANTHROPIC_API_KEY unset)."
            : `Error: ${data.error ?? res.status}`
        );
      } else {
        setConversationId(data.conversationId);
        setMessages((m) => [...m, { role: "assistant", content: data.reply }]);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
      requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: "smooth" }));
    }
  }

  // Auto-send a Pal-seeded prompt exactly once, then strip ?q= so a refresh
  // doesn't resend it.
  useEffect(() => {
    if (initialPrompt && !autoSent.current) {
      autoSent.current = true;
      void submit(initialPrompt);
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        url.searchParams.delete("q");
        window.history.replaceState(null, "", url.pathname + url.search);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt]);

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", height: "68vh", padding: 0, overflow: "hidden" }}>
      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12, padding: "20px 22px" }}>
        {messages.length === 0 && !busy && (
          <p className="card-subtitle" style={{ margin: 0 }}>
            Ask about the cash sheet — e.g. &ldquo;How did the last sync go?&rdquo;, &ldquo;List July parts
            purchases&rdquo;, or &ldquo;Which rows need review?&rdquo;
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              alignSelf: m.role === "user" ? "flex-end" : "flex-start",
              maxWidth: "82%",
              background: m.role === "user" ? "var(--royal-blue)" : "var(--gray-50)",
              color: m.role === "user" ? "#fff" : "var(--text-strong)",
              border: m.role === "user" ? "none" : "1px solid var(--border-subtle)",
              padding: "10px 14px",
              borderRadius: 14,
              boxShadow: "var(--shadow-sm)",
              fontSize: 14,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
            }}
          >
            {m.content}
          </div>
        ))}
        {busy && (
          <div style={{ alignSelf: "flex-start", display: "flex", gap: 5, padding: "12px 16px", background: "var(--gray-50)", border: "1px solid var(--border-subtle)", borderRadius: 14 }}>
            <Dot delay={0} /><Dot delay={0.16} /><Dot delay={0.32} />
          </div>
        )}
        <div ref={endRef} />
      </div>
      {error && <div className="notice danger" style={{ margin: "0 22px" }}>{error}</div>}
      <form
        onSubmit={(e) => { e.preventDefault(); void submit(input); }}
        style={{ display: "flex", gap: 10, padding: "14px 22px", borderTop: "1px solid var(--border-subtle)" }}
      >
        <input
          className="input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about the books…"
          disabled={busy}
          style={{ flex: 1, borderRadius: "var(--radius-pill)" }}
        />
        <button className="btn primary" type="submit" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

function Dot({ delay }: { delay: number }) {
  return (
    <span
      style={{
        width: 7,
        height: 7,
        borderRadius: "50%",
        background: "var(--text-muted)",
        display: "inline-block",
        animation: "gcd-blink 1.2s var(--ease-standard) infinite",
        animationDelay: `${delay}s`,
      }}
    />
  );
}
