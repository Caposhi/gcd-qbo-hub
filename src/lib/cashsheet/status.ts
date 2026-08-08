/**
 * Cash Sheet Sync status model (§12).
 *
 * These are the dashboard-facing statuses a row can hold. They are plain
 * string constants (not a Prisma enum) because they describe workflow state
 * that the dashboard filters and displays, and we want to add statuses for
 * future signals without a DB migration.
 */
export const RowStatus = {
  New: "New",
  IgnoredBeforeStartDate: "Ignored - Before Start Date",
  IgnoredBlankRow: "Ignored - Blank Row",
  Validated: "Validated",
  AuditOnly: "Audit Only",
  AwaitingQboMatch: "Awaiting QBO Match",
  ReadyToPost: "Ready To Post",
  Posted: "Posted",
  PostedWithWarning: "Posted With Warning",
  DepositCreated: "Deposit Created",
  Error: "Error",
  PossibleDuplicate: "Possible Duplicate",
  DuplicateRowId: "Duplicate Row ID",
  UnknownPurpose: "Unknown Purpose",
  MissingAccountMapping: "Missing Account Mapping",
  MissingPayeeMapping: "Missing Payee Mapping",
  ChangedAfterPosting: "Changed After Posting",
  RemovedFromSheetAfterPosting: "Removed From Sheet After Posting",
  Skipped: "Skipped",
  /**
   * A never-posted, not-yet-UUID'd row whose exact content no longer appears
   * anywhere in a full tab scan — almost always because the sheet was edited
   * (a date/amount/name correction) before this row captured a stable
   * GCD_QBO_Row_ID, which left the old content behind as an orphan under its
   * old fingerprint-keyed identity (see uuid.ts, engine.ts §4). Auto-applied
   * and auto-archived by the sync engine — there is nothing to do with a
   * Superseded row, which is the point: it stops looking identical to a real
   * pending row in the Queue (§10, the whole reason this status exists).
   */
  Superseded: "Superseded",
} as const;

export type RowStatus = (typeof RowStatus)[keyof typeof RowStatus];

/** Statuses that mean the row has a live QBO transaction we must never touch. */
export const POSTED_STATUSES: RowStatus[] = [
  RowStatus.Posted,
  RowStatus.PostedWithWarning,
];

/** Terminal "do not post" statuses that still need human attention. */
export const REVIEW_STATUSES: RowStatus[] = [
  RowStatus.PossibleDuplicate,
  RowStatus.DuplicateRowId,
  RowStatus.UnknownPurpose,
  RowStatus.MissingAccountMapping,
  RowStatus.MissingPayeeMapping,
  RowStatus.Error,
  RowStatus.ChangedAfterPosting,
  RowStatus.RemovedFromSheetAfterPosting,
];
