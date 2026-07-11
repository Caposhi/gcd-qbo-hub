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
