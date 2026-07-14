import Link from "next/link";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/roles";
import { RequireAuth } from "../components/RequireAuth";
import { askQuestionAction, importAskMyClientAction } from "./actions";
import { askMyClientAccountName } from "@/lib/coworker/qbo";

export const dynamic = "force-dynamic";

const STATUS_CLASS: Record<string, string> = {
  open: "warn",
  answered: "ok",
  closed: "muted",
};

const STATUSES = ["open", "answered", "closed"] as const;

/** Render the outcome of a just-run import (from the ?import= redirect). */
function ImportNotice({ status, accountName }: { status?: string; accountName: string }) {
  if (!status) return null;
  if (status.startsWith("ok:")) {
    const [, created, updated, closed, found] = status.split(":");
    return (
      <div className="notice info" style={{ marginBottom: 16 }}>
        Imported from QuickBooks — <strong>{created}</strong> new, {updated} updated, {closed} auto-closed
        (from {found} parked {found === "1" ? "transaction" : "transactions"} in &ldquo;{accountName}&rdquo;).
      </div>
    );
  }
  const messages: Record<string, React.ReactNode> = {
    not_connected: (
      <>QuickBooks isn&apos;t connected for this environment. Connect it in{" "}
      <Link href="/cash-sheet-sync/settings">Settings &amp; rollout</Link>, then import again.</>
    ),
    reconnect_required: (
      <>QuickBooks rejected the saved connection (its token expired/was revoked). Reconnect in{" "}
      <Link href="/cash-sheet-sync/settings">Settings &amp; rollout</Link> → <strong>Reconnect QBO</strong>, then import again.</>
    ),
    account_not_found: (
      <>No QuickBooks account named &ldquo;{accountName}&rdquo; was found. Check the name in QBO, or set{" "}
      <code>COWORKER_QBO_ACCOUNT_NAME</code> to match it.</>
    ),
    error: <>The import hit an unexpected error. Please try again; if it persists, check the server logs.</>,
  };
  return (
    <div className="notice warn" style={{ marginBottom: 16 }}>
      {messages[status] ?? "Import failed."}
    </div>
  );
}

export default async function CoworkerPortalPage({
  searchParams,
}: {
  searchParams: { status?: string; import?: string };
}) {
  const user = await getSessionUser();
  if (!user) return <RequireAuth />;

  const canAsk = can(user.role, "ask_coworker_questions");
  const canImport = can(user.role, "import_coworker_questions");
  const status = searchParams.status ?? "open";

  // Coworkers only see questions assigned to them or in the unassigned pool.
  const scope =
    user.role === "coworker"
      ? { OR: [{ assignedEmail: user.email }, { assignedEmail: null }] }
      : {};

  const where: Record<string, unknown> = { ...scope };
  if (status !== "all") where.status = status;

  const [questions, counts] = await Promise.all([
    prisma.cwpQuestion.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
    prisma.cwpQuestion.groupBy({
      by: ["status"],
      where: scope,
      _count: { _all: true },
    }),
  ]);

  const countBy = (s: string) =>
    counts.find((c) => c.status === s)?._count._all ?? 0;

  return (
    <>
      <div className="accent-bar" />
      <h1>Coworker portal</h1>
      <p className="page-desc">
        &ldquo;Ask My Client&rdquo; — questions about specific transactions.
        Owners and reviewers raise questions; coworkers answer the ones directed
        at them. Import pulls the transactions parked in the &ldquo;{askMyClientAccountName()}&rdquo;
        QuickBooks account (read-only) so each can be explained and re-coded in QBO.
      </p>

      <ImportNotice status={searchParams.import} accountName={askMyClientAccountName()} />

      {canImport && (
        <form action={importAskMyClientAction} className="row-actions" style={{ margin: "0 0 4px" }}>
          <button className="btn secondary" type="submit">↻ Import from QuickBooks</button>
          <span className="card-subtitle">
            Read-only — pulls parked transactions as questions; nothing is written to QuickBooks.
          </span>
        </form>
      )}

      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">Open</div>
          <div className="kpi-value">{countBy("open")}</div>
          <div className="kpi-foot">
            <span className="badge warn">open</span>
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Answered</div>
          <div className="kpi-value">{countBy("answered")}</div>
          <div className="kpi-foot">
            <span className="badge ok">answered</span>
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Closed</div>
          <div className="kpi-value">{countBy("closed")}</div>
          <div className="kpi-foot">
            <span className="badge muted">closed</span>
          </div>
        </div>
      </div>

      <div className="segmented">
        {STATUSES.map((s) => (
          <Link
            key={s}
            className={status === s ? "active" : ""}
            href={`/coworker-portal?status=${s}`}
          >
            {s}
          </Link>
        ))}
        <Link
          className={status === "all" ? "active" : ""}
          href="/coworker-portal?status=all"
        >
          all
        </Link>
      </div>

      <div className="table-wrap" style={{ marginTop: "16px" }}>
        <table className="gcd">
          <thead>
            <tr>
              <th>Subject</th>
              <th>Source</th>
              <th>Asked by</th>
              <th>Assigned to</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {questions.map((q) => (
              <tr key={q.id}>
                <td>
                  <Link href={`/coworker-portal/${q.id}`}>{q.subject}</Link>
                  {q.qboTxnDate && (
                    <span className="card-subtitle" style={{ display: "block" }}>
                      {q.qboTxnDate}
                      {q.qboReference ? ` · ${q.qboReference}` : ""}
                    </span>
                  )}
                </td>
                <td>
                  {q.source === "ask_my_client" ? (
                    <span className="badge info">QBO</span>
                  ) : (
                    <span className="badge muted">manual</span>
                  )}
                </td>
                <td>{q.askedByEmail}</td>
                <td>{q.assignedEmail ?? <span className="muted">general pool</span>}</td>
                <td>
                  <span className={`badge ${STATUS_CLASS[q.status] ?? "muted"}`}>
                    {q.status}
                  </span>
                </td>
                <td>{q.createdAt.toISOString().slice(0, 10)}</td>
              </tr>
            ))}
            {questions.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No questions match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {canAsk ? (
        <div className="card" style={{ marginTop: "24px" }}>
          <h3 className="card-title">Ask a question</h3>
          <form action={askQuestionAction}>
            <div className="grid" style={{ marginTop: "16px" }}>
              <div className="field">
                <label>Subject</label>
                <input name="subject" required className="input" />
              </div>
              <div className="field">
                <label>Assigned to (email)</label>
                <input name="assignedEmail" type="email" className="input" />
                <span className="card-subtitle">leave blank for the general pool</span>
              </div>
              <div className="field">
                <label>QBO reference (optional)</label>
                <input name="qboReference" className="input" />
              </div>
              <div className="field">
                <label>Related row id (optional)</label>
                <input name="relatedRowId" className="input" />
              </div>
            </div>
            <div className="field" style={{ marginTop: "16px" }}>
              <label>Question</label>
              <textarea name="body" required rows={4} className="input" />
            </div>
            <div className="row-actions">
              <button className="btn primary" type="submit">
                Post question
              </button>
            </div>
          </form>
        </div>
      ) : (
        <p className="card-subtitle" style={{ marginTop: "24px" }}>
          You answer questions assigned to you — open one from the list above to
          respond.
        </p>
      )}
    </>
  );
}
