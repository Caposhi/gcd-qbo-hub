"use client";
/* =============================================================================
   App-shell top bar (§2). Frosted, sticky. Left: breadcrumb (Hub / <group>) +
   page title in Eurostile. Right: the ⌘K command palette (a real search — see
   CommandPalette) + the environment pill. The pill replaces the loose env
   `notice` row that used to sit atop the Cash Sheet Sync page. Env facts come
   from the server layout so the pill can never disagree with the derived QBO
   environment (§12/§16).
   On phones (globals.css §11) it collapses to: menu button · page title ·
   search icon · short env pill. The breadcrumb hides and the Arcade link moves
   into the slide-out menu so the bar never wraps or clips.
   ========================================================================== */
import { usePathname } from "next/navigation";
import { MODULES } from "@/lib/modules/registry";
import { ARCADE_URL } from "@/lib/modules/arcade";
import { CommandPalette } from "./CommandPalette";
import { MenuButton } from "./NavDrawer";

export interface EnvInfo {
  environment: "sandbox" | "live";
  configured: boolean;
}

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
      <MenuButton />
      <BackToArcade />
      <div className="topbar-heading">
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
        <span className="env-full">Setup required</span>
        <span className="env-short">Setup</span>
      </span>
    );
  }
  if (env.environment === "live") {
    return (
      <span className="env-pill live" title="Connected to the live QuickBooks company.">
        <span className="dot" />
        <span className="env-full">Live · Connected</span>
        <span className="env-short">Live</span>
      </span>
    );
  }
  return (
    <span className="env-pill" title="Connected to the QuickBooks sandbox company.">
      <span className="dot" />
      <span className="env-full">Sandbox · Connected</span>
      <span className="env-short">Sandbox</span>
    </span>
  );
}
