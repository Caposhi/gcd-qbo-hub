/**
 * Initial seed mappings for the German Car Depot cash sheet (§7, §14).
 *
 * These are the starting rows for the admin-editable purpose/account mapping
 * tables. QBO account IDs are intentionally left null: they are resolved to
 * real IDs from the connected QBO company (§14 "never rely on names alone once
 * IDs are resolved"). Until resolved, a row that needs an account is flagged
 * "Missing Account Mapping" rather than posted on a guessed name.
 *
 * Pure data + a builder, so the seeder (prisma/seed.ts) and tests share it.
 */
import { normalizePurpose } from "./purpose";

export interface SeedPurposeMapping {
  purposePattern: string;
  normalizedPurpose: string;
  amountType: string | null;
  qboAction: string; // expense | deposit | transfer | audit_only
  qboAccountName: string | null;
  postToQbo: boolean;
  auditOnly: boolean;
  requiresPayee: boolean;
  requiresManualApproval: boolean;
  invoiceMatching: boolean;
  active: boolean;
}

interface SeedGroup {
  patterns: string[];
  amountType: string | null;
  qboAction: string;
  qboAccountName: string | null;
  postToQbo: boolean;
  auditOnly?: boolean;
  requiresPayee?: boolean;
  requiresManualApproval?: boolean;
  invoiceMatching?: boolean;
}

const GROUPS: SeedGroup[] = [
  {
    // OWNER contract labor / payroll paid from the envelope (§6A, §7).
    patterns: ["PR", "JOSE PR", "PAYROLL", "LABOR"],
    amountType: "amount_paid_out",
    qboAction: "expense",
    qboAccountName: "Cost of Goods Sold:LABOR Wages:OWNER - Contract Labor",
    postToQbo: true,
  },
  {
    patterns: ["PART", "PARTS", "CABIN FLTR", "CABIN FILTER", "FILTER"],
    amountType: "amount_paid_out",
    qboAction: "expense",
    qboAccountName: "Cost of Goods Sold:Parts Cost",
    postToQbo: true,
  },
  {
    patterns: ["LUNCH", "FRIDAY LUNCH", "MEAL", "MEALS"],
    amountType: "amount_paid_out",
    qboAction: "expense",
    qboAccountName: "Meals & Entertainment",
    postToQbo: true,
  },
  {
    // Customer invoice cash — audit only, attempt QBO match, NEVER post revenue
    // (§6B, §19, §22). This is the critical no-double-count rule.
    patterns: ["INV", "INVOICE"],
    amountType: "amt_collected",
    qboAction: "audit_only",
    qboAccountName: null,
    postToQbo: false,
    auditOnly: true,
    invoiceMatching: true,
  },
  {
    patterns: ["SCRAP", "SCRAP METAL", "METAL"],
    amountType: "amt_collected",
    qboAction: "deposit",
    qboAccountName: "Other Income",
    postToQbo: true,
  },
  {
    patterns: ["LOAN TO COMP", "LOAN TO COMPANY", "SHAREHOLDER LOAN"],
    amountType: "amt_collected",
    qboAction: "deposit",
    qboAccountName: "Due To/From Shareholder",
    postToQbo: true,
  },
  {
    // Employee loans: stronger mapping required, always manual approval (§6A,
    // §8, §12). Money leaves Cash on hand to a receivable asset.
    patterns: ["EMPLOYEE LOAN", "LOAN TO EMPLOYEE"],
    amountType: "amount_paid_out",
    qboAction: "expense",
    qboAccountName: "Employee Loans Receivable",
    postToQbo: true,
    requiresPayee: true,
    requiresManualApproval: true,
  },
  {
    // Cash over/short: deposit when collected, expense when paid out. classify
    // picks the direction from the populated amount column (§6B).
    patterns: ["CASH OVER", "CASH SHORT", "CASH OVER/SHORT", "OVER SHORT"],
    amountType: null,
    qboAction: "deposit",
    qboAccountName: "Cash over/short",
    postToQbo: true,
  },
];

export function buildSeedPurposeMappings(): SeedPurposeMapping[] {
  const out: SeedPurposeMapping[] = [];
  for (const g of GROUPS) {
    for (const p of g.patterns) {
      out.push({
        purposePattern: p,
        normalizedPurpose: normalizePurpose(p),
        amountType: g.amountType,
        qboAction: g.qboAction,
        qboAccountName: g.qboAccountName,
        postToQbo: g.postToQbo,
        auditOnly: g.auditOnly ?? false,
        requiresPayee: g.requiresPayee ?? false,
        requiresManualApproval: g.requiresManualApproval ?? false,
        invoiceMatching: g.invoiceMatching ?? false,
        active: true,
      });
    }
  }
  return out;
}

export interface SeedAccountMapping {
  friendlyName: string;
  qboAccountName: string;
  qboAccountType: string;
}

/** The account slots the module must resolve to real QBO IDs (§14). */
export const SEED_ACCOUNT_MAPPINGS: SeedAccountMapping[] = [
  { friendlyName: "Cash on hand", qboAccountName: "Cash on hand", qboAccountType: "Bank" },
  { friendlyName: "Chase Checking 9680", qboAccountName: "Chase Checking 9680", qboAccountType: "Bank" },
  {
    friendlyName: "Cost of Goods Sold:Parts Cost",
    qboAccountName: "Cost of Goods Sold:Parts Cost",
    qboAccountType: "CostOfGoodsSold",
  },
  {
    friendlyName: "Cost of Goods Sold:LABOR Wages:OWNER - Contract Labor",
    qboAccountName: "Cost of Goods Sold:LABOR Wages:OWNER - Contract Labor",
    qboAccountType: "CostOfGoodsSold",
  },
  { friendlyName: "Meals & Entertainment", qboAccountName: "Meals & Entertainment", qboAccountType: "Expense" },
  { friendlyName: "Other Income", qboAccountName: "Other Income", qboAccountType: "OtherIncome" },
  {
    friendlyName: "Due To/From Shareholder",
    qboAccountName: "Due To/From Shareholder",
    qboAccountType: "OtherCurrentLiability",
  },
  { friendlyName: "Cash over/short", qboAccountName: "Cash over/short", qboAccountType: "Expense" },
  {
    friendlyName: "Employee Loans Receivable",
    qboAccountName: "Employee Loans Receivable",
    qboAccountType: "OtherCurrentAsset",
  },
];

/** Common internal names treated as employees/approvers/cash handlers (§8). */
export const INTERNAL_NAMES = ["Jose", "Rich", "Styven", "Eddie"];
