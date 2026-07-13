/**
 * Pure Tekmetric normalization + derived metrics (Build Phase 4 groundwork).
 *
 * Deliberately free of Prisma, Next.js, and any network/IO imports so the
 * business rules are unit-tested in isolation (§20) — mirroring
 * src/lib/projections/engine.ts and the src/lib/cashsheet modules.
 *
 * Responsibilities:
 *   1. Map raw Tekmetric JSON (money in integer CENTS, numeric ids) onto the
 *      normalized dollar/string shapes in `types.ts`. Raw JSON never leaves
 *      this module.
 *   2. Compute the derived metrics: gross profit per RO/job, technician
 *      utilization & effective-vs-posted labor rate, revenue by make, and
 *      service-advisor performance.
 *
 * Money model: Tekmetric returns cents; every `$` field below is dollars
 * (cents / 100, rounded to 2dp).
 *
 * Gross profit definition (documented so the AI officers read it the same way
 * everywhere): revenue is pre-tax and post-discount; cost is parts cost +
 * sublet cost. Labor carries no COGS in the API (technician wages are not
 * exposed), so labor is treated as full margin. RO GP = (totalSales − taxes) −
 * partsCost − subletCost. Job GP = job.subtotal − jobPartsCost.
 */
import type {
  TekAdvisorPerformance,
  TekAppointment,
  TekAppointmentStatus,
  TekJob,
  TekKpi,
  TekKpiSummary,
  TekOperationsData,
  TekPeriod,
  TekRepairOrder,
  TekRevenueByMake,
  TekRoStatus,
  TekServiceAdvisor,
  TekTechUtilization,
  TekTechnician,
  TekVehicle,
} from "./types";
import type {
  TekRawAppointment,
  TekRawEmployee,
  TekRawJob,
  TekRawRepairOrder,
  TekRawVehicle,
} from "./raw";

// ===========================================================================
// Primitive helpers
// ===========================================================================

