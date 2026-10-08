/**
 * Customer-financing payouts (Snap Finance, Bosch card via CFNA/Bridgestone,
 * Koalafi) and Zelle customer payments — the deposits no processor export
 * covers.
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
 *   Zelle       no fee, same day (Tekmetric may record it a day or two either
 *               side); sender named on the line — usually the customer, but a
 *               company can pay for someone (then the "Zelle" method decides)
 */
import { parseCsv } from "./csv";
import { normalizeDate } from "./paymentech";
import { toCents } from "./types";

export type LenderId = "snap" | "cfna" | "koalafi" | "zelle";

export interface LenderRule {
  id: LenderId;
  label: string;
  /** Whether a Chase deposit line belongs to this source. */
  matchesLine: (line: BankLine) => boolean;
  /** Matches a QBO payment-method name / memo that identifies this lender. */
  evidence: RegExp;
  /** Whether a fee of `feeCents` on a payment of `grossCents` is plausible. */
  feeFits: (grossCents: number, feeCents: number) => boolean;
  /** Most business days the payment may PRECEDE the bank deposit. */
  maxBusinessDays: number;
  /** Most business days the payment may FOLLOW the deposit (recorded late). */
  maxBusinessDaysAfter: number;
  /**
   * How the customer is confirmed beyond amount/date/fee:
   *   "name"            the name on the bank line must match the QBO customer
   *   "nameOrEvidence"  the name matches, OR the QBO payment method names the source
   *   "evidence"        the QBO payment method must name the source (loose fee rules)
   *   "none"            amount, date and fee rule only (method still preferred)
   */
  identity: "name" | "nameOrEvidence" | "evidence" | "none";
  /** Extra hint when nothing matches (where the payment usually is instead). */
  missingHint?: string;
}

const byOrigCo = (re: RegExp) => (l: BankLine) => re.test(l.origCoName);

/** Payment methods that are never a lender payout or a Zelle. */
const CARD_AND_OTHER_METHODS =
  /\bvisa\b|master ?card|american express|\bamex\b|discover|\bcash\b|\bcheck\b|affirm|klarna|pac warranty|bad debt/i;

export const LENDERS: LenderRule[] = [
  {
    id: "cfna",
    label: "Bosch card (CFNA)",
    matchesLine: byOrigCo(/^BRIDGESTONE\/FIRE/i),
    // Tekmetric's method for the Bosch card is "Financing (i.e. snap,
    // synchrony...) (Bosch CNFCA)".
    evidence: /bosch|cnfca|cfna|^financing\b/i,
    // Exactly 1.99%, rounded to the cent (±1¢ for the lender's rounding).
    feeFits: (g, f) => Math.abs(f - Math.round(g * 0.0199)) <= 1,
    maxBusinessDays: 5,
    maxBusinessDaysAfter: 0,
    identity: "none",
  },
  {
    id: "snap",
    label: "Snap Finance",
    matchesLine: byOrigCo(/^QB\/SNAP LOAN/i),
    // "Snap Finance" — but not Tekmetric's generic "Financing (i.e. snap,
    // synchrony...) (Bosch CNFCA)" method, which also contains "snap".
    evidence: /snap finance/i,
    feeFits: (g, f) => f >= 0 && f <= Math.round(g * 0.015),
    maxBusinessDays: 5,
    maxBusinessDaysAfter: 0,
    // A 0–1.5% band is loose enough that card payments can fit it by chance
    // (a dry run on real data paired two Visa payments with a Snap payout when
    // the real Snap payment was missing), so Snap needs its method label.
    identity: "evidence",
  },
  {
    id: "koalafi",
    label: "Koalafi",
    matchesLine: byOrigCo(/^KOALAFI/i),
    evidence: /koal/i,
    // Normally funds the full amount; allow a small merchant discount, but the
    // customer name on the line must also match.
    feeFits: (g, f) => f >= 0 && f <= Math.round(g * 0.06),
    maxBusinessDays: 7,
    maxBusinessDaysAfter: 0,
    identity: "name",
  },
  {
    id: "zelle",
    label: "Zelle",
    matchesLine: (l) => /^Zelle payment from /i.test(l.description),
    evidence: /zelle/i,
    feeFits: (_g, f) => f === 0, // Zelle is free: the exact amount arrives
    maxBusinessDays: 3,
    maxBusinessDaysAfter: 3,
    identity: "nameOrEvidence",
    missingHint:
      " If Tekmetric's Accounting Link shows the Zelle payment as Unapproved, approve it so it reaches QBO; a Zelle that isn't a repair-order payment should be categorized by hand.",
  },
];

