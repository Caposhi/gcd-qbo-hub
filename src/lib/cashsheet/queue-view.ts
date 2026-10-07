/**
 * Pure helpers shared by the Cash Sheet Sync Overview, Queue, row detail and
 * Reconciliation pages, so the numbers on a tile and the rows behind it are
 * always computed from the same rules.
 */

/** "$12,240.00" / "-$21.00"; "" for a missing value. */
export function formatUsd(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  if (Number.isNaN(n)) return "";
  const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? "-" : ""}$${abs}`;
}

/**
 * Queue `approval` filter. "pending" = not yet approved by an owner;
 * "approved" = approved but still without a QBO transaction (i.e. waiting for
 * the next real sync, or approved and then blocked). Anything else: no filter.
 */
export type ApprovalFilter = "pending" | "approved";

export function parseApprovalFilter(raw: string | null | undefined): ApprovalFilter | null {
  return raw === "pending" || raw === "approved" ? raw : null;
}

export function approvalWhere(filter: ApprovalFilter | null): Record<string, unknown> {
  if (filter === "pending") return { approvedAt: null };
  if (filter === "approved") return { approvedAt: { not: null }, qboTransactionId: null };
  return {};
}

/**
 * Where an approved row stands relative to the sync that should post it.
 *
 * Approval is only honored by the NEXT real (non-dry-run) sync: the engine
 * reads `approvedAt` while it processes each row. So an approved row with no
 * QBO transaction is either
 *   - "waiting": approved after the last real sync started — normal; it posts
 *     on the next "Run sync now" or nightly cron; or
 *   - "blocked": a real sync started after the approval and the row still did
 *     not post — something else is stopping it (see its status reason).
 */
export type ApprovalState = "not_approved" | "posted" | "waiting" | "blocked";

export function approvalState(
  row: { approvedAt: Date | null; qboTransactionId: string | null },
  lastRealSyncStartedAt: Date | null
): ApprovalState {
  if (row.qboTransactionId) return "posted";
  if (!row.approvedAt) return "not_approved";
  if (lastRealSyncStartedAt && lastRealSyncStartedAt > row.approvedAt) return "blocked";
  return "waiting";
}

/** Whether a stored reconciliation check covers exactly the selected period. */
export function checkCoversRange(
  check: { startStr: string; endStr: string },
  range: { start: Date | null; end: Date | null }
): boolean {
  if (!range.start || !range.end) return false;
  return (
    check.startStr === range.start.toISOString().slice(0, 10) &&
    check.endStr === range.end.toISOString().slice(0, 10)
  );
}
