/**
 * Tekmetric integration — normalized internal types (Build Phase 4 groundwork).
 *
 * THIS FILE IS THE INTERFACE CONTRACT. The Tekmetric provider (client + pure
 * normalization) maps Tekmetric's raw API JSON onto the shapes below; the rest
 * of the hub — the standalone /tekmetric Operations page and, later, the AI
 * C-suite officers (COO / CRO / CDA) — consume ONLY these shapes. Raw Tekmetric
 * JSON must never leak upward past `src/lib/tekmetric/normalize.ts`.
 *
 * Conventions mirrored from the rest of the repo:
 *  - Pure types only — no Prisma/Next/network imports here.
 *  - IDs are normalized to `string` (Tekmetric exposes numeric ids; we stringify
 *    them so they compose with the rest of the app, where every id is a string).
 *  - Timestamps are ISO-8601 strings (JSON-serializable straight into the
 *    `tek_snapshot` payload) or `null` when Tekmetric has no value yet.
 *  - Money is USD **dollars** as a `number` (2-dp), matching the projections
 *    engine and the reporting KPI tiles — NOT cents. Percentages are whole
 *    percents (e.g. 62.5 means 62.5%), matching the "up/down %" tile format.
 *
 * Read-only integration: nothing here models a write to Tekmetric.
 */

// ===========================================================================
// Shared primitives
// ===========================================================================

/** USD dollars, 2-dp. Named for readability at call sites. */
export type UsdDollars = number;

/** Whole-percent value, e.g. 62.5 === 62.5%. */
export type Percent = number;

/** ISO-8601 timestamp string, or null when Tekmetric has no value. */
export type IsoDateTime = string;

/** A closed date range [start, end], ISO-8601 (used to key snapshots). */
export interface TekPeriod {
  /** Inclusive start, ISO-8601. */
  start: IsoDateTime;
  /** Inclusive end, ISO-8601. */
  end: IsoDateTime;
}

/**
 * Normalized repair-order lifecycle status. We map Tekmetric's raw status onto
 * this small, stable set so downstream consumers never branch on raw strings;
 * `rawStatus` preserves the original for audit / display. `unknown` is the
 * safe fallback when a raw status doesn't map — never a crash.
 */
export type TekRoStatus =
  | "estimate"
  | "in_progress"
  | "complete"
  | "posted"
  | "accounts_receivable"
  | "void"
  | "unknown";

/** Normalized appointment lifecycle status (same fallback discipline). */
export type TekAppointmentStatus =
  | "scheduled"
  | "arrived"
  | "in_service"
  | "completed"
  | "cancelled"
  | "no_show"
  | "unknown";

// ===========================================================================
// Core entities
// ===========================================================================

/** Money breakdown carried on a repair order. All USD dollars. */
export interface TekRoTotals {
  labor: UsdDollars;
  parts: UsdDollars;
  /** Pre-tax subtotal (labor + parts + fees/discounts, per Tekmetric). */
  subtotal: UsdDollars;
  tax: UsdDollars;
  /** Grand total the customer owes/paid. */
  total: UsdDollars;
}

export interface TekRepairOrder {
  id: string;
  shopId: string;
  status: TekRoStatus;
  /** Original Tekmetric status string, preserved for audit/display. */
  rawStatus: string;
  openedAt: IsoDateTime | null;
  /** Closed/posted timestamp; null while the RO is still open. */
  closedAt: IsoDateTime | null;
  customerId: string | null;
  vehicleId: string | null;
  serviceAdvisorId: string | null;
  totals: TekRoTotals;
  /** Gross profit for the whole RO (revenue − cost of labor & parts). */
  grossProfit: UsdDollars;
  jobs: TekJob[];
}

export interface TekJob {
  id: string;
  roId: string;
  /** Job name (e.g. "Front brake pads & rotors"). */
  name: string;
  /** Job category/canned-service group, when Tekmetric provides one. */
  category: string | null;
  /** Billed (sold) labor hours on this job. */
  laborHours: number;
  /** Posted labor rate applied ($/hr). */
  laborRate: UsdDollars;
  /** Labor revenue for the job (USD). */
  labor: UsdDollars;
  /** Parts revenue for the job (USD). */
  parts: UsdDollars;
  /** Gross profit for the job (revenue − cost of labor & parts). */
  grossProfit: UsdDollars;
  /** Technician assigned to the job, when one is assigned. */
  assignedTechnicianId: string | null;
}