export function lenderById(id: string): LenderRule | undefined {
  return LENDERS.find((l) => l.id === id);
}

/**
 * A payment whose QBO method names something ELSE (a card brand, cash, another
 * lender) can't be this source's payout, whatever its amount. Blank or generic
 * ("Other") methods stay eligible.
 */
export function methodConflicts(rule: LenderRule, methodText: string): boolean {
  if (!methodText.trim() || rule.evidence.test(methodText)) return false;
  return CARD_AND_OTHER_METHODS.test(methodText) || LENDERS.some((r) => r.id !== rule.id && r.evidence.test(methodText));
}

/**
 * Card payouts (Paymentech, Tekmetric/Stripe) carry only card money. A QBO
 * payment whose method names a lender, Zelle, cash, check, PAC Warranty or bad
 * debt can never be one of their charges — even at the same amount on the same
 * day (live 09/10: a $1,500 Bosch "Financing" payment was taken by a Stripe
 * payout's $1,500 Visa charge, stranding the Bosch bank line). Pass the QBO
 * payment-method NAME only, not memos, which can mention anything.
 */
export function isNonCardMethod(methodName: string): boolean {
  return /\bcash\b|\bcheck\b|pac warranty|bad debt/i.test(methodName) || LENDERS.some((r) => r.evidence.test(methodName));
}

/** Sort key for card-payout candidates: a card-brand label (0) beats "Other" or none (1). */
export function cardMethodRank(methodName: string): number {
  return /\bvisa\b|master ?card|american express|\bamex\b|discover|affirm|klarna/i.test(methodName) ? 0 : 1;
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
    // Zelle lines carry no ACH fields: "Zelle payment from ANA RIVERA BACx1y2z3"
    // — the sender, then a bank reference token, which doubles as the trace.
    const zelle = description.match(/^Zelle payment from (.+) (\S+)$/i);
    out.push({
      date,
      amount,
      description,
      origCoName: field(description, "ORIG CO NAME", ["ORIG ID"]) ?? "",
      trace: zelle ? zelle[2] : field(description, "TRACE#", ["EED"]),
      indName: zelle ? zelle[1] : field(description, "IND NAME", ["TRN"]),
    });
  }
  return out;
}

