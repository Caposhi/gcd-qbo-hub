"use client";

/**
 * Coworker portal — live master/detail board (client).
 *
 * Left: a compact, fully-clickable list of the transactions/questions in the
 * current status filter. Right: the selected transaction's question bubble, an
 * answer box, and the answer history — all refreshed in place when another item
 * is clicked, no navigation. The first item is selected on load.
 *
 * Posting an answer flips the question open → answered server-side; since the
 * Open filter then drops it, the panel auto-advances to the next open item.
 * Only an owner can Close (or Reopen). All mutations go through the same gated
 * server actions the rest of the module uses — the client never trusts itself.
 */
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useFormStatus } from "react-dom";
import { answerQuestionAction, closeQuestionAction, reopenQuestionAction } from "./actions";

const STATUS_CLASS: Record<string, string> = { open: "warn", answered: "ok", closed: "muted" };

export interface BoardAnswer {
  id: string;
  body: string;
  answeredByEmail: string;
  createdAt: string; // ISO
}

export interface BoardQuestion {
  id: string;
  subject: string;
  body: string;
  status: string;
  askedByEmail: string;
  assignedEmail: string | null;
  source: string;
  qboReference: string | null;
  relatedRowId: string | null;
  qboTxnDate: string | null;
  qboTxnType: string | null;
  qboTxnName: string | null;
  createdAt: string; // ISO
  answers: BoardAnswer[];
}

/** "2026-07-14 17:51 UTC" from an ISO string (no raw ISO in the UI). */
function fmtDateTime(iso: string): string {
  return iso.slice(0, 16).replace("T", " ") + " UTC";
}

function SubmitButton({ children, className = "btn primary" }: { children: React.ReactNode; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button className={className} type="submit" disabled={pending}>
      {pending ? "Saving…" : children}
    </button>
  );
}

export function CoworkerBoard({
  questions,
  canAnswer,
  canClose,
}: {
  questions: BoardQuestion[];
  canAnswer: boolean;
  canClose: boolean;
}) {
  const router = useRouter();
  const answerFormRef = useRef<HTMLFormElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(questions[0]?.id ?? null);

  // Selection survives a server refresh: if the picked item left the current
  // filter (e.g. it was just answered and this is the Open tab), fall back to the
  // first remaining item — that's the auto-advance to the next open transaction.
  const selected = questions.find((q) => q.id === selectedId) ?? questions[0] ?? null;

  if (questions.length === 0) {
    return (
      <div className="card" style={{ marginTop: 16 }}>
        <p className="card-subtitle">No transactions match this filter.</p>
      </div>
    );
  }

  return (
    <div className="cwp-board" style={{ marginTop: 16 }}>
      {/* Left: clickable list */}
      <div className="cwp-list">
        {questions.map((q) => {
          const active = selected?.id === q.id;
          return (
            <button
              key={q.id}
              type="button"
              onClick={() => setSelectedId(q.id)}
              aria-pressed={active}
              className="cwp-item"
              data-active={active ? "true" : "false"}
            >
              <div className="cwp-item-top">
                <strong style={{ overflowWrap: "anywhere" }}>{q.subject}</strong>
                <span className={`badge ${STATUS_CLASS[q.status] ?? "muted"}`}>{q.status}</span>
              </div>
              <span className="card-subtitle">
                {q.qboTxnDate ?? q.createdAt.slice(0, 10)}
                {q.qboTxnType ? ` · ${q.qboTxnType}` : ""}
                {q.assignedEmail ? "" : " · general pool"}
              </span>
            </button>
          );
        })}
      </div>

      {/* Right: detail for the selected transaction */}
      {selected && (
        <div className="cwp-detail">
          {/* Question bubble */}
          <div className="card">
            <div className="cwp-item-top">
              <h3 className="card-title" style={{ marginTop: 0 }}>{selected.subject}</h3>
              <span className={`badge ${STATUS_CLASS[selected.status] ?? "muted"}`}>{selected.status}</span>
            </div>
            <p style={{ marginTop: 8, color: "var(--text-body)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {selected.body}
            </p>
            <dl className="kv" style={{ marginTop: 16 }}>
              <dt>Asked by</dt>
              <dd>{selected.askedByEmail}</dd>
              <dt>Assigned to</dt>
              <dd>{selected.assignedEmail ?? <span className="muted">general pool</span>}</dd>
              {selected.qboTxnName && (
                <>
                  <dt>Payee / name</dt>
                  <dd>{selected.qboTxnName}</dd>
                </>
              )}
              {selected.qboReference && (
                <>
                  <dt>QBO reference</dt>
                  <dd>{selected.qboReference}</dd>
                </>
              )}
              <dt>Created</dt>
              <dd>{fmtDateTime(selected.createdAt)}</dd>
            </dl>
          </div>

          {/* Answer box */}
          {canAnswer && selected.status !== "closed" && (
            <div className="card" style={{ marginTop: 16 }}>
              <h3 className="card-title" style={{ marginTop: 0 }}>Answer this transaction</h3>
              <form
                key={selected.id}
                ref={answerFormRef}
                action={async (fd) => {
                  await answerQuestionAction(selected.id, fd);
                  answerFormRef.current?.reset();
                  router.refresh();
                }}
              >
                <div className="field" style={{ marginTop: 12 }}>
                  <label>Your answer (the correct category / classification)</label>
                  <textarea name="body" required rows={4} className="input" />
                </div>
                <div className="row-actions">
                  <SubmitButton>Post answer</SubmitButton>
                </div>
              </form>
            </div>
          )}

          {/* Owner close / reopen */}
          {canClose && (
            <div className="row-actions" style={{ marginTop: 12 }}>
              {selected.status !== "closed" ? (
                <form
                  action={async () => {
                    await closeQuestionAction(selected.id);
                    router.refresh();
                  }}
                >
                  <SubmitButton className="btn secondary">Close question</SubmitButton>
                </form>
              ) : (
                <form
                  action={async () => {
                    await reopenQuestionAction(selected.id);
                    router.refresh();
                  }}
                >
                  <SubmitButton className="btn secondary">Reopen question</SubmitButton>
                </form>
              )}
            </div>
          )}

          {/* Answer history */}
          <h3 className="card-title" style={{ marginTop: 20 }}>History</h3>
          {selected.answers.length === 0 ? (
            <div className="card pad-sm" style={{ marginTop: 12 }}>
              <p className="card-subtitle">No answers yet.</p>
            </div>
          ) : (
            selected.answers.map((a) => (
              <div key={a.id} className="card pad-sm" style={{ marginTop: 12 }}>
                <div className="card-subtitle" style={{ overflowWrap: "anywhere" }}>
                  {a.answeredByEmail} · {fmtDateTime(a.createdAt)}
                </div>
                <p style={{ marginTop: 8, color: "var(--text-body)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                  {a.body}
                </p>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
