import { describe, it, expect } from "vitest";
import { presetRange, comparisonRange } from "@/lib/tekmetric/periods";
import { toStartOfDay, toEndOfDay } from "@/lib/tekmetric/client";

// Fixed "today" = Mon 2026-07-13 (UTC) so ranges are deterministic.
const TODAY = new Date("2026-07-13T12:00:00Z");

describe("presetRange", () => {
  it("this_month spans the 1st through today", () => {
    expect(presetRange("this_month", TODAY)).toEqual({ start: "2026-07-01", end: "2026-07-13" });
  });

  it("last_month spans the full prior calendar month", () => {
    expect(presetRange("last_month", TODAY)).toEqual({ start: "2026-06-01", end: "2026-06-30" });
  });

  it("last_30_days is a 30-day inclusive window ending today", () => {
    expect(presetRange("last_30_days", TODAY)).toEqual({ start: "2026-06-14", end: "2026-07-13" });
  });

  it("ytd spans Jan 1 through today", () => {
    expect(presetRange("ytd", TODAY)).toEqual({ start: "2026-01-01", end: "2026-07-13" });
  });

  it("last_year spans the full prior calendar year", () => {
    expect(presetRange("last_year", TODAY)).toEqual({ start: "2025-01-01", end: "2025-12-31" });
  });
});

describe("comparisonRange", () => {
  it("prior_period is the equal-length window immediately before", () => {
    // June (30 days) → prior period is the 30 days before June 1 = May 2–31.
    const june = { start: "2026-06-01", end: "2026-06-30" };
    expect(comparisonRange(june, "prior_period")).toEqual({ start: "2026-05-02", end: "2026-05-31" });
  });

  it("prior_year shifts the same window back one year", () => {
    const june = { start: "2026-06-01", end: "2026-06-30" };
    expect(comparisonRange(june, "prior_year")).toEqual({ start: "2025-06-01", end: "2025-06-30" });
  });

  it("none yields no comparison", () => {
    expect(comparisonRange({ start: "2026-06-01", end: "2026-06-30" }, "none")).toBeNull();
  });
});

describe("date → ZonedDateTime widening (Tekmetric requires full datetimes)", () => {
  it("widens a bare date to start/end of UTC day", () => {
    expect(toStartOfDay("2026-06-01")).toBe("2026-06-01T00:00:00Z");
    expect(toEndOfDay("2026-06-30")).toBe("2026-06-30T23:59:59Z");
  });

  it("passes through a value that already has a time component", () => {
    expect(toStartOfDay("2026-06-01T09:30:00Z")).toBe("2026-06-01T09:30:00Z");
    expect(toEndOfDay("2026-06-30T23:00:00Z")).toBe("2026-06-30T23:00:00Z");
  });
});
