import { describe, it, expect } from "vitest";
import {
  parseStripePayouts,
  parseStripeCharges,
  reconstructTekmetricPayouts,
  chargeSetTotals,
  backfillPayoutFromCharges,
} from "@/lib/deposits/stripe";
import { detectFileType, buildProposalsFromFiles } from "@/lib/deposits/ingest";

const PAYOUTS_HEADER = "id,Amount,Created (UTC),Currency,Livemode,Arrival Date (UTC),Status";
const CHARGES_HEADER = "id,Created date (UTC),Amount,Amount Refunded,Fee,Status";

function payoutRow(id: string, amount: number, arrival: string): string {
  return `${id},${amount},${arrival} 00:00,usd,true,${arrival} 00:00,paid`;
}

function chargeRow(id: string, created: string, amount: number, refunded: number, fee: number): string {
  return `${id},${created} 12:00:00,${amount},${refunded},${fee},Paid`;
}

describe("parseStripeCharges — refund handling (real-world bug, §20)", () => {
  it("subtracts Amount Refunded from a charge's net contribution", () => {
    const csv = [CHARGES_HEADER, chargeRow("py_1", "2026-08-05", 2037.87, 1728.05, 44.12)].join("\n");
    const [charge] = parseStripeCharges(csv);
    // Before the fix: net = gross - fee = 1993.75, silently ignoring the refund.
    expect(charge.net).toBeCloseTo(2037.87 - 44.12 - 1728.05, 2);
  });

  it("an unrefunded charge is unaffected", () => {
    const csv = [CHARGES_HEADER, chargeRow("py_1", "2026-08-05", 100, 0, 2.5)].join("\n");
    const [charge] = parseStripeCharges(csv);
    expect(charge.net).toBeCloseTo(97.5, 2);
  });
});

describe("reconstructTekmetricPayouts — the August cascade (real-shape data, §20)", () => {
  // Reproduces the actual failure mode from the investigation: a partially-
  // refunded charge on 8/5 broke payout 8/6, and — because the FIFO
  // reconstruction has no error recovery — every payout after it also
  // failed for the rest of the month, even though their own charges were
  // perfectly fine in isolation. (py_a/b/c and py_d/e are the real 8/3 and
  // 8/4 charge sets from the investigation, which do tie out exactly.)
  const payoutsCsv = [
    PAYOUTS_HEADER,
    payoutRow("po_04", 1733.11, "2026-08-04"),
    payoutRow("po_05", 11476.91, "2026-08-05"),
    payoutRow("po_06", 9065.7, "2026-08-06"),
    payoutRow("po_07", 500.0, "2026-08-07"),
  ].join("\n");

  const chargesCsv = [
    CHARGES_HEADER,
    // 8/3 charges → settle into po_04 (net exactly 1733.11).
    chargeRow("py_a", "2026-08-03", 361.13, 0, 7.9),
    chargeRow("py_b", "2026-08-03", 1147.87, 0, 24.89),
    chargeRow("py_c", "2026-08-03", 262.67, 0, 5.77),
    // 8/4 charges → settle into po_05 (net exactly 11476.91).
    chargeRow("py_d", "2026-08-04", 2166.81, 0, 46.9),
    chargeRow("py_e", "2026-08-04", 9588.11, 0, 231.11), // net 9357.00
    // 8/5 charges → settle into po_06 (net exactly 9065.70), one refunded.
    chargeRow("py_f", "2026-08-05", 9000.0, 0, 200.0), // net 8800.00
    chargeRow("py_g", "2026-08-05", 2037.87, 1728.05, 44.12), // net 265.70
    // 8/6 charges → settle into po_07 (net exactly 500.00).
    chargeRow("py_h", "2026-08-06", 510.0, 0, 10.0),
  ].join("\n");

  it("without the refund accounted for, the cascade breaks every payout from the refund onward", () => {
    // Hand-verified pre-fix arithmetic: ignoring py_g's refund, its net is
    // 1993.75 instead of 265.70, so po_06's bucket (8800.00 + 1993.75 =
    // 10793.75) overshoots its 9065.70 target and never resolves.
    const wrongCharges = parseStripeCharges(chargesCsv).map((c) =>
      c.id === "py_g" ? { ...c, net: 2037.87 - 44.12 } : c
    );
    const payouts = parseStripePayouts(payoutsCsv);
    const result = reconstructTekmetricPayouts(payouts, wrongCharges);
    // po_04 and po_05 still resolve (they're before the bad charge)...
    expect(result.deposits.map((d) => d.settlementDate)).toEqual(["2026-08-04", "2026-08-05"]);
    // ...but po_06 AND po_07 both fail, even though po_07's own charge
    // (py_h) is perfectly fine on its own — this is the cascade, not an
    // isolated miss: the leftover, un-consumed pile from po_06's failed
    // attempt swamps po_07's much smaller target too.
    expect(result.unresolved.map((u) => u.payout.id)).toEqual(["po_06", "po_07"]);
  });

  it("with the refund correctly subtracted, every payout for the rest of the month resolves", () => {
    const charges = parseStripeCharges(chargesCsv); // real parser, refund-aware
    const payouts = parseStripePayouts(payoutsCsv);
    const result = reconstructTekmetricPayouts(payouts, charges);
    expect(result.unresolved).toEqual([]);
    expect(result.deposits.map((d) => d.settlementDate)).toEqual([
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
    ]);
    const po06 = result.deposits.find((d) => d.settlementDate === "2026-08-06")!;
    expect(po06.net).toBeCloseTo(9065.7, 2);
    expect(po06.lines).toHaveLength(2); // py_f and py_g
  });
});

