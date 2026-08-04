/**
 * Duplicate detection (§10).
 *
 * Three independent signals, all pure so they're unit-tested (§20):
 *   1. Duplicate row UUID  — the same GCD_QBO_Row_ID appears on two+ sheet rows
 *                            (a copied hidden id). Flag ALL affected rows.
 *   2. Possible duplicate  — a new row shares a fingerprint with a row that was
 *                            already posted (copied without the hidden id).
 *   3. Already posted       — a row that already carries a QBO transaction id is
 *                            skipped (never re-posted). Enforced here and by a
 *                            DB unique constraint (§15).
 */

export interface ScannedRowRef {
  rowUuid: string | null;
  rowNumber: number;
  tabName: string;
  fingerprint: string;
}

/**
 * Find UUIDs that appear on more than one scanned row. Returns a map from the
 * offending UUID to the list of rows carrying it (all should be flagged).
 */
export function findDuplicateRowIds(rows: ScannedRowRef[]): Map<string, ScannedRowRef[]> {
  const byUuid = new Map<string, ScannedRowRef[]>();
  for (const r of rows) {
    if (!r.rowUuid) continue;
    const list = byUuid.get(r.rowUuid) ?? [];
    list.push(r);
    byUuid.set(r.rowUuid, list);
  }
  const dupes = new Map<string, ScannedRowRef[]>();
  for (const [uuid, list] of byUuid) {
    if (list.length > 1) dupes.set(uuid, list);
  }
  return dupes;
}

export interface PostedRowRef {
  rowUuid: string;
  fingerprint: string;
  qboTransactionId: string;
}

/**
 * Possible-duplicate check for a candidate row against already-posted rows.
 * A match is "possible duplicate" only when the fingerprint matches a posted
 * row whose UUID is DIFFERENT (same UUID = the same row, handled by the
 * already-posted path, not a duplicate).
 */
export function findPossibleDuplicate(
  candidateUuid: string | null,
  candidateFingerprint: string,
  postedRows: PostedRowRef[]
): PostedRowRef | null {
  for (const p of postedRows) {
    if (p.fingerprint === candidateFingerprint && p.rowUuid !== candidateUuid) {
      return p;
    }
  }
  return null;
}

/** A row that already has a QBO transaction id must never be posted again. */
export function isAlreadyPosted(qboTransactionId: string | null | undefined): boolean {
  return typeof qboTransactionId === "string" && qboTransactionId.trim() !== "";
}

/**
 * Fourth duplicate signal: re-identification after an edit (§4, §11).
 *
 * Row identity is the hidden GCD_QBO_Row_ID when write-back has captured one;
 * until then (or if that cell is ever cleared — e.g. a whole-row paste/clear
 * that overwrites an unprotected hidden column) it falls back to a content
 * fingerprint. That fingerprint includes fields like name and date, so a
 * routine correction (a typo fix, a date fix) on a row that hasn't yet picked
 * up a stable UUID changes the fingerprint entirely — the engine then sees
 * what looks like a brand-new row, and the existing fingerprint-based
 * `findPossibleDuplicate` check above can't catch it because the fingerprint
 * genuinely differs. Left alone, a row in this state gets reprocessed as new
 * and can attempt to post the same transaction to QBO a second time.
 *
 * INV#/RO number is stable across exactly that class of edit (the invoice
 * number itself is essentially never the thing being corrected), so keying
 * off it — instead of the fingerprint — closes the gap. A row with no INV#
 * has no key to compare on and is never matched here.
 */
export interface InvNumberRowRef {
  id: string;
  tabName: string;
  invNumber: string | null;
  status: string;
}

/** Leading whitespace-delimited token of an INV#/RO value, upper-cased. */
export function normalizeInvNumber(v: string | null | undefined): string {
  const s = (v ?? "").trim();
  if (!s) return "";
  return (s.split(/\s+/)[0] ?? "").toUpperCase();
}

/**
 * Find another row in the same tab, sharing the same normalized INV#, whose
 * status is already one of `resolvedStatuses` (i.e. it already has a QBO
 * outcome) — meaning `candidate` is very likely that same transaction
 * reappearing under a new identity, not a genuinely new one. Excludes
 * `candidate.id` itself so an existing row is never flagged against its own
 * prior state.
 */
export function findInvNumberSibling(
  candidate: { id: string; tabName: string; invNumber: string | null },
  resolvedStatuses: readonly string[],
  siblings: InvNumberRowRef[]
): InvNumberRowRef | null {
  const key = normalizeInvNumber(candidate.invNumber);
  if (!key) return null;
  for (const sib of siblings) {
    if (sib.id === candidate.id) continue;
    if (sib.tabName !== candidate.tabName) continue;
    if (normalizeInvNumber(sib.invNumber) !== key) continue;
    if (resolvedStatuses.includes(sib.status)) return sib;
  }
  return null;
}