export interface TekTechnician {
  id: string;
  name: string;
  active: boolean;
}

export interface TekServiceAdvisor {
  id: string;
  name: string;
  active: boolean;
}

export interface TekVehicle {
  id: string;
  year: number | null;
  make: string | null;
  model: string | null;
  /** Odometer reading at time of service, when captured. */
  mileage: number | null;
}

export interface TekAppointment {
  id: string;
  scheduledAt: IsoDateTime | null;
  /** When the customer actually arrived (for cycle-time / show-rate metrics). */
  arrivedAt: IsoDateTime | null;
  /** Linked repair order, when the appointment converted to one. */
  roId: string | null;
  status: TekAppointmentStatus;
}

// ===========================================================================
// Derived metrics (computed, pure, in normalize.ts — no IO)
// ===========================================================================

/**
 * Technician utilization & effective rate for a period.
 * utilizationPct = billedHours / availableHours * 100.
 * effectiveLaborRate = laborRevenue / billedHours (what the shop actually
 * realized per billed hour, vs. the posted `postedLaborRate` menu rate).
 */
export interface TekTechUtilization {
  technicianId: string;
  technicianName: string;
  billedHours: number;
  availableHours: number;
  utilizationPct: Percent;
  laborRevenue: UsdDollars;
  effectiveLaborRate: UsdDollars;
  postedLaborRate: UsdDollars;
}

/** Revenue / profit rolled up by vehicle make for a period. */
export interface TekRevenueByMake {
  make: string;
  roCount: number;
  revenue: UsdDollars;
  grossProfit: UsdDollars;
  grossMarginPct: Percent;
  /** Average repair order = revenue / roCount. */
  aro: UsdDollars;
}

/** Service-advisor performance rollup for a period. */
export interface TekAdvisorPerformance {
  advisorId: string;
  advisorName: string;
  roCount: number;
  /** Distinct vehicles serviced (car count). */
  carCount: number;
  totalSales: UsdDollars;
  grossProfit: UsdDollars;
  grossMarginPct: Percent;
  /** Average repair order = totalSales / roCount. */
  aro: UsdDollars;
}

/**
 * Headline KPI figure for the house-format tiles (figure + up/down % and $
 * delta vs. a comparison period). The page renders one of these per KPI; the
 * comparison fields are null when no comparison period was requested.
 */
export interface TekKpi {
  /** Current-period value (dollars for money KPIs, a count/percent otherwise). */
  value: number;
  /** Comparison-period value, or null when no comparison was requested. */
  priorValue: number | null;
  /** Absolute delta (value − priorValue), or null. */
  deltaAbs: number | null;
  /** Percent change vs. prior, or null (and null when prior is 0). */
  deltaPct: Percent | null;
}

/**
 * The five headline KPIs for the Operations page, in house format:
 * RO count, ARO, gross profit, gross margin %, and car count.
 */
export interface TekKpiSummary {
  roCount: TekKpi;
  aro: TekKpi;
  grossProfit: TekKpi;
  grossMarginPct: TekKpi;
  carCount: TekKpi;
}

/**
 * The full normalized operations dataset for a period — what a `tek_snapshot`
 * derived-metrics payload holds and what the /tekmetric page (and later the AI
 * officers) consume. Entities are included so consumers can drill in without a
 * second fetch; the derived arrays are the pre-computed rollups.
 */
export interface TekOperationsData {
  period: TekPeriod;
  repairOrders: TekRepairOrder[];
  technicians: TekTechnician[];
  serviceAdvisors: TekServiceAdvisor[];
  vehicles: TekVehicle[];
  appointments: TekAppointment[];
  kpis: TekKpiSummary;
  techUtilization: TekTechUtilization[];
  revenueByMake: TekRevenueByMake[];
  advisorPerformance: TekAdvisorPerformance[];
}

/** Entities persisted as `tek_snapshot` rows (Prisma `entity` column values). */
export type TekSnapshotEntity =
  | "repair_orders"
  | "jobs"
  | "technicians"
  | "appointments"
  | "vehicles"
  | "derived_metrics";
