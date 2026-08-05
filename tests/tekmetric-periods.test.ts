import { describe, it, expect } from "vitest";
import {
  presetRange,
  comparisonRange,
  monthRangesBack,
  monthsInRange,
  monthKeyToRange,
  monthRangeToKey,
  ytdComposableRange,
} from "@/lib/tekmetric/periods";
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
  it("prior_period on a whole calendar month is the prior CALENDAR month", () => {
    // June is a whole calendar month → compare to all of May (not the 30 days
    // before June 1, which would be May 2–31 and omit May 1).
    const june = { start: "2026-06-01", end: "2026-06-30" };
    expect(comparisonRange(june, "prior_period")).toEqual({ start: "2026-05-01", end: "2026-05-31" });
  });

  it("prior_year shifts the same window back one year", () => {
    const june = { start: "2026-06-01", end: "2026-06-30" };
    expect(comparisonRange(june, "prior_year")).toEqual({ start: "2025-06-01", end: "2025-06-30" });
  });

  it("none yields no comparison", () => {
    expect(comparisonRange({ start: "2026-06-01", end: "2026-06-30" }, "none")).toBeNull();
  });

  it("prior_year clamps a Feb-29 boundary to Feb 28 in a non-leap prior year", () => {
    // 2024 is a leap year, 2023 is not: Feb 29 must map to Feb 28, not roll to Mar 1.
    const leapFeb = { start: "2024-02-01", end: "2024-02-29" };
    expect(comparisonRange(leapFeb, "prior_year")).toEqual({ start: "2023-02-01", end: "2023-02-28" });
  });
});

describe("monthRangesBack (history backfill)", () => {
  it("enumerates the N full months ending with the prior month, oldest first", () => {
    const r = monthRangesBack(TODAY, 24); // TODAY = 2026-07-13
    expect(r).toHaveLength(24);
    expect(r[r.length - 1]).toEqual({ start: "2026-06-01", end: "2026-06-30", label: "Jun 2026" });
    expect(r[0]).toEqual({ start: "2024-07-01", end: "2024-07-31", label: "Jul 2024" });
  });

  it("crosses year boundaries and handles February length", () => {
    const r = monthRangesBack(new Date("2024-03-10T12:00:00Z"), 2);
    expect(r).toEqual([
      { start: "2024-01-01", end: "2024-01-31", label: "Jan 2024" },
      { start: "2024-02-01", end: "2024-02-29", label: "Feb 2024" }, // leap
    ]);
  });
});

describe("monthsInRange (composed multi-month view — see compose.ts)", () => {
  it("decomposes a whole calendar year into its 12 months, oldest first", () => {
    const r = monthsInRange({ start: "2025-01-01", end: "2025-12-31" });
    expect(r).not.toBeNull();
    expect(r).toHaveLength(12);
    expect(r?.[0]).toEqual({ start: "2025-01-01", end: "2025-01-31", label: "Jan 2025" });
    expect(r?.[11]).toEqual({ start: "2025-12-01", end: "2025-12-31", label: "Dec 2025" });
  });

  it("decomposes a single whole calendar month into itself", () => {
    expect(monthsInRange({ start: "2026-02-01", end: "2026-02-28" })).toEqual([
      { start: "2026-02-01", end: "2026-02-28", label: "Feb 2026" },
    ]);
  });

  it("decomposes a multi-month span crossing a year boundary", () => {
    const r = monthsInRange({ start: "2025-11-01", end: "2026-02-28" });
    expect(r).toEqual([
      { start: "2025-11-01", end: "2025-11-30", label: "Nov 2025" },
      { start: "2025-12-01", end: "2025-12-31", label: "Dec 2025" },
      { start: "2026-01-01", end: "2026-01-31", label: "Jan 2026" },
      { start: "2026-02-01", end: "2026-02-28", label: "Feb 2026" },
    ]);
  });

  it("refuses (returns null) a range that isn't whole-month-aligned", () => {
    // "Last 90 days"-style range: arbitrary day boundaries, not month-aligned.
    expect(monthsInRange({ start: "2026-05-15", end: "2026-08-12" })).toBeNull();
    // "YTD" mid-year: the trailing end isn't a month's last day.
    expect(monthsInRange({ start: "2026-01-01", end: "2026-07-13" })).toBeNull();
    // Starts mid-month even though it ends cleanly.
    expect(monthsInRange({ start: "2026-01-15", end: "2026-02-28" })).toBeNull();
  });
});