/** The lender deposits in a Chase export (everything else is left alone). */
export function lenderDeposits(lines: BankLine[]): LenderDeposit[] {
  const out: LenderDeposit[] = [];
  for (const l of lines) {
    const rule = LENDERS.find((r) => r.matchesLine(l));
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
 * Same person? Order-insensitive token overlap — "Rivera Ana" (bank) vs
 * "Rivera, Ana" (QBO). Needs two shared tokens, or every token of a
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
  named: boolean;
  lagDays: number;
}

/**
 * Pair one lender deposit with the payment(s) it pays out. Only ever returns a
 * match that is the single plausible one; anything ambiguous goes to review.
 */
export function matchFinancingDeposit(
  dep: LenderDeposit,
  pool: FinancingCandidate[],
  opts: { labelInsteadOfName?: boolean } = {}
): FinancingMatch {
  const found = lenderById(dep.lender);
  if (!found) return { kind: "review", reason: `Unknown lender ${dep.lender}.` };
  // labelInsteadOfName: accept a payment labelled with this lender even when the
  // bank line names someone else (a relative or co-signer financed it). Only
  // for confirming an EXISTING deposit that equals the bank line — never for
  // choosing an open payment.
  const rule: LenderRule =
    opts.labelInsteadOfName && (found.identity === "name" || found.identity === "nameOrEvidence")
      ? { ...found, identity: "evidence" }
      : found;
  const netCents = toCents(dep.amount);

  // Business days from the payment to the deposit; negative when it was recorded after.
  const lagOf = (c: FinancingCandidate) =>
    c.date <= dep.date ? businessDaysBetween(c.date, dep.date) : -businessDaysBetween(dep.date, c.date);
  const eligible = pool.filter((c) => {
    const lag = lagOf(c);
    return lag <= rule.maxBusinessDays && lag >= -rule.maxBusinessDaysAfter && !methodConflicts(rule, c.methodText);
  });
  const nameOk = (c: FinancingCandidate) => !!dep.indName && namesMatch(dep.indName, c.customerName);
  const named =
    rule.identity === "name"
      ? eligible.filter(nameOk)
      : rule.identity === "nameOrEvidence"
        ? eligible.filter((c) => nameOk(c) || rule.evidence.test(c.methodText))
        : rule.identity === "evidence"
          ? eligible.filter((c) => rule.evidence.test(c.methodText))
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
      named: payments.every(nameOk),
      lagDays: Math.max(...payments.map(lagOf)),
    };
  };

  // Single payment first; a pair only when no single payment fits (a lender
  // occasionally pays two customers in one ACH) — and only from payments whose
  // method names this source, so two unrelated payments can't add up by chance.
  let options = named.map((p) => option([p])).filter((o): o is Option => o !== null);
  if (options.length === 0) {
    const labelled = named.filter((c) => rule.evidence.test(c.methodText));
    for (let i = 0; i < labelled.length; i++)
      for (let j = i + 1; j < labelled.length; j++) {
        const o = option([labelled[i], labelled[j]]);
        if (o) options.push(o);
      }
  }

  // A name match on the bank line beats everything (Zelle); then prefer
  // payments whose QBO method names this source.
  if (rule.identity === "nameOrEvidence" && options.some((o) => o.named)) options = options.filter((o) => o.named);
  if (options.some((o) => o.evidence)) options = options.filter((o) => o.evidence);

  if (options.length === 1) {
    const o = options[0];
    const basis = [
      o.named && rule.identity !== "none" ? "name on the bank line matches the customer" : null,
      o.evidence ? "payment method names the lender" : null,
      `fee ${(o.feeCents / 100).toFixed(2)} fits ${rule.label}'s rate`,
      o.lagDays >= 0
        ? `${o.lagDays} business day(s) after the payment`
        : `payment recorded ${-o.lagDays} business day(s) after the deposit`,
    ]
      .filter(Boolean)
      .join("; ");
    return { kind: "matched", paymentIds: o.payments.map((p) => p.id), grossCents: o.grossCents, feeCents: o.feeCents, basis };
  }

  const window =
    `up to ${rule.maxBusinessDays} business days before ${dep.date}` +
    (rule.maxBusinessDaysAfter ? ` (or ${rule.maxBusinessDaysAfter} after)` : "");
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
  if (rule.identity === "evidence" && named.length === 0) {
    return {
      kind: "review",
      reason: `No open Undeposited-Funds payment labelled as ${rule.label} ${window}. Create this deposit by hand in QBO, or check the payment type in Tekmetric.`,
    };
  }
  if (rule.identity !== "none" && named.length === 0) {
    return {
      kind: "review",
      reason: `No open Undeposited-Funds payment for "${dep.indName ?? "?"}" ${window}. Check the customer's payment in Tekmetric/QBO.${rule.missingHint ?? ""}`,
    };
  }
  return {
    kind: "review",
    reason:
      `No open Undeposited-Funds payment ${window} fits a ${rule.label} deposit of ${dep.amount.toFixed(2)}` +
      `${rule.id === "zelle" ? " (Zelle has no fee, so the amount must be exact)" : " (gross minus the lender's fee)"}. ` +
      `It may already be deposited, or recorded as a different payment type.${rule.missingHint ?? ""}`,
  };
}
