import { describe, it, expect } from "vitest";
import {
  buildOperationsData,
  businessDaysInclusive,
  centsToDollars,
  computeAdvisorPerformance,
  computeRevenueByMake,
  computeTechUtilization,
  mapAppointmentStatus,
  mapRoStatus,
  normalizeEmployees,
  normalizeRepairOrder,
} from "@/lib/tekmetric/normalize";
import type {
  TekRawAppointment,
  TekRawEmployee,
  TekRawRepairOrder,
  TekRawVehicle,
} from "@/lib/tekmetric/raw";

// ---------------------------------------------------------------------------
// Fixtures — shaped after the official Tekmetric API sample payloads (money in
// integer cents). Two posted ROs across two makes, advisors, and technicians.
// ---------------------------------------------------------------------------

// Ford, advisor 616, tech 100. No discount.
const RO_A: TekRawRepairOrder = {
  id: 1001,
  repairOrderNumber: 43,
  shopId: 1,
  repairOrderStatus: { id: 5, code: "POSTED", name: "Posted" },
  customerId: 500,
  technicianId: null,
  serviceWriterId: 616,
  vehicleId: 1,
  postedDate: "2026-07-05T10:00:00Z",
  createdDate: "2026-07-04T09:00:00Z",
  laborSales: 20000,
  partsSales: 10000,
  subletSales: 0,
  feeTotal: 0,
  discountTotal: 0,
  taxes: 2000,
  amountPaid: 32000,
  totalSales: 32000,
  jobs: [
    {
      id: 9001,
      repairOrderId: 1001,
      vehicleId: 1,
      customerId: 500,
      name: "Front brakes",
      jobCategoryName: "Brakes",
      technicianId: 100,
      partsTotal: 10000,
      laborTotal: 20000,
      discountTotal: 0,
      feeTotal: 0,
      subtotal: 30000,
      laborHours: 2,
      loggedHours: 2.5,
      labor: [{ id: 1, name: "Brakes", rate: 10000, hours: 2, complete: true }],
      parts: [{ id: 1, quantity: 1, cost: 4000, retail: 10000, name: "Pads" }],
    },
  ],
  sublets: [],
};

// Lexus, advisor 617, tech 101. $100 RO discount.
const RO_B: TekRawRepairOrder = {
  id: 1002,
  repairOrderNumber: 44,
  shopId: 1,
  repairOrderStatus: { id: 5, code: "POSTED", name: "Posted" },
  customerId: 501,
  technicianId: null,
  serviceWriterId: 617,
  vehicleId: 2,
  postedDate: "2026-07-10T10:00:00Z",
  createdDate: "2026-07-09T09:00:00Z",
  laborSales: 30000,
  partsSales: 20000,
  subletSales: 0,
  feeTotal: 0,
  discountTotal: 10000,
  taxes: 3000,
  amountPaid: 43000,
  totalSales: 43000,
  jobs: [
    {
      id: 9002,
      repairOrderId: 1002,
      vehicleId: 2,
      customerId: 501,
      name: "Timing belt",
      jobCategoryName: "Engine",
      technicianId: 101,
      partsTotal: 20000,
      laborTotal: 30000,
      discountTotal: 10000,
      feeTotal: 0,
      subtotal: 40000,
      laborHours: 3,
      loggedHours: 3.2,
      labor: [{ id: 2, name: "Timing", rate: 10000, hours: 3, complete: true }],
      parts: [{ id: 2, quantity: 1, cost: 8000, retail: 20000, name: "Belt kit" }],
    },
  ],
  sublets: [],
};

// A deleted RO that must be excluded from every rollup.
const RO_DELETED: TekRawRepairOrder = {
  ...RO_A,
  id: 1003,
  repairOrderStatus: { id: 7, code: "DELETED", name: "Deleted" },
  deletedDate: "2026-07-06T10:00:00Z",
};

// Prior-period RO for KPI deltas.
const RO_PRIOR: TekRawRepairOrder = {
  ...RO_A,
  id: 900,
  serviceWriterId: 616,
  vehicleId: 1,
  laborSales: 20000,
  partsSales: 0,
  taxes: 0,
  totalSales: 20000,
  jobs: [
    {
      ...RO_A.jobs![0],
      id: 8000,
      partsTotal: 0,
      laborTotal: 20000,
      subtotal: 20000,
      parts: [],
    },
  ],
};

const VEHICLES: TekRawVehicle[] = [
  { id: 1, customerId: 500, year: 2018, make: "Ford", model: "F-150" },
  { id: 2, customerId: 501, year: 2020, make: "Lexus", model: "RX350" },
];

