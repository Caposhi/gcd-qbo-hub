/**
 * Check Reception — pure classification helpers (no I/O, unit-tested).
 *
 * The learned payee→category mapping is the automation the owner asked for:
 * the first check to a payee is confirmed by hand, and every later check to the
 * same payee pre-fills its vendor + expense account. These helpers normalize a
 * handwritten payee name for matching and decide whether an extracted check is
 * ready to post or still needs review — keeping that logic side-effect-free so
 * it can be tested without QBO, Claude, or the database.
 */

/** A check as read from the PDF by Claude vision (raw, possibly imperfect). */
export interface ExtractedCheck {
  page: number;
  checkNumber: string | null;
  amount: number | null;
  date: string | null; // YYYY-MM-DD
  payee: string | null;
  memo: string | null;
  confidence: "high" | "medium" | "low";
}

/** Minimal shape of a learned payee mapping (mirrors ChkPayeeMapping). */
export interface PayeeMappingLike {
  normalizedPayee: string;
  payeeDisplay: string;
  qboVendorId: string | null;
  qboVendorName: string | null;
  categoryAccountId: string | null;
  categoryAccountName: string | null;
  /** Normalized raw reads that also resolve to this mapping (learned aliases). */
  rawAliases?: string[];
}

/**
 * Normalize a handwritten payee for matching: uppercase, drop everything that
 * isn't a letter or digit. "Bob's Auto Parts, LLC" and "BOBS AUTO PARTS LLC"
 * collapse to the same key so trivial punctuation/spacing differences in the
 * OCR don't spawn duplicate mappings.
 */
export function normalizePayee(s: string | null | undefined): string {
  return (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Find the learned mapping for a payee: exact normalized match on the confirmed
 * payee first, then on any learned raw-read alias (so a consistent misread
 * resolves to the right mapping).
 */
export function findPayeeMapping(
  mappings: PayeeMappingLike[],
  payee: string | null | undefined
): PayeeMappingLike | undefined {
  const key = normalizePayee(payee);
  if (!key) return undefined;
  return (
    mappings.find((m) => m.normalizedPayee === key) ??
    mappings.find((m) => (m.rawAliases ?? []).includes(key))
  );
}

export interface ChecksClassification {
  /** Vendor + category chosen for this check (from the mapping or blank). */
  payeeResolved: string | null;
  qboVendorId: string | null;
  qboVendorName: string | null;
  categoryAccountId: string | null;
  categoryAccountName: string | null;
  /** ready = fully classified & confidently read; needs_review otherwise. */
  status: "ready" | "needs_review";
  reason: string;
}

/**
 * Decide the initial state of a freshly-read check. A check is "ready" (one
 * click from posting) only when: the read is not low-confidence, it has a check
 * number and a positive amount, and a learned mapping supplies BOTH a vendor and
 * an expense category. Anything short of that is "needs_review" — the owner
 * confirms/corrects it, which is also what teaches the mapping. This is the
 * review-first gate: handwriting is imperfect, so nothing is auto-marked ready
 * on a shaky read.
 */
export function classifyExtractedCheck(
  check: ExtractedCheck,
  mapping: PayeeMappingLike | undefined
): ChecksClassification {
  const base = {
    payeeResolved: mapping?.payeeDisplay ?? check.payee ?? null,
    qboVendorId: mapping?.qboVendorId ?? null,
    qboVendorName: mapping?.qboVendorName ?? null,
    categoryAccountId: mapping?.categoryAccountId ?? null,
    categoryAccountName: mapping?.categoryAccountName ?? null,
  };

  const problems: string[] = [];
  if (!check.checkNumber) problems.push("no check number read");
  if (check.amount === null || !(check.amount > 0)) problems.push("no amount read");
  if (check.confidence === "low") problems.push("low-confidence read");
  if (!mapping) problems.push("no learned payee mapping — confirm vendor & category once");
  else if (!mapping.qboVendorId || !mapping.categoryAccountId) problems.push("mapping incomplete");

  if (problems.length === 0) {
    return { ...base, status: "ready", reason: `Matched learned mapping for ${mapping!.payeeDisplay}.` };
  }
  return { ...base, status: "needs_review", reason: problems.join("; ") };
}
