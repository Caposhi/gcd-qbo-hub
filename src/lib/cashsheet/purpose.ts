/**
 * Purpose normalization and mapping resolution (§5, §7).
 *
 * Purposes are typed by employees with inconsistent spelling/case/whitespace.
 * We normalize to an uppercase, single-spaced key and match against the
 * admin-editable purpose_mappings table. A row is NEVER posted on a fuzzy
 * guess — it must resolve to an active mapping, otherwise it is flagged
 * "Unknown Purpose" (§5, §7, §22).
 */

/** Shape we need from a purpose mapping — decoupled from Prisma for testing. */
export interface MappingLike {
  normalizedPurpose: string;
  amountType?: string | null;
  qboAction: string; // expense | deposit | transfer | audit_only
  qboAccountName?: string | null;
  qboAccountId?: string | null;
  postToQbo: boolean;
  auditOnly: boolean;
  requiresPayee: boolean;
  requiresManualApproval: boolean;
  invoiceMatching?: boolean;
  active: boolean;
}

/** Normalize a purpose string for matching: trim, collapse spaces, uppercase. */
export function normalizePurpose(raw: unknown): string {
  return String(raw ?? "")
    .replace(/[ ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/**
 * Resolve a purpose to its mapping.
 *
 * Matching strategy (deterministic, no silent fuzzy posting):
 *   1. exact normalized match against an active mapping;
 *   2. if amountType is provided, prefer a mapping whose amountType matches or
 *      is null (any). This lets the same word behave differently by column
 *      (rare, but the schema allows it).
 *
 * Returns the matched mapping, or null when unknown.
 */
export function resolvePurposeMapping(
  purposeRaw: unknown,
  mappings: MappingLike[],
  amountType?: string | null
): MappingLike | null {
  const key = normalizePurpose(purposeRaw);
  if (key === "") return null;

  const active = mappings.filter((m) => m.active && m.normalizedPurpose === key);
  if (active.length === 0) return null;
  if (active.length === 1) return active[0];

  // Multiple mappings share the key (e.g. distinguished by amount column).
  if (amountType) {
    const byType = active.find((m) => m.amountType === amountType);
    if (byType) return byType;
  }
  const anyType = active.find((m) => !m.amountType);
  return anyType ?? active[0];
}

export function isKnownPurpose(
  purposeRaw: unknown,
  mappings: MappingLike[],
  amountType?: string | null
): boolean {
  return resolvePurposeMapping(purposeRaw, mappings, amountType) !== null;
}
