import { describe, it, expect } from "vitest";
import { payoutKey, buildPayoutIndexes, resolveMatch, findDuplicateIds, type MatchCandidate } from "@/lib/deposits/reconcile-match";

interface Row extends MatchCandidate {
  id: string;
}

function row(id: string, opts: Partial<Row> = {}): Row {
  return {
    id,
    processor: "tekmetric",
    sourceRef: null,
    settlementDate: "2026-08-20",
    netAmount: 100,
    qboDepositId: null,
    ...opts,
  };
}

describe("resolveMatch — sourceRef-instability duplicate bug (real-world, Sept 1 CSV set)", () => {
  it("matches directly by sourceRef when it's unchanged", () => {
    const existing = [row("r1", { sourceRef: "po_abc" })];
    const indexes = buildPayoutIndexes(existing);
    const match = resolveMatch(
      { processor: "tekmetric", sourceRef: "po_abc", settlementDate: "2026-08-20", net: 100 },
      indexes,
      new Set()
    );
    expect(match?.id).toBe("r1");
  });

  it("falls back to settlementDate+netAmount when sourceRef format changed (the reported bug)", () => {
    // The real scenario: an earlier ingest's CSV had a "Trace ID" column, so
    // the stored row's sourceRef is a bank trace id. A later export of the
    // SAME real payout has no Trace ID column, so the fresh parse's
    // sourceRef falls back to the raw `po_…` id — a different string.
    // Without the fallback, this reads as a brand-new payout and creates a
    // phantom duplicate "needs review" row next to the real "created" one.
    const existing = [row("r1", { sourceRef: "111000022160628", settlementDate: "2026-08-20", netAmount: 7367.27 })];
    const indexes = buildPayoutIndexes(existing);
    const match = resolveMatch(
      { processor: "tekmetric", sourceRef: "po_1U6JjR2YMG3jLolZnOWgAo8W", settlementDate: "2026-08-20", net: 7367.27 },
      indexes,
      new Set()
    );
    expect(match?.id).toBe("r1");
  });

  it("DOES fall back onto an already-posted row (real-world bug: a posted payout re-parsed under a new sourceRef format created a duplicate)", () => {
    // This is the exact screenshot bug: the 2026-08-20 payout was posted
    // under sourceRef "111000022160628" (a bank trace id, from an export
    // that had a Trace ID column). A later re-ingest's payouts_1.csv has no
    // Trace ID column, so the fresh parse's sourceRef falls back to the raw
    // po_… id. The OLD behavior excluded posted rows from the fallback pool
    // (reasoning: "posted history is immutable, never a fallback target"),
    // so this fresh parse found NO match at all and created a second,
    // duplicate "needs review" row for the same real payout. Posted rows
    // must be valid fallback targets — the caller only ever SKIPS a posted
    // match (see reconcileParsedPayouts), it never overwrites it, so this is
    // safe and is what actually prevents the duplicate.
    const existing = [row("r1", { sourceRef: "111000022160628", settlementDate: "2026-08-20", netAmount: 7367.27, qboDepositId: "qbo-1" })];
    const indexes = buildPayoutIndexes(existing);
    const match = resolveMatch(
      { processor: "tekmetric", sourceRef: "po_1U6JjR2YMG3jLolZnOWgAo8W", settlementDate: "2026-08-20", net: 7367.27 },
      indexes,
      new Set()
    );
    expect(match?.id).toBe("r1");
  });

  it("does not guess across an ambiguous fallback collision (two different payouts, same date+amount)", () => {
    const existing = [
      row("r1", { sourceRef: "ref-a", settlementDate: "2026-08-20", netAmount: 500 }),
      row("r2", { sourceRef: "ref-b", settlementDate: "2026-08-20", netAmount: 500 }),
    ];
    const indexes = buildPayoutIndexes(existing);
    const match = resolveMatch(
      { processor: "tekmetric", sourceRef: "ref-c", settlementDate: "2026-08-20", net: 500 },
      indexes,
      new Set()
    );
    expect(match).toBeUndefined();
  });

  it("does not guess across an ambiguous collision even when one candidate is posted", () => {
    const existing = [
      row("r1", { sourceRef: "ref-a", settlementDate: "2026-08-20", netAmount: 500, qboDepositId: "qbo-1" }),
      row("r2", { sourceRef: "ref-b", settlementDate: "2026-08-20", netAmount: 500 }),
    ];
    const indexes = buildPayoutIndexes(existing);
    const match = resolveMatch(
      { processor: "tekmetric", sourceRef: "ref-c", settlementDate: "2026-08-20", net: 500 },
      indexes,
      new Set()
    );
    expect(match).toBeUndefined();
  });

  it("a fallback key is claimed only once per run — a second differently-keyed payout with the same fallback key doesn't also match it", () => {
    const existing = [row("r1", { sourceRef: "old-ref", settlementDate: "2026-08-20", netAmount: 100 })];
    const indexes = buildPayoutIndexes(existing);
    const claimed = new Set<string>();
    const first = resolveMatch({ processor: "tekmetric", sourceRef: "new-ref-1", settlementDate: "2026-08-20", net: 100 }, indexes, claimed);
    const second = resolveMatch({ processor: "tekmetric", sourceRef: "new-ref-2", settlementDate: "2026-08-20", net: 100 }, indexes, claimed);
    expect(first?.id).toBe("r1");
    expect(second).toBeUndefined();
  });

  it("a genuinely new payout (different date+amount, no key match) is not matched to anything", () => {
    const existing = [row("r1", { sourceRef: "ref-a", settlementDate: "2026-08-20", netAmount: 100 })];
    const indexes = buildPayoutIndexes(existing);
    const match = resolveMatch(
      { processor: "tekmetric", sourceRef: "ref-z", settlementDate: "2026-08-21", net: 250 },
      indexes,
      new Set()
    );
    expect(match).toBeUndefined();
  });
});

