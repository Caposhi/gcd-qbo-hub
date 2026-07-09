/**
 * Transaction classification → a posting plan (§6, §8).
 *
 * Combines a parsed row, its resolved purpose mapping, and the account-mapping
 * table into a concrete, QBO-shaped plan describing exactly what WOULD be
 * posted — or why it can't be. This is the single place category rules live, so
 * dry-run and real posting share identical logic (the dry-run guarantee, §19).
 */
import type { ParsedRow } from "./rows";
import type { MappingLike } from "./purpose";
import { resolvePurposeMapping } from "./purpose";
import { RowStatus } from "./status";

export type QboAction = "expense" | "deposit" | "transfer" | "audit_only" | "none";

export interface AccountMappingLike {
  friendlyName: string;
  qboAccountId?: string | null;
  qboAccountName?: string | null;
  active: boolean;
}

export interface PostingPlan {
  action: QboAction;
  /** Human summary of the intended QBO effect, for the dashboard/dry-run. */
  description: string;
  amount: number | null;
  amountType: ParsedRow["amountType"];
  /** Category / target account friendly name (from the purpose mapping). */
  categoryAccount?: string | null;
  categoryAccountId?: string | null;
  /** The cash account the money moves from/to (always Cash on hand here). */
  cashAccount: string;
  cashAccountId?: string | null;
  /** For transfers (Bank Deposit): the destination bank account. */
  destinationAccount?: string | null;
  destinationAccountId?: string | null;
  auditOnly: boolean;
  invoiceMatching: boolean;
  requiresManualApproval: boolean;
  requiresPayee: boolean;
  /** The status this row should carry given the plan. */
  status: string;
  /** Blocking reasons (non-empty → not ready to post). */
  blockers: string[];
  /** Non-blocking warnings (row can still post). */
  warnings: string[];
  mapping: MappingLike | null;
}

const CASH_ON_HAND = "Cash on hand";
const CHASE_CHECKING = "Chase Checking 9680";

function findAccount(accounts: AccountMappingLike[], friendlyName: string): AccountMappingLike | undefined {
  return accounts.find((a) => a.active && a.friendlyName === friendlyName);
}

/**
 * Build the posting plan for a parsed row. Assumes the row is already a valid
 * transaction candidate (validateRow passed) — classification is about the
 * QBO shape, not structural validity.
 */
export function buildPostingPlan(
  row: ParsedRow,
  mappings: MappingLike[],
  accounts: AccountMappingLike[]
): PostingPlan {
  const blockers: string[] = [];
  const warnings: string[] = [];

  const cash = findAccount(accounts, CASH_ON_HAND);
  if (!cash?.qboAccountId) {
    blockers.push(`Account mapping missing or unresolved: ${CASH_ON_HAND}`);
  }

  const base: PostingPlan = {
    action: "none",
    description: "",
    amount: row.amount,
    amountType: row.amountType,
    cashAccount: CASH_ON_HAND,
    cashAccountId: cash?.qboAccountId ?? null,
    auditOnly: false,
    invoiceMatching: false,
    requiresManualApproval: false,
    requiresPayee: false,
    status: RowStatus.Validated,
    blockers,
    warnings,
    mapping: null,
  };

  const mapping = resolvePurposeMapping(row.purpose, mappings, row.amountType ?? undefined);
  if (!mapping) {
    return {
      ...base,
      action: "none",
      description: `Unknown purpose "${row.purpose}" — never posted automatically.`,
      status: RowStatus.UnknownPurpose,
      blockers: [...blockers, `Unknown purpose: "${row.purpose}"`],
    };
  }

  base.mapping = mapping;
  base.auditOnly = mapping.auditOnly;
  base.invoiceMatching = !!mapping.invoiceMatching;
  base.requiresManualApproval = mapping.requiresManualApproval;
  base.requiresPayee = mapping.requiresPayee;
  base.categoryAccount = mapping.qboAccountName ?? null;
  base.categoryAccountId = mapping.qboAccountId ?? null;

  // Payee requirement (§8): only a warning unless the mapping requires it
  // (employee loans), in which case it blocks.
  if (mapping.requiresPayee && row.name.trim() === "") {
    blockers.push("Payee required for this category but Name is blank");
  } else if (row.name.trim() === "") {
    warnings.push("Payee Not Matched (Name blank) — posting allowed if type/amount valid");
  }

  // ---- Audit-only (INV customer cash) — never creates QBO revenue (§6B) ----
  if (mapping.auditOnly || mapping.qboAction === "audit_only") {
    return {
      ...base,
      action: "audit_only",
      description:
        "Customer invoice cash — audit only. No QBO transaction created; attempt to match an existing QBO record.",
      status: mapping.invoiceMatching ? RowStatus.AwaitingQboMatch : RowStatus.AuditOnly,
    };
  }

  // ---- Category account must resolve for anything that posts ----
  const needsCategoryAccount = mapping.qboAction === "expense" || mapping.qboAction === "deposit";
  if (needsCategoryAccount && !mapping.qboAccountId) {
    blockers.push(
      `Account mapping missing or unresolved for category "${mapping.qboAccountName ?? mapping.normalizedPurpose}"`
    );
  }

  let action: QboAction = "none";
  let description = "";
  let destinationAccount: string | null | undefined;
  let destinationAccountId: string | null | undefined;

  if (mapping.qboAction === "transfer" || row.amountType === "bank_deposit") {
    // Bank Deposit → Transfer Cash on hand → Chase Checking 9680 (§6C).
    action = "transfer";
    const dest = findAccount(accounts, CHASE_CHECKING);
    destinationAccount = CHASE_CHECKING;
    destinationAccountId = dest?.qboAccountId ?? null;
    if (!dest?.qboAccountId) {
      blockers.push(`Bank account mapping missing or unresolved: ${CHASE_CHECKING}`);
    }
    description = `Transfer $${fmt(row.amount)} from ${CASH_ON_HAND} to ${CHASE_CHECKING} (bank-feed match).`;
  } else if (mapping.qboAction === "expense" || row.amountType === "amount_paid_out") {
    // Paid out → expense/purchase from Cash on hand (§6A).
    action = "expense";
    description = `Expense $${fmt(row.amount)} from ${CASH_ON_HAND} → ${mapping.qboAccountName ?? "(category)"}.`;
  } else if (mapping.qboAction === "deposit") {
    // Non-invoice cash in → deposit/increase to Cash on hand (§6B: SCRAP,
    // LOAN TO COMP, CASH OVER/SHORT).
    action = "deposit";
    description = `Deposit $${fmt(row.amount)} to ${CASH_ON_HAND} → ${mapping.qboAccountName ?? "(category)"}.`;
  }

  return {
    ...base,
    action,
    description,
    destinationAccount,
    destinationAccountId,
    status: blockers.length > 0 ? RowStatus.MissingAccountMapping : RowStatus.ReadyToPost,
  };
}

function fmt(n: number | null): string {
  return n === null ? "0.00" : n.toFixed(2);
}
