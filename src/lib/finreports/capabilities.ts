/**
 * Financial Reports — company capability probe (Phase 1).
 *
 * Some reports only make sense when the company actually uses the feature:
 * Sales-by-Class needs QBO **classes**, Budget-vs-Actual needs a **budget**, and
 * Inventory Valuation needs **inventory-tracked items**. Rather than asking the
 * owner to research their own QuickBooks setup, we ask QBO and cache the answer —
 * then the catalog hides reports whose data doesn't exist, so there are never
 * empty tabs.
 *
 * This file holds the PURE half: interpreting a probe result. The queries live in
 * service.ts (they need a QBO context).
 */
import type { FinCapability } from "./catalog";

export interface Capabilities {
  classes: boolean;
  budgets: boolean;
  inventory: boolean;
  /** ISO timestamp the probe ran; undefined when never probed. */
  probedAt?: string;
}

export const NO_CAPABILITIES: Capabilities = { classes: false, budgets: false, inventory: false };

/**
 * Interpret raw QBO query counts into capabilities. A feature counts as "in use"
 * only when at least one ACTIVE record exists — a company that once created a
 * class and deactivated it shouldn't get a class report.
 */
export function capabilitiesFromCounts(counts: {
  activeClasses: number;
  budgets: number;
  inventoryItems: number;
  probedAt?: string;
}): Capabilities {
  return {
    classes: counts.activeClasses > 0,
    budgets: counts.budgets > 0,
    inventory: counts.inventoryItems > 0,
    probedAt: counts.probedAt,
  };
}

/**
 * Validate/coerce a stored capabilities blob on read — mirrors the hub's
 * `parseAssumptions` discipline so a corrupt cache row degrades to "no optional
 * reports" instead of crashing the page.
 */
export function parseCapabilities(json: unknown): Capabilities {
  const o = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
  const bool = (v: unknown): boolean => v === true;
  const probedAt = typeof o.probedAt === "string" && o.probedAt !== "" ? o.probedAt : undefined;
  return {
    classes: bool(o.classes),
    budgets: bool(o.budgets),
    inventory: bool(o.inventory),
    probedAt,
  };
}

/** Is a probe result stale enough to re-run? Capabilities change very rarely. */
export function capabilitiesStale(caps: Capabilities, now: Date, maxAgeMs = 7 * 24 * 60 * 60 * 1000): boolean {
  if (!caps.probedAt) return true;
  const t = Date.parse(caps.probedAt);
  if (Number.isNaN(t)) return true;
  return now.getTime() - t > maxAgeMs;
}

/** Convenience for the catalog's `requires` lookup. */
export function hasCapability(caps: Capabilities, cap: FinCapability): boolean {
  return caps[cap] === true;
}
