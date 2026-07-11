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
  alreadyDeposited?: boolean;
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

  const accountsReady = !!accounts.depositToId && !!accounts.overShortId;

  // Last locate breadcrumb (visible feedback even for a zero-result run).
  const lastLocate = await prisma.rowEvent.findFirst({
    where: { eventType: "cash_deposit_locate_summary" },
    orderBy: { createdAt: "desc" },
  });

  return (
    <>
      <h1>Cash Deposit Matching</h1>
      <p className="sub">
        Customer invoice cash (INV rows with an RO# and a Collected amount) whose Customer Payment already sits in
        Undeposited Funds. The hub finds that payment by RO# and builds the exact QBO Bank Deposit <strong>into Cash on
        hand</strong> that clears it out of Undeposited Funds — the payment plus a small <em>Cash over/short</em> plug
        when the collected amount differs from the payment by rounding (e.g. sheet $241.00 vs payment $240.74 → +$0.26).
        Nothing posts until you click <strong>Create deposit</strong> on a row, and only when it ties out.
      </p>
      <p className="badge warn" style={{ display: "block", padding: "0.5rem 0.75rem" }}>
        Safety: rows whose payment is <em>already</em> on a QBO deposit are marked “already deposited” and offer no
        Create button, so a payment can never be deposited twice. Still, create deposits deliberately — start with the
        current pending rows rather than mass-creating the historical backlog, in case older months were reconciled a
        different way.
      </p>

      {!accountsReady && (
        <p className="badge danger">
          Account mapping incomplete — need both “Cash on hand” ({accounts.depositToId ?? "unresolved"}) and “Cash
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

      {lastLocate && (
        <p className="muted" style={{ fontSize: "0.8rem", marginTop: "-0.25rem" }}>
          Last locate: {lastLocate.eventMessage} · {lastLocate.createdAt.toISOString().replace("T", " ").slice(0, 19)} UTC
        </p>
      )}

      {rows.length === 0 ? (
        <p className="muted">
          No candidate rows. These appear once a sync has scanned INV rows that carry an RO# and a Collected amount and
          haven&apos;t been deposited yet.
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tab</th><th>Row</th><th>Date</th><th>Name</th><th>INV#/RO</th><th>Collected</th>
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
                    <td>{money(r.amtCollected)}</td>
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
                      ) : p?.alreadyDeposited ? (
                        <span className="badge muted" title={latestMsg.get(r.id)}>already deposited</span>
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
        Each deposit posts into Cash on hand and clears the customer payment out of Undeposited Funds (it does not touch
        the bank feed — moving the envelope cash to Chase is the separate Bank Deposit transfer). The hub records the
        deposit id against the row and never creates it twice; rows already deposited in QBO are marked accordingly.
      </p>
    </>
  );
}