describe("per-payout transfers export (Type/ID/Created/Amount/Fees/Net)", () => {
  // The real file the owner exported for the stuck 2026-08-03 payout: 14 charges
  // dated 07-31 that net to exactly 15,267.32.
  const TRANSFERS = `Type,ID,Created,Description,Amount,Currency,Converted Amount,Fees,Net,Converted Currency,Details,Customer ID,Customer Email,Customer Name
Charge,py_a,2026-07-31 14:22,,703.39,usd,703.39,15.29,688.10,usd,
Charge,py_b,2026-07-31 15:10,,1547.23,usd,1547.23,77.51,1469.72,usd,
Charge,py_c,2026-07-31 15:18,,251.46,usd,251.46,12.85,238.61,usd,
Charge,py_d,2026-07-31 16:04,,507.13,usd,507.13,11.05,496.08,usd,
Charge,py_e,2026-07-31 16:05,,240.75,usd,240.75,5.30,235.45,usd,
Charge,py_f,2026-07-31 17:23,,1230.50,usd,1230.50,26.68,1203.82,usd,
Charge,py_g,2026-07-31 18:00,,235.10,usd,235.10,5.18,229.92,usd,
Charge,py_h,2026-07-31 18:22,,691.66,usd,691.66,15.04,676.62,usd,
Charge,py_i,2026-07-31 18:39,,490.81,usd,490.81,15.61,475.20,usd,
Charge,py_j,2026-07-31 19:03,,481.50,usd,481.50,15.32,466.18,usd,
Charge,py_k,2026-07-31 19:29,,392.91,usd,392.91,8.59,384.32,usd,
Charge,py_l,2026-07-31 20:03,,1890.03,usd,1890.03,59.82,1830.21,usd,
Charge,py_m,2026-07-31 20:33,,2338.23,usd,2338.23,73.99,2264.24,usd,
Charge,py_n,2026-07-31 20:36,,4759.35,usd,4759.35,150.50,4608.85,usd,
`;

  it("is detected as a charges file (it used to fall through to unknown)", () => {
    expect(detectFileType(TRANSFERS)).toBe("stripe_charges");
  });

  it("parses Fees/Created/ID and totals to the payout net", () => {
    const charges = parseStripeCharges(TRANSFERS);
    expect(charges).toHaveLength(14);
    expect(charges[0].createdDate).toBe("2026-07-31");
    expect(charges.some((c) => c.id === "py_n")).toBe(true);
    const t = chargeSetTotals(charges);
    expect(t.gross).toBeCloseTo(15760.05, 2);
    expect(t.fee).toBeCloseTo(492.73, 2);
    expect(t.net).toBeCloseTo(15267.32, 2);
  });

  it("skips non-charge rows (payout/transfer/refund) in a balance-transaction export", () => {
    const mixed =
      TRANSFERS +
      "Payout,po_x,2026-08-03 00:04,STRIPE PAYOUT,-15267.32,usd,-15267.32,0.00,-15267.32,usd,\n";
    const charges = parseStripeCharges(mixed);
    expect(charges).toHaveLength(14);
    expect(chargeSetTotals(charges).net).toBeCloseTo(15267.32, 2);
  });

  it("back-fills the one payout whose net it ties to", () => {
    const charges = parseStripeCharges(TRANSFERS);
    const back = backfillPayoutFromCharges(charges, [
      { id: "p1", sourceRef: "111000028939568", settlementDate: "2026-08-03", netAmount: 15267.32 },
      { id: "p2", sourceRef: "other", settlementDate: "2026-08-04", netAmount: 1733.11 },
    ]);
    expect(back.payoutId).toBe("p1");
    expect(back.matchCount).toBe(1);
    expect(back.deposit).not.toBeNull();
    // Reconciles onto the EXISTING row: same sourceRef + settlement date.
    expect(back.deposit!.sourceRef).toBe("111000028939568");
    expect(back.deposit!.settlementDate).toBe("2026-08-03");
    expect(back.deposit!.lines).toHaveLength(14);
    expect(back.deposit!.gross).toBeCloseTo(15760.05, 2);
    expect(back.deposit!.fee).toBeCloseTo(492.73, 2);
    // gross − fee must equal the payout that actually hit the bank.
    expect(back.deposit!.gross - back.deposit!.fee).toBeCloseTo(15267.32, 2);
  });

  it("declines rather than guessing when two payouts share the net", () => {
    const charges = parseStripeCharges(TRANSFERS);
    const back = backfillPayoutFromCharges(charges, [
      { id: "p1", sourceRef: "a", settlementDate: "2026-08-03", netAmount: 15267.32 },
      { id: "p2", sourceRef: "b", settlementDate: "2026-08-10", netAmount: 15267.32 },
    ]);
    expect(back.deposit).toBeNull();
    expect(back.matchCount).toBe(2);
  });

  it("declines when the set doesn't tie to any waiting payout", () => {
    const charges = parseStripeCharges(TRANSFERS);
    const back = backfillPayoutFromCharges(charges, [
      { id: "p1", sourceRef: "a", settlementDate: "2026-08-03", netAmount: 999.99 },
    ]);
    expect(back.deposit).toBeNull();
    expect(back.matchCount).toBe(0);
    expect(back.totals.net).toBeCloseTo(15267.32, 2);
  });

  it("reports an unrecognized file instead of silently doing nothing", () => {
    const res = buildProposalsFromFiles([{ name: "mystery.csv", text: "a,b,c\n1,2,3\n" }]);
    expect(res.unknown).toEqual(["mystery.csv"]);
    expect(res.notes.join(" ")).toContain("mystery.csv");
    expect(res.notes.join(" ")).toMatch(/not recognized/i);
  });

  it("exposes charges for back-fill when dropped without a payouts file", () => {
    const res = buildProposalsFromFiles([{ name: "transfers.csv", text: TRANSFERS }]);
    expect(res.tekmetric).toBeNull();
    expect(res.chargesOnly).toHaveLength(14);
    expect(res.unknown).toEqual([]);
  });
});