describe("findDuplicateIds — cleanup of a duplicate already sitting in the DB (real-world, Sept 1 report)", () => {
  it("removes a needs_review duplicate created for an already-posted payout under a different sourceRef", () => {
    // Exact screenshot scenario: the real 2026-08-20 payout was posted
    // ("created") under the bank trace id, then a later re-ingest (before
    // the reconcile-time fix landed) created a second "needs_review" row
    // under the raw po_… id because that export had no Trace ID column.
    const posted = row("posted-1", {
      id: "posted-1",
      sourceRef: "111000022160628",
      settlementDate: "2026-08-20",
      netAmount: 7367.27,
      qboDepositId: "qbo-dep-1",
    });
    const duplicate = row("dup-1", {
      id: "dup-1",
      sourceRef: "po_1U6JjR2YMG3jLolZnOWgAo8W",
      settlementDate: "2026-08-20",
      netAmount: 7367.27,
      qboDepositId: null,
    });
    const dupeIds = findDuplicateIds([posted, duplicate]); // oldest first: posted was created earlier
    expect(dupeIds).toEqual(["dup-1"]);
  });

  it("never removes a posted row, even if it were somehow processed after its duplicate", () => {
    const duplicate = row("dup-1", { id: "dup-1", sourceRef: "po_new", settlementDate: "2026-08-20", netAmount: 7367.27, qboDepositId: null });
    const posted = row("posted-1", { id: "posted-1", sourceRef: "trace-1", settlementDate: "2026-08-20", netAmount: 7367.27, qboDepositId: "qbo-dep-1" });
    // Posted processed second (unusual ordering, but the guard must hold regardless).
    const dupeIds = findDuplicateIds([duplicate, posted]);
    expect(dupeIds).not.toContain("posted-1");
  });

  it("leaves distinct payouts (different date or amount) alone", () => {
    const a = row("a", { id: "a", sourceRef: "ref-a", settlementDate: "2026-08-20", netAmount: 100 });
    const b = row("b", { id: "b", sourceRef: "ref-b", settlementDate: "2026-08-21", netAmount: 100 });
    const c = row("c", { id: "c", sourceRef: "ref-c", settlementDate: "2026-08-20", netAmount: 200 });
    expect(findDuplicateIds([a, b, c])).toEqual([]);
  });
});

describe("payoutKey", () => {
  it("keys by processor+sourceRef when sourceRef is present", () => {
    expect(payoutKey("tekmetric", "po_1", "2026-08-20", 100)).toBe("tekmetric|po_1");
  });

  it("falls back to processor+date+cents when sourceRef is null", () => {
    expect(payoutKey("paymentech", null, "2026-08-20", 123.456)).toBe("paymentech|2026-08-20|12346");
  });
});
