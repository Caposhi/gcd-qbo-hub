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

export interface ModuleDef {
  id: string;
  name: string;
  icon: string;
  basePath: string;
  tablePrefix: string;
  status: "live" | "planned";
  tagline: string;
  /** Minimum permission needed to see the module in nav (all can view live ones). */
  requiredPermission?: Permission;
}

export const MODULES: ModuleDef[] = [
  {
    id: "cash-sheet-sync",
    name: "Cash Sheet Sync",
    icon: "💵",
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
    basePath: "/projections",
    tablePrefix: "proj_",
    status: "planned",
    tagline: "Cash-flow & financial projections (coming soon).",
  },
  {
    id: "assistant",
    name: "AI Report Assistant",
    icon: "🤖",
    basePath: "/assistant",
    tablePrefix: "ai_",
    status: "planned",
    tagline: "Ask questions about the business's books (coming soon).",
  },
  {
    id: "coworker-portal",
    name: "Coworker Portal",
    icon: "🧑‍🔧",
    basePath: "/coworker-portal",
    tablePrefix: "cwp_",
    status: "planned",
    tagline: "\"Ask My Client\" transaction Q&A for coworkers (coming soon).",
  },
];

export function getModule(id: string): ModuleDef | undefined {
  return MODULES.find((m) => m.id === id);
}
