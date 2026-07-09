import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/roles";
import { RequireAuth } from "../../components/RequireAuth";
import {
  answerQuestionAction,
  closeQuestionAction,
  reopenQuestionAction,
} from "../actions";

export const dynamic = "force-dynamic";

const STATUS_CLASS: Record<string, string> = {
  open: "warn",
  answered: "ok",
  closed: "muted",
};

export default async function QuestionDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const user = await getSessionUser();
  if (!user) return <RequireAuth />;

  const question = await prisma.cwpQuestion.findUnique({
    where: { id: params.id },
    include: { answers: { orderBy: { createdAt: "asc" } } },
  });
  if (!question) return notFound();

  // Coworkers may only view questions assigned to them (or the unassigned pool).
  if (
    user.role === "coworker" &&
    question.assignedEmail &&
    question.assignedEmail !== user.email
  ) {
    return (
      <>
        <p>
          <Link href="/coworker-portal">← Coworker Portal</Link>
        </p>
        <div className="notice danger">
          This question is not assigned to you.
        </div>
      </>
    );
  }

  const canAnswer = can(user.role, "answer_coworker_questions");
  const canAsk = can(user.role, "ask_coworker_questions");

  return (
    <>
      <p>
        <Link href="/coworker-portal">← Coworker Portal</Link>
      </p>
      <h1>
        {question.subject}{" "}
        <span className={`badge ${STATUS_CLASS[question.status] ?? "muted"}`}>
          {question.status}
        </span>
      </h1>

      <dl className="kv">
        <dt>Question</dt><dd>{question.body}</dd>
        <dt>Asked by</dt><dd>{question.askedByEmail}</dd>
        <dt>Assigned to</dt>
        <dd>{question.assignedEmail ?? <span className="muted">general pool</span>}</dd>
        {question.qboReference && (
          <>
            <dt>QBO reference</dt><dd>{question.qboReference}</dd>
          </>
        )}
        {question.relatedRowId && (
          <>
            <dt>Related row id</dt><dd><code>{question.relatedRowId}</code></dd>
          </>
        )}
        <dt>Created</dt><dd>{question.createdAt.toISOString()}</dd>
      </dl>

      <h2>Answers</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>When</th><th>By</th><th>Answer</th></tr>
          </thead>
          <tbody>
            {question.answers.map((a) => (
              <tr key={a.id}>
                <td>{a.createdAt.toISOString()}</td>
                <td>{a.answeredByEmail}</td>
                <td>{a.body}</td>
              </tr>
            ))}
            {question.answers.length === 0 && (
              <tr><td colSpan={3} className="muted">No answers yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {canAnswer && question.status !== "closed" && (
        <div className="card" style={{ marginTop: "1.5rem" }}>
          <h2>Answer this question</h2>
          <form action={answerQuestionAction.bind(null, question.id)}>
            <textarea name="body" required rows={4} style={textareaStyle} />
            <div className="row-actions">
              <button className="btn" type="submit">
                Post answer
              </button>
            </div>
          </form>
        </div>
      )}

      {canAsk && (
        <div className="row-actions" style={{ marginTop: "1.5rem" }}>
          {question.status !== "closed" && (
            <form action={closeQuestionAction.bind(null, question.id)}>
              <button className="btn secondary" type="submit">
                Close question
              </button>
            </form>
          )}
          {question.status === "closed" && (
            <form action={reopenQuestionAction.bind(null, question.id)}>
              <button className="btn secondary" type="submit">
                Reopen question
              </button>
            </form>
          )}
        </div>
      )}
    </>
  );
}

const textareaStyle: React.CSSProperties = {
  padding: "0.4rem",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--panel-2)",
  color: "var(--text)",
  width: "100%",
};
