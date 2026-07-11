import Link from "next/link";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/roles";
import { RequireAuth } from "../../components/RequireAuth";
import { RowStatus } from "@/lib/cashsheet/status";
import {
  findCashDepositCandidates,
  resolveDepositAccounts,
  alreadyHasDeposit,
} from "@/lib/cashsheet/cash-deposit-service";
import { locateCashDepositsAction, createCashDepositAction } from "../actions";

export const dynamic = "force-dynamic";

function money(v: unknown): string {
  if (v === null || v === undefined) return "";
  return `$${Number(v).toFixed(2)}`;
}

interface PlanEvent {
  found?: boolean;
  reason?: string;
  ro?: string;
  depositedAmount?: number;
  payment?: { id: string; amount: number; privateNote: string; date: string; customerName?: string } | null;
  plan?: { paymentId: string; paymentCents: number; depositedCents: number; overShortCents: number; withinThreshold: boolean } | null;
}

export default async function CashDepositsPage() {
  const user = await getSessionUser();
  if (!user) return <RequireAuth />;
  const editable = can(user.role, "approve_posting");

  const [rows, accounts] = await Promise.all([findCashDepositCandidates(), resolveDepositAccounts()]);
  const rowIds = rows.map((r) => r.id);

  // Latest plan/created event per row (for display).
  const events = rowIds.length
    ? await prisma.rowEvent.findMany({
        where: {
          sheetRowId: { in: rowIds },
          eventType: { in: ["cash_deposit_plan", "cash_deposit_created", "cash_deposit_blocked", "cash_deposit_locate_error"] },
        },
        orderBy: { createdAt: "desc" },
      })
    : [];
  const latestPlan = new Map<string, PlanEvent>();
  const latestMsg = new Map<string, string>();
  for (const e of events) {
    if (!e.sheetRowId) continue;
    if (!latestMsg.has(e.sheetRowId)) latestMsg.set(e.sheetRowId, `${e.eventType}: ${e.eventMessage}`);
    if (e.eventType === "cash_deposit_plan" && !latestPlan.has(e.sheetRowId)) {
      latestPlan.set(e.sheetRowId, (e.diffJson as PlanEvent) ?? {});
    }
  }

  const accountsReady = !!accounts.chaseId && !!accounts.overShortId;

  return (
    <>
      <h1>Cash Deposit Matching</h1>
      <p className="sub">
        Customer cash collections (rows with an INV#/RO and a Bank Deposit amount) whose payment already sits in
        Undeposited Funds. The hub finds that payment by RO#, builds the exact QBO Bank Deposit — the payment plus a
        small <em>Cash over/short</em> plug when the deposited amount differs by rounding — and, once you create it,
        QuickBooks auto-matches the bank-feed line. Nothing posts until you click <strong>Create deposit</strong> on a
        row, and only when it ties out.
      </p>

      {!accountsReady && (
        <p className="badge danger">
          Account mapping incomplete — need both “Chase Checking 9680” ({accounts.chaseId ?? "unresolved"}) and “Cash
          over/short” ({accounts.overShortId ?? "unresolved"}). Resolve them on the Mappings page first.
        </p>
      )}

      {editable && (
        <form action={locateCashDepositsAction} className="row-actions" style={{ margin: "0.75rem 0" }}>
          <button className="btn secondary" type="submit">
            Locate payments in QBO (read-only)
          </button>
          <span className="muted" style={{ alignSelf: "center", fontSize: "0.85rem" }}>
            Finds each row&apos;s Undeposited-Funds payment and previews the deposit. No writes.
          </span>
        </form>
      )}

      {rows.length === 0 ? (
        <p className="muted">
          No candidate rows. These appear once a sync has scanned rows that carry both an INV#/RO and a Bank Deposit
          amount and haven&apos;t been deposited yet.
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tab</th><th>Row</th><th>Date</th><th>Name</th><th>INV#/RO</th><th>Bank Deposit</th>
                <th>Located payment</th><th>Over/short</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const p = latestPlan.get(r.id);
                const created = alreadyHasDeposit(r);
                const ready = !created && !!p?.found && !!p?.plan;
                const overShort = p?.plan ? p.plan.overShortCents / 100 : null;
                return (
                  <tr key={r.id}>
                    <td>{r.tabName}</td>
                    <td>
                      <Link href={`/cash-sheet-sync/rows/${r.id}`}>{r.rowNumberLastSeen}</Link>
                    </td>
                    <td>{r.date ? r.date.toISOString().slice(0, 10) : ""}</td>
                    <td>{r.name}</td>
                    <td>{r.invNumber}</td>
                    <td>{money(r.bankDeposit)}</td>
                    <td style={{ fontSize: "0.8rem" }}>
                      {created ? (
                        <span className="muted">—</span>
                      ) : p?.payment ? (
                        <>
                          {money(p.payment.amount)}{" "}
                          <span className="muted">
                            {p.payment.customerName ? `· ${p.payment.customerName}` : ""} · {p.payment.privateNote}
                          </span>
                        </>
                      ) : (
                        <span className="muted">{p ? "not found" : "run locate"}</span>
                      )}
                    </td>
                    <td>{overShort === null ? "" : money(overShort)}</td>
                    <td>
                      {created ? (
                        <span className="badge ok">{RowStatus.DepositCreated}</span>
                      ) : ready ? (
                        <span className="badge ok">ready</span>
                      ) : p ? (
                        <span className="badge warn" title={latestMsg.get(r.id)}>needs review</span>
                      ) : (
                        <span className="badge muted">pending locate</span>
                      )}
                    </td>
                    <td>
                      {editable && ready && accountsReady && (
                        <form action={createCashDepositAction}>
                          <input type="hidden" name="rowId" value={r.id} />
                          <button className="btn" type="submit">Create deposit</button>
                        </form>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="muted" style={{ marginTop: "1rem", fontSize: "0.85rem" }}>
        After you create a deposit here, open QuickBooks → the Chase Checking bank feed and confirm the matching deposit
        line (it should already be suggested). The hub records the deposit id against the row and never creates it twice.
      </p>
    </>
  );
}
