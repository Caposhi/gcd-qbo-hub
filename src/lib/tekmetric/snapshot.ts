/**
 * Tekmetric fetch-through cache (`tek_snapshot` table).
 *
 * The Operations page reads normalized data from `tek_snapshot` (fast, no
 * network). A manual, permission-gated refresh action pulls live data from the
 * Tekmetric API, builds the normalized `TekOperationsData`, and upserts it into
 * the cache keyed by (entity, periodStart, periodEnd).
 *
 * Everything stored is NORMALIZED (never raw Tekmetric JSON), and everything
 * read back is validated/coerced by `parseOperationsData` (mirroring
 * projections' `parseAssumptions`) so a corrupt row can never crash the page.
 *
 * This module performs IO (Prisma + the Tekmetric client), so it must not be
 * imported by the pure normalizer or the pure period helpers.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  fetchAppointments,
  fetchEmployees,
  fetchRepairOrders,
  fetchVehicles,
  resolveShopIds,
  type TekDateRange,
} from "./client";
import { buildOperationsData } from "./normalize";
import type { TekPeriod } from "./types";
import type { TekOperationsData } from "./types";

const DERIVED_ENTITY = "derived_metrics";

// ===========================================================================
// Validation on read — a bad snapshot degrades to safe empties, never a crash
// ===========================================================================

function n(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function s(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function nOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function parseKpi(v: unknown): { value: number; priorValue: number | null; deltaAbs: number | null; deltaPct: number | null } {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return {
    value: n(o.value),
    priorValue: nOrNull(o.priorValue),
    deltaAbs: nOrNull(o.deltaAbs),
    deltaPct: nOrNull(o.deltaPct),
  };
}

function emptyOperations(period: TekPeriod): TekOperationsData {
  const zeroKpi = { value: 0, priorValue: null, deltaAbs: null, deltaPct: null };
  return {
    period,
    repairOrders: [],
    technicians: [],
    serviceAdvisors: [],
    vehicles: [],
    appointments: [],
    kpis: {
      roCount: { ...zeroKpi },
      aro: { ...zeroKpi },
      grossProfit: { ...zeroKpi },
      grossMarginPct: { ...zeroKpi },
      carCount: { ...zeroKpi },
    },
    techUtilization: [],
    revenueByMake: [],
    advisorPerformance: [],
  };
}

/**
 * Validate/coerce a stored snapshot JSON into a safe `TekOperationsData`.
 * Unknown/missing fields fall back to safe defaults so the page never crashes
 * on a partial or malformed row.
 */
