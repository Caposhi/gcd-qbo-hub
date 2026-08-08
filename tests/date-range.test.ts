import { describe, it, expect } from "vitest";
import { resolveDateRange, parseDateOnly, dateRangeWhere, describeDateRange } from "@/lib/cashsheet/date-range";

// A fixed "now" so every test is deterministic regardless of when it runs.
const NOW = new Date(Date.UTC(2026, 7, 8)); // 2026-08-08 (August)

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

describe("resolveDateRange presets (§20)", () => {
  it("this_month: full calendar month containing `now`", () => {
    const r = resolveDateRange("this_month", { now: NOW });
    expect(iso(r.start)).toBe("2026-08-01T00:00:00.000Z");
    expect(iso(r.end)).toBe("2026-08-31T23:59:59.999Z");
  });

  it("last_month: the prior calendar month, including a year rollback in January", () => {
    const r = resolveDateRange("last_month", { now: NOW });
    expect(iso(r.start)).toBe("2026-07-01T00:00:00.000Z");
    expect(iso(r.end)).toBe("2026-07-31T23:59:59.999Z");

    const jan = resolveDateRange("last_month", { now: new Date(Date.UTC(2026, 0, 15)) });
    expect(iso(jan.start)).toBe("2025-12-01T00:00:00.000Z");
    expect(iso(jan.end)).toBe("2025-12-31T23:59:59.999Z");
  });

  it("this_quarter: August is Q3 (Jul-Sep)", () => {
    const r = resolveDateRange("this_quarter", { now: NOW });
    expect(iso(r.start)).toBe("2026-07-01T00:00:00.000Z");
    expect(iso(r.end)).toBe("2026-09-30T23:59:59.999Z");
  });

  it("last_quarter: Q2 (Apr-Jun) when now is in Q3", () => {
    const r = resolveDateRange("last_quarter", { now: NOW });
    expect(iso(r.start)).toBe("2026-04-01T00:00:00.000Z");
    expect(iso(r.end)).toBe("2026-06-30T23:59:59.999Z");
  });

  it("last_quarter rolls back across a year boundary from Q1", () => {
    const r = resolveDateRange("last_quarter", { now: new Date(Date.UTC(2026, 1, 10)) }); // Feb → Q1
    expect(iso(r.start)).toBe("2025-10-01T00:00:00.000Z"); // prior year's Q4
    expect(iso(r.end)).toBe("2025-12-31T23:59:59.999Z");
  });

  it("this_year / last_year", () => {
    expect(iso(resolveDateRange("this_year", { now: NOW }).start)).toBe("2026-01-01T00:00:00.000Z");
    expect(iso(resolveDateRange("this_year", { now: NOW }).end)).toBe("2026-12-31T23:59:59.999Z");
    expect(iso(resolveDateRange("last_year", { now: NOW }).start)).toBe("2025-01-01T00:00:00.000Z");
    expect(iso(resolveDateRange("last_year", { now: NOW }).end)).toBe("2025-12-31T23:59:59.999Z");
  });

  it("custom: uses the given from/to, open-ended if either is missing", () => {
    const both = resolveDateRange("custom", { customFrom: "2026-07-01", customTo: "2026-07-31" });
    expect(iso(both.start)).toBe("2026-07-01T00:00:00.000Z");
    expect(iso(both.end)).toBe("2026-07-31T23:59:59.999Z");

    const fromOnly = resolveDateRange("custom", { customFrom: "2026-07-01" });
    expect(iso(fromOnly.start)).toBe("2026-07-01T00:00:00.000Z");
    expect(fromOnly.end).toBeNull();
  });

  it("all, missing, or unknown preset → fully open range (never silently narrows a link)", () => {
    for (const p of ["all", undefined, null, "bogus"]) {
      const r = resolveDateRange(p as string | undefined);
      expect(r.start).toBeNull();
      expect(r.end).toBeNull();
    }
  });
});

describe("parseDateOnly (§20)", () => {
  it("parses a plain YYYY-MM-DD as UTC midnight", () => {
    expect(iso(parseDateOnly("2026-07-09"))).toBe("2026-07-09T00:00:00.000Z");
  });

  it("rejects overflow and garbage", () => {
    expect(parseDateOnly("2026-02-30")).toBeNull();
    expect(parseDateOnly("not-a-date")).toBeNull();
    expect(parseDateOnly("")).toBeNull();
    expect(parseDateOnly(null)).toBeNull();
  });
});

describe("dateRangeWhere (§20)", () => {
  it("omits bounds that are null and returns undefined when fully open", () => {
    expect(dateRangeWhere({ start: null, end: null })).toBeUndefined();
    const start = new Date(Date.UTC(2026, 6, 1));
    expect(dateRangeWhere({ start, end: null })).toEqual({ gte: start });
    const end = new Date(Date.UTC(2026, 6, 31));
    expect(dateRangeWhere({ start, end })).toEqual({ gte: start, lte: end });
  });
});

describe("describeDateRange (§20)", () => {
  it("labels a known preset", () => {
    expect(describeDateRange("this_month", resolveDateRange("this_month", { now: NOW }))).toBe("This month");
  });

  it("formats a custom range as from → to", () => {
    const r = resolveDateRange("custom", { customFrom: "2026-07-01", customTo: "2026-07-31" });
    expect(describeDateRange("custom", r)).toBe("2026-07-01 → 2026-07-31");
  });
});
