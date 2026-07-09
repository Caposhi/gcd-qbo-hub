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