export function parseOperationsData(json: unknown, period: TekPeriod): TekOperationsData {
  if (!json || typeof json !== "object" || Array.isArray(json)) return emptyOperations(period);
  const src = json as Record<string, unknown>;
  const k = src.kpis && typeof src.kpis === "object" ? (src.kpis as Record<string, unknown>) : {};

  return {
    period,
    repairOrders: arr(src.repairOrders).map((r) => {
      const o = r as Record<string, unknown>;
      const totals = o.totals && typeof o.totals === "object" ? (o.totals as Record<string, unknown>) : {};
      return {
        id: s(o.id),
        shopId: s(o.shopId),
        status: s(o.status, "unknown") as TekOperationsData["repairOrders"][number]["status"],
        rawStatus: s(o.rawStatus),
        openedAt: typeof o.openedAt === "string" ? o.openedAt : null,
        closedAt: typeof o.closedAt === "string" ? o.closedAt : null,
        customerId: typeof o.customerId === "string" ? o.customerId : null,
        vehicleId: typeof o.vehicleId === "string" ? o.vehicleId : null,
        serviceAdvisorId: typeof o.serviceAdvisorId === "string" ? o.serviceAdvisorId : null,
        totals: {
          labor: n(totals.labor),
          parts: n(totals.parts),
          subtotal: n(totals.subtotal),
          tax: n(totals.tax),
          total: n(totals.total),
        },
        grossProfit: n(o.grossProfit),
        jobs: arr(o.jobs).map((j) => {
          const job = j as Record<string, unknown>;
          return {
            id: s(job.id),
            roId: s(job.roId),
            name: s(job.name),
            category: typeof job.category === "string" ? job.category : null,
            laborHours: n(job.laborHours),
            laborRate: n(job.laborRate),
            labor: n(job.labor),
            parts: n(job.parts),
            grossProfit: n(job.grossProfit),
            assignedTechnicianId: typeof job.assignedTechnicianId === "string" ? job.assignedTechnicianId : null,
          };
        }),
      };
    }),
    technicians: arr(src.technicians).map((t) => {
      const o = t as Record<string, unknown>;
      return { id: s(o.id), name: s(o.name), active: o.active !== false };
    }),
    serviceAdvisors: arr(src.serviceAdvisors).map((t) => {
      const o = t as Record<string, unknown>;
      return { id: s(o.id), name: s(o.name), active: o.active !== false };
    }),
    vehicles: arr(src.vehicles).map((v) => {
      const o = v as Record<string, unknown>;
      return {
        id: s(o.id),
        year: nOrNull(o.year),
        make: typeof o.make === "string" ? o.make : null,
        model: typeof o.model === "string" ? o.model : null,
        mileage: nOrNull(o.mileage),
      };
    }),
    appointments: arr(src.appointments).map((a) => {
      const o = a as Record<string, unknown>;
      return {
        id: s(o.id),
        scheduledAt: typeof o.scheduledAt === "string" ? o.scheduledAt : null,
        arrivedAt: typeof o.arrivedAt === "string" ? o.arrivedAt : null,
        roId: typeof o.roId === "string" ? o.roId : null,
        status: s(o.status, "unknown") as TekOperationsData["appointments"][number]["status"],
      };
    }),
    kpis: {
      roCount: parseKpi(k.roCount),
      aro: parseKpi(k.aro),
      grossProfit: parseKpi(k.grossProfit),
      grossMarginPct: parseKpi(k.grossMarginPct),
      carCount: parseKpi(k.carCount),
    },
    techUtilization: arr(src.techUtilization).map((u) => {
      const o = u as Record<string, unknown>;
      return {
        technicianId: s(o.technicianId),
        technicianName: s(o.technicianName),
        billedHours: n(o.billedHours),
        availableHours: n(o.availableHours),
        utilizationPct: n(o.utilizationPct),
        laborRevenue: n(o.laborRevenue),
        effectiveLaborRate: n(o.effectiveLaborRate),
        postedLaborRate: n(o.postedLaborRate),
      };
    }),
    revenueByMake: arr(src.revenueByMake).map((r) => {
      const o = r as Record<string, unknown>;
      return {
        make: s(o.make, "Unknown"),
        roCount: n(o.roCount),
        revenue: n(o.revenue),
        grossProfit: n(o.grossProfit),
        grossMarginPct: n(o.grossMarginPct),
        aro: n(o.aro),
      };
    }),
    advisorPerformance: arr(src.advisorPerformance).map((a) => {
      const o = a as Record<string, unknown>;
      return {
        advisorId: s(o.advisorId),
        advisorName: s(o.advisorName),
        roCount: n(o.roCount),
        carCount: n(o.carCount),
        totalSales: n(o.totalSales),
        grossProfit: n(o.grossProfit),
        grossMarginPct: n(o.grossMarginPct),
        aro: n(o.aro),
      };
    }),
  };
}

// ===========================================================================
// Read path (no network) — used by the page
// ===========================================================================

export interface SnapshotResult {
  data: TekOperationsData | null;
  fetchedAt: Date | null;
}

/**
 * Read the cached derived-metrics snapshot for a period + comparison mode (no
 * network call). The comparison is part of the key because the KPI deltas in the
 * payload are computed against it — reading a period under a different comparison
 * than it was refreshed with would show deltas whose baseline the page mislabels.
 */
export async function readOperationsSnapshot(
  period: TekPeriod,
  comparison: string
): Promise<SnapshotResult> {
  const row = await prisma.tekSnapshot.findUnique({
    where: {
      entity_periodStart_periodEnd_comparison: {
        entity: DERIVED_ENTITY,
        periodStart: new Date(period.start),
        periodEnd: new Date(period.end),
        comparison,
      },
    },
  });
  if (!row) return { data: null, fetchedAt: null };
  return { data: parseOperationsData(row.payloadJson, period), fetchedAt: row.fetchedAt };
}

