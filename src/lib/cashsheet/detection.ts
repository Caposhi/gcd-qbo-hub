/**
 * Changed- and removed-after-posting detection (§2, §11).
 *
 * After a row is posted to QBO we snapshot it (original hash + snapshot). On
 * every later sync we compare. We NEVER edit or delete QBO in response — these
 * functions only produce a signal + diff for the dashboard and a critical email
 * (§2, §11, §22). Pure and unit-tested (§20).
 */

export interface FieldDiff {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

/**
 * Compare a stored original snapshot with the current row snapshot and return
 * the per-field diffs. Empty array → unchanged.
 */
export function diffSnapshots(
  original: Record<string, unknown> | null | undefined,
  current: Record<string, unknown> | null | undefined
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  const o = original ?? {};
  const c = current ?? {};
  // Compare the union of keys, but ignore volatile bookkeeping fields that are
  // expected to move without being a "change" to the transaction itself.
  const ignore = new Set(["rowNumber"]);
  const keys = new Set([...Object.keys(o), ...Object.keys(c)]);
  for (const k of keys) {
    if (ignore.has(k)) continue;
    if (!valuesEqual(o[k], c[k])) {
      diffs.push({ field: k, oldValue: o[k] ?? null, newValue: c[k] ?? null });
    }
  }
  return diffs;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Normalize null/undefined/empty-string to the same "absent" value so
  // whitespace churn isn't reported as a fraud signal.
  const na = a === null || a === undefined ? "" : String(a).trim();
  const nb = b === null || b === undefined ? "" : String(b).trim();
  return na === nb;
}

/**
 * A posted row is "changed after posting" when its stored original hash differs
 * from its freshly computed current hash (§11).
 */
export function isChangedAfterPosting(originalHash: string | null, currentHash: string): boolean {
  if (!originalHash) return false; // no baseline → nothing to compare
  return originalHash !== currentHash;
}

/**
 * A posted row is "removed from sheet after posting" when a UUID that we
 * previously posted is not present anywhere in the freshly scanned set of
 * UUIDs, after a FULL scan of its tab (§11). This is distinct from a row that
 * merely moved — a moved row is still findable by UUID, so it stays in
 * `seenUuids`.
 *
 * @param postedUuids  UUIDs we have previously posted (per tab).
 * @param seenUuids    UUIDs found in this sync's full scan (per tab).
 * @returns the posted UUIDs that have truly disappeared.
 */
export function findRemovedAfterPosting(postedUuids: string[], seenUuids: Iterable<string>): string[] {
  const seen = seenUuids instanceof Set ? seenUuids : new Set(seenUuids);
  return postedUuids.filter((u) => !seen.has(u));
}
