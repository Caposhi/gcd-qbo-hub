import Link from "next/link";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/roles";
import { RequireAuth } from "../components/RequireAuth";
import { askQuestionAction, importAskMyClientAction } from "./actions";
import { askMyClientAccountName } from "@/lib/coworker/qbo";
import { CoworkerBoard, type BoardQuestion } from "./CoworkerBoard";

export const dynamic = "force-dynamic";

const STATUSES = ["open", "answered", "closed"] as const;

/** Render the outcome of a just-run import (from the ?import= redirect). */
function ImportNotice({ status, accountName }: { status?: string; accountName: string }) {
  if (!status) return null;
  if (status.startsWith("ok:")) {
    const [, created, updated, closed, removed, found] = status.split(":");
    return (
      <div className="notice info" style={{ marginBottom: 16 }}>
        Imported from QuickBooks — <strong>{created}</strong> new, {updated} updated, {closed} auto-closed,
        {" "}{removed} removed (from {found} parked {found === "1" ? "transaction" : "transactions"} in
        {" "}&ldquo;{accountName}&rdquo;).
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
      <Link href="/cash-sheet-sync/settings">Settings &amp; rollout</Link> → <strong>Reconnect QBO</strong>, then import again.
      {" "}If reconnecting doesn&apos;t help, open{" "}
      <Link href="/cash-sheet-sync/diagnostics">QBO diagnostics</Link>.</>
    ),
    account_not_found: (
      <>No QuickBooks account named &ldquo;{accountName}&rdquo; was found. Check the exact name with{" "}
      <Link href="/cash-sheet-sync/diagnostics">QBO diagnostics</Link>, or set{" "}
      <code>COWORKER_QBO_ACCOUNT_NAME</code> to match it.</>
    ),
    qbo_error: (
      <>QuickBooks is connected, but it rejected the request (an API error, not a token problem). Open{" "}
      <Link href="/cash-sheet-sync/diagnostics">QBO diagnostics</Link> to see the exact error.</>
    ),
    error: (
      <>The import hit an unexpected error. Open{" "}
      <Link href="/cash-sheet-sync/diagnostics">QBO diagnostics</Link> for details, or check the server logs.</>
    ),
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
      include: { answers: { orderBy: { createdAt: "asc" } } },
    }),
    prisma.cwpQuestion.groupBy({
      by: ["status"],
      where: scope,
      _count: { _all: true },
    }),
  ]);

  const countBy = (s: string) =>
    counts.find((c) => c.status === s)?._count._all ?? 0;

  const canAnswer = can(user.role, "answer_coworker_questions");

  // Serialize to plain, client-safe data (Dates → ISO strings, Decimal → number).
  const boardQuestions: BoardQuestion[] = questions.map((q) => ({
    id: q.id,
    subject: q.subject,
    body: q.body,
    status: q.status,
    askedByEmail: q.askedByEmail,
    assignedEmail: q.assignedEmail,
    source: q.source,
    qboReference: q.qboReference,
    relatedRowId: q.relatedRowId,
    qboTxnDate: q.qboTxnDate,
    qboTxnType: q.qboTxnType,
    qboTxnName: q.qboTxnName,
    createdAt: q.createdAt.toISOString(),
    answers: q.answers.map((a) => ({
      id: a.id,
      body: a.body,
      answeredByEmail: a.answeredByEmail,
      createdAt: a.createdAt.toISOString(),
    })),
  }));

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

      <CoworkerBoard questions={boardQuestions} canAnswer={canAnswer} canClose={canAsk} />

      {canAsk && (
        <details className="card" style={{ marginTop: "24px" }}>
          <summary style={{ cursor: "pointer", fontWeight: 600, color: "var(--text-strong)" }}>
            Ask a question
          </summary>
          <p className="card-subtitle" style={{ marginTop: "8px" }}>
            Raise a question manually (not tied to an imported transaction).
          </p>
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
        </details>
      )}
    </>
  );
}