/** The five headline KPI values for a period, without the heavy entity arrays. */
export interface OpsKpiValues {
  carCount: number;
  roCount: number;
  aro: number;
  grossProfit: number;
  grossMarginPct: number;
}

/**
 * Read ONLY the KPI numbers from a cached snapshot — not the full dataset.
 *
 * The stored payload also holds every repair order, job, vehicle, and
 * appointment for the month, which is large. The ops forecast reads 24 months,
 * so fully parsing each (via `parseOperationsData`) blows memory. This pulls just
 * the five headline KPIs and lets the big blob be GC'd, so callers can loop over
 * many months cheaply. Returns null when the month isn't cached.
 */
export async function readOperationsKpis(period: TekPeriod, comparison: string): Promise<OpsKpiValues | null> {
  const row = await prisma.tekSnapshot.findUnique({
    where: {
      entity_periodStart_periodEnd_comparison: {
        entity: DERIVED_ENTITY,
        periodStart: new Date(period.start),
        periodEnd: new Date(period.end),
        comparison,
      },
    },
    select: { payloadJson: true },
  });
  if (!row) return null;
  const payload = row.payloadJson as unknown;
  const k =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? ((payload as Record<string, unknown>).kpis as Record<string, unknown> | undefined)
      : undefined;
  const val = (x: unknown): number => {
    if (typeof x === "number") return Number.isFinite(x) ? x : 0;
    if (x && typeof x === "object" && typeof (x as { value?: unknown }).value === "number") {
      const v = (x as { value: number }).value;
      return Number.isFinite(v) ? v : 0;
    }
    return 0;
  };
  return {
    carCount: val(k?.carCount),
    roCount: val(k?.roCount),
    aro: val(k?.aro),
    grossProfit: val(k?.grossProfit),
    grossMarginPct: val(k?.grossMarginPct),
  };
}

// ===========================================================================
// Refresh path (network) — used by the gated refresh action
// ===========================================================================

async function fetchRosForRange(shopIds: string[], range: TekDateRange) {
  const all = [];
  for (const shopId of shopIds) {
    all.push(...(await fetchRepairOrders(shopId, range)));
  }
  return all;
}

/**
 * Pull live Tekmetric data for the period (across all in-scope shops), build
 * the normalized dataset, and upsert it into `tek_snapshot`. Returns the freshly
 * built data. Callers MUST gate this with `requirePermission` — it is the only
 * mutation in this module.
 */
export async function refreshOperations(
  period: TekPeriod,
  comparisonMode: string,
  comparison: TekPeriod | null
): Promise<TekOperationsData> {
  const shopIds = await resolveShopIds();
  const range: TekDateRange = { start: period.start, end: period.end };

  const repairOrders = await fetchRosForRange(shopIds, range);
  const priorRepairOrders = comparison
    ? await fetchRosForRange(shopIds, { start: comparison.start, end: comparison.end })
    : null;

  const vehicles = [];
  const appointments = [];
  const employees = [];
  for (const shopId of shopIds) {
    vehicles.push(...(await fetchVehicles(shopId)));
    appointments.push(...(await fetchAppointments(shopId, range)));
    employees.push(...(await fetchEmployees(shopId)));
  }

  const data = buildOperationsData({
    period,
    repairOrders,
    priorRepairOrders,
    vehicles,
    appointments,
    employees,
  });

  await prisma.tekSnapshot.upsert({
    where: {
      entity_periodStart_periodEnd_comparison: {
        entity: DERIVED_ENTITY,
        periodStart: new Date(period.start),
        periodEnd: new Date(period.end),
        comparison: comparisonMode,
      },
    },
    create: {
      entity: DERIVED_ENTITY,
      periodStart: new Date(period.start),
      periodEnd: new Date(period.end),
      comparison: comparisonMode,
      payloadJson: data as unknown as Prisma.InputJsonValue,
    },
    update: {
      payloadJson: data as unknown as Prisma.InputJsonValue,
      fetchedAt: new Date(),
    },
  });

  return data;
}