describe("ytdComposableRange (composing a wide 'Year to date' view)", () => {
  it("trims YTD to Jan 1 through the last FULLY completed month", () => {
    // TODAY = 2026-07-13 → June is the last complete month.
    expect(ytdComposableRange(TODAY)).toEqual({ start: "2026-01-01", end: "2026-06-30" });
  });

  it("excludes the current month even on its very last day (never assumed complete mid-month)", () => {
    expect(ytdComposableRange(new Date("2026-12-31T12:00:00Z"))).toEqual({ start: "2026-01-01", end: "2026-11-30" });
  });

  it("handles a month right after January rollover (February complete, March in progress)", () => {
    expect(ytdComposableRange(new Date("2026-03-01T12:00:00Z"))).toEqual({ start: "2026-01-01", end: "2026-02-28" });
  });

  it("returns null while still in January — zero complete months so far this year", () => {
    expect(ytdComposableRange(new Date("2026-01-15T12:00:00Z"))).toBeNull();
    expect(ytdComposableRange(new Date("2026-01-31T12:00:00Z"))).toBeNull();
  });
});

describe("monthKeyToRange / monthRangeToKey (fill-missing-months action, §never trust the client)", () => {
  it("round-trips a whole calendar month through the key encoding", () => {
    const range = monthKeyToRange("2025-03");
    expect(range).toEqual({ start: "2025-03-01", end: "2025-03-31", label: "Mar 2025" });
    expect(monthRangeToKey({ start: "2025-03-01" })).toBe("2025-03");
  });

  it("handles February (leap and non-leap) correctly", () => {
    expect(monthKeyToRange("2024-02")).toEqual({ start: "2024-02-01", end: "2024-02-29", label: "Feb 2024" });
    expect(monthKeyToRange("2025-02")).toEqual({ start: "2025-02-01", end: "2025-02-28", label: "Feb 2025" });
  });

  it("rejects malformed or out-of-range input rather than guessing", () => {
    expect(monthKeyToRange("not-a-month")).toBeNull();
    expect(monthKeyToRange("2025-13")).toBeNull();
    expect(monthKeyToRange("2025-00")).toBeNull();
    expect(monthKeyToRange("")).toBeNull();
    expect(monthKeyToRange("2025-3")).toBeNull(); // must be zero-padded
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

describe("comparisonRange — prior_period on calendar months (§off-by-one)", () => {
  it("compares a calendar month to the PRIOR CALENDAR MONTH, not an equal-length day shift", () => {
    // Jul 2026 (31 days) must compare to Jun 1–30, not May 31–Jun 30.
    expect(comparisonRange({ start: "2026-07-01", end: "2026-07-31" }, "prior_period")).toEqual({
      start: "2026-06-01",
      end: "2026-06-30",
    });
  });

  it("handles a 30-day month and a year boundary", () => {
    expect(comparisonRange({ start: "2026-06-01", end: "2026-06-30" }, "prior_period")).toEqual({
      start: "2026-05-01",
      end: "2026-05-31",
    });
    expect(comparisonRange({ start: "2026-01-01", end: "2026-01-31" }, "prior_period")).toEqual({
      start: "2025-12-01",
      end: "2025-12-31",
    });
  });

  it("handles February and multi-month spans", () => {
    expect(comparisonRange({ start: "2026-03-01", end: "2026-03-31" }, "prior_period")).toEqual({
      start: "2026-02-01",
      end: "2026-02-28",
    });
    // Q3 → Q2 (3 whole months back).
    expect(comparisonRange({ start: "2026-07-01", end: "2026-09-30" }, "prior_period")).toEqual({
      start: "2026-04-01",
      end: "2026-06-30",
    });
  });

  it("still uses an equal-length shift for partial ranges (e.g. last 30 days)", () => {
    expect(comparisonRange({ start: "2026-07-05", end: "2026-08-03" }, "prior_period")).toEqual({
      start: "2026-06-05",
      end: "2026-07-04",
    });
    // Month-to-date is NOT a whole month → equal-length shift.
    expect(comparisonRange({ start: "2026-08-01", end: "2026-08-04" }, "prior_period")).toEqual({
      start: "2026-07-28",
      end: "2026-07-31",
    });
  });
});
