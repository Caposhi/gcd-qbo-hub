import { describe, it, expect } from "vitest";
import {
  parseChaseActivity,
  lenderDeposits,
  matchFinancingDeposit,
  businessDaysBetween,
  namesMatch,
  type FinancingCandidate,
  type LenderDeposit,
} from "@/lib/deposits/financing";
import { detectFileType, buildProposalsFromFiles } from "@/lib/deposits/ingest";

// Fictional data shaped like a real Chase "Download account activity" export.
const pad = (s: string, n: number) => s.padEnd(n, " ");
const desc = (orig: string, entry: string, trace: string, eed: string, indName: string) =>
  `ORIG CO NAME:${pad(orig, 22)} ORIG ID:0000000000 DESC DATE:       CO ENTRY DESCR:${pad(entry, 10)}SEC:CCD    ` +
  `TRACE#:${trace} EED:${eed}   IND ID:000000                       IND NAME:${indName} TRN: 0000000000TC`;
const CHASE = [
  "Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #",
  `CREDIT,03/04/2026,"${desc("QB/SNAP LOAN", "FUNDING", "111000000000001", "260304", "Example Auto - O'r 800-555-0100 CCBSNAP")}",398.56,ACH_CREDIT,1000.00,,`,
  `CREDIT,03/09/2026,"${desc("BRIDGESTONE/FIRE", "EPOSPYMNTS", "111000000000002", "260309", "0007EXAMPLE AUTO")}",980.10,ACH_CREDIT,2000.00,,`,
  `CREDIT,03/10/2026,"${desc("KOALAFI", "LEASE FUND", "111000000000003", "260310", "Rivera Ana")}",750.00,ACH_CREDIT,3000.00,,`,
  `CREDIT,03/10/2026,"${desc("Tekmetric Paymen", "Tekmetric", "111000000000004", "260310", "EXAMPLE AUTO INC")}",5000.00,ACH_CREDIT,8000.00,,`,
  `DEBIT,03/10/2026,"${desc("SOME VENDOR", "PAYMENT", "111000000000005", "260310", "EXAMPLE AUTO")}",-120.00,ACH_DEBIT,7880.00,,`,
].join("\n");

describe("Chase activity export", () => {
  it("is recognized as its own file type", () => {
    expect(detectFileType(CHASE)).toBe("chase_activity");
  });

  it("reads deposit lines with trace number and IND NAME", () => {
    const lines = parseChaseActivity(CHASE);
    expect(lines).toHaveLength(4); // the debit is ignored
    const k = lines.find((l) => l.origCoName === "KOALAFI")!;
    expect(k).toMatchObject({ date: "2026-03-10", amount: 750, trace: "111000000000003", indName: "Rivera Ana" });
  });

  it("keeps only lender deposits — Tekmetric and everything else are left alone", () => {
    const deps = lenderDeposits(parseChaseActivity(CHASE));
    expect(deps.map((d) => d.lender)).toEqual(["snap", "cfna", "koalafi"]);
  });

  it("turns lender lines into proposed financing payouts keyed by trace number", () => {
    const r = buildProposalsFromFiles([{ name: "Chase_Activity.CSV", text: CHASE }]);
    expect(r.unknown).toEqual([]);
    expect(r.financingDeposits.map((d) => [d.sourceRef, d.net, d.lines[0].brand])).toEqual([
      ["chase:111000000000001", 398.56, "snap"],
      ["chase:111000000000002", 980.1, "cfna"],
      ["chase:111000000000003", 750, "koalafi"],
    ]);
  });
});

