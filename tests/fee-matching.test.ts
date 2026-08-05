import { describe, it, expect } from "vitest";
import { customerMatchKey, matchFees, matchFeesByCustomer, type FeeJournalEntry } from "@/lib/qbo/journal-entries";

const daysApart = (a: string, b: string) =>
  Math.abs((new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86400000);

function je(id: string, customerName: string, amount: number, date: string): FeeJournalEntry {
  return { jeId: id, ufLineId: `${id}-0`, amount, customerName, memo: "", date };
}

describe("customerMatchKey", () => {
  it("is order-insensitive on name tokens", () => {
    expect(customerMatchKey("Castillo, Junior")).toBe(customerMatchKey("Junior Castillo"));
    expect(customerMatchKey("PAKNIS, ASHLEY")).toBe(customerMatchKey("Ashley Paknis"));
  });
  it("ignores punctuation and case", () => {
    expect(customerMatchKey("O'Brien, Sean")).toBe(customerMatchKey("sean obrien"));
  });
  it("keeps different customers distinct", () => {
    expect(customerMatchKey("Castillo, Junior")).not.toBe(customerMatchKey("Castillo, Maria"));
  });
  it("is empty for blank input", () => {
    expect(customerMatchKey("")).toBe("");
  });
});

describe("matchFeesByCustomer", () => {
  it("matches a fee JE stored First-Last to a payment customer stored Last, First", () => {
    const fees = [je("1", "Junior Castillo", 12.34, "2026-07-20")];
    const { linked, missing } = matchFeesByCustomer(fees, ["Castillo, Junior"], "2026-07-20", new Set(), daysApart);
    expect(linked.map((l) => l.jeId)).toEqual(["1"]);
    expect(missing).toEqual([]);
  });

  it("reports customers whose fee JE is genuinely absent", () => {
    const fees = [je("1", "Ashley Paknis", 9.0, "2026-07-20")];
    const { linked, missing } = matchFeesByCustomer(
      fees,
      ["Paknis, Ashley", "Castillo, Junior"],
      "2026-07-20",
      new Set(),
      daysApart
    );
    expect(linked.map((l) => l.jeId)).toEqual(["1"]);
    expect(missing).toEqual(["Castillo, Junior"]);
  });

  it("de-dupes: one fee JE backs only one payment", () => {
    const fees = [je("1", "Junior Castillo", 5, "2026-07-20")];
    const used = new Set<string>();
    const { linked, missing } = matchFeesByCustomer(
      fees,
      ["Castillo, Junior", "Castillo, Junior"],
      "2026-07-20",
      used,
      daysApart
    );
    expect(linked).toHaveLength(1);
    expect(missing).toEqual(["Castillo, Junior"]);
  });

  it("respects the date window", () => {
    const fees = [je("1", "Junior Castillo", 5, "2026-06-01")];
    const { linked, missing } = matchFeesByCustomer(fees, ["Castillo, Junior"], "2026-07-20", new Set(), daysApart);
    expect(linked).toEqual([]);
    expect(missing).toEqual(["Castillo, Junior"]);
  });
});

describe("matchFees — amount fallback", () => {
  it("falls back to the exact fee amount when the customer name doesn't match at all", () => {
    // The JE is booked under a totally different name in QBO, but its amount is
    // the charge's known fee (43.60) — so it's still found.
    const fees = [je("1", "Some Other Name LLC", 43.6, "2026-07-17")];
    const { linked, missing, amountMatched } = matchFees(
      fees,
      [{ customer: "Castillo, Junior", feeAmount: 43.6 }],
      "2026-07-20",
      new Set(),
      daysApart
    );
    expect(linked.map((l) => l.jeId)).toEqual(["1"]);
    expect(missing).toEqual([]);
    expect(amountMatched).toBe(1);
  });

  it("prefers the customer-name match over the amount fallback", () => {
    const fees = [je("byname", "Junior Castillo", 43.6, "2026-07-18"), je("byamt", "Wrong Person", 43.6, "2026-07-17")];
    const { linked, amountMatched } = matchFees(
      fees,
      [{ customer: "Castillo, Junior", feeAmount: 43.6 }],
      "2026-07-20",
      new Set(),
      daysApart
    );
    expect(linked.map((l) => l.jeId)).toEqual(["byname"]);
    expect(amountMatched).toBe(0);
  });

  it("still reports missing when neither name nor amount matches", () => {
    const fees = [je("1", "Someone Else", 9.99, "2026-07-17")];
    const { linked, missing } = matchFees(
      fees,
      [{ customer: "Castillo, Junior", feeAmount: 43.6 }],
      "2026-07-20",
      new Set(),
      daysApart
    );
    expect(linked).toEqual([]);
    expect(missing).toEqual(["Castillo, Junior"]);
  });
});
