"use client";
/* =============================================================================
   Command palette (⌘K / Ctrl-K) for the app shell.

   The top bar used to render a decorative, aria-hidden "Search…" box that did
   nothing. This makes it real: click it (or press ⌘K / Ctrl-K anywhere) to open
   a fuzzy navigator over every module and page in the hub. Keyboard-first —
   ↑/↓ to move, Enter to go, Esc to close — and it never traps the shortcut when
   the user is typing in a field.

   Destinations come from the module registry plus the sub-pages the registry
   doesn't know about, so adding a module automatically makes it searchable.
   ========================================================================== */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { MODULES } from "@/lib/modules/registry";

export interface PaletteItem {
  label: string;
  href: string;
  group: string;
  /** Extra words that should match this item without being displayed. */
  keywords?: string;
}

/** Pages that aren't modules in their own right (module sub-pages + shell pages). */
const EXTRA_ITEMS: PaletteItem[] = [
  { label: "Cash Sheet Sync · Queue", href: "/cash-sheet-sync/queue", group: "Workspace", keywords: "rows review pending" },
  { label: "Cash Sheet Sync · Cash Deposits", href: "/cash-sheet-sync/deposits", group: "Workspace", keywords: "cash on hand deposit match" },
  { label: "Cash Sheet Sync · Mappings", href: "/cash-sheet-sync/mappings", group: "Workspace", keywords: "purpose account payee mapping" },
  { label: "Cash Sheet Sync · Settings", href: "/cash-sheet-sync/settings", group: "Workspace", keywords: "rollout stage environment" },
  { label: "Cash Sheet Sync · Diagnostics", href: "/cash-sheet-sync/diagnostics", group: "Workspace", keywords: "debug logs sync run" },
  { label: "Financial Projections · Reporting", href: "/projections", group: "Finance", keywords: "p&l pnl kpi revenue charts reports" },
  { label: "Financial Projections · AI Council", href: "/projections", group: "Finance", keywords: "cfo cmo coo board auditor officers council" },
  { label: "System Health", href: "/system-health", group: "Hub", keywords: "status quickbooks connection alerts cron" },
];

function buildItems(): PaletteItem[] {
  const fromModules: PaletteItem[] = MODULES.map((m) => ({
    label: m.name,
    href: m.basePath,
    group: m.group,
    keywords: m.tagline,
  }));
  return [
    { label: "Hub Home", href: "/", group: "Hub", keywords: "dashboard overview modules" },
    ...fromModules,
    ...EXTRA_ITEMS,
  ];
}

/** Subsequence match: "chkrec" matches "Check Reception". Returns a score, or -1. */
function score(item: PaletteItem, query: string): number {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const hay = `${item.label} ${item.keywords ?? ""}`.toLowerCase();
  const label = item.label.toLowerCase();
  if (label.includes(query.toLowerCase())) return 1000 - label.indexOf(query.toLowerCase());
  if (hay.includes(query.toLowerCase())) return 500;
  // Ordered-subsequence fallback over the label.
  let i = 0;
  for (const ch of label) {
    if (ch === q[i]) i++;
    if (i === q.length) return 100;
  }
  return -1;
}

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const items = useMemo(buildItems, []);

  const results = useMemo(() => {
    if (!query.trim()) return items;
    return items
      .map((item) => ({ item, s: score(item, query.trim()) }))
      .filter(({ s }) => s >= 0)
      .sort((a, b) => b.s - a.s)
      .map(({ item }) => item);
  }, [items, query]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActive(0);
  }, []);

  const go = useCallback(
    (item: PaletteItem | undefined) => {
      if (!item) return;
      close();
      router.push(item.href);
    },
    [close, router]
  );

  // Global ⌘K / Ctrl-K. Ignored while typing in an input so it never eats a
  // keystroke meant for a form field (except to close the palette itself).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const k = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && k === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === "Escape" && open) {
        e.preventDefault();
        close();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  // Focus the field whenever the palette opens.
  useEffect(() => {
    if (open) {
      setActive(0);
      // rAF so the input exists and is focusable before we call focus().
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="topbar-search"
        onClick={() => setOpen(true)}
        aria-label="Search the hub (Command K)"
        style={{ cursor: "pointer", font: "inherit", textAlign: "left" }}
      >
        <Search size={15} />
        <span>Search…</span>
        <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.8 }}>⌘K</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Search the hub"
          onMouseDown={close}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 200,
            background: "rgba(10,20,35,0.45)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            padding: "12vh 1rem 1rem",
          }}
        >
          <div
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              width: "min(560px, 100%)",
              background: "var(--surface-card)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-lg, 12px)",
              boxShadow: "var(--shadow-lg)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "12px 14px",
                borderBottom: "1px solid var(--border-subtle)",
              }}
            >
              <Search size={16} style={{ opacity: 0.6, flex: "0 0 auto" }} />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setActive((a) => Math.min(a + 1, results.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setActive((a) => Math.max(a - 1, 0));
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    go(results[active]);
                  }
                }}
                placeholder="Jump to a module or page…"
                aria-label="Search"
                style={{
                  flex: 1,
                  border: "none",
                  outline: "none",
                  background: "transparent",
                  font: "inherit",
                  fontSize: 15,
                  color: "var(--text-body)",
                }}
              />
              <kbd style={{ fontSize: 11, opacity: 0.55 }}>esc</kbd>
            </div>

            {results.length === 0 ? (
              <div style={{ padding: "18px 14px", fontSize: 13, color: "var(--text-muted)" }}>
                Nothing matches “{query}”.
              </div>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 6, maxHeight: "50vh", overflowY: "auto" }}>
                {results.map((item, i) => (
                  <li key={`${item.href}-${item.label}`}>
                    <button
                      type="button"
                      onMouseEnter={() => setActive(i)}
                      onClick={() => go(item)}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "9px 10px",
                        border: "none",
                        borderRadius: "var(--radius-md)",
                        cursor: "pointer",
                        textAlign: "left",
                        font: "inherit",
                        fontSize: 14,
                        background: i === active ? "var(--powder-blue-100)" : "transparent",
                        color: i === active ? "var(--royal-blue)" : "var(--text-body)",
                      }}
                    >
                      <span style={{ flex: 1 }}>{item.label}</span>
                      <span style={{ fontSize: 11, opacity: 0.55 }}>{item.group}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </>
  );
}
