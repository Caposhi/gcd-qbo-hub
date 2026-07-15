"use client";
/* =============================================================================
   App-shell sidebar (§2 of the redesign handoff). Fixed 250px white rail:
   brand row → grouped nav (Workspace / Finance / Operations) → user chip.
   Active route gets the powder-blue fill + the signature lemondrop bar (CSS).
   Drives entirely off the MODULES registry; icons map registry `lucide` names
   to Lucide components so the registry stays server-serializable.
   ========================================================================== */
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Home,
  Wallet,
  TrendingUp,
  Bot,
  Landmark,
  ReceiptText,
  Wrench,
  Users,
  Activity,
  type LucideIcon,
} from "lucide-react";
import { MODULES, type ModuleGroup } from "@/lib/modules/registry";

const ICONS: Record<string, LucideIcon> = {
  Home,
  Wallet,
  TrendingUp,
  Bot,
  Landmark,
  ReceiptText,
  Wrench,
  Users,
};

const GROUP_ORDER: ModuleGroup[] = ["Workspace", "Finance", "Operations"];

function initials(email?: string | null): string {
  if (!email) return "?";
  const name = email.split("@")[0] || email;
  const parts = name.split(/[.\-_]+/).filter(Boolean);
  const chars = (parts.length >= 2 ? parts[0][0] + parts[1][0] : name.slice(0, 2)) || "?";
  return chars.toUpperCase();
}

export function Sidebar({
  user,
  coworkerOpenCount = 0,
}: {
  user: { email?: string | null; role?: string } | null;
  coworkerOpenCount?: number;
}) {
  const pathname = usePathname() || "/";
  const isActive = (basePath: string) =>
    basePath === "/" ? pathname === "/" : pathname === basePath || pathname.startsWith(basePath + "/");

  return (
    <aside className="sidebar">
      <Link href="/" className="sidebar-brand" style={{ textDecoration: "none" }}>
        <img src="/assets/gcd-logo-disc.png" alt="German Car Depot" />
        <span>
          <span className="name">GCD Hub</span>
          <span className="sub">QuickBooks Online</span>
        </span>
      </Link>

      {GROUP_ORDER.map((group) => {
        const items = MODULES.filter((m) => m.group === group);
        return (
          <nav key={group}>
            <div className="nav-section">{group}</div>
            {group === "Workspace" && (
              <Link href="/" className={"nav-item" + (isActive("/") ? " active" : "")}>
                <Home />
                Home
              </Link>
            )}
            {group === "Workspace" && user?.role === "owner_admin" && (
              <Link
                href="/system-health"
                className={"nav-item" + (isActive("/system-health") ? " active" : "")}
              >
                <Activity />
                System Health
              </Link>
            )}
            {items.map((m) => {
              const Icon = ICONS[m.lucide] ?? Home;
              const badge =
                m.id === "coworker-portal" && coworkerOpenCount > 0 ? coworkerOpenCount : null;
              return (
                <Link
                  key={m.id}
                  href={m.basePath}
                  className={"nav-item" + (isActive(m.basePath) ? " active" : "")}
                >
                  <Icon />
                  {m.name}
                  {badge !== null && (
                    <span className="badge warn nav-count" style={{ marginLeft: "auto" }}>
                      {badge > 99 ? "99+" : badge}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>
        );
      })}

      {user?.email && (
        <div className="sidebar-user">
          <span className="avatar">{initials(user.email)}</span>
          <span style={{ minWidth: 0 }}>
            <span
              style={{
                display: "block",
                fontSize: 12.5,
                fontWeight: 600,
                color: "var(--text-strong)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {user.email}
            </span>
            {user.role && (
              <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)" }}>
                {user.role}
              </span>
            )}
          </span>
        </div>
      )}
    </aside>
  );
}
