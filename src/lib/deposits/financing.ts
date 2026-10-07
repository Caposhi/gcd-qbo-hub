/**
 * Customer-financing payouts (Snap Finance, Bosch card via CFNA/Bridgestone,
 * Koalafi) — the deposits no processor export covers.
 *
 * Tekmetric records a financed repair as ONE customer payment for the full
 * amount in Undeposited Funds (no fee entry). The lender later pays the shop by
 * ACH, minus its own fee, under its own name in the Chase account. Nothing ties
 * the two together, so the payment sat in Undeposited Funds and the bank line
 * looked like new income. This module reads those lender lines from a Chase
 * account-activity CSV and pairs each with the payment(s) it pays out — pure
 * logic; the server action does the QBO lookups and posting.
 *
 * Rules were verified against real payouts (Aug–Sep 2026):
 *   Bosch/CFNA  fee exactly 1.99% of the payment, paid ~2 business days later
 *   Snap        fee ~0.36% (varies by plan), paid ~2 business days later
 *   Koalafi     usually no fee, ~3 business days later, customer named on the line
 */
import { parseCsv } from "./csv";
import { normalizeDate } from "./paymentech";
import { toCents } from "./types";

export type LenderId = "snap" | "cfna" | "koalafi";

export interface LenderRule {
  id: LenderId;
  label: string;
  /** Matches the bank line's ORIG CO NAME. */
  origCoName: RegExp;
  /** Matches a QBO payment-method name / memo that identifies this lender. */
  evidence: RegExp;
  /** Whether a fee of `feeCents` on a payment of `grossCents` is plausible. */
  feeFits: (grossCents: number, feeCents: number) => boolean;
  /** Most business days between the payment and the bank deposit. */
  maxBusinessDays: number;
  /** The bank line names the customer, and the match must agree with it. */
  requiresNameMatch: boolean;
}

export const LENDERS: LenderRule[] = [
  {
    id: "cfna",
    label: "Bosch card (CFNA)",
    origCoName: /^BRIDGESTONE\/FIRE/i,
    evidence: /bosch|cnfca|cfna/i,
    // Exactly 1.99%, rounded to the cent (±1¢ for the lender's rounding).
    feeFits: (g, f) => Math.abs(f - Math.round(g * 0.0199)) <= 1,
    maxBusinessDays: 5,
    requiresNameMatch: false,
  },
  {
    id: "snap",
    label: "Snap Finance",
    origCoName: /^QB\/SNAP LOAN/i,
    // "Snap Finance" — but not Tekmetric's generic "Financing (i.e. snap,
    // synchrony...) (Bosch CNFCA)" method, which also contains "snap".
    evidence: /snap finance/i,
    feeFits: (g, f) => f >= 0 && f <= Math.round(g * 0.015),
    maxBusinessDays: 5,
    requiresNameMatch: false,
  },
  {
    id: "koalafi",
    label: "Koalafi",
    origCoName: /^KOALAFI/i,
    evidence: /koal/i,
    // Normally funds the full amount; allow a small merchant discount, but the
    // customer name on the line must also match (requiresNameMatch).
    feeFits: (g, f) => f >= 0 && f <= Math.round(g * 0.06),
    maxBusinessDays: 7,
    requiresNameMatch: true,
  },
];

export function lenderById(id: string): LenderRule | undefined {
  return LENDERS.find((l) => l.id === id);
}

/** One deposit line from a Chase account-activity export. */
export interface BankLine {
  date: string; // YYYY-MM-DD posting date
  amount: number; // positive for deposits
  description: string;
  origCoName: string;
  trace: string | null;
  /** IND NAME — the customer for Koalafi; the merchant name for others. */
  indName: string | null;
}

export interface LenderDeposit extends BankLine {
  lender: LenderId;
}

/** Recognize Chase's "Download account activity" CSV by its header. */
export function isChaseActivityHeader(headers: Set<string>): boolean {
  return headers.has("details") && headers.has("posting date") && headers.has("description") && headers.has("amount");
}

