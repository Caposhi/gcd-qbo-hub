import { describe, it, expect } from "vitest";
import {
  formatUsd,
  parseApprovalFilter,
  approvalWhere,
  approvalState,
  checkCoversRange,
} from "@/lib/cashsheet/queue-view";
import { resolveDateRange } from "@/lib/cashsheet/date-range";

describe("formatUsd", () => {
  it("adds thousands separators and two decimals", () => {
    expect(formatUsd(12240)).toBe("$12,240.00");
    expect(formatUsd("1640")).toBe("$1,640.00");
    expect(formatUsd(21)).toBe("$21.00");
    expect(formatUsd(1234567.891)).toBe("$1,234,567.89");
  });
  it("puts the sign before the dollar sign", () => {
    expect(formatUsd(-3211)).toBe("-$3,211.00");
  });
  it("renders nothing for missing values", () => {
    expect(formatUsd(null)).toBe("");
    expect(formatUsd(undefined)).toBe("");
    expect(formatUsd("")).toBe("");
    expect(formatUsd("abc")).toBe("");
  });
});

describe("approval filter", () => {
  it("only accepts the two known values", () => {
    expect(parseApprovalFilter("pending")).toBe("pending");
    expect(parseApprovalFilter("approved")).toBe("approved");
    expect(parseApprovalFilter("yes")).toBeNull();
    expect(parseApprovalFilter(undefined)).toBeNull();
  });
  it("maps to the matching Prisma where fragment", () => {
    expect(approvalWhere("pending")).toEqual({ approvedAt: null });
    expect(approvalWhere("approved")).toEqual({ approvedAt: { not: null }, qboTransactionId: null });
    expect(approvalWhere(null)).toEqual({});
  });
});

describe("approvalState", () => {
  const approvedAt = new Date("2026-10-07T17:00:00Z");
  it("an approval after the last real sync waits for the next one", () => {
    expect(approvalState({ approvedAt, qboTransactionId: null }, new Date("2026-10-07T16:27:59Z"))).toBe("waiting");
  });
  it("waits when no real sync has ever run", () => {
    expect(approvalState({ approvedAt, qboTransactionId: null }, null)).toBe("waiting");
  });
  it("is blocked when a real sync ran after approval and the row still has no QBO txn", () => {
    expect(approvalState({ approvedAt, qboTransactionId: null }, new Date("2026-10-07T23:00:00Z"))).toBe("blocked");
  });
  it("posted and unapproved rows are reported as such", () => {
    expect(approvalState({ approvedAt, qboTransactionId: "123" }, null)).toBe("posted");
    expect(approvalState({ approvedAt: null, qboTransactionId: null }, null)).toBe("not_approved");
  });
});

describe("checkCoversRange", () => {
  const now = new Date(Date.UTC(2026, 9, 7)); // October 2026
  it("matches the stored check's exact dates", () => {
    expect(checkCoversRange({ startStr: "2026-10-01", endStr: "2026-10-31" }, resolveDateRange("this_month", { now }))).toBe(true);
  });
  it("flags a stored check for a different period", () => {
    expect(checkCoversRange({ startStr: "2026-08-01", endStr: "2026-08-31" }, resolveDateRange("this_month", { now }))).toBe(false);
  });
  it("an unbounded selection never matches", () => {
    expect(checkCoversRange({ startStr: "2026-08-01", endStr: "2026-08-31" }, resolveDateRange("all", { now }))).toBe(false);
  });
});
