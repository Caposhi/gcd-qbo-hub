import { describe, it, expect } from "vitest";
import { parsePaymentechCsv, normalizeDate } from "@/lib/deposits/paymentech";
import { buildTekmetricDeposit, payoutTiesOut } from "@/lib/deposits/tekmetric";
import { classifyBankLine } from "@/lib/deposits/routing";
import { reconcileDeposit } from "@/lib/deposits/reconcile";
import { parseCsv, stripGuard } from "@/lib/deposits/csv";
import { buildDepositPayload, depositTotalCents } from "@/lib/deposits/qbo-deposit";
import type { QboUndepositedRecord } from "@/lib/deposits/types";

// A trimmed slice of the real Paymentech export (batches 187001, 188001,
// 189001, 189002) — the ones we reconciled to the penny by hand.
const PAYMENTECH_CSV = `Date,Card brand,Card number,Amount,Merchant name,Merchant #,Batch #,Batch date,Batch sequence #,Original transaction ref. #,Authorization code,Entry,Type,Qualification type,Digital payment,Settled by,Rejected
7/08/2026,Visa,438854******8129,1730.62,GERMAN CAR DEPOT,="6585954",="189001",7/08/2026,2,1890010002,01320D,CHIP,DEBIT,NULL,No,Chase,
7/08/2026,Visa,440066******9137,1471.75,GERMAN CAR DEPOT,="6585954",="189001",7/08/2026,3,1890010003,01494D,CHIP,DEBIT,NULL,No,Chase,
7/08/2026,Mastercard,515503******6702,885.74,GERMAN CAR DEPOT,="6585954",="189001",7/08/2026,1,1890010001,12853Z,VI/MC CHIP OR DISC ECOMM,DEBIT,Consumer Digital Payment Token,No,Chase,
7/08/2026,Visa,483950******7342,783.23,GERMAN CAR DEPOT,="6585954",="189002",7/08/2026,1,1890020001,02604D,CHIP,DEBIT,NULL,No,Chase,
7/07/2026,Visa,405413******3598,4550.30,GERMAN CAR DEPOT,="6585954",="188001",7/07/2026,3,1880010004,03852A,VI/MC CHIP OR DISC ECOMM,DEBIT,Consumer Digital Payment Token,No,Chase,
7/07/2026,Visa,446542******6314,930.89,GERMAN CAR DEPOT,="6585954",="188001",7/07/2026,2,1880010005,007682,VI/MC CHIP OR DISC ECOMM,DEBIT,NULL,No,Chase,
7/07/2026,Visa,464018******5923,915.80,GERMAN CAR DEPOT,="6585954",="188001",7/07/2026,6,1880010007,03838D,CHIP,DEBIT,NULL,No,Chase,
7/07/2026,Mastercard,518941******8835,658.81,GERMAN CAR DEPOT,="6585954",="188001",7/07/2026,7,1880010001,40897Z,VI/MC CHIP OR DISC ECOMM,DEBIT,NULL,No,Chase,
7/07/2026,Visa,414720******2708,497.16,GERMAN CAR DEPOT,="6585954",="188001",7/07/2026,1,1880010006,00064D,VI/MC CHIP OR DISC ECOMM,DEBIT,NULL,No,Chase,
7/07/2026,Visa,433993******2614,255.73,GERMAN CAR DEPOT,="6585954",="188001",7/07/2026,4,1880010003,07163G,CHIP,DEBIT,NULL,No,Chase,
7/07/2026,Mastercard,517805******3294,168.53,GERMAN CAR DEPOT,="6585954",="188001",7/07/2026,5,1880010002,09116S,CHIP,DEBIT,NULL,No,Chase,`;

describe("CSV parsing", () => {
  it("strips the Excel text-guard and honors headers", () => {
    expect(stripGuard('="6585954"')).toBe("6585954");
    expect(stripGuard("Visa")).toBe("Visa");
    const rows = parseCsv("a,b\n1,2\n");
    expect(rows).toEqual([{ a: "1", b: "2" }]);
  });
});

describe("date normalization (§Chase)", () => {
  it("handles US and ISO forms", () => {
    expect(normalizeDate("7/09/2026")).toBe("2026-07-09");
    expect(normalizeDate("07/9/2026")).toBe("2026-07-09");
    expect(normalizeDate("2026-07-09")).toBe("2026-07-09");
    expect(normalizeDate("")).toBeNull();
  });
});

describe("Paymentech → expected deposits (grouped by batch date)", () => {
  const deposits = parsePaymentechCsv(PAYMENTECH_CSV);

  it("bundles multiple batches from the same day into one deposit", () => {
    const d0708 = deposits.find((d) => d.settlementDate === "2026-07-08")!;
    // 189001 (1730.62+1471.75+885.74) + 189002 (783.23) = 4,871.34
    expect(d0708.net).toBe(4871.34);
    expect(d0708.sourceRef).toBe("189001+189002");
    expect(d0708.fee).toBe(0); // Chase fees are monthly, never netted daily
  });

  it("matches the 7/07 batch total to the penny", () => {
    const d0707 = deposits.find((d) => d.settlementDate === "2026-07-07")!;
    expect(d0707.net).toBe(7977.22);
    expect(d0707.lines).toHaveLength(7);
  });
});

