/**
 * Chase Paymentech settlement parsing → expected bank deposits.
 *
 * Chase does NOT net fees daily (they're billed monthly), so a payout deposit =
 * the exact sum of that settlement day's gross card charges. A single bank
 * deposit can bundle MULTIPLE batch numbers from the same day, so we group by
 * BATCH DATE, not batch number (verified against real data: 7/08 batches
 * 189001+189002 = one $4,871.34 deposit on 7/09).
 */
import { parseCsv } from "./csv";
import { parseCurrency } from "@/lib/cashsheet/amount";
import type { ExpectedDeposit, PayoutLine } from "./types";
import { toCents } from "./types";

/** "7/09/2026" | "07/9/2026" | "2026-07-09" → "2026-07-09". */
export function normalizeDate(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (s === "") return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) {
    const mm = us[1].padStart(2, "0");
    const dd = us[2].padStart(2, "0");
    return `${us[3]}-${mm}-${dd}`;
  }
  return null;
}

/** Find a header key case/space-insensitively (exports vary in casing). */
function pick(row: Record<string, string>, ...names: string[]): string {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const wanted = names.map(norm);
  for (const key of Object.keys(row)) {
    if (wanted.includes(norm(key))) return row[key];
  }
  return "";
}

export function parsePaymentechCsv(text: string): ExpectedDeposit[] {
  const rows = parseCsv(text);
  // Group rows by batch date.
  const byDate = new Map<string, PayoutLine[]>();
  const batchesByDate = new Map<string, Set<string>>();

  for (const row of rows) {
    const amount = parseCurrency(pick(row, "Amount"));
    if (amount === null) continue; // skip malformed lines
    const batchDate = normalizeDate(pick(row, "Batch date", "Batch Date"));
    const txnDate = normalizeDate(pick(row, "Date"));
    const key = batchDate ?? txnDate;
    if (!key) continue;
    const brand = pick(row, "Card brand", "Card Brand") || "Unknown";
    const seq = pick(row, "Batch sequence #", "Batch sequence", "Original transaction ref. #");
    const batchNo = pick(row, "Batch #", "Batch");

    if (!byDate.has(key)) {
      byDate.set(key, []);
      batchesByDate.set(key, new Set());
    }
    byDate.get(key)!.push({ amount, brand, ref: seq || undefined });
    if (batchNo) batchesByDate.get(key)!.add(batchNo);
  }

  const deposits: ExpectedDeposit[] = [];
  for (const [settlementDate, lines] of byDate) {
    const grossCents = lines.reduce((s, l) => s + toCents(l.amount), 0);
    const gross = grossCents / 100;
    deposits.push({
      processor: "paymentech",
      settlementDate,
      gross,
      fee: 0, // Chase fees billed monthly — never netted from a daily payout
      net: gross,
      lines,
      sourceRef: [...(batchesByDate.get(settlementDate) ?? [])].sort().join("+") || undefined,
    });
  }
  deposits.sort((a, b) => a.settlementDate.localeCompare(b.settlementDate));
  return deposits;
}
