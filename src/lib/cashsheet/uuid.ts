/**
 * Hidden row-UUID handling (§3, §4).
 *
 * The row UUID (GCD_QBO_Row_ID) is the PRIMARY stable identity, kept in the
 * sheet's developer metadata or a hidden/protected column far to the right. It
 * survives edits and moves, so identity never depends on the visible row number.
 *
 * This module only owns UUID *value* logic (generation, validation, extraction
 * from a hidden-column map). Actually reading/writing developer metadata is the
 * Google Sheets service's job.
 */
import { randomUUID } from "node:crypto";

/** The hidden control column / metadata keys (§4). */
export const CONTROL_KEYS = {
  rowId: "GCD_QBO_Row_ID",
  firstSeenAt: "GCD_QBO_First_Seen_At",
  lastSeenAt: "GCD_QBO_Last_Seen_At",
  originalHash: "GCD_QBO_Original_Hash",
  lastKnownHash: "GCD_QBO_Last_Known_Hash",
} as const;

const UUID_RE = /^gcdqbo-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Generate a new, namespaced row UUID. The prefix makes stray pastes obvious. */
export function generateRowUuid(): string {
  return `gcdqbo-${randomUUID()}`;
}

export function isValidRowUuid(v: unknown): boolean {
  return typeof v === "string" && UUID_RE.test(v.trim());
}

/** Read a UUID from a hidden-column map for a row; null if absent/invalid. */
export function extractRowUuid(hidden: Record<string, unknown> | undefined): string | null {
  if (!hidden) return null;
  const raw = hidden[CONTROL_KEYS.rowId];
  return isValidRowUuid(raw) ? String(raw).trim() : null;
}
