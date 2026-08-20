import { describe, it, expect } from "vitest";
import { parseStripePayouts, parseStripeCharges, reconstructTekmetricPayouts } from "@/lib/deposits/stripe";

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
