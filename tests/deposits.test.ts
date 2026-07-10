import { describe, it, expect } from "vitest";
import { parsePaymentechCsv, normalizeDate } from "@/lib/deposits/paymentech";
import { buildTekmetricDeposit, payoutTiesOut } from "@/lib/deposits/tekmetric";
import { classifyBankLine } from "@/lib/deposits/routing";
import { reconcileDeposit } from "@/lib/deposits/reconcile";
import { parseCsv, stripGuard } from "@/lib/deposits/csv";
import { buildDepositPayload, depositTotalCents } from "@/lib/deposits/qbo-deposit";
import {
  parseStripePayouts,
  parseStripeCharges,
  reconstructTekmetricPayouts,
} from "@/lib/deposits/stripe";
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

// Real Stripe/Tekmetric July exports (trimmed to the columns we use).
const STRIPE_PAYOUTS = `id,Amount,Created (UTC),Currency,Livemode,Arrival Date (UTC),Source Type,Destination,Status,Type,Method,Description,Balance Transaction,Failure Balance Transaction,Failure Message,Failure Code,Statement Descriptor,Trace ID,Trace ID Status,Destination Name,Destination Country,Destination Last 4
po_a,3930.14,2026-07-10 00:18,usd,true,2026-07-10 00:00,card,ba_x,paid,bank_account,standard,STRIPE PAYOUT,txn_a,,,,Tekmetric Payments,091000010212946,supported,"JPMORGAN CHASE BANK, NA",US,9680
po_b,3267.46,2026-07-09 00:23,usd,true,2026-07-09 00:00,card,ba_x,paid,bank_account,standard,STRIPE PAYOUT,txn_b,,,,Tekmetric Payments,111000022875117,supported,"JPMORGAN CHASE BANK, NA",US,9680
po_c,8578.73,2026-07-03 00:17,usd,true,2026-07-03 00:00,card,ba_x,paid,bank_account,standard,STRIPE PAYOUT,txn_c,,,,Tekmetric Payments,091000010228941,supported,"JPMORGAN CHASE BANK, NA",US,9680
po_d,475.03,2026-07-02 00:14,usd,true,2026-07-02 00:00,card,ba_x,paid,bank_account,standard,STRIPE PAYOUT,txn_d,,,,Tekmetric Payments,091000019589196,supported,"JPMORGAN CHASE BANK, NA",US,9680`;

const STRIPE_CHARGES = `id,Created date (UTC),Amount,Amount Refunded,Currency,Captured,Converted Amount,Converted Amount Refunded,Converted Currency,Fee,Is Link,Mode,Payment Source Type,Status,Taxes On Fee,Application Fee,Application ID
py_01,2026-07-10 18:37:41,1061.86,0.00,usd,true,1061.86,0.00,usd,33.65,false,Live,stripe_account,Paid,0.00,33.65,ca_x
py_02,2026-07-09 19:48:17,2187.95,0.00,usd,true,2187.95,0.00,usd,69.24,false,Live,stripe_account,Paid,0.00,69.24,ca_x
py_03,2026-07-09 19:20:22,1243.64,0.00,usd,true,1243.64,0.00,usd,39.40,false,Live,stripe_account,Paid,0.00,39.40,ca_x
py_04,2026-07-09 15:54:02,627.11,0.00,usd,true,627.11,0.00,usd,19.92,false,Live,stripe_account,Paid,0.00,19.92,ca_x
py_05,2026-07-08 21:24:17,1790.59,0.00,usd,true,1790.59,0.00,usd,56.68,false,Live,stripe_account,Paid,0.00,56.68,ca_x
py_06,2026-07-08 17:49:14,354.24,0.00,usd,true,354.24,0.00,usd,11.29,false,Live,stripe_account,Paid,0.00,11.29,ca_x
py_07,2026-07-08 14:36:38,1253.45,0.00,usd,true,1253.45,0.00,usd,62.85,false,Live,stripe_account,Paid,0.00,62.85,ca_x
py_08,2026-07-02 21:37:24,361.11,0.00,usd,true,361.11,0.00,usd,11.51,false,Live,stripe_account,Paid,0.00,11.51,ca_x
py_09,2026-07-02 20:47:57,995.10,0.00,usd,true,995.10,0.00,usd,31.55,false,Live,stripe_account,Paid,0.00,31.55,ca_x
py_10,2026-07-02 20:41:39,2262.10,0.00,usd,true,2262.10,0.00,usd,71.58,false,Live,stripe_account,Paid,0.00,71.58,ca_x
py_11,2026-07-02 19:26:19,266.32,0.00,usd,true,266.32,0.00,usd,8.52,false,Live,stripe_account,Paid,0.00,8.52,ca_x
py_12,2026-07-02 17:12:22,668.74,0.00,usd,true,668.74,0.00,usd,33.67,false,Live,stripe_account,Paid,0.00,33.67,ca_x
py_13,2026-07-02 14:00:45,4402.16,0.00,usd,true,4402.16,0.00,usd,219.97,false,Live,stripe_account,Paid,0.00,219.97,ca_x
py_14,2026-07-01 20:56:41,249.99,0.00,usd,true,249.99,0.00,usd,8.00,false,Live,stripe_account,Paid,0.00,8.00,ca_x
py_15,2026-07-01 12:19:59,240.75,0.00,usd,true,240.75,0.00,usd,7.71,false,Live,stripe_account,Paid,0.00,7.71,ca_x`;

describe("Tekmetric/Stripe payout reconstruction (D+1, exact-sum)", () => {
  const payouts = parseStripePayouts(STRIPE_PAYOUTS);
  const charges = parseStripeCharges(STRIPE_CHARGES);
  const { deposits, unresolved, leftoverCharges } = reconstructTekmetricPayouts(payouts, charges);

  it("parses payouts and charges", () => {
    expect(payouts).toHaveLength(4);
    expect(charges).toHaveLength(15);
    expect(charges.find((c) => c.id === "py_15")!.net).toBe(233.04); // 240.75 - 7.71
  });

  it("reconstructs every payout to the penny from its prior-day charges", () => {
    expect(unresolved).toHaveLength(0);
    const byDate = Object.fromEntries(deposits.map((d) => [d.settlementDate, d]));
    expect(byDate["2026-07-02"].net).toBe(475.03);
    expect(byDate["2026-07-02"].lines).toHaveLength(2);
    expect(byDate["2026-07-03"].net).toBe(8578.73);
    expect(byDate["2026-07-03"].lines).toHaveLength(6);
    expect(byDate["2026-07-03"].gross).toBe(8955.53); // 8578.73 + fees
    expect(byDate["2026-07-09"].net).toBe(3267.46);
    expect(byDate["2026-07-10"].net).toBe(3930.14);
  });

  it("fee equals gross minus net for each reconstructed payout", () => {
    for (const d of deposits) {
      expect(Math.round((d.gross - d.net) * 100)).toBe(Math.round(d.fee * 100));
    }
  });

  it("leaves today's not-yet-settled charge unassigned (settles next payout)", () => {
    // py_01 (7/10) can't be in the 7/10 payout — it settles 7/11.
    expect(leftoverCharges.map((c) => c.id)).toContain("py_01");
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
