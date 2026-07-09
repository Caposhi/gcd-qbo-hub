import { describe, it, expect } from "vitest";
import { buildPostingPlan, type AccountMappingLike } from "@/lib/cashsheet/classify";
import { buildSeedPurposeMappings } from "@/lib/cashsheet/seed-mappings";
import { RowStatus } from "@/lib/cashsheet/status";
import { parse } from "./fixtures";

const MAPPINGS = buildSeedPurposeMappings();

// Accounts with QBO IDs resolved (simulating a connected company).
const ACCOUNTS: AccountMappingLike[] = [
  { friendlyName: "Cash on hand", qboAccountId: "35", qboAccountName: "Cash on hand", active: true },
  { friendlyName: "Chase Checking 9680", qboAccountId: "36", qboAccountName: "Chase Checking 9680", active: true },
  { friendlyName: "Cost of Goods Sold:Parts Cost", qboAccountId: "80", active: true },
  { friendlyName: "Cost of Goods Sold:LABOR Wages:OWNER - Contract Labor", qboAccountId: "81", active: true },
  { friendlyName: "Other Income", qboAccountId: "90", active: true },
];

// Purpose mappings with their account IDs resolved (the engine does this at setup).
function withResolvedAccounts() {
  const byName: Record<string, string> = {
    "Cost of Goods Sold:Parts Cost": "80",
    "Cost of Goods Sold:LABOR Wages:OWNER - Contract Labor": "81",
    "Other Income": "90",
  };
  return MAPPINGS.map((m) =>
    m.qboAccountName && byName[m.qboAccountName] ? { ...m, qboAccountId: byName[m.qboAccountName] } : m
  );
}

const RESOLVED = withResolvedAccounts();

describe("transaction classification (§6)", () => {
  it("INV → audit only, never posts revenue, awaits QBO match (§6B, §19, §22)", () => {
    const r = parse({ date: "7/7/2026", rcv: "Eddie", name: "McAdam", purpose: "INV", inv: "73735", amtCollected: "800" });
    const plan = buildPostingPlan(r, RESOLVED, ACCOUNTS);
    expect(plan.action).toBe("audit_only");
    expect(plan.auditOnly).toBe(true);
    expect(plan.status).toBe(RowStatus.AwaitingQboMatch);
    expect(plan.invoiceMatching).toBe(true);
  });

  it("PART → paid-out expense from Cash on hand (§6A)", () => {
    const r = parse({ date: "7/7/2026", name: "Fusion Auto", purpose: "PART", amountPaidOut: "$1,080.00" });
    const plan = buildPostingPlan(r, RESOLVED, ACCOUNTS);
    expect(plan.action).toBe("expense");
    expect(plan.cashAccountId).toBe("35");
    expect(plan.categoryAccountId).toBe("80");
    expect(plan.status).toBe(RowStatus.ReadyToPost);
  });

  it("PR → paid-out expense to owner contract labor (§6A)", () => {
    const r = parse({ date: "7/7/2026", name: "Jose", purpose: "PR", amountPaidOut: "500" });
    const plan = buildPostingPlan(r, RESOLVED, ACCOUNTS);
    expect(plan.action).toBe("expense");
    expect(plan.categoryAccountId).toBe("81");
    expect(plan.status).toBe(RowStatus.ReadyToPost);
  });

  it("Bank Deposit → transfer Cash on hand → Chase Checking 9680 (§6C)", () => {
    const r = parse({ date: "7/7/2026", purpose: "Bank Deposit", bankDeposit: "2000" });
    // 'Bank Deposit' isn't a mapped purpose, but a bank_deposit amount forces a
    // transfer regardless — assert via a mapped purpose that posts as transfer:
    // here we rely on amountType routing. Provide a transfer mapping inline.
    const mappingsWithTransfer = [
      ...RESOLVED,
      {
        normalizedPurpose: "BANK DEPOSIT",
        amountType: "bank_deposit",
        qboAction: "transfer",
        qboAccountName: null,
        qboAccountId: null,
        postToQbo: true,
        auditOnly: false,
        requiresPayee: false,
        requiresManualApproval: false,
        active: true,
      },
    ];
    const plan = buildPostingPlan(r, mappingsWithTransfer, ACCOUNTS);
    expect(plan.action).toBe("transfer");
    expect(plan.destinationAccountId).toBe("36");
    expect(plan.cashAccountId).toBe("35");
    expect(plan.status).toBe(RowStatus.ReadyToPost);
  });

  it("unknown purpose → never posts, flagged Unknown Purpose (§7, §22)", () => {
    const r = parse({ date: "7/7/2026", purpose: "SPACESHIP", amountPaidOut: "100" });
    const plan = buildPostingPlan(r, RESOLVED, ACCOUNTS);
    expect(plan.action).toBe("none");
    expect(plan.status).toBe(RowStatus.UnknownPurpose);
    expect(plan.blockers.length).toBeGreaterThan(0);
  });

  it("missing account mapping blocks posting (§6, §14)", () => {
    // LUNCH maps to Meals & Entertainment, which has no resolved id here.
    const r = parse({ date: "7/7/2026", purpose: "LUNCH", amountPaidOut: "45" });
    const plan = buildPostingPlan(r, RESOLVED, ACCOUNTS);
    expect(plan.status).toBe(RowStatus.MissingAccountMapping);
    expect(plan.blockers.some((b) => /account mapping/i.test(b))).toBe(true);
  });

  it("employee loan requires payee → blocks when Name blank (§8)", () => {
    const r = parse({ date: "7/7/2026", purpose: "Employee Loan", amountPaidOut: "300" });
    const plan = buildPostingPlan(r, RESOLVED, ACCOUNTS);
    expect(plan.requiresManualApproval).toBe(true);
    expect(plan.blockers.some((b) => /payee required/i.test(b))).toBe(true);
  });

  it("blank payee on a non-required category → warning, still postable (§8)", () => {
    const r = parse({ date: "7/7/2026", purpose: "PART", amountPaidOut: "100" });
    const plan = buildPostingPlan(r, RESOLVED, ACCOUNTS);
    expect(plan.warnings.some((w) => /payee not matched/i.test(w))).toBe(true);
    expect(plan.status).toBe(RowStatus.ReadyToPost);
  });
});
