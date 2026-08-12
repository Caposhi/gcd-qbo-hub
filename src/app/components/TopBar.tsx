"use client";
/* =============================================================================
   App-shell top bar (§2). Frosted, sticky. Left: breadcrumb (Hub / <group>) +
   page title in Eurostile. Right: the ⌘K command palette (a real search — see
   CommandPalette) + the environment pill. The pill replaces the loose env
   `notice` row that used to sit atop the Cash Sheet Sync page. Env facts come
   from the server layout so the pill can never disagree with the derived QBO
   environment (§12/§16).
   ========================================================================== */
import { usePathname } from "next/navigation";
import { MODULES } from "@/lib/modules/registry";
import { CommandPalette } from "./CommandPalette";

export interface EnvInfo {
  environment: "sandbox" | "live";
  configured: boolean;
}

// GCD Arcade — the launcher hub every program links back to. Override via env
// if Render ever assigns the arcade's static site a different host.
const ARCADE_URL = process.env.NEXT_PUBLIC_ARCADE_URL || "https://gcd-arcade-web.onrender.com";

/** Top-left "back to arcade" link — iOS-style tinted back button, so leaving
 *  this program for another one is a single click, same as every other GCD app. */
function BackToArcade() {
  return (
    <a href={ARCADE_URL} title="Back to GCD Arcade" className="back-to-arcade">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M15 18l-6-6 6-6" />
      </svg>
      Arcade
    </a>
  );
}

function crumbFor(pathname: string): { group: string; title: string } {
  if (pathname === "/") return { group: "Workspace", title: "Home" };
  const mod = MODULES.find(
    (m) => pathname === m.basePath || pathname.startsWith(m.basePath + "/")
  );
  if (mod) return { group: mod.group, title: mod.name };
  // Fallback: title-case the first path segment.
  const seg = pathname.split("/").filter(Boolean)[0] || "Home";
  const title = seg.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return { group: "Hub", title };
}

export function TopBar({ env }: { env: EnvInfo }) {
  const pathname = usePathname() || "/";
  const { group, title } = crumbFor(pathname);

  return (
    <header className="topbar">
      <BackToArcade />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="crumb">Hub / {group}</div>
        <div className="title">{title}</div>
      </div>

      <CommandPalette />

      <EnvPill env={env} />
    </header>
  );
}

function EnvPill({ env }: { env: EnvInfo }) {
  if (!env.configured) {
    return (
      <span className="env-pill live" title="QuickBooks credentials are not connected yet.">
        <span className="dot" />
        Setup required
      </span>
    );
  }
  if (env.environment === "live") {
    return (
      <span className="env-pill live" title="Connected to the live QuickBooks company.">
        <span className="dot" />
        Live · Connected
      </span>
    );
  }
  return (
    <span className="env-pill" title="Connected to the QuickBooks sandbox company.">
      <span className="dot" />
      Sandbox · Connected
    </span>
  );
}
