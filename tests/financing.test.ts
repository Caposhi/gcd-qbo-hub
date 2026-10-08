import { describe, it, expect } from "vitest";
import {
  isNonCardMethod,
  cardMethodRank,
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

  it("Snap: needs the Snap Finance method label — its fee band is too loose to match on amount alone", () => {
    const bare = pool.map((p) => ({ ...p, methodText: "" }));
    const m = matchFinancingDeposit(dep("snap", "2026-03-04", 398.56), bare);
    expect(m.kind).toBe("review");
    expect(m.kind === "review" && m.reason).toMatch(/labelled as Snap Finance/);
  });

  it("never builds a payout from card payments (dry-run regression: two Visa payments 'fit' a Snap payout)", () => {
    // The real Snap payment is missing; two Visa payments happen to sum into Snap's fee band.
    const cards = [pay("v1", 240.75, "2026-03-02", "A, A", "Visa"), pay("v2", 159.0, "2026-03-03", "B, B", "Visa")];
    expect(matchFinancingDeposit(dep("snap", "2026-03-04", 398.56), cards).kind).toBe("review");
  });

  it("Bosch: a same-amount Koalafi or card payment is excluded; the Financing-labelled one matches", () => {
    const m = matchFinancingDeposit(dep("cfna", "2026-03-09", 980.1), [
      pay("koal", 1000.0, "2026-03-05", "X, X", "Koalifi"),
      pay("visa", 1000.0, "2026-03-05", "Y, Y", "Visa"),
      pay("other", 1000.0, "2026-03-05", "Z, Z", "Other"),
      pay("bosch", 1000.0, "2026-03-05", "Park, Kim", "Financing (i.e. snap, synchrony...) (Bosch CNFCA)"),
    ]);
    expect(m).toMatchObject({ kind: "matched", paymentIds: ["bosch"] });
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

  it("does not guess between identical unlabelled payments (one may be a reversed entry)", () => {
    // Live 09/10: two "Other" payments were each reversed by a negative entry;
    // the real Bosch payment was the one labelled "Financing".
    const same = [pay("o1", 1000.0, "2026-03-05", "Park, Kim", "Other"), pay("o2", 1000.0, "2026-03-05", "Park, Kim", "Other")];
    expect(matchFinancingDeposit(dep("cfna", "2026-03-09", 980.1), same).kind).toBe("review");
  });

  it("still refuses to guess between different customers", () => {
    const two = [pay("x", 1000.0, "2026-03-05", "Park, Kim", "Other"), pay("y", 1000.0, "2026-03-05", "Lee, Sam", "Other")];
    expect(matchFinancingDeposit(dep("cfna", "2026-03-09", 980.1), two).kind).toBe("review");
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

describe("Zelle customer payments", () => {
  const ZELLE = [
    "Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #",
    `CREDIT,03/10/2026,"Zelle payment from ANA RIVERA BACx1y2z3w4",320.15,PARTNERFI_TO_CHASE,1000.00,,`,
    `CREDIT,03/11/2026,"Zelle payment from EXAMPLE STUDIES CONSORTIUM INC 30500000001",2500.00,QUICKPAY_CREDIT,3500.00,,`,
    `CREDIT,03/12/2026,"Zelle payment from SAM LEE WFCT00000001",2.00,PARTNERFI_TO_CHASE,3502.00,,`,
  ].join("\n");

  it("reads the sender and the bank reference from a Zelle line (both reference styles)", () => {
    const deps = lenderDeposits(parseChaseActivity(ZELLE));
    expect(deps.map((d) => [d.lender, d.indName, d.trace])).toEqual([
      ["zelle", "ANA RIVERA", "BACx1y2z3w4"],
      ["zelle", "EXAMPLE STUDIES CONSORTIUM INC", "30500000001"],
      ["zelle", "SAM LEE", "WFCT00000001"],
    ]);
  });

  const zdep = (date: string, amount: number, indName: string): LenderDeposit => ({
    lender: "zelle",
    date,
    amount,
    description: "",
    origCoName: "",
    trace: "z",
    indName,
  });
  const zpay = (id: string, amount: number, date: string, customerName: string, methodText = "Zelle"): FinancingCandidate => ({
    id,
    amount,
    date,
    customerName,
    methodText,
  });

  it("matches the customer's own Zelle: exact amount, same day, name on the line", () => {
    const m = matchFinancingDeposit(zdep("2026-03-10", 320.15, "ANA RIVERA"), [
      zpay("z1", 320.15, "2026-03-10", "Rivera, Ana"),
      zpay("card", 320.15, "2026-03-10", "Other, Person", "Visa"),
    ]);
    expect(m).toMatchObject({ kind: "matched", paymentIds: ["z1"], feeCents: 0 });
  });

  it("a name match wins over another Zelle payment of the same amount", () => {
    const m = matchFinancingDeposit(zdep("2026-03-10", 320.15, "ANA RIVERA"), [
      zpay("other", 320.15, "2026-03-10", "Stone, Bo"),
      zpay("z1", 320.15, "2026-03-10", "Rivera, Ana"),
    ]);
    expect(m).toMatchObject({ kind: "matched", paymentIds: ["z1"] });
  });

  it("a company paying for a customer matches on the Zelle method when it's the only one", () => {
    const m = matchFinancingDeposit(zdep("2026-03-11", 2500, "EXAMPLE STUDIES CONSORTIUM INC"), [
      zpay("z2", 2500, "2026-03-11", "Mbeki, Tom"),
      zpay("card", 2500, "2026-03-11", "Other, Person", "Mastercard"),
    ]);
    expect(m).toMatchObject({ kind: "matched", paymentIds: ["z2"] });
    expect(m.kind === "matched" && m.basis).toContain("payment method names the lender");
  });

  it("…but without a name or a Zelle method there's nothing to go on — review", () => {
    const m = matchFinancingDeposit(zdep("2026-03-11", 2500, "EXAMPLE STUDIES CONSORTIUM INC"), [
      zpay("card", 2500, "2026-03-11", "Mbeki, Tom", ""),
    ]);
    expect(m.kind).toBe("review");
  });

  it("accepts a payment Tekmetric recorded a business day after the money arrived", () => {
    const m = matchFinancingDeposit(zdep("2026-03-13", 320.15, "ANA RIVERA"), [zpay("z1", 320.15, "2026-03-16", "Rivera, Ana")]);
    expect(m).toMatchObject({ kind: "matched", paymentIds: ["z1"] });
    expect(m.kind === "matched" && m.basis).toContain("recorded 1 business day(s) after the deposit");
  });

  it("requires the exact amount — Zelle has no fee", () => {
    const m = matchFinancingDeposit(zdep("2026-03-10", 320.15, "ANA RIVERA"), [zpay("z1", 320.16, "2026-03-10", "Rivera, Ana")]);
    expect(m.kind).toBe("review");
  });

  it("a Zelle that isn't a repair-order payment goes to review with the Tekmetric hint", () => {
    const m = matchFinancingDeposit(zdep("2026-03-12", 2, "SAM LEE"), []);
    expect(m.kind).toBe("review");
    expect(m.kind === "review" && m.reason).toMatch(/Accounting Link shows the Zelle payment as Unapproved/);
  });
});

describe("card-payout candidate methods", () => {
  it("rules out lender, Zelle, cash, check, warranty and bad-debt payments", () => {
    for (const m of ["Financing (i.e. snap, synchrony...)", "Koalifi", "Snap Finance", "Zelle", "Cash", "Check", "PAC WARRANTY", "Bad Debt - Comeback"])
      expect(isNonCardMethod(m)).toBe(true);
  });
  it("keeps card brands and Other (a Stripe charge can be recorded as Other)", () => {
    for (const m of ["Visa", "Mastercard", "American Express", "Discover", "Other", ""]) expect(isNonCardMethod(m)).toBe(false);
  });
  it("prefers a card-brand label over Other", () => {
    expect(cardMethodRank("Visa")).toBeLessThan(cardMethodRank("Other"));
    expect(cardMethodRank("")).toBe(cardMethodRank("Other"));
  });
});
