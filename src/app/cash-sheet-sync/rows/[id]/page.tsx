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
  archiveRowAction,
  unarchiveRowAction,
  setPurposeOverrideAction,
} from "../../actions";
import { qboWebUrl } from "@/lib/qbo/links";

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

  // Cell-change history: every edit detected across daily syncs (§11) — both
  // the per-sync `row_changed` events and any `changed_after_posting` alert.
  const changeEvents = row.events.filter(
    (e) => e.eventType === "row_changed" || e.eventType === "changed_after_posting"
  );

  return (
    <>
      <p className="card-subtitle" style={{ marginBottom: 6 }}>
        <Link href="/cash-sheet-sync/queue">← Queue</Link>
      </p>
      <div className="accent-bar" />
      <h1>
        {row.tabName} · Row {row.rowNumberLastSeen}{" "}
        <span className="badge muted">{row.status}</span>
      </h1>
      <p className="page-desc">GCD Row ID: <code>{row.rowUuid}</code></p>

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
      {row.archived && (
        <div className="notice">
          <strong>Archived</strong> {row.archivedAt?.toISOString().slice(0, 16).replace("T", " ")} by{" "}
          {row.archivedByEmail ?? "the sync engine (auto)"} — {row.archivedReason}. Hidden from the Queue and
          Deposits pages by default; never posted to QBO.
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))", gap: 16, marginTop: 16 }}>
        <div className="card">
          <h3 className="card-title" style={{ marginBottom: 12 }}>Current snapshot</h3>
          <dl className="kv">
            <dt>Date</dt><dd>{row.date?.toISOString().slice(0, 10)}</dd>
            <dt>Rcv by / paid to</dt><dd>{row.rcvByOrPaidTo}</dd>
            <dt>Name (payee)</dt><dd>{row.name}</dd>
            <dt>Purpose</dt><dd>{row.purpose}</dd>
            {row.purposeOverride && (
              <>
                <dt>Purpose override</dt>
                <dd>
                  {row.purposeOverride}{" "}
                  <span className="card-subtitle">
                    (internal only, set by {row.purposeOverrideByEmail} — not written to the sheet)
                  </span>
                </dd>
              </>
            )}
            <dt>INV#</dt><dd>{row.invNumber}</dd>
            <dt>Approved By (sheet)</dt><dd>{row.approvedBy}</dd>
            <dt>Amt Collected</dt><dd>{fmt(row.amtCollected)}</dd>
            <dt>Amount Paid Out</dt><dd>{fmt(row.amountPaidOut)}</dd>
            <dt>Bank Deposit</dt><dd>{fmt(row.bankDeposit)}</dd>
            <dt>First seen</dt><dd>{row.firstSeenAt.toISOString()}</dd>
            <dt>Last seen</dt><dd>{row.lastSeenAt.toISOString()}</dd>
            <dt>Status reason</dt><dd>{row.statusReason}</dd>
          </dl>
        </div>

        {row.qboTransactionId && (() => {
          // The environment lives on the QboTransaction record, not the row —
          // match by transaction id (there's normally exactly one per row; a
          // row is never re-posted, §10).
          const txn = row.transactions.find((t) => t.qboTransactionId === row.qboTransactionId) ?? row.transactions[0];
          const webUrl = qboWebUrl(row.qboTransactionType, row.qboTransactionId, txn?.qboEnvironment as "sandbox" | "live" | undefined);
          return (
            <div className="card">
              <h3 className="card-title" style={{ marginBottom: 12 }}>QBO transaction</h3>
              <dl className="kv">
                <dt>Transaction ID</dt><dd>{row.qboTransactionId}</dd>
                <dt>Type</dt><dd>{row.qboTransactionType}</dd>
                <dt>Posted at</dt><dd>{row.qboPostedAt?.toISOString()}</dd>
              </dl>
              {webUrl && (
                <p style={{ marginTop: 12 }}>
                  <a className="btn secondary" href={webUrl} target="_blank" rel="noopener noreferrer">
                    View in QBO ↗
                  </a>
                </p>
              )}
              <p className="card-subtitle" style={{ marginTop: 12 }}>
                The original posted snapshot is preserved for audit; QBO is never auto-edited.
              </p>
            </div>
          );
        })()}
      </div>

      {changeEvents.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3 className="card-title" style={{ marginBottom: 4 }}>Change history</h3>
          <p className="card-subtitle" style={{ marginTop: 0, marginBottom: 14 }}>
            Cell edits detected across daily syncs. QBO is never auto-edited in response — these are audit signals only.
          </p>
          <div style={{ display: "grid", gap: 14 }}>
            {changeEvents.map((e) => {
              const diffs = extractDiffs(e.diffJson);
              const posted = e.eventType === "changed_after_posting";
              return (
                <div
                  key={e.id}
                  style={{
                    borderLeft: `3px solid ${posted ? "var(--danger, #c0392b)" : "var(--royal-blue, #2b5fd0)"}`,
                    paddingLeft: 12,
                  }}
                >
                  <p className="card-subtitle" style={{ margin: "0 0 6px" }}>
                    <span className={`badge ${posted ? "danger" : "muted"}`}>
                      {posted ? "changed after posting" : "edited"}
                    </span>{" "}
                    {e.createdAt.toISOString()}
                  </p>
                  {diffs.length > 0 ? (
                    <table className="gcd" style={{ fontSize: 13 }}>
                      <thead>
                        <tr><th>Field</th><th>Was</th><th>Now</th></tr>
                      </thead>
                      <tbody>
                        {diffs.map((d, i) => (
                          <tr key={`${e.id}-${i}`}>
                            <td>{d.field}</td>
                            <td style={{ color: "var(--text-muted, #777)" }}>{renderVal(d.oldValue)}</td>
                            <td style={{ fontWeight: 600 }}>{renderVal(d.newValue)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="card-subtitle" style={{ margin: 0 }}>{e.eventMessage}</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <h2 style={{ fontSize: 18, margin: "24px 0 10px" }}>Actions</h2>
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
          <button className="btn primary" disabled={!can(user.role, "approve_posting") || !!row.approvedAt}>
            {row.approvedAt ? `Approved by ${row.approvedByEmail}` : "Approve for posting"}
          </button>
        </form>
      </div>
      {!can(user.role, "approve_posting") && (
        <p className="card-subtitle" style={{ marginTop: 10 }}>Approving a posting requires the owner_admin role (§14).</p>
      )}

      {!row.purpose && !row.qboTransactionId && can(user.role, "override_purpose") && (
        <div className="card" style={{ marginTop: 12 }}>
          <h3 className="card-title" style={{ marginBottom: 8 }}>Internal purpose override</h3>
          <p className="card-subtitle" style={{ marginTop: 0, marginBottom: 10 }}>
            The sheet's Purpose cell is blank on this row. Set an internal purpose here to classify it — it resolves
            through the same mapping table a sheet purpose would (Mappings page), it's just never written back to the
            sheet. Saving runs a dry-run reclassification right away so you can see whether it worked (e.g. moved to
            Unknown Purpose means the purpose text still needs a mapping) — a dry run never posts to QBO, so actually
            posting this row still needs a deliberate "Run sync now".
          </p>
          <form action={setPurposeOverrideAction.bind(null, row.id)} className="row-actions">
            <input
              className="input"
              name="purposeOverride"
              defaultValue={row.purposeOverride ?? ""}
              placeholder='e.g. "JR SRVCS" — must match an active purpose mapping'
              style={{ minWidth: 280 }}
            />
            <button className="btn primary" type="submit">
              {row.purposeOverride ? "Update override" : "Set override"}
            </button>
          </form>
          {row.purposeOverride && (
            <form action={setPurposeOverrideAction.bind(null, row.id)} style={{ marginTop: 8 }}>
              <input type="hidden" name="purposeOverride" value="" />
              <button className="btn ghost" type="submit">Clear override</button>
            </form>
          )}
        </div>
      )}

      {!row.qboTransactionId && can(user.role, "archive_row") && (
        <div className="card" style={{ marginTop: 12 }}>
          {row.archived ? (
            <form action={unarchiveRowAction.bind(null, row.id)} className="row-actions">
              <button className="btn secondary" type="submit">Unarchive — bring back into the Queue</button>
            </form>
          ) : (
            <form action={archiveRowAction.bind(null, row.id)} className="row-actions">
              <input
                className="input"
                name="reason"
                placeholder="Why archive this row? (e.g. edited/superseded, will never resolve)"
                style={{ minWidth: 340 }}
              />
              <button className="btn ghost" type="submit">Archive — hide from Queue &amp; Deposits</button>
            </form>
          )}
          <p className="card-subtitle" style={{ marginTop: 8, marginBottom: 0 }}>
            Archiving never touches QBO or deletes this row — it only hides a never-posted row from the default
            views. Only available because this row has no QBO transaction; a posted row can never be archived.
          </p>
        </div>
      )}

      <h2 style={{ fontSize: 18, margin: "24px 0 10px" }}>Sync events</h2>
      <div className="table-wrap">
        <table className="gcd">
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
              <tr><td colSpan={3} className="card-subtitle">No events yet.</td></tr>
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

interface FieldDiff {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

/**
 * Normalize a RowEvent.diffJson into a flat list of field diffs. `row_changed`
 * events store the array directly; `changed_after_posting` events wrap it under
 * a `diff` key.
 */
function extractDiffs(diffJson: unknown): FieldDiff[] {
  if (!diffJson) return [];
  const raw = Array.isArray(diffJson)
    ? diffJson
    : (diffJson as { diff?: unknown }).diff;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (d): d is FieldDiff => !!d && typeof d === "object" && "field" in d
  );
}

function renderVal(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  return String(v);
}
