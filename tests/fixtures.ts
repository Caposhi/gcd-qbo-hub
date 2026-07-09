import type { SheetField } from "@/lib/cashsheet/headers";
import { parseRow, type ParsedRow } from "@/lib/cashsheet/rows";

/** Column layout matching the canonical GCD cash-sheet header (§3). */
export const COLUMNS: Partial<Record<SheetField, number>> = {
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

/** Build a raw sheet row array in canonical column order. */
export function rawRow(o: {
  date?: string;
  rcv?: string;
  name?: string;
  purpose?: string;
  inv?: string;
  backup?: string;
  approvedBy?: string;
  amtCollected?: string | number;
  amountPaidOut?: string | number;
  bankDeposit?: string | number;
  cashBalance?: string | number;
}): unknown[] {
  return [
    o.date ?? "",
    o.rcv ?? "",
    o.name ?? "",
    o.purpose ?? "",
    o.inv ?? "",
    o.backup ?? "",
    o.approvedBy ?? "",
    o.amtCollected ?? "",
    o.amountPaidOut ?? "",
    o.bankDeposit ?? "",
    o.cashBalance ?? "",
  ];
}

export function parse(o: Parameters<typeof rawRow>[0], rowNumber = 4): ParsedRow {
  return parseRow(rawRow(o), COLUMNS, rowNumber);
}