function field(desc: string, name: string, next: string[]): string | null {
  // Chase pads fields with runs of spaces: "ORIG CO NAME:KOALAFI        ORIG ID:…"
  const alt = next.map((n) => n.replace(/[#/]/g, "\\$&")).join("|");
  const m = desc.match(new RegExp(`${name}:(.*?)\\s*(?=(?:${alt}):|$)`));
  const v = m?.[1]?.trim();
  return v ? v : null;
}

/** Parse a Chase activity CSV into its deposit (credit) lines. */
export function parseChaseActivity(text: string): BankLine[] {
  const out: BankLine[] = [];
  for (const row of parseCsv(text)) {
    const details = String(row["Details"] ?? "").trim().toUpperCase();
    const amount = Number(String(row["Amount"] ?? "").replace(/[$,]/g, ""));
    const date = normalizeDate(String(row["Posting Date"] ?? "").trim());
    const description = String(row["Description"] ?? "").replace(/\s+/g, " ").trim();
    if (details !== "CREDIT" || !Number.isFinite(amount) || amount <= 0 || !date) continue;
    out.push({
      date,
      amount,
      description,
      origCoName: field(description, "ORIG CO NAME", ["ORIG ID"]) ?? "",
      trace: field(description, "TRACE#", ["EED"]),
      indName: field(description, "IND NAME", ["TRN"]),
    });
  }
  return out;
}

/** The lender deposits in a Chase export (everything else is left alone). */
export function lenderDeposits(lines: BankLine[]): LenderDeposit[] {
  const out: LenderDeposit[] = [];
  for (const l of lines) {
    const rule = LENDERS.find((r) => r.origCoName.test(l.origCoName));
    if (rule) out.push({ ...l, lender: rule.id });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Weekdays strictly after `from` up to and including `to` (no holiday calendar). */
export function businessDaysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  if (b < a) return -1;
  let n = 0;
  for (const d = new Date(a); d < b; ) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

function nameTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 2)
  );
}

/**
 * Same person? Order-insensitive token overlap — "Ferdinand Jacob" (bank) vs
 * "Ferdinand, Jacob" (QBO). Needs two shared tokens, or every token of a
 * one-word name.
 */
export function namesMatch(a: string, b: string): boolean {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared >= Math.min(2, ta.size, tb.size);
}

/** An Undeposited-Funds payment that's still free to deposit. */
export interface FinancingCandidate {
  id: string;
  amount: number;
  date: string; // YYYY-MM-DD
  customerName: string;
  /** Payment-method name and/or memo text, when QBO has it. */
  methodText: string;
}

export type FinancingMatch =
  | {
      kind: "matched";
      paymentIds: string[];
      grossCents: number;
      feeCents: number;
      /** How the match was confirmed, for the audit message. */
      basis: string;
    }
  | { kind: "review"; reason: string };

interface Option {
  payments: FinancingCandidate[];
  grossCents: number;
  feeCents: number;
  evidence: boolean;
  lagDays: number;
}

/**
 * Pair one lender deposit with the payment(s) it pays out. Only ever returns a
 * match that is the single plausible one; anything ambiguous goes to review.
 */
export function matchFinancingDeposit(dep: LenderDeposit, pool: FinancingCandidate[]): FinancingMatch {
  const rule = lenderById(dep.lender);
  if (!rule) return { kind: "review", reason: `Unknown lender ${dep.lender}.` };
  const netCents = toCents(dep.amount);

  const eligible = pool.filter((c) => {
    const lag = businessDaysBetween(c.date, dep.date);
    return lag >= 0 && lag <= rule.maxBusinessDays;
  });
  const named = rule.requiresNameMatch
    ? eligible.filter((c) => dep.indName && namesMatch(dep.indName, c.customerName))
    : eligible;

  const option = (payments: FinancingCandidate[]): Option | null => {
    const grossCents = payments.reduce((s, p) => s + toCents(p.amount), 0);
    const feeCents = grossCents - netCents;
    if (!rule.feeFits(grossCents, feeCents)) return null;
    return {
      payments,
      grossCents,
      feeCents,
      evidence: payments.every((p) => rule.evidence.test(p.methodText)),
      lagDays: Math.max(...payments.map((p) => businessDaysBetween(p.date, dep.date))),
    };
  };

  // Single payment first; a pair only when no single payment fits (a lender
  // occasionally pays two customers in one ACH).
  let options = named.map((p) => option([p])).filter((o): o is Option => o !== null);
  if (options.length === 0) {
    for (let i = 0; i < named.length; i++)
      for (let j = i + 1; j < named.length; j++) {
        const o = option([named[i], named[j]]);
        if (o) options.push(o);
      }
  }

  // When QBO tells us the payment method, prefer payments that name this lender.
  if (options.some((o) => o.evidence)) options = options.filter((o) => o.evidence);

  if (options.length === 1) {
    const o = options[0];
    const basis = [
      rule.requiresNameMatch ? "customer name on the bank line matches" : null,
      o.evidence ? "payment method names the lender" : null,
      `fee ${(o.feeCents / 100).toFixed(2)} fits ${rule.label}'s rate`,
      `${o.lagDays} business day(s) after the payment`,
    ]
      .filter(Boolean)
      .join("; ");
    return { kind: "matched", paymentIds: o.payments.map((p) => p.id), grossCents: o.grossCents, feeCents: o.feeCents, basis };
  }

  const window = `up to ${rule.maxBusinessDays} business days before ${dep.date}`;
  if (options.length > 1) {
    const list = options
      .slice(0, 4)
      .map((o) => o.payments.map((p) => `${p.customerName || "?"} ${p.amount.toFixed(2)} on ${p.date}`).join(" + "))
      .join("; ");
    return {
      kind: "review",
      reason: `${options.length} Undeposited-Funds payments could be this ${rule.label} payout (${list}) — not guessing. Create this deposit by hand in QBO.`,
    };
  }
  if (rule.requiresNameMatch && named.length === 0) {
    return {
      kind: "review",
      reason: `No open Undeposited-Funds payment for "${dep.indName ?? "?"}" ${window}. Check the customer's payment in Tekmetric/QBO.`,
    };
  }
  return {
    kind: "review",
    reason: `No open Undeposited-Funds payment ${window} fits a ${rule.label} payout of ${dep.amount.toFixed(2)} (gross minus the lender's fee). It may already be deposited, or recorded as a different payment type.`,
  };
}
