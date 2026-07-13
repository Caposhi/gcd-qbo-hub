"use client";
/* =============================================================================
   App-shell top bar (§2). Frosted, sticky. Left: breadcrumb (Hub / <group>) +
   page title in Eurostile. Right: a (non-functional) search affordance + the
   environment pill. The pill replaces the loose env `notice` row that used to
   sit atop the Cash Sheet Sync page. Env facts come from the server layout so
   the pill can never disagree with the derived QBO environment (§12/§16).
   ========================================================================== */
import { usePathname } from "next/navigation";
import { Search } from "lucide-react";
import { MODULES } from "@/lib/modules/registry";

export interface EnvInfo {
  environment: "sandbox" | "live";
  configured: boolean;
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
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="crumb">Hub / {group}</div>
        <div className="title">{title}</div>
      </div>

      <div className="topbar-search" aria-hidden="true">
        <Search size={15} />
        <span>Search…</span>
        <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.8 }}>⌘K</span>
      </div>

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
