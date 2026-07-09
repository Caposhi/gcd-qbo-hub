import Link from "next/link";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";
import { RequireAuth } from "../../components/RequireAuth";
import { RowStatus } from "@/lib/cashsheet/status";

export const dynamic = "force-dynamic";

const STATUS_CLASS: Record<string, string> = {
  [RowStatus.Posted]: "ok",
  [RowStatus.PostedWithWarning]: "warn",
  [RowStatus.Error]: "danger",
  [RowStatus.ChangedAfterPosting]: "danger",
  [RowStatus.RemovedFromSheetAfterPosting]: "danger",
  [RowStatus.PossibleDuplicate]: "warn",
  [RowStatus.DuplicateRowId]: "warn",
  [RowStatus.UnknownPurpose]: "warn",
  [RowStatus.MissingAccountMapping]: "warn",
};

function money(v: unknown): string {
  if (v === null || v === undefined) return "";
  return `$${Number(v).toFixed(2)}`;
}

export default async function QueuePage({
  searchParams,
}: {
  searchParams: { status?: string; tab?: string };
}) {
  const user = await getSessionUser();
  if (!user) return <RequireAuth />;

  const where: Record<string, unknown> = {};
  if (searchParams.status) where.status = searchParams.status;
  if (searchParams.tab) where.tabName = searchParams.tab;

  const rows = await prisma.sheetRow.findMany({
    where,
    orderBy: [{ tabName: "asc" }, { rowNumberLastSeen: "asc" }],
    take: 500,
  });

  const statuses = Object.values(RowStatus);

  return (
    <>
      <h1>Cash Sheet Queue</h1>
      <p className="sub">
        Every scanned row and its status. Filter by status or month tab. Click a row for its full audit detail.
      </p>

      <form method="get" className="row-actions">
        <select name="status" defaultValue={searchParams.status ?? ""} style={selStyle}>
          <option value="">All statuses</option>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input name="tab" placeholder="Month tab (e.g. Jul)" defaultValue={searchParams.tab ?? ""} style={selStyle} />
        <button className="btn secondary" type="submit">
          Filter
        </button>
        <Link className="btn secondary" href="/cash-sheet-sync/queue">
          Clear
        </Link>
      </form>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Tab</th>
              <th>Row</th>
              <th>Date</th>
              <th>Rcv/Paid</th>
              <th>Name</th>
              <th>Purpose</th>
              <th>INV#</th>
              <th>Collected</th>
              <th>Paid Out</th>
              <th>Deposit</th>
              <th>Status</th>
              <th>QBO Txn</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.tabName}</td>
                <td>
                  <Link href={`/cash-sheet-sync/rows/${r.id}`}>{r.rowNumberLastSeen}</Link>
                </td>
                <td>{r.date ? r.date.toISOString().slice(0, 10) : ""}</td>
                <td>{r.rcvByOrPaidTo}</td>
                <td>{r.name}</td>
                <td>{r.purpose}</td>
                <td>{r.invNumber}</td>
                <td>{money(r.amtCollected)}</td>
                <td>{money(r.amountPaidOut)}</td>
                <td>{money(r.bankDeposit)}</td>
                <td>
                  <span className={`badge ${STATUS_CLASS[r.status] ?? "muted"}`}>{r.status}</span>
                </td>
                <td>{r.qboTransactionId ?? ""}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={12} className="muted">
                  No rows match. Run a dry-run from the overview to populate the queue.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {rows.length === 500 && <p className="muted">Showing the first 500 rows — narrow the filter to see more.</p>}
    </>
  );
}

const selStyle: React.CSSProperties = {
  padding: "0.4rem",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--panel-2)",
  color: "var(--text)",
};