const EMPLOYEES: TekRawEmployee[] = [
  { id: 616, firstName: "Alice", lastName: "Advisor", employeeRole: { id: 2, code: "2", name: "Service Advisor" }, canPerformWork: false },
  { id: 617, firstName: "Bob", lastName: "Booker", employeeRole: { id: 2, code: "2", name: "Service Advisor" }, canPerformWork: false },
  { id: 100, firstName: "Tina", lastName: "Tech", employeeRole: { id: 3, code: "3", name: "Technician" }, canPerformWork: true },
  { id: 101, firstName: "Tom", lastName: "Turner", employeeRole: { id: 3, code: "3", name: "Technician" }, canPerformWork: true },
];

const APPOINTMENTS: TekRawAppointment[] = [
  { id: 1, shopId: 1, customerId: 500, vehicleId: 1, startTime: "2026-07-05T08:00:00Z", arrived: true, appointmentStatus: "ARRIVED" },
  { id: 2, shopId: 1, customerId: 501, vehicleId: 2, startTime: "2026-07-10T08:00:00Z", arrived: null, appointmentStatus: "NONE" },
];

const PERIOD = { start: "2026-07-01", end: "2026-07-31" };

describe("tekmetric money + status mapping", () => {
  it("converts integer cents to dollars", () => {
    expect(centsToDollars(13000)).toBe(130);
    expect(centsToDollars(42247)).toBe(422.47);
    expect(centsToDollars(0)).toBe(0);
    expect(centsToDollars(undefined)).toBe(0);
  });

  it("maps RO status ids onto the normalized set", () => {
    expect(mapRoStatus(1)).toBe("estimate");
    expect(mapRoStatus(2)).toBe("in_progress");
    expect(mapRoStatus(3)).toBe("complete");
    expect(mapRoStatus(5)).toBe("posted");
    expect(mapRoStatus(6)).toBe("accounts_receivable");
    expect(mapRoStatus(7)).toBe("void");
    expect(mapRoStatus(4)).toBe("unknown"); // Saved for Later
    expect(mapRoStatus(99)).toBe("unknown");
  });

  it("maps appointment status codes", () => {
    expect(mapAppointmentStatus("NONE")).toBe("scheduled");
    expect(mapAppointmentStatus("ARRIVED")).toBe("arrived");
    expect(mapAppointmentStatus("NO_SHOW")).toBe("no_show");
    expect(mapAppointmentStatus("CANCELED")).toBe("cancelled");
    expect(mapAppointmentStatus("CANCELLED")).toBe("cancelled");
    expect(mapAppointmentStatus("whatever")).toBe("unknown");
  });
});

describe("normalizeRepairOrder", () => {
  it("maps totals (cents→dollars), pre-tax subtotal, and gross profit", () => {
    const ro = normalizeRepairOrder(RO_A);
    expect(ro.id).toBe("1001");
    expect(ro.status).toBe("posted");
    expect(ro.serviceAdvisorId).toBe("616");
    expect(ro.totals).toEqual({ labor: 200, parts: 100, subtotal: 300, tax: 20, total: 320 });
    // GP = (totalSales − tax) − partsCost = (32000−2000) − 4000 = 26000c = $260
    expect(ro.grossProfit).toBe(260);
    expect(ro.jobs).toHaveLength(1);
    // Job GP = subtotal(30000) − partsCost(4000) = 26000c = $260
    expect(ro.jobs[0].grossProfit).toBe(260);
    expect(ro.jobs[0].laborRate).toBe(100); // $200 / 2h
    expect(ro.jobs[0].assignedTechnicianId).toBe("100");
  });
});

describe("normalizeEmployees", () => {
  it("splits technicians and service advisors by role", () => {
    const { technicians, serviceAdvisors } = normalizeEmployees(EMPLOYEES);
    expect(serviceAdvisors.map((a) => a.id).sort()).toEqual(["616", "617"]);
    expect(technicians.map((t) => t.id).sort()).toEqual(["100", "101"]);
    expect(serviceAdvisors[0].name).toBe("Alice Advisor");
  });
});

describe("businessDaysInclusive", () => {
  it("counts weekdays inclusively", () => {
    expect(businessDaysInclusive("2026-07-06", "2026-07-10")).toBe(5); // Mon–Fri
    expect(businessDaysInclusive("2026-07-01", "2026-07-31")).toBe(23); // July 2026
    expect(businessDaysInclusive("2026-07-04", "2026-07-05")).toBe(0); // Sat–Sun
    expect(businessDaysInclusive("2026-07-10", "2026-07-06")).toBe(0); // reversed
  });
});

