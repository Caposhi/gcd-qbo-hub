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
      <div className="center">
        <div className="card" style={{ width: 420 }}>
          <h1>Not assigned to you</h1>
          <p className="card-subtitle">
            This question is not assigned to you.
          </p>
          <div className="row-actions">
            <Link className="btn secondary" href="/coworker-portal">
              Back to coworker portal
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const canAnswer = can(user.role, "answer_coworker_questions");
  const canAsk = can(user.role, "ask_coworker_questions");

  return (
    <>
      <p>
        <Link href="/coworker-portal">← Coworker portal</Link>
      </p>
      <div className="accent-bar" />
      <h1>
        {question.subject}{" "}
        <span className={`badge ${STATUS_CLASS[question.status] ?? "muted"}`}>
          {question.status}
        </span>
      </h1>
      <p className="page-desc">
        Asked by {question.askedByEmail} on{" "}
        {question.createdAt.toISOString().slice(0, 10)}.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 360px) 1fr",
          gap: "20px",
          alignItems: "start",
        }}
      >
        <div className="card">
          <h3 className="card-title">Question</h3>
          <p style={{ marginTop: "8px", color: "var(--text-body)" }}>
            {question.body}
          </p>
          <dl className="kv" style={{ marginTop: "16px" }}>
            <dt>Asked by</dt>
            <dd>{question.askedByEmail}</dd>
            <dt>Assigned to</dt>
            <dd>
              {question.assignedEmail ?? (
                <span className="muted">general pool</span>
              )}
            </dd>
            {question.qboReference && (
              <>
                <dt>QBO reference</dt>
                <dd>{question.qboReference}</dd>
              </>
            )}
            {question.relatedRowId && (
              <>
                <dt>Related row id</dt>
                <dd>
                  <code>{question.relatedRowId}</code>
                </dd>
              </>
            )}
            <dt>Created</dt>
            <dd>{question.createdAt.toISOString()}</dd>
          </dl>
        </div>

        <div>
          <h3 className="card-title">Answers</h3>
          {question.answers.map((a) => (
            <div key={a.id} className="card pad-sm" style={{ marginTop: "12px" }}>
              <div className="card-subtitle">
                {a.answeredByEmail} · {a.createdAt.toISOString()}
              </div>
              <p style={{ marginTop: "8px", color: "var(--text-body)" }}>
                {a.body}
              </p>
            </div>
          ))}
          {question.answers.length === 0 && (
            <div className="card pad-sm" style={{ marginTop: "12px" }}>
              <p className="card-subtitle">No answers yet.</p>
            </div>
          )}

          {canAnswer && question.status !== "closed" && (
            <div className="card" style={{ marginTop: "20px" }}>
              <h3 className="card-title">Answer this question</h3>
              <form action={answerQuestionAction.bind(null, question.id)}>
                <div className="field" style={{ marginTop: "16px" }}>
                  <label>Your answer</label>
                  <textarea name="body" required rows={4} className="input" />
                </div>
                <div className="row-actions">
                  <button className="btn primary" type="submit">
                    Post answer
                  </button>
                </div>
              </form>
            </div>
          )}

          {canAsk && (
            <div className="row-actions" style={{ marginTop: "20px" }}>
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
        </div>
      </div>
    </>
  );
}
