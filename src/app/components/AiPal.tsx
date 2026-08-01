"use client";
/* =============================================================================
   GCD Pal — the Apple-style AI companion. Docks bottom-right on every module.
   It surfaces things worth checking on the current page; clicking a suggestion
   (or "Open AI Report Assistant") jumps to /assistant with a seeded prompt.
   Mounted ONCE in the shell (src/app/layout.tsx) so it rides every route.

   Insight copy is intentionally GENERIC — it names WHAT to look at and seeds a
   question, but never states figures. This is an accounting tool: the Pal must
   not invent numbers. A later pass can wire GET /api/assistant/insights?module=
   (running the existing READ-ONLY assistant tools) and replace this static map
   with live, sourced bullets; until then the copy states no unverified facts.
   ========================================================================== */
import React, { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

type Tone = "good" | "watch" | "bad" | "info";
interface Insight {
  tone: Tone;
  text: React.ReactNode;
  prompt: string;
}

const DOT: Record<Tone, string> = {
  good: "var(--lemondrop)",
  watch: "var(--warning)",
  bad: "var(--danger)",
  info: "var(--royal-blue)",
};

/* module id (from MODULES registry) -> generic suggestions. Keep to 2-4. */
const INSIGHTS: Record<string, { label: string; items: Insight[] }> = {
  projections: {
    label: "Reporting",
    items: [
      { tone: "info", text: "See how revenue moved this period and what drove the change.", prompt: "How did revenue change this period? Break it down by service and product." },
      { tone: "watch", text: "Check whether operating expenses are trending up.", prompt: "What drove the change in operating expenses this period?" },
      { tone: "info", text: "Review A/R aging — anything sitting past 90 days.", prompt: "Which customers make up the A/R over 90 days, and how much does each owe?" },
      { tone: "info", text: "Look at gross margin by service line.", prompt: "Show gross margin by service line and flag the lowest-margin ones." },
    ],
  },
  "cash-sheet-sync": {
    label: "Cash Sheet Sync",
    items: [
      { tone: "info", text: "Review any rows the last sync flagged as possible duplicates.", prompt: "List the possible-duplicate rows from the last sync and why each was flagged." },
      { tone: "watch", text: "Check for rows changed after posting — QBO is never touched automatically.", prompt: "Show the field-level diff for any rows changed after posting." },
      { tone: "info", text: "Confirm which rollout stage you're on and what posts automatically.", prompt: "What rollout stage am I on, what does it do, and what's the next stage?" },
    ],
  },
  "deposit-reconciliation": {
    label: "Deposit Reconciliation",
    items: [
      { tone: "info", text: "See which payouts matched and are ready to create as QBO deposits.", prompt: "Which matched payouts are ready to create, and what will each deposit total?" },
      { tone: "watch", text: "Review payouts flagged needs-review where the amounts don't tie yet.", prompt: "Why are payouts flagged needs-review, and what's the delta on each?" },
    ],
  },
  "check-reception": {
    label: "Check Reception",
    items: [
      { tone: "watch", text: "Review checks that need a look before they post to QBO.", prompt: "Which checks need review and what did vision read for each?" },
      { tone: "info", text: "See the learned payee mappings that pre-fill repeat payees.", prompt: "List the learned payee-to-category mappings." },
    ],
  },
  tekmetric: {
    label: "Tekmetric Operations",
    items: [
      { tone: "info", text: "See how ARO moved versus the comparison period.", prompt: "How did ARO change this period versus the comparison period?" },
      { tone: "watch", text: "Check technician utilization for anyone running low.", prompt: "Which technicians are below 60% utilization and by how much?" },
      { tone: "info", text: "Look at revenue and gross profit by make.", prompt: "Show revenue and gross profit by make, largest first." },
    ],
  },
  "coworker-portal": {
    label: "Coworker Portal",
    items: [
      { tone: "watch", text: "See which coworker questions are still open.", prompt: "Summarize the open coworker questions and who they're assigned to." },
    ],
  },
};

function moduleFromPath(pathname: string): string {
  const seg = pathname.split("/").filter(Boolean)[0] || "";
  return INSIGHTS[seg] ? seg : "projections"; // default to reporting
}

export function AiPal() {
  const pathname = usePathname() || "/";
  const router = useRouter();
  const [open, setOpen] = useState(false); // default minimized; user opens it
  const moduleId = moduleFromPath(pathname);
  const ctx = useMemo(() => INSIGHTS[moduleId], [moduleId]);

  // Live, figure-accurate insights from the read-only endpoint. Fetched lazily
  // when the panel is opened; falls back to the static (figure-free) copy on any
  // error or empty result, so the Pal never shows a fabricated number.
  const [live, setLive] = useState<Insight[] | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLive(null);
    fetch("/api/assistant/insights?module=" + encodeURIComponent(moduleId))
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d || !Array.isArray(d.insights) || d.insights.length === 0) return;
        setLive(
          d.insights
            .filter((it: unknown): it is Insight => !!it && typeof (it as Insight).text === "string")
            .map((it: Insight) => ({ tone: it.tone, text: it.text, prompt: it.prompt }))
        );
      })
      .catch(() => {
        /* keep static fallback */
      });
    return () => {
      cancelled = true;
    };
  }, [open, moduleId]);

  const items = live && live.length ? live : ctx.items;
  const intro = live && live.length
    ? "Here's what stands out on this page — tap one to ask:"
    : "A few things worth checking on this page — tap one to ask:";

  // Don't show on the assistant page itself (that's where it takes you) or auth.
  if (pathname.startsWith("/assistant") || pathname.startsWith("/auth")) return null;

  const ask = (prompt: string) => router.push("/assistant?q=" + encodeURIComponent(prompt));

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title="Ask GCD Pal"
        style={{
          position: "fixed", right: 24, bottom: 24, width: 60, height: 60, borderRadius: "50%",
          border: "none", cursor: "pointer", background: "var(--royal-blue)", zIndex: 600,
          display: "flex", alignItems: "center", justifyContent: "center", color: "#fff",
          animation: "gcd-glow 3s var(--ease-standard) infinite",
        }}
      >
        <Sparkle />
        <span style={{ position: "absolute", top: 9, right: 11, width: 9, height: 9, borderRadius: "50%", background: "var(--lemondrop)", border: "2px solid var(--royal-blue)" }} />
      </button>
    );
  }

  return (
    <div style={{
      position: "fixed", right: 24, bottom: 24, width: 346, background: "rgba(255,255,255,0.92)",
      backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", border: "1px solid var(--border-subtle)",
      borderRadius: 20, boxShadow: "var(--shadow-xl)", overflow: "hidden", zIndex: 600,
      fontFamily: "var(--font-body)", animation: "gcd-fadeup .32s var(--ease-out)",
    }}>
      {/* header */}
      <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "14px 16px",
        borderBottom: "1px solid var(--border-subtle)", background: "linear-gradient(180deg,var(--powder-blue-100),rgba(255,255,255,0))" }}>
        <div style={{ width: 36, height: 36, flex: "none", borderRadius: "50%", background: "var(--royal-blue)",
          display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "var(--shadow-yellow)" }}>
          <Sparkle size={20} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: "var(--font-heading)", fontSize: 14.5, fontWeight: 700, color: "var(--navy-blue)" }}>GCD Pal</div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Insights · {ctx.label}</div>
        </div>
        <button onClick={() => setOpen(false)} title="Minimize"
          style={{ width: 30, height: 30, border: "none", background: "transparent", borderRadius: 8, cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center", color: "var(--gray-500)" }}>
          <Chevron />
        </button>
      </div>
      {/* body */}
      <div style={{ padding: "13px 15px", display: "flex", flexDirection: "column", gap: 9, maxHeight: 390, overflowY: "auto" }}>
        <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "0 2px 2px" }}>{intro}</div>
        {items.map((it, i) => (
          <button key={i} onClick={() => ask(it.prompt)} className="gcd-insight"
            style={{ textAlign: "left", width: "100%", display: "flex", gap: 11, background: "var(--powder-blue-100)",
              border: "1px solid transparent", borderRadius: 13, padding: "12px 13px", cursor: "pointer",
              fontFamily: "inherit", transition: "all .15s var(--ease-standard)" }}>
            <span style={{ width: 8, height: 8, flex: "none", marginTop: 5, borderRadius: "50%", background: DOT[it.tone] }} />
            <span style={{ minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 13, lineHeight: 1.45, color: "var(--navy-blue)" }}>{it.text}</span>
              <span className="gcd-ask" style={{ display: "inline-flex", alignItems: "center", gap: 4, marginTop: 7,
                fontSize: 11.5, fontWeight: 700, color: "var(--royal-blue)", opacity: 0.55, transition: "opacity .15s" }}>
                Ask about this <Arrow />
              </span>
            </span>
          </button>
        ))}
      </div>
      {/* footer */}
      <div style={{ padding: "12px 15px", borderTop: "1px solid var(--border-subtle)" }}>
        <button className="btn primary" style={{ width: "100%" }} onClick={() => ask("Give me a plain-English summary of this page and what I should act on.")}>
          <Bot /> Open AI Report Assistant
        </button>
      </div>
    </div>
  );
}

/* --- inline Lucide-style icons (stroke = currentColor unless noted) --------- */
const Sparkle = ({ size = 27 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--lemondrop)" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /><path d="M19 14v3M20.5 15.5h-3" />
  </svg>
);
const Chevron = () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>);
const Arrow = () => (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>);
const Bot = () => (<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="10" rx="2" /><circle cx="8.5" cy="16" r="1" /><circle cx="15.5" cy="16" r="1" /><path d="M12 7v4" /><circle cx="12" cy="5" r="2" /></svg>);
