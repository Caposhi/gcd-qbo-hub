import Link from "next/link";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/roles";
import { RequireAuth } from "../components/RequireAuth";
import { askQuestionAction } from "./actions";

export const dynamic = "force-dynamic";

const STATUS_CLASS: Record<string, string> = {
  open: "warn",
  answered: "ok",
  closed: "muted",
};

const STATUSES = ["open", "answered", "closed"] as const;

export default async function CoworkerPortalPage({
  searchParams,
}: {
  searchParams: { status?: string };
}) {
  const user = await getSessionUser();
  if (!user) return <RequireAuth />;

  const canAsk = can(user.role, "ask_coworker_questions");
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
      <h1>Coworker Portal</h1>
      <p className="sub">
        &ldquo;Ask My Client&rdquo; — questions about specific transactions.
        Owners and reviewers raise questions; coworkers answer the ones directed
        at them.
      </p>

      <div className="tiles">
        <div className="tile">
          <span className="badge warn">open</span>
          <strong>{countBy("open")}</strong>
        </div>
        <div className="tile">
          <span className="badge ok">answered</span>
          <strong>{countBy("answered")}</strong>
        </div>
        <div className="tile">
          <span className="badge muted">closed</span>
          <strong>{countBy("closed")}</strong>
        </div>
      </div>

      <div className="row-actions">
        {STATUSES.map((s) => (
          <Link
            key={s}
            className="btn secondary"
            href={`/coworker-portal?status=${s}`}
          >
            {s}
          </Link>
        ))}
        <Link className="btn secondary" href="/coworker-portal?status=all">
          all
        </Link>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Subject</th>
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
                <td colSpan={5} className="muted">
                  No questions match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {canAsk ? (
        <div className="card" style={{ marginTop: "1.5rem" }}>
          <h2>Ask a question</h2>
          <form action={askQuestionAction}>
            <div className="grid">
              <label>
                Subject
                <input name="subject" required style={inputStyle} />
              </label>
              <label>
                Assigned to (email)
                <input name="assignedEmail" type="email" style={inputStyle} />
                <span className="muted sub">leave blank for the general pool</span>
              </label>
              <label>
                QBO reference (optional)
                <input name="qboReference" style={inputStyle} />
              </label>
              <label>
                Related row id (optional)
                <input name="relatedRowId" style={inputStyle} />
              </label>
            </div>
            <label>
              Question
              <textarea name="body" required rows={4} style={{ ...inputStyle, width: "100%" }} />
            </label>
            <div className="row-actions">
              <button className="btn" type="submit">
                Post question
              </button>
            </div>
          </form>
        </div>
      ) : (
        <p className="muted" style={{ marginTop: "1.5rem" }}>
          You answer questions assigned to you — open one from the list above to
          respond.
        </p>
      )}
    </>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "0.4rem",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--panel-2)",
  color: "var(--text)",
  display: "block",
  width: "100%",
};
