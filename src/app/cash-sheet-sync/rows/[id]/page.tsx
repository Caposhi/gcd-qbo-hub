import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/roles";
import { RequireAuth } from "../../../components/RequireAuth";
import {
  approveRowAction,
  markReviewedAction,
  recheckQboMatchAction,
} from "../../actions";

export const dynamic = "force-dynamic";

export default async function RowDetailPage({ params }: { params: { id: string } }) {
  const user = await getSessionUser();
  if (!user) return <RequireAuth />;

  const row = await prisma.sheetRow.findUnique({
    where: { id: params.id },
    include: {
      events: { orderBy: { createdAt: "desc" }, take: 50 },
      transactions: true,
    },
  });
  if (!row) return notFound();

  const changedEvent = row.events.find((e) => e.eventType === "changed_after_posting");

  return (
    <>
      <p>
        <Link href="/cash-sheet-sync/queue">← Queue</Link>
      </p>
      <h1>
        {row.tabName} · Row {row.rowNumberLastSeen}{" "}
        <span className="badge">{row.status}</span>
      </h1>
      <p className="sub">GCD Row ID: <code>{row.rowUuid}</code></p>

      {row.status === "Changed After Posting" && (
        <div className="notice danger">
          This row was edited AFTER it was posted to QBO. QBO was NOT modified (never auto-edited). Review the diff
          below.
        </div>
      )}
      {row.status === "Removed From Sheet After Posting" && (
        <div className="notice danger">
          This posted row disappeared from the sheet. QBO was NOT deleted. Investigate whether this was intentional.
        </div>
      )}

      <h2>Current snapshot</h2>
      <dl className="kv">
        <dt>Date</dt><dd>{row.date?.toISOString().slice(0, 10)}</dd>
        <dt>Rcv by / paid to</dt><dd>{row.rcvByOrPaidTo}</dd>
        <dt>Name (payee)</dt><dd>{row.name}</dd>
        <dt>Purpose</dt><dd>{row.purpose}</dd>
        <dt>INV#</dt><dd>{row.invNumber}</dd>
        <dt>Approved By (sheet)</dt><dd>{row.approvedBy}</dd>
        <dt>Amt Collected</dt><dd>{fmt(row.amtCollected)}</dd>
        <dt>Amount Paid Out</dt><dd>{fmt(row.amountPaidOut)}</dd>
        <dt>Bank Deposit</dt><dd>{fmt(row.bankDeposit)}</dd>
        <dt>First seen</dt><dd>{row.firstSeenAt.toISOString()}</dd>
        <dt>Last seen</dt><dd>{row.lastSeenAt.toISOString()}</dd>
        <dt>Status reason</dt><dd>{row.statusReason}</dd>
      </dl>

      {row.qboTransactionId && (
        <>
          <h2>QBO transaction</h2>
          <dl className="kv">
            <dt>Transaction ID</dt><dd>{row.qboTransactionId}</dd>
            <dt>Type</dt><dd>{row.qboTransactionType}</dd>
            <dt>Posted at</dt><dd>{row.qboPostedAt?.toISOString()}</dd>
          </dl>
          <p className="muted">The original posted snapshot is preserved for audit; QBO is never auto-edited.</p>
        </>
      )}

      {changedEvent?.diffJson != null && (
        <>
          <h2>Diff (original → current)</h2>
          <pre>{JSON.stringify((changedEvent.diffJson as { diff?: unknown }).diff ?? changedEvent.diffJson, null, 2)}</pre>
        </>
      )}

      <h2>Actions</h2>
      <div className="row-actions">
        {row.status === "Awaiting QBO Match" && (
          <form action={recheckQboMatchAction.bind(null, row.id)}>
            <button className="btn secondary" disabled={!can(user.role, "recheck_qbo_match")}>
              Recheck QBO match
            </button>
          </form>
        )}
        <form action={markReviewedAction.bind(null, row.id)}>
          <button className="btn secondary" disabled={!can(user.role, "mark_warning_reviewed")}>
            {row.reviewedAt ? "Reviewed ✓" : "Mark reviewed"}
          </button>
        </form>
        <form action={approveRowAction.bind(null, row.id)}>
          <button className="btn" disabled={!can(user.role, "approve_posting") || !!row.approvedAt}>
            {row.approvedAt ? `Approved by ${row.approvedByEmail}` : "Approve for posting"}
          </button>
        </form>
      </div>
      {!can(user.role, "approve_posting") && (
        <p className="muted">Approving a posting requires the owner_admin role (§14).</p>
      )}

      <h2>Sync events</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>When</th><th>Type</th><th>Message</th></tr>
          </thead>
          <tbody>
            {row.events.map((e) => (
              <tr key={e.id}>
                <td>{e.createdAt.toISOString()}</td>
                <td>{e.eventType}</td>
                <td>{e.eventMessage}</td>
              </tr>
            ))}
            {row.events.length === 0 && (
              <tr><td colSpan={3} className="muted">No events yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "";
  return `$${Number(v).toFixed(2)}`;
}
