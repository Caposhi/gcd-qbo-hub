import { describe, it, expect } from "vitest";
import { planWritebackColumns, MANAGED_HEADERS } from "@/lib/cashsheet/writeback";
import type { SheetField } from "@/lib/cashsheet/headers";

// Data columns A..K (0..10), mirroring the real 26 DC layout.
const DATA_COLUMNS: Partial<Record<SheetField, number>> = {
  date: 0,
  rcvByOrPaidTo: 1,
  name: 2,
  purpose: 3,
  invNumber: 4,
  backup: 5,
  approvedBy: 6,
  amtCollected: 7,
  amountPaidOut: 8,
  bankDeposit: 9,
  cashBalanceEnvelope: 10,
};

describe("sheet write-back column planning (§4)", () => {
  it("appends the managed block just past the last data/header column", () => {
    const header = ["Date", "Rcv", "Name", "Purpose", "INV#", "Back up", "Approved By", "Amt Collected", "Amount Paid Out", "Bank Deposit", "Cash Balance In Envelope"];
    const { colByKey, headerCellsToWrite } = planWritebackColumns(header, DATA_COLUMNS);
    // Header has 11 cells (0..10), so managed columns start at 11.
    expect(colByKey.rowId).toBe(11);
    expect(colByKey.status).toBe(12);
    expect(colByKey.txnId).toBe(13);
    expect(colByKey.postedAt).toBe(14);
    expect(colByKey.error).toBe(15);
    // All five need their header written.
    expect(headerCellsToWrite.map((h) => h.value)).toEqual([
      MANAGED_HEADERS.rowId,
      MANAGED_HEADERS.status,
      MANAGED_HEADERS.txnId,
      MANAGED_HEADERS.postedAt,
      MANAGED_HEADERS.error,
    ]);
  });

  it("never lands on an existing far-right column (e.g. a legend)", () => {
    // A legend occupies columns Y/Z (24/25) in the same header row.
    const header = [...Array(11).fill("h"), ...Array(13).fill(""), "Column", "Purpose"]; // len 26
    const { colByKey } = planWritebackColumns(header, DATA_COLUMNS);
    expect(colByKey.rowId).toBe(26); // starts after the last non-empty header cell
    expect(colByKey.error).toBe(30);
  });

  it("reuses an existing managed column and only appends the missing ones", () => {
    const header = [...Array(11).fill("h")];
    header[11] = MANAGED_HEADERS.rowId; // GCD_QBO_Row_ID already present
    const { colByKey, headerCellsToWrite } = planWritebackColumns(header, DATA_COLUMNS);
    expect(colByKey.rowId).toBe(11); // reused, not rewritten
    expect(headerCellsToWrite.some((h) => h.value === MANAGED_HEADERS.rowId)).toBe(false);
    // The other four are appended after the last header cell (index 11).
    expect(colByKey.status).toBe(12);
    expect(headerCellsToWrite).toHaveLength(4);
  });
});
