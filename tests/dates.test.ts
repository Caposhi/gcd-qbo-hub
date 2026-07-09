import { describe, it, expect } from "vitest";
import {
  parseSheetDate,
  isOnOrAfterStartDate,
  formatDate,
  AUTOMATION_START_DATE,
} from "@/lib/cashsheet/dates";

describe("date parsing (§3, §5)", () => {
  it("parses US and ISO formats", () => {
    expect(formatDate(parseSheetDate("7/7/2026"))).toBe("2026-07-07");
    expect(formatDate(parseSheetDate("07/07/2026"))).toBe("2026-07-07");
    expect(formatDate(parseSheetDate("2026-07-07"))).toBe("2026-07-07");
    expect(formatDate(parseSheetDate("7/7/26"))).toBe("2026-07-07");
  });

  it("parses Google Sheets serial numbers", () => {
    // 2026-07-07 serial = days since 1899-12-30.
    const serial = Math.round((Date.UTC(2026, 6, 7) - Date.UTC(1899, 11, 30)) / 86_400_000);
    expect(formatDate(parseSheetDate(serial))).toBe("2026-07-07");
  });

  it("rejects invalid dates", () => {
    expect(parseSheetDate("")).toBeNull();
    expect(parseSheetDate("not a date")).toBeNull();
    expect(parseSheetDate("2/30/2026")).toBeNull();
    expect(parseSheetDate("13/1/2026")).toBeNull();
  });

  it("start-date ignore logic (§3): before 2026-07-07 is excluded", () => {
    expect(isOnOrAfterStartDate(parseSheetDate("7/6/2026"))).toBe(false);
    expect(isOnOrAfterStartDate(parseSheetDate("7/7/2026"))).toBe(true);
    expect(isOnOrAfterStartDate(parseSheetDate("12/31/2026"))).toBe(true);
    expect(isOnOrAfterStartDate(null)).toBe(false);
  });

  it("start date constant is 2026-07-07", () => {
    expect(formatDate(AUTOMATION_START_DATE)).toBe("2026-07-07");
  });
});