describe("computeTechUtilization", () => {
  it("computes billed/available hours and effective vs posted rate with discount allocation", () => {
    const { technicians } = normalizeEmployees(EMPLOYEES);
    // 5 business-day window → available = 5 × 8 = 40h.
    const util = computeTechUtilization([RO_A, RO_B, RO_DELETED], technicians, {
      start: "2026-07-06",
      end: "2026-07-10",
    });
    const tina = util.find((u) => u.technicianId === "100")!;
    const tom = util.find((u) => u.technicianId === "101")!;

    expect(tina.billedHours).toBe(2);
    expect(tina.availableHours).toBe(40);
    expect(tina.utilizationPct).toBe(5); // 2/40
    expect(tina.postedLaborRate).toBe(100);
    expect(tina.effectiveLaborRate).toBe(100); // no discount on RO_A

    expect(tom.billedHours).toBe(3);
    expect(tom.utilizationPct).toBe(7.5); // 3/40
    expect(tom.postedLaborRate).toBe(100);
    // RO_B $100 discount, all labor share → realized labor $240 / 3h = $80/h
    expect(tom.effectiveLaborRate).toBe(80);
    expect(tom.laborRevenue).toBe(240);
  });
});

describe("computeRevenueByMake", () => {
  it("rolls up revenue and GP by make, sorted by revenue desc", () => {
    const vehicles = VEHICLES.map((v) => ({ id: String(v.id), year: v.year, make: v.make, model: v.model, mileage: null }));
    const byMake = computeRevenueByMake([RO_A, RO_B, RO_DELETED], vehicles);
    expect(byMake.map((m) => m.make)).toEqual(["Lexus", "Ford"]);
    const ford = byMake.find((m) => m.make === "Ford")!;
    expect(ford.revenue).toBe(300);
    expect(ford.grossProfit).toBe(260);
    expect(ford.aro).toBe(300);
    expect(ford.grossMarginPct).toBe(86.67);
  });
});

describe("computeAdvisorPerformance", () => {
  it("rolls up sales, car count, and margin per advisor", () => {
    const { serviceAdvisors } = normalizeEmployees(EMPLOYEES);
    const perf = computeAdvisorPerformance([RO_A, RO_B, RO_DELETED], serviceAdvisors);
    expect(perf.map((p) => p.advisorId)).toEqual(["617", "616"]); // by sales desc
    const alice = perf.find((p) => p.advisorId === "616")!;
    expect(alice.roCount).toBe(1);
    expect(alice.carCount).toBe(1);
    expect(alice.totalSales).toBe(300);
    expect(alice.grossProfit).toBe(260);
  });
});

describe("buildOperationsData (KPIs + deltas)", () => {
  const data = buildOperationsData({
    period: PERIOD,
    repairOrders: [RO_A, RO_B, RO_DELETED],
    priorRepairOrders: [RO_PRIOR],
    vehicles: VEHICLES,
    appointments: APPOINTMENTS,
    employees: EMPLOYEES,
  });

  it("excludes deleted ROs from the normalized list", () => {
    expect(data.repairOrders.map((r) => r.id).sort()).toEqual(["1001", "1002"]);
  });

  it("computes headline KPIs vs the comparison period", () => {
    expect(data.kpis.roCount.value).toBe(2);
    expect(data.kpis.roCount.priorValue).toBe(1);
    expect(data.kpis.roCount.deltaAbs).toBe(1);
    expect(data.kpis.roCount.deltaPct).toBe(100);

    expect(data.kpis.aro.value).toBe(350); // $700 / 2
    expect(data.kpis.grossProfit.value).toBe(580); // $260 + $320
    expect(data.kpis.grossMarginPct.value).toBe(82.86); // 580/700
    expect(data.kpis.carCount.value).toBe(2);
    expect(data.kpis.carCount.priorValue).toBe(1);
  });

  it("returns null deltas when no comparison period is supplied", () => {
    const solo = buildOperationsData({
      period: PERIOD,
      repairOrders: [RO_A],
      priorRepairOrders: null,
      vehicles: VEHICLES,
      appointments: APPOINTMENTS,
      employees: EMPLOYEES,
    });
    expect(solo.kpis.roCount.priorValue).toBeNull();
    expect(solo.kpis.roCount.deltaPct).toBeNull();
  });

  it("normalizes appointments (arrivedAt/roId null; status mapped)", () => {
    expect(data.appointments).toHaveLength(2);
    expect(data.appointments[0].status).toBe("arrived");
    expect(data.appointments[0].arrivedAt).toBeNull();
    expect(data.appointments[1].status).toBe("scheduled");
  });
});