/** Round to 2 decimals, killing negative-zero and float dust. */
export function round2(n: number): number {
  const r = Math.round((n + Number.EPSILON) * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

/** Integer cents → USD dollars (2dp). Non-finite input → 0. */
export function centsToDollars(cents: unknown): number {
  const n = typeof cents === "number" && Number.isFinite(cents) ? cents : 0;
  return round2(n / 100);
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function pct(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return round2((numerator / denominator) * 100);
}

// ===========================================================================
// Status mapping
// ===========================================================================

/** Map Tekmetric's numeric RO status id onto our normalized status. */
export function mapRoStatus(statusId: number | null | undefined): TekRoStatus {
  switch (statusId) {
    case 1:
      return "estimate";
    case 2:
      return "in_progress";
    case 3:
      return "complete";
    case 5:
      return "posted";
    case 6:
      return "accounts_receivable";
    case 7:
      return "void";
    default:
      return "unknown"; // includes 4 "Saved for Later" and anything unseen
  }
}

/** Map Tekmetric's appointmentStatus string onto our normalized status. */
export function mapAppointmentStatus(code: string | null | undefined): TekAppointmentStatus {
  switch ((code ?? "").toUpperCase()) {
    case "NONE":
      return "scheduled";
    case "ARRIVED":
      return "arrived";
    case "NO_SHOW":
      return "no_show";
    case "CANCELED":
    case "CANCELLED":
      return "cancelled";
    default:
      return "unknown";
  }
}

// ===========================================================================
// Cost / revenue primitives on RAW repair orders (cents in, cents out)
// ===========================================================================

/** Parts cost across all of an RO's jobs, in cents. */
function roPartsCostCents(ro: TekRawRepairOrder): number {
  let c = 0;
  for (const job of ro.jobs ?? []) {
    for (const p of job.parts ?? []) {
      c += num(p.cost) * num(p.quantity, 1);
    }
  }
  return c;
}

/** Sublet cost for an RO, in cents. */
function roSubletCostCents(ro: TekRawRepairOrder): number {
  return (ro.sublets ?? []).reduce((s, sub) => s + num(sub.cost), 0);
}

/** Parts cost for a single job, in cents. */
function jobPartsCostCents(job: TekRawJob): number {
  return (job.parts ?? []).reduce((s, p) => s + num(p.cost) * num(p.quantity, 1), 0);
}

/** Pre-tax revenue for an RO, in cents (grand total minus tax). */
function roRevenuePreTaxCents(ro: TekRawRepairOrder): number {
  return num(ro.totalSales) - num(ro.taxes);
}

/** Gross profit for an RO, in cents (pre-tax revenue − parts & sublet cost). */
function roGrossProfitCents(ro: TekRawRepairOrder): number {
  return roRevenuePreTaxCents(ro) - roPartsCostCents(ro) - roSubletCostCents(ro);
}

/** Gross profit for a job, in cents (subtotal − parts cost). */
function jobGrossProfitCents(job: TekRawJob): number {
  return num(job.subtotal) - jobPartsCostCents(job);
}

/** True when an RO should be excluded from metrics (deleted/void). */
function isDeleted(ro: TekRawRepairOrder): boolean {
  return Boolean(ro.deletedDate) || mapRoStatus(ro.repairOrderStatus?.id) === "void";
}

// ===========================================================================
// Entity normalizers (raw → types.ts)
// ===========================================================================

export function normalizeJob(job: TekRawJob): TekJob {
  const laborHours = num(job.laborHours);
  const laborDollars = centsToDollars(job.laborTotal);
  // Posted labor rate: labor $ per billed hour on this job.
  const laborRate = laborHours > 0 ? round2(centsToDollars(job.laborTotal) / laborHours) : 0;
  return {
    id: String(job.id),
    roId: String(job.repairOrderId),
    name: str(job.name),
    category: job.jobCategoryName ?? null,
    laborHours: round2(laborHours),
    laborRate,
    labor: laborDollars,
    parts: centsToDollars(job.partsTotal),
    grossProfit: centsToDollars(jobGrossProfitCents(job)),
    assignedTechnicianId: job.technicianId != null ? String(job.technicianId) : null,
  };
}

export function normalizeRepairOrder(ro: TekRawRepairOrder): TekRepairOrder {
  const subtotalCents = roRevenuePreTaxCents(ro);
  return {
    id: String(ro.id),
    shopId: String(ro.shopId),
    status: mapRoStatus(ro.repairOrderStatus?.id),
    rawStatus: str(ro.repairOrderStatus?.name) || str(ro.repairOrderStatus?.code),
    openedAt: ro.createdDate ?? null,
    closedAt: ro.postedDate ?? ro.completedDate ?? null,
    customerId: ro.customerId != null ? String(ro.customerId) : null,
    vehicleId: ro.vehicleId != null ? String(ro.vehicleId) : null,
    serviceAdvisorId: ro.serviceWriterId != null ? String(ro.serviceWriterId) : null,
    totals: {
      labor: centsToDollars(ro.laborSales),
      parts: centsToDollars(ro.partsSales),
      subtotal: centsToDollars(subtotalCents),
      tax: centsToDollars(ro.taxes),
      total: centsToDollars(ro.totalSales),
    },
    grossProfit: centsToDollars(roGrossProfitCents(ro)),
    jobs: (ro.jobs ?? []).map(normalizeJob),
  };
}

/** Split employees into technicians and service advisors by role. */
export function normalizeEmployees(employees: TekRawEmployee[]): {
  technicians: TekTechnician[];
  serviceAdvisors: TekServiceAdvisor[];
} {
  const technicians: TekTechnician[] = [];
  const serviceAdvisors: TekServiceAdvisor[] = [];
  for (const e of employees) {
    const name = `${str(e.firstName)} ${str(e.lastName)}`.trim();
    const roleName = str(e.employeeRole?.name).toLowerCase();
    const active = !e.deletedDate;
    if (roleName.includes("advisor") || roleName.includes("writer")) {
      serviceAdvisors.push({ id: String(e.id), name, active });
    }
    // canPerformWork flags a technician; role name is the backup signal.
    if (e.canPerformWork || roleName.includes("tech")) {
      technicians.push({ id: String(e.id), name, active });
    }
  }
  return { technicians, serviceAdvisors };
}

export function normalizeVehicle(v: TekRawVehicle): TekVehicle {
  return {
    id: String(v.id),
    year: v.year ?? null,
    make: v.make ?? null,
    model: v.model ?? null,
    mileage: null, // Vehicle endpoint carries no odometer; RO milesOut holds it.
  };
}

export function normalizeAppointment(a: TekRawAppointment): TekAppointment {
  return {
    id: String(a.id),
    scheduledAt: a.startTime ?? null,
    // Tekmetric exposes only an `arrived` boolean, no arrival timestamp.
    arrivedAt: null,
    // Appointments link by customer/vehicle, not RO, so roId stays null here.
    roId: null,
    status: mapAppointmentStatus(a.appointmentStatus),
  };
}

// ===========================================================================
// Derived metrics (computed from RAW ROs, which carry full cost/discount detail)
// ===========================================================================

/** Inclusive business-day count (Mon–Fri) between two ISO dates. Pure. */
export function businessDaysInclusive(startIso: string, endIso: string): number {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) return 0;
  let count = 0;
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  while (cur <= last) {
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) count += 1;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return count;
}

export interface TechUtilizationOptions {
  /** Billable hours a technician is available per business day. Default 8. */
  dailyCapacityHours?: number;
}

/**
 * Technician utilization + effective/posted labor rate for the period.
 *
 * - billedHours: sum of billed (sold) job hours assigned to the tech.
 * - availableHours: businessDays(period) × dailyCapacityHours.
 * - postedLaborRate: hours-weighted rate from the job labor lines (the rate on
 *   the ticket).
 * - effectiveLaborRate: labor $ actually realized (after proportional RO
 *   discount allocation) ÷ billed hours.
 */
export function computeTechUtilization(
  ros: TekRawRepairOrder[],
  technicians: TekTechnician[],
  period: TekPeriod,
  options: TechUtilizationOptions = {}
): TekTechUtilization[] {
  const dailyCapacity = options.dailyCapacityHours ?? 8;
  const availableHours = round2(businessDaysInclusive(period.start, period.end) * dailyCapacity);
  const nameById = new Map(technicians.map((t) => [t.id, t.name]));

  interface Acc {
    billedHours: number;
    postedRateWeighted: number; // Σ(rate×hours) in dollars
    postedHours: number; // Σ hours that had a rate line
    realizedLaborCents: number; // labor $ after discount allocation, in cents
  }
  const byTech = new Map<string, Acc>();
  const acc = (id: string): Acc => {
    let a = byTech.get(id);
    if (!a) {
      a = { billedHours: 0, postedRateWeighted: 0, postedHours: 0, realizedLaborCents: 0 };
      byTech.set(id, a);
    }
    return a;
  };

  for (const ro of ros) {
    if (isDeleted(ro)) continue;
    const jobs = ro.jobs ?? [];
    // Allocate the RO discount to labor in proportion to labor's share of the
    // pre-discount ticket, then split that labor discount across jobs by their
    // labor total.
    const grossPreDiscount =
      num(ro.laborSales) + num(ro.partsSales) + num(ro.subletSales) + num(ro.feeTotal);
    const laborDiscountCents =
      grossPreDiscount > 0 ? num(ro.discountTotal) * (num(ro.laborSales) / grossPreDiscount) : 0;
    const roLaborTotal = jobs.reduce((s, j) => s + num(j.laborTotal), 0);

    for (const job of jobs) {
      const techId = job.technicianId != null ? String(job.technicianId) : ro.technicianId != null ? String(ro.technicianId) : null;
      if (!techId) continue;
      const a = acc(techId);
      a.billedHours += num(job.laborHours);
      for (const line of job.labor ?? []) {
        a.postedRateWeighted += centsToDollars(line.rate) * num(line.hours);
        a.postedHours += num(line.hours);
      }
      const jobLaborDiscount =
        roLaborTotal > 0 ? laborDiscountCents * (num(job.laborTotal) / roLaborTotal) : 0;
      a.realizedLaborCents += num(job.laborTotal) - jobLaborDiscount;
    }
  }

  const out: TekTechUtilization[] = [];
  for (const [technicianId, a] of byTech) {
    const billedHours = round2(a.billedHours);
    const laborRevenue = centsToDollars(a.realizedLaborCents);
    out.push({
      technicianId,
      technicianName: nameById.get(technicianId) ?? `Tech ${technicianId}`,
      billedHours,
      availableHours,
      utilizationPct: pct(billedHours, availableHours),
      laborRevenue,
      effectiveLaborRate: billedHours > 0 ? round2(laborRevenue / billedHours) : 0,
      postedLaborRate: a.postedHours > 0 ? round2(a.postedRateWeighted / a.postedHours) : 0,
    });
  }
  // Stable, meaningful order: most billed hours first.
  return out.sort((x, y) => y.billedHours - x.billedHours);
}

export function computeRevenueByMake(
  ros: TekRawRepairOrder[],
  vehicles: TekVehicle[]
): TekRevenueByMake[] {
  const makeByVehicle = new Map(vehicles.map((v) => [v.id, v.make]));
  interface Acc {
    roCount: number;
    revenueCents: number;
    grossProfitCents: number;
  }
  const byMake = new Map<string, Acc>();
  for (const ro of ros) {
    if (isDeleted(ro)) continue;
    const make = (ro.vehicleId != null ? makeByVehicle.get(String(ro.vehicleId)) : null) || "Unknown";
    let a = byMake.get(make);
    if (!a) {
      a = { roCount: 0, revenueCents: 0, grossProfitCents: 0 };
      byMake.set(make, a);
    }
    a.roCount += 1;
    a.revenueCents += roRevenuePreTaxCents(ro);
    a.grossProfitCents += roGrossProfitCents(ro);
  }
  const out: TekRevenueByMake[] = [];
  for (const [make, a] of byMake) {
    const revenue = centsToDollars(a.revenueCents);
    const grossProfit = centsToDollars(a.grossProfitCents);
    out.push({
      make,
      roCount: a.roCount,
      revenue,
      grossProfit,
      grossMarginPct: pct(a.grossProfitCents, a.revenueCents),
      aro: a.roCount > 0 ? round2(revenue / a.roCount) : 0,
    });
  }
  return out.sort((x, y) => y.revenue - x.revenue);
}

export function computeAdvisorPerformance(
  ros: TekRawRepairOrder[],
  advisors: TekServiceAdvisor[]
): TekAdvisorPerformance[] {
  const nameById = new Map(advisors.map((a) => [a.id, a.name]));
  interface Acc {
    roCount: number;
    revenueCents: number;
    grossProfitCents: number;
    vehicles: Set<string>;
  }
  const byAdvisor = new Map<string, Acc>();
  for (const ro of ros) {
    if (isDeleted(ro)) continue;
    if (ro.serviceWriterId == null) continue;
    const id = String(ro.serviceWriterId);
    let a = byAdvisor.get(id);
    if (!a) {
      a = { roCount: 0, revenueCents: 0, grossProfitCents: 0, vehicles: new Set() };
      byAdvisor.set(id, a);
    }
    a.roCount += 1;
    a.revenueCents += roRevenuePreTaxCents(ro);
    a.grossProfitCents += roGrossProfitCents(ro);
    if (ro.vehicleId != null) a.vehicles.add(String(ro.vehicleId));
  }
  const out: TekAdvisorPerformance[] = [];
  for (const [advisorId, a] of byAdvisor) {
    const totalSales = centsToDollars(a.revenueCents);
    const grossProfit = centsToDollars(a.grossProfitCents);
    out.push({
      advisorId,
      advisorName: nameById.get(advisorId) ?? `Advisor ${advisorId}`,
      roCount: a.roCount,
      carCount: a.vehicles.size,
      totalSales,
      grossProfit,
      grossMarginPct: pct(a.grossProfitCents, a.revenueCents),
      aro: a.roCount > 0 ? round2(totalSales / a.roCount) : 0,
    });
  }
  return out.sort((x, y) => y.totalSales - x.totalSales);
}

// ===========================================================================
// KPIs (current vs. optional comparison period)
// ===========================================================================

interface KpiRaw {
  roCount: number;
  revenue: number;
  grossProfit: number;
  carCount: number;
}

function rollupKpis(ros: TekRawRepairOrder[]): KpiRaw {
  let roCount = 0;
  let revenueCents = 0;
  let grossProfitCents = 0;
  const vehicles = new Set<string>();
  for (const ro of ros) {
    if (isDeleted(ro)) continue;
    roCount += 1;
    revenueCents += roRevenuePreTaxCents(ro);
    grossProfitCents += roGrossProfitCents(ro);
    if (ro.vehicleId != null) vehicles.add(String(ro.vehicleId));
  }
  return {
    roCount,
    revenue: centsToDollars(revenueCents),
    grossProfit: centsToDollars(grossProfitCents),
    carCount: vehicles.size,
  };
}

/** Build one house-format KPI (value + delta vs. prior). */
export function buildKpi(value: number, priorValue: number | null): TekKpi {
  if (priorValue === null) {
    return { value: round2(value), priorValue: null, deltaAbs: null, deltaPct: null };
  }
  const deltaAbs = round2(value - priorValue);
  const deltaPct = priorValue !== 0 ? round2((deltaAbs / Math.abs(priorValue)) * 100) : null;
  return { value: round2(value), priorValue: round2(priorValue), deltaAbs, deltaPct };
}

export function computeKpis(
  currentRos: TekRawRepairOrder[],
  priorRos: TekRawRepairOrder[] | null
): TekKpiSummary {
  const cur = rollupKpis(currentRos);
  const prior = priorRos ? rollupKpis(priorRos) : null;
  const aro = (k: KpiRaw): number => (k.roCount > 0 ? round2(k.revenue / k.roCount) : 0);
  const margin = (k: KpiRaw): number => (k.revenue > 0 ? round2((k.grossProfit / k.revenue) * 100) : 0);
  return {
    roCount: buildKpi(cur.roCount, prior ? prior.roCount : null),
    aro: buildKpi(aro(cur), prior ? aro(prior) : null),
    grossProfit: buildKpi(cur.grossProfit, prior ? prior.grossProfit : null),
    grossMarginPct: buildKpi(margin(cur), prior ? margin(prior) : null),
    carCount: buildKpi(cur.carCount, prior ? prior.carCount : null),
  };
}

// ===========================================================================
// Orchestration — one call that produces the full operations dataset
// ===========================================================================

export interface BuildOperationsInput {
  period: TekPeriod;
  repairOrders: TekRawRepairOrder[];
  /** Comparison-period ROs for KPI deltas, or null when no comparison. */
  priorRepairOrders?: TekRawRepairOrder[] | null;
  vehicles: TekRawVehicle[];
  appointments: TekRawAppointment[];
  employees: TekRawEmployee[];
  utilization?: TechUtilizationOptions;
}

/**
 * Assemble the normalized `TekOperationsData` the page and AI officers consume.
 * Pure: same inputs → same output, no IO. Entities are normalized for drill-in;
 * derived arrays are computed from the raw ROs (which retain cost/discount
 * detail the normalized shapes intentionally drop).
 */
export function buildOperationsData(input: BuildOperationsInput): TekOperationsData {
  const { technicians, serviceAdvisors } = normalizeEmployees(input.employees);
  const vehicles = input.vehicles.map(normalizeVehicle);
  const liveRos = input.repairOrders.filter((ro) => !isDeleted(ro));

  return {
    period: input.period,
    repairOrders: liveRos.map(normalizeRepairOrder),
    technicians,
    serviceAdvisors,
    vehicles,
    appointments: input.appointments.map(normalizeAppointment),
    kpis: computeKpis(input.repairOrders, input.priorRepairOrders ?? null),
    techUtilization: computeTechUtilization(input.repairOrders, technicians, input.period, input.utilization),
    revenueByMake: computeRevenueByMake(input.repairOrders, vehicles),
    advisorPerformance: computeAdvisorPerformance(input.repairOrders, serviceAdvisors),
  };
}
