import { describe, it, expect } from "vitest";
import { detectHeaderRow, normalizeHeader } from "@/lib/cashsheet/headers";

// A realistic July tab: title row, opening-balance row, header row, data.
const JULY_TAB: unknown[][] = [
  ["July 2026 Monthly Cash Balance", "", "", "", "", "", "", "", "", "", ""],
  ["Opening Balance", 500, "", "", "", "", "", "", "", "", ""],
  [
    "Date",
    "Rcv by or paid to",
    "Name",
    "Purpose",
    "INV#",
    "Back up",
    "Approved By",
    "Amt Collected",
    "Amount Paid Out",
    "Bank Deposit",
    "Cash Balance In Envelope",
  ],
  ["7/7/2026", "Eddie", "McAdam", "INV", "73735", "", "MC", "800.00", "", "", "1300.00"],
];

describe("header detection (§3)", () => {
  it("finds the header row regardless of position and maps columns", () => {
    const det = detectHeaderRow(JULY_TAB);
    expect(det).not.toBeNull();
    expect(det!.headerRowIndex).toBe(2);
    expect(det!.columns.date).toBe(0);
    expect(det!.columns.purpose).toBe(3);
    expect(det!.columns.amtCollected).toBe(7);
    expect(det!.columns.amountPaidOut).toBe(8);
    expect(det!.columns.bankDeposit).toBe(9);
    expect(det!.columns.cashBalanceEnvelope).toBe(10);
  });

  it("tolerates spacing/case variations", () => {
    const rows = [
      ["  DATE ", "rcv by/paid to", "NAME", "purpose", "Inv #", "Backup", "approved", "amt collected", "paid out", "deposit", "balance in envelope"],
    ];
    const det = detectHeaderRow(rows);
    expect(det).not.toBeNull();
    expect(det!.columns.date).toBe(0);
    expect(det!.columns.bankDeposit).toBe(9);
  });

  it("returns null when there is no plausible header", () => {
    const rows = [
      ["Some title", "", ""],
      ["random", "notes", "here"],
    ];
    expect(detectHeaderRow(rows)).toBeNull();
  });

  it("normalizeHeader collapses whitespace and trailing punctuation", () => {
    expect(normalizeHeader("  Amt   Collected: ")).toBe("amt collected");
  });
});
