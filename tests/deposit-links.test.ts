import { describe, it, expect } from "vitest";
import { indexDepositLinks, indexDepositTotals, depositLinkKey, depositHolding } from "@/lib/qbo/deposits";

// Fictional deposits shaped like QBO's Deposit query rows.
const DEPOSITS = [
  {
    Id: "900",
    Line: [
      { Amount: 100, LinkedTxn: [{ TxnType: "Payment", TxnId: "11", TxnLineId: "0" }] },
      { Amount: -3.2, LinkedTxn: [{ TxnType: "JournalEntry", TxnId: "70", TxnLineId: "1" }] },
      { Amount: -25, LinkedTxn: [{ TxnType: "RefundReceipt", TxnId: "80" }] },
      { Amount: -1, DepositLineDetail: { AccountRef: { value: "5" } } },
    ],
  },
  {
    Id: "901",
    Line: [{ Amount: -4.1, LinkedTxn: [{ TxnType: "JournalEntry", TxnId: "71", TxnLineId: "0" }] }],
  },
];

describe("depositLinkKey", () => {
  it("treats a Payment's TxnLineId 0 as the whole payment", () => {
    expect(depositLinkKey("Payment", "11", "0")).toBe("Payment:11:");
    expect(depositLinkKey("Payment", "11", null)).toBe("Payment:11:");
  });
  it("keeps journal-entry line ids, including 0", () => {
    expect(depositLinkKey("JournalEntry", "70", "1")).toBe("JournalEntry:70:1");
    expect(depositLinkKey("JournalEntry", "71", "0")).toBe("JournalEntry:71:0");
  });
});

describe("indexDepositLinks / depositHolding", () => {
  const links = indexDepositLinks(DEPOSITS);

  it("finds payments by id", () => {
    expect(depositHolding(links, "Payment", "11")).toBe("900");
    expect(depositHolding(links, "Payment", "12")).toBeUndefined();
  });

  it("matches a fee journal entry only on the deposited line", () => {
    expect(depositHolding(links, "JournalEntry", "70", "1")).toBe("900");
    expect(depositHolding(links, "JournalEntry", "70", "2")).toBeUndefined();
    expect(depositHolding(links, "JournalEntry", "71", "0")).toBe("901");
  });

  it("a link without a line covers every line of that transaction", () => {
    expect(depositHolding(links, "RefundReceipt", "80")).toBe("900");
    expect(depositHolding(links, "RefundReceipt", "80", "3")).toBe("900");
  });

  it("does not confuse transaction types sharing an id", () => {
    expect(depositHolding(links, "Payment", "70")).toBeUndefined();
  });

  it("ignores plain account lines and empty input", () => {
    expect(links.size).toBe(4);
    expect(indexDepositLinks([]).size).toBe(0);
    expect(indexDepositLinks([{ Id: "1" }]).size).toBe(0);
  });
});

describe("indexDepositTotals", () => {
  it("maps each deposit id to its total in cents", () => {
    const totals = indexDepositTotals([
      { Id: "900", TotalAmt: 1470.15 },
      { Id: "901", TotalAmt: 0.1 + 0.2 },
      { Id: "902" },
    ]);
    expect(totals.get("900")).toBe(147015);
    expect(totals.get("901")).toBe(30);
    expect(totals.has("902")).toBe(false);
  });
});
