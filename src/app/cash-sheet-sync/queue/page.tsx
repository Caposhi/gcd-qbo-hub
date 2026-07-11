import Link from "next/link";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";
import { RequireAuth } from "../../components/RequireAuth";
import { RowStatus } from "@/lib/cashsheet/status";
import { MONTH_TABS, canonicalMonthTab } from "@/lib/cashsheet/config";

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

const MONTH_FULL = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

function money(v: unknown): string {
  if (v === null || v === undefined) return "";
  return `$${Number(v).toFixed(2)}`;
}

/** Strip $ and commas, lowercase, collapse whitespace — for tolerant matching. */
function normalizeSearch(s: string): string {
  return s.replace(/[$,]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

type Row = Awaited<ReturnType<typeof prisma.sheetRow.findMany>>[number];

/** Every searchable representation of a row, joined + normalized. */
function haystack(r: Row): string {
  const tokens: string[] = [
    r.tabName,
    String(r.rowNumberLastSeen),
    r.rcvByOrPaidTo ?? "",
    r.name ?? "",
    r.purpose ?? "",
    r.invNumber ?? "",
    r.status,
    r.statusReason ?? "",
    r.qboTransactionId ?? "",
    r.qboTransactionType ?? "",
  ];
  if (r.date) {
    const y = r.date.getUTCFullYear();
    const m = r.date.getUTCMonth(); // 0-based
    const d = r.date.getUTCDate();
    tokens.push(
      r.date.toISOString().slice(0, 10), // 2026-07-09
      `${m + 1}/${d}/${y}`, // 7/9/2026
      `${String(m + 1).padStart(2, "0")}/${String(d).padStart(2, "0")}/${y}`, // 07/09/2026
      MONTH_TABS[m], // Jul
      MONTH_FULL[m], // july
      String(y)
    );
  }
  for (const amt of [r.amtCollected, r.amountPaidOut, r.bankDeposit]) {
    if (amt !== null && amt !== undefined) {
      const n = Number(amt);
      tokens.push(n.toFixed(2)); // 1080.00 (also matches "1080")
    }
  }
  return normalizeSearch(tokens.join(" | "));
}

export default async function QueuePage({
  searchParams,
}: {
  searchParams: { status?: string; tab?: string; q?: string };
}) {
  const user = await getSessionUser();
  if (!user) return <RequireAuth />;

  const activeTab = searchParams.tab ?? "";
  const activeStatus = searchParams.status ?? "";
  const q = searchParams.q ?? "";

  const where: Record<string, unknown> = {};
  if (activeStatus) where.status = activeStatus;
  if (activeTab) where.tabName = activeTab;

  // Month tabs: the distinct tab names present, ordered Jan→Dec.
  const distinctTabs = await prisma.sheetRow.findMany({
    distinct: ["tabName"],
    select: { tabName: true },
  });
  const monthTabs = distinctTabs
    .map((t) => t.tabName)
    .sort((a, b) => {
      const ia = MONTH_TABS.indexOf(canonicalMonthTab(a) ?? "");
      const ib = MONTH_TABS.indexOf(canonicalMonthTab(b) ?? "");
      return ia - ib;
    });

  const fetched = await prisma.sheetRow.findMany({
    where,
    orderBy: [{ tabName: "asc" }, { rowNumberLastSeen: "asc" }],
    take: 3000,
  });

  // Tolerant, multi-term search across every field (AND of space-separated terms).
  const terms = normalizeSearch(q).split(" ").filter(Boolean);
  const filtered = terms.length
    ? fetched.filter((r) => {
        const hay = haystack(r);
        return terms.every((t) => hay.includes(t));
      })
    : fetched;
  const rows = filtered.slice(0, 500);

  const statuses = Object.values(RowStatus);

  // Build an href that keeps the other filters when switching one.
  const hrefWith = (over: { tab?: string | null; status?: string; q?: string }) => {
    const p = new URLSearchParams();
    const tab = over.tab === undefined ? activeTab : over.tab ?? "";
    const status = over.status === undefined ? activeStatus : over.status;
    const query = over.q === undefined ? q : over.q;
    if (tab) p.set("tab", tab);
    if (status) p.set("status", status);
    if (query) p.set("q", query);
    const s = p.toString();
    return `/cash-sheet-sync/queue${s ? `?${s}` : ""}`;
  };

  return (
    <>
      <h1>Cash Sheet Queue</h1>
      <p className="sub">
        Every scanned row and its status. Pick a month tab, or search any field. Click a row for its full audit detail.
      </p>

      {/* Month tabs */}
      <div className="month-tabs" style={tabsWrap}>
        <Link href={hrefWith({ tab: null })} className="btn secondary" style={tabStyle(activeTab === "")}>
          All
        </Link>
        {monthTabs.map((t) => (
          <Link key={t} href={hrefWith({ tab: t })} className="btn secondary" style={tabStyle(activeTab === t)}>
            {t}
          </Link>
        ))}
      </div>

      {/* Search + status */}
      <form method="get" className="row-actions" style={{ marginTop: "0.75rem" }}>
        {activeTab && <input type="hidden" name="tab" value={activeTab} />}
        <input
          name="q"
          placeholder="Search amount, name, INV#, QBO txn, date, row…"
          defaultValue={q}
          style={{ ...selStyle, minWidth: 320 }}
        />
        <select name="status" defaultValue={activeStatus} style={selStyle}>
          <option value="">All statuses</option>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button className="btn secondary" type="submit">Search</button>
        <Link className="btn secondary" href="/cash-sheet-sync/queue">Clear</Link>
      </form>

      <p className="muted" style={{ fontSize: "0.85rem" }}>
        {filtered.length} row{filtered.length === 1 ? "" : "s"}
        {activeTab ? ` in ${activeTab}` : ""}
        {q ? ` matching “${q}”` : ""}
        {activeStatus ? ` · ${activeStatus}` : ""}.
      </p>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Tab</th><th>Row</th><th>Date</th><th>Rcv/Paid</th><th>Name</th><th>Purpose</th>
              <th>INV#</th><th>Collected</th><th>Paid Out</th><th>Deposit</th><th>Status</th><th>QBO Txn</th>
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
                  No rows match. {fetched.length === 0 ? "Run a dry-run from the overview to populate the queue." : "Try a different search or month."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {filtered.length > 500 && (
        <p className="muted">Showing the first 500 of {filtered.length} — narrow with a month tab or search.</p>
      )}
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

const tabsWrap: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.4rem",
};

function tabStyle(active: boolean): React.CSSProperties {
  return active
    ? { borderColor: "var(--accent)", color: "var(--accent)", fontWeight: 700 }
    : {};
}
