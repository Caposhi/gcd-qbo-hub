/**
 * Module registry (§1).
 *
 * The hub is a multi-module dashboard. Each module is a self-contained section
 * under the shared shell (top nav, auth, layout). New modules (Projections,
 * Assistant, Coworker Portal) are added here without rearchitecting — the shell
 * renders nav from this list and route groups live under each module's basePath.
 *
 * Namespacing: each module owns a DB table prefix (e.g. `css_` for Cash Sheet
 * Sync) so future modules don't collide with this one's schema (§1, §15).
 */
import type { Permission } from "@/lib/auth/roles";

/** Sidebar grouping (§2 of the redesign handoff). */
export type ModuleGroup = "Workspace" | "Finance" | "Operations";

export interface ModuleDef {
  id: string;
  name: string;
  /** Legacy emoji — retained for back-compat; the UI now renders `lucide`. */
  icon: string;
  /** Lucide icon name; mapped to a component in the client Sidebar (§1/§3). */
  lucide: string;
  /** Sidebar section this module lives under. */
  group: ModuleGroup;
  basePath: string;
  tablePrefix: string;
  /** live = production; prototype = early build behind auth; planned = stub only. */
  status: "live" | "prototype" | "planned";
  tagline: string;
  /** Minimum permission needed to see the module in nav (all can view live ones). */
  requiredPermission?: Permission;
}

export const MODULES: ModuleDef[] = [
  {
    id: "cash-sheet-sync",
    name: "Cash Sheet Sync",
    icon: "💵",
    lucide: "Wallet",
    group: "Workspace",
    basePath: "/cash-sheet-sync",
    tablePrefix: "css_",
    status: "live",
    tagline: "Post the employee cash sheet to QBO with a full audit trail.",
    requiredPermission: "view_dashboard",
  },
  {
    id: "projections",
    name: "Financial Projections",
    icon: "📈",
    lucide: "TrendingUp",
    group: "Finance",
    basePath: "/projections",
    tablePrefix: "proj_",
    status: "prototype",
    tagline: "Interactive QBO reporting with period-over-period deltas, plus cash-flow scenarios.",
    requiredPermission: "view_projections",
  },
  {
    id: "assistant",
    name: "AI Report Assistant",
    icon: "🤖",
    lucide: "Bot",
    group: "Finance",
    basePath: "/assistant",
    tablePrefix: "ai_",
    status: "prototype",
    tagline: "Ask Claude about the business's books.",
    requiredPermission: "use_assistant",
  },
  {
    id: "coworker-portal",
    name: "Coworker Portal",
    icon: "🧑‍🔧",
    lucide: "Users",
    group: "Operations",
    basePath: "/coworker-portal",
    tablePrefix: "cwp_",
    status: "prototype",
    tagline: "\"Ask My Client\" transaction Q&A for coworkers.",
    requiredPermission: "view_coworker_portal",
  },
  {
    id: "deposit-reconciliation",
    name: "Deposit Reconciliation",
    icon: "🏦",
    lucide: "Landmark",
    group: "Operations",
    basePath: "/deposit-reconciliation",
    tablePrefix: "dep_",
    status: "prototype",
    tagline: "Auto-build QBO deposits for Tekmetric & Chase payouts so the bank matches itself.",
    requiredPermission: "view_dashboard",
  },
  {
    id: "check-reception",
    name: "Check Reception",
    icon: "🧾",
    lucide: "ReceiptText",
    group: "Operations",
    basePath: "/check-reception",
    tablePrefix: "chk_",
    status: "prototype",
    tagline: "Read handwritten checks from a Chase PDF and build the QBO Check so the bank matches itself.",
    requiredPermission: "view_dashboard",
  },
  {
    id: "tekmetric",
    name: "Tekmetric Operations",
    icon: "🔧",
    lucide: "Wrench",
    group: "Operations",
    basePath: "/tekmetric",
    tablePrefix: "tek_",
    status: "prototype",
    tagline: "Read-only shop-management KPIs: ARO, gross profit, tech utilization, revenue by make, advisor performance.",
    requiredPermission: "view_tekmetric",
  },
];

export function getModule(id: string): ModuleDef | undefined {
  return MODULES.find((m) => m.id === id);
}