describe("matchFinancingDeposit", () => {
  const dep = (lender: LenderDeposit["lender"], date: string, amount: number, indName: string | null = null): LenderDeposit => ({
    lender,
    date,
    amount,
    description: "",
    origCoName: "",
    trace: "t",
    indName,
  });
  const pay = (id: string, amount: number, date: string, customerName: string, methodText = ""): FinancingCandidate => ({
    id,
    amount,
    date,
    customerName,
    methodText,
  });
  // A realistic Undeposited-Funds pool: card payments of every size around the
  // financed ones, plus a reversed/re-entered pair.
  const pool = [
    pay("card1", 400.0, "2026-03-02", "Doe, Jane", "Visa"),
    pay("card2", 1000.0, "2026-03-04", "Roe, Rick", "Mastercard"),
    pay("snap1", 400.0, "2026-03-02", "Lee, Sam", "Snap Finance"),
    pay("cfna1", 1000.0, "2026-03-05", "Park, Kim", "Financing (i.e. snap, synchrony...) (Bosch CNFCA)"),
    pay("koal1", 750.0, "2026-03-05", "Rivera, Ana", "Koalifi"),
    pay("koal2", 750.0, "2026-03-05", "Stone, Bo", "Koalifi"),
  ];

  it("Bosch/CFNA: pays the payment minus exactly 1.99%", () => {
    // 1000.00 − 19.90 = 980.10, two business days later (Thu → Mon).
    const m = matchFinancingDeposit(dep("cfna", "2026-03-09", 980.1), pool);
    expect(m).toMatchObject({ kind: "matched", paymentIds: ["cfna1"], grossCents: 100000, feeCents: 1990 });
  });

  it("Bosch/CFNA: a same-amount card payment doesn't confuse it once the method names the lender", () => {
    // card2 is also 1000.00 and in the window; only cfna1 is a Bosch payment.
    const m = matchFinancingDeposit(dep("cfna", "2026-03-09", 980.1), pool);
    expect(m.kind === "matched" && m.basis).toContain("payment method names the lender");
  });

  it("Snap: a small fee within Snap's range, preferring the Snap-method payment over a same-amount card", () => {
    const m = matchFinancingDeposit(dep("snap", "2026-03-04", 398.56), pool); // 400.00 − 1.44
    expect(m).toMatchObject({ kind: "matched", paymentIds: ["snap1"], feeCents: 144 });
  });

  it("Snap: refuses to guess between two equally plausible payments when QBO has no method info", () => {
    const bare = pool.map((p) => ({ ...p, methodText: "" }));
    const m = matchFinancingDeposit(dep("snap", "2026-03-04", 398.56), bare);
    expect(m.kind).toBe("review");
    expect(m.kind === "review" && m.reason).toMatch(/2 Undeposited-Funds payments could be/);
  });

  it("Koalafi: matches on the customer named on the bank line, even with a same-amount payment for someone else", () => {
    const m = matchFinancingDeposit(dep("koalafi", "2026-03-10", 750, "Rivera Ana"), pool);
    expect(m).toMatchObject({ kind: "matched", paymentIds: ["koal1"], feeCents: 0 });
  });

  it("Koalafi: a name that matches no open payment goes to review", () => {
    const m = matchFinancingDeposit(dep("koalafi", "2026-03-10", 750, "Nobody Here"), pool);
    expect(m.kind).toBe("review");
    expect(m.kind === "review" && m.reason).toMatch(/No open Undeposited-Funds payment for "Nobody Here"/);
  });

  it("never matches a payment dated after the deposit, or too long before it", () => {
    const later = [pay("x", 1000.0, "2026-03-10", "Park, Kim", "Bosch CNFCA")];
    expect(matchFinancingDeposit(dep("cfna", "2026-03-09", 980.1), later).kind).toBe("review");
    const stale = [pay("y", 1000.0, "2026-02-20", "Park, Kim", "Bosch CNFCA")];
    expect(matchFinancingDeposit(dep("cfna", "2026-03-09", 980.1), stale).kind).toBe("review");
  });

  it("rejects a fee that doesn't fit the lender (Bosch is exactly 1.99%)", () => {
    const off = [pay("z", 1000.0, "2026-03-05", "Park, Kim", "Bosch CNFCA")];
    expect(matchFinancingDeposit(dep("cfna", "2026-03-09", 975.0), off).kind).toBe("review");
  });

  it("falls back to two payments paid out in one ACH when no single payment fits", () => {
    const two = [pay("a", 600.0, "2026-03-05", "A, A", "Bosch CNFCA"), pay("b", 400.0, "2026-03-05", "B, B", "Bosch CNFCA")];
    const m = matchFinancingDeposit(dep("cfna", "2026-03-09", 980.1), two);
    expect(m).toMatchObject({ kind: "matched", feeCents: 1990 });
    expect(m.kind === "matched" && m.paymentIds.sort()).toEqual(["a", "b"]);
  });
});

describe("helpers", () => {
  it("counts business days, skipping weekends", () => {
    expect(businessDaysBetween("2026-03-05", "2026-03-09")).toBe(2); // Thu → Mon
    expect(businessDaysBetween("2026-03-09", "2026-03-09")).toBe(0);
    expect(businessDaysBetween("2026-03-10", "2026-03-09")).toBe(-1);
  });
  it("matches names regardless of order and punctuation", () => {
    expect(namesMatch("Rivera Ana", "Rivera, Ana")).toBe(true);
    expect(namesMatch("Rivera Ana", "Ana Maria Rivera")).toBe(true);
    expect(namesMatch("Rivera Ana", "Rivera, Bob")).toBe(false);
  });
});