describe("processor routing by ORIG CO NAME", () => {
  it("separates the two processors", () => {
    expect(classifyBankLine("ORIG CO NAME:PAYMENTECH ORIG ID:XXXXXX1225 …")).toBe("paymentech");
    expect(classifyBankLine("ORIG CO NAME:Tekmetric Paymen ORIG ID:XXXXXX5600 …")).toBe("tekmetric");
    expect(classifyBankLine("ZELLE PAYMENT FROM SOMEONE")).toBeNull();
  });
});

describe("reconcile: Chase deposit ties out to gross payments", () => {
  const deposits = parsePaymentechCsv(PAYMENTECH_CSV);
  const d0707 = deposits.find((d) => d.settlementDate === "2026-07-07")!;

  // QBO Undeposited-Funds payments for that batch (gross, in UF).
  const candidates: QboUndepositedRecord[] = d0707.lines.map((l, i) => ({
    id: `pay-${i}`,
    type: "Payment",
    amount: l.amount,
    brand: l.brand,
    date: "2026-07-07",
  }));

  it("selects all payments and matches the net exactly", () => {
    const r = reconcileDeposit(d0707, candidates);
    expect(r.status).toBe("matched");
    expect(r.selected).toHaveLength(7);
    expect(r.selectedTotal).toBe(7977.22);
    expect(r.deltaCents).toBe(0);
  });

  it("flags needs_review when a payment is missing (never posts on mismatch)", () => {
    const r = reconcileDeposit(d0707, candidates.slice(0, 6));
    expect(r.status).toBe("needs_review");
    expect(r.unmatchedLineAmounts).toHaveLength(1);
    expect(r.deltaCents).not.toBe(0);
  });
});

describe("reconcile: Tekmetric deposit = gross payments + fee JEs", () => {
  // The live-verified $1,017.41 payout.
  const deposit = buildTekmetricDeposit({
    settlementDate: "2026-06-30",
    grossLines: [
      { amount: 851.66, brand: "Visa" },
      { amount: 199.15, brand: "Visa" },
    ],
    fee: 33.4,
    net: 1017.41,
    sourceRef: "trace-7929471",
  });

  it("payout ties out (gross - fee == net)", () => {
    expect(payoutTiesOut({
      settlementDate: "2026-06-30",
      grossLines: [{ amount: 851.66, brand: "Visa" }, { amount: 199.15, brand: "Visa" }],
      fee: 33.4,
      net: 1017.41,
    })).toBeNull();
  });

  it("nets to the payout when the fee JEs are included, and books the fee once", () => {
    const candidates: QboUndepositedRecord[] = [
      { id: "pay-a", type: "Payment", amount: 851.66, brand: "Visa", date: "2026-06-30" },
      { id: "pay-b", type: "Payment", amount: 199.15, brand: "Visa", date: "2026-06-30" },
      { id: "fee-a", type: "JournalEntry", amount: -27.01, brand: "Visa", date: "2026-06-30", lineId: "1" },
      { id: "fee-b", type: "JournalEntry", amount: -6.39, brand: "Visa", date: "2026-06-30", lineId: "1" },
    ];
    const r = reconcileDeposit(deposit, candidates);
    expect(r.status).toBe("matched");
    expect(r.matchedPayments).toHaveLength(2);
    expect(r.feeRecords).toHaveLength(2); // fee comes from the existing JEs, not a new line
    expect(r.selectedTotal).toBe(1017.41);
    expect(r.deltaCents).toBe(0);
  });

  it("refuses (needs_review) if a duplicate fee line would over-deduct", () => {
    // A stray extra fee JE (the old double-count) breaks the checksum → no post.
    const candidates: QboUndepositedRecord[] = [
      { id: "pay-a", type: "Payment", amount: 851.66, brand: "Visa", date: "2026-06-30" },
      { id: "pay-b", type: "Payment", amount: 199.15, brand: "Visa", date: "2026-06-30" },
      { id: "fee-a", type: "JournalEntry", amount: -27.01, brand: "Visa", date: "2026-06-30" },
      { id: "fee-b", type: "JournalEntry", amount: -6.39, brand: "Visa", date: "2026-06-30" },
      { id: "fee-dup", type: "JournalEntry", amount: -33.4, brand: "Visa", date: "2026-06-30" },
    ];
    const r = reconcileDeposit(deposit, candidates);
    expect(r.status).toBe("needs_review");
    expect(r.deltaCents).toBe(3340);
  });
});

describe("QBO deposit payload builder", () => {
  it("links payments + fee JEs and totals the net payout", () => {
    const records: QboUndepositedRecord[] = [
      { id: "pay-a", type: "Payment", amount: 851.66, brand: "Visa", date: "2026-06-30" },
      { id: "pay-b", type: "Payment", amount: 199.15, brand: "Visa", date: "2026-06-30" },
      { id: "fee-a", type: "JournalEntry", amount: -27.01, brand: "Visa", date: "2026-06-30", lineId: "1" },
      { id: "fee-b", type: "JournalEntry", amount: -6.39, brand: "Visa", date: "2026-06-30", lineId: "1" },
    ];
    const payload = buildDepositPayload("42", "2026-07-01", records);
    expect(payload.DepositToAccountRef.value).toBe("42");
    expect(payload.Line).toHaveLength(4);
    // Fee JE line carries its TxnLineId; payment line does not.
    expect(payload.Line[2].LinkedTxn[0]).toMatchObject({ TxnType: "JournalEntry", TxnLineId: "1" });
    expect(payload.Line[0].LinkedTxn[0].TxnLineId).toBeUndefined();
    expect(depositTotalCents(payload)).toBe(101741);
  });
});
