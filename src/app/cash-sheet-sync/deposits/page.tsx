import Link from "next/link";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/roles";
import { RequireAuth } from "../../components/RequireAuth";
import { DateRangeFilter } from "../../components/DateRangeFilter";
import { RowStatus } from "@/lib/cashsheet/status";
import {
  findCashDepositCandidates,
  resolveDepositAccounts,
  alreadyHasDeposit,
} from "@/lib/cashsheet/cash-deposit-service";
import { resolveDateRange, dateRangeWhere, describeDateRange } from "@/lib/cashsheet/date-range";
import {
  locateCashDepositsAction,
  createCashDepositAction,
  createAllReadyCashDepositsAction,
  archiveRowAction,
} from "../actions";

export const dynamic = "force-dynamic";

function money(v: unknown): string {
  if (v === null || v === undefined) return "";
  return `$${Number(v).toFixed(2)}`;
}

interface PlanEvent {
  found?: boolean;
  reason?: string;
  ro?: string;
  depositedAmount?: number;
  alreadyDeposited?: boolean;
  payment?: { id: string; amount: number; privateNote: string; date: string; customerName?: string } | null;
  plan?: { paymentId: string; paymentCents: number; depositedCents: number; overShortCents: number; withinThreshold: boolean } | null;
}

export default async function CashDepositsPage({
  searchParams,
}: {
  searchParams: { range?: string; from?: string; to?: string };
}) {
  const user = await getSessionUser();
  if (!user) return <RequireAuth />;
  const editable = can(user.role, "approve_posting");
  const canArchive = can(user.role, "archive_row");
  const now = new Date();

  const activeRange = searchParams.range ?? "";
  const customFrom = searchParams.from ?? "";
  const customTo = searchParams.to ?? "";
  const resolvedRange = resolveDateRange(activeRange || undefined, { customFrom, customTo });
  const dateWhere = dateRangeWhere(resolvedRange);

  const [rows, accounts] = await Promise.all([findCashDepositCandidates(dateWhere), resolveDepositAccounts()]);
  const rowIds = rows.map((r) => r.id);

  // Latest plan/created event per row (for display).
  const events = rowIds.length
    ? await prisma.rowEvent.findMany({
        where: {
          sheetRowId: { in: rowIds },
          eventType: {
            in: [
              "cash_deposit_plan",
              "cash_deposit_created",
              "cash_deposit_blocked",
              "cash_deposit_error",
              "cash_deposit_locate_error",
            ],
          },
        },
        orderBy: { createdAt: "desc" },
      })
    : [];
  const latestPlan = new Map<string, PlanEvent>();
  const latestMsg = new Map<string, string>();
  // The most recent Create attempt outcome per row (so a blocked/failed create
  // is visible on the page instead of silently doing nothing).
  const createOutcome = new Map<string, { kind: "blocked" | "error"; msg: string }>();
  for (const e of events) {
    if (!e.sheetRowId) continue;
    if (!latestMsg.has(e.sheetRowId)) latestMsg.set(e.sheetRowId, `${e.eventType}: ${e.eventMessage}`);
    if (e.eventType === "cash_deposit_plan" && !latestPlan.has(e.sheetRowId)) {
      latestPlan.set(e.sheetRowId, (e.diffJson as PlanEvent) ?? {});
    }
    if (
      (e.eventType === "cash_deposit_blocked" || e.eventType === "cash_deposit_error") &&
      !createOutcome.has(e.sheetRowId)
    ) {
      createOutcome.set(e.sheetRowId, {
        kind: e.eventType === "cash_deposit_error" ? "error" : "blocked",
        msg: e.eventMessage ?? "",
      });
    }
  }

  const accountsReady = !!accounts.depositToId && !!accounts.overShortId;

  // Group into the three states a row can actually be in (§Phase 4) instead
  // of one flat table where "ready to act on now" and "will sit here for
  // months" look the same weight. Order within each group is preserved from
  // the query (oldest first), so "Needs review" surfaces the oldest backlog
  // first rather than burying it under this week's rows.
  const readyRows: typeof rows = [];
  const needsReviewRows: typeof rows = [];
  const resolvedRows: typeof rows = [];
  for (const r of rows) {
    const p = latestPlan.get(r.id);
    if (alreadyHasDeposit(r) || p?.alreadyDeposited) resolvedRows.push(r);
    else if (p?.found && p?.plan) readyRows.push(r);
    else needsReviewRows.push(r);
  }
  const readyCount = readyRows.length;

  /** Days between a row's date and now — for flagging a long-stale "needs review" row. */
  function ageDays(r: (typeof rows)[number]): number | null {
    if (!r.date) return null;
    return Math.floor((now.getTime() - r.date.getTime()) / 86_400_000);
  }

  // Last locate / batch breadcrumbs (visible feedback even for a zero-result run).
  const [lastLocate, lastBatch] = await Promise.all([
    prisma.rowEvent.findFirst({
      where: { eventType: "cash_deposit_locate_summary" },
      orderBy: { createdAt: "desc" },
    }),
    prisma.rowEvent.findFirst({
      where: { eventType: "cash_deposit_batch" },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return (
    <>
      <div className="accent-bar" />
      <h1>Cash deposit matching</h1>
      <p className="page-desc">
        Customer invoice cash (INV rows with an RO# and a Collected amount) whose Customer Payment already sits in
        Undeposited Funds. The hub finds that payment by RO# and builds the exact QBO Bank Deposit <strong>into Cash on
        hand</strong> that clears it out of Undeposited Funds — the payment plus a small <em>Cash over/short</em> plug
        when the collected amount differs from the payment by rounding (e.g. sheet $241.00 vs payment $240.74 → +$0.26).
        Nothing posts until you click <strong>Create deposit</strong> on a row, and only when it ties out.
      </p>
      <div className="notice warn">
        <strong>Safety:</strong> rows whose payment is <em>already</em> on a QBO deposit are marked “already deposited”
        and offer no Create button, so a payment can never be deposited twice. Still, create deposits deliberately —
        start with the current pending rows rather than mass-creating the historical backlog, in case older months were
        reconciled a different way.
      </div>

      <DateRangeFilter
        activePreset={activeRange}
        customFrom={customFrom}
        customTo={customTo}
        hrefFor={(preset) => {
          const p = new URLSearchParams();
          if (preset !== "all") p.set("range", preset);
          const s = p.toString();
          return `/cash-sheet-sync/deposits${s ? `?${s}` : ""}`;
        }}
      />
      <p className="card-subtitle" style={{ margin: "6px 0 12px" }}>
        Showing <strong>{describeDateRange(activeRange || "all", resolvedRange)}</strong> — {rows.length} candidate
        row{rows.length === 1 ? "" : "s"}. "Locate" always checks the full backlog regardless of this filter (it's
        read-only); "Create all ready" only posts what's in the current filtered view below.
      </p>

      {!accountsReady && (
        <div className="notice danger" style={{ marginTop: 12 }}>
          Account mapping incomplete — need both “Cash on hand” ({accounts.depositToId ?? "unresolved"}) and “Cash
          over/short” ({accounts.overShortId ?? "unresolved"}). Resolve them on the Mappings page first.
        </div>
      )}

      {editable && (
        <form action={locateCashDepositsAction} className="row-actions" style={{ margin: "0.75rem 0" }}>
          <button className="btn ghost" type="submit">
            Locate payments in QBO (read-only)
          </button>
          <span className="muted" style={{ alignSelf: "center", fontSize: "0.85rem" }}>
            Finds each row&apos;s Undeposited-Funds payment and previews the deposit. No writes.
          </span>
        </form>
      )}

      {editable && accountsReady && readyCount > 0 && (
        <form action={createAllReadyCashDepositsAction} className="row-actions" style={{ margin: "0.25rem 0 0.5rem" }}>
          {activeRange && <input type="hidden" name="range" value={activeRange} />}
          {customFrom && <input type="hidden" name="from" value={customFrom} />}
          {customTo && <input type="hidden" name="to" value={customTo} />}
          <button className="btn primary" type="submit">Create all {readyCount} ready deposit{readyCount === 1 ? "" : "s"}</button>
          <span className="muted" style={{ alignSelf: "center", fontSize: "0.85rem" }}>
            Posts every row marked <em>ready</em> above, each re-verified and duplicate-guarded before it writes.
          </span>
        </form>
      )}

      {lastLocate && (
        <p className="muted" style={{ fontSize: "0.8rem", marginTop: "-0.25rem" }}>
          Last locate: {lastLocate.eventMessage} · {lastLocate.createdAt.toISOString().replace("T", " ").slice(0, 19)} UTC
        </p>
      )}
      {lastBatch && (
        <p className="muted" style={{ fontSize: "0.8rem", marginTop: "-0.25rem" }}>
          {lastBatch.eventMessage} · {lastBatch.createdAt.toISOString().replace("T", " ").slice(0, 19)} UTC
        </p>
      )}

      {rows.length === 0 ? (
        <p className="muted">
          No candidate rows. These appear once a sync has scanned INV rows that carry an RO# and a Collected amount and
          haven&apos;t been deposited yet.
        </p>
      ) : (
        <>
          <h2 style={{ fontSize: 16, margin: "20px 0 8px" }}>Ready to create ({readyRows.length})</h2>
          {readyRows.length === 0 ? (
            <p className="card-subtitle">
              Nothing ready right now. Run Locate above — a row lands here once its Undeposited-Funds payment is found.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="gcd">
                <thead>
                  <tr>
                    <th>Tab</th><th>Row</th><th>Date</th><th>Name</th><th>INV#/RO</th><th className="num">Collected</th>
                    <th>Located payment</th><th className="num">Over/short</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {readyRows.map((r) => {
                    const p = latestPlan.get(r.id)!;
                    const overShort = p.plan ? p.plan.overShortCents / 100 : null;
                    return (
                      <tr key={r.id}>
                        <td>{r.tabName}</td>
                        <td><Link href={`/cash-sheet-sync/rows/${r.id}`}>{r.rowNumberLastSeen}</Link></td>
                        <td>{r.date ? r.date.toISOString().slice(0, 10) : ""}</td>
                        <td>{r.name}</td>
                        <td>{r.invNumber}</td>
                        <td>{money(r.amtCollected)}</td>
                        <td style={{ fontSize: "0.8rem" }}>
                          {money(p.payment!.amount)}{" "}
                          <span className="muted">
                            {p.payment!.customerName ? `· ${p.payment!.customerName}` : ""} · {p.payment!.privateNote}
                          </span>
                        </td>
                        <td className="num">{overShort === null ? "" : money(overShort)}</td>
                        <td>
                          {editable && accountsReady && (
                            <form action={createCashDepositAction}>
                              <input type="hidden" name="rowId" value={r.id} />
                              <button className="btn primary" type="submit">Create deposit</button>
                            </form>
                          )}
                          {createOutcome.get(r.id) && (
                            <span
                              className={`badge ${createOutcome.get(r.id)!.kind === "error" ? "danger" : "warn"}`}
                              style={{ display: "inline-block", whiteSpace: "normal", maxWidth: 320, fontSize: "0.72rem" }}
                            >
                              {createOutcome.get(r.id)!.kind === "error" ? "Create failed: " : "Blocked: "}
                              {createOutcome.get(r.id)!.msg}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <h2 style={{ fontSize: 16, margin: "24px 0 8px" }}>Needs review ({needsReviewRows.length})</h2>
          <p className="card-subtitle" style={{ marginTop: 0 }}>
            Oldest first. No match yet, or Locate hasn&apos;t run against this row — not "ready" until a human resolves
            why, or archives it as never going to resolve.
          </p>
          {needsReviewRows.length === 0 ? (
            <p className="card-subtitle">Nothing waiting on review.</p>
          ) : (
            <div className="table-wrap">
              <table className="gcd">
                <thead>
                  <tr>
                    <th>Tab</th><th>Row</th><th>Date</th><th>Age</th><th>Name</th><th>INV#/RO</th>
                    <th className="num">Collected</th><th>Status</th>{canArchive && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {needsReviewRows.map((r) => {
                    const p = latestPlan.get(r.id);
                    const age = ageDays(r);
                    const stale = age !== null && age > 30;
                    return (
                      <tr key={r.id}>
                        <td>{r.tabName}</td>
                        <td><Link href={`/cash-sheet-sync/rows/${r.id}`}>{r.rowNumberLastSeen}</Link></td>
                        <td>{r.date ? r.date.toISOString().slice(0, 10) : ""}</td>
                        <td>
                          {age === null ? "" : (
                            <span className={`badge ${stale ? "danger" : age > 14 ? "warn" : "muted"}`}>{age}d</span>
                          )}
                        </td>
                        <td>{r.name}</td>
                        <td>{r.invNumber}</td>
                        <td>{money(r.amtCollected)}</td>
                        <td style={{ fontSize: "0.8rem" }}>
                          <span className="badge warn" title={latestMsg.get(r.id)}>
                            {p ? "not found" : "pending locate"}
                          </span>
                          {stale && (
                            <div className="muted" style={{ marginTop: 4 }}>
                              Pending {age}+ days — if this will never resolve (e.g. reconciled a different way before
                              this tool existed), archive it instead of leaving it open forever.
                            </div>
                          )}
                        </td>
                        {canArchive && (
                          <td>
                            <form action={archiveRowAction.bind(null, r.id)} className="row-actions" style={{ flexWrap: "nowrap" }}>
                              <input className="input" name="reason" placeholder="Reason" style={{ width: 140, fontSize: "0.75rem" }} />
                              <button className="btn ghost" type="submit" style={{ fontSize: "0.75rem", padding: "4px 8px" }}>
                                Archive
                              </button>
                            </form>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <details style={{ marginTop: 24 }}>
            <summary style={{ cursor: "pointer", fontSize: 16, fontWeight: 600 }}>
              Already deposited / resolved ({resolvedRows.length})
            </summary>
            {resolvedRows.length === 0 ? (
              <p className="card-subtitle">None yet.</p>
            ) : (
              <div className="table-wrap" style={{ marginTop: 10 }}>
                <table className="gcd">
                  <thead>
                    <tr>
                      <th>Tab</th><th>Row</th><th>Date</th><th>Name</th><th>INV#/RO</th>
                      <th className="num">Collected</th><th>Status</th><th>QBO Txn</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resolvedRows.map((r) => {
                      const p = latestPlan.get(r.id);
                      const created = alreadyHasDeposit(r);
                      return (
                        <tr key={r.id}>
                          <td>{r.tabName}</td>
                          <td><Link href={`/cash-sheet-sync/rows/${r.id}`}>{r.rowNumberLastSeen}</Link></td>
                          <td>{r.date ? r.date.toISOString().slice(0, 10) : ""}</td>
                          <td>{r.name}</td>
                          <td>{r.invNumber}</td>
                          <td>{money(r.amtCollected)}</td>
                          <td>
                            {created ? (
                              <span className="badge ok">{RowStatus.DepositCreated}</span>
                            ) : (
                              <span className="badge muted" title={latestMsg.get(r.id)}>
                                payment already on another deposit
                              </span>
                            )}
                          </td>
                          <td>{created ? r.qboTransactionId : (p?.payment?.id ?? "")}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </details>
        </>
      )}

      <p className="muted" style={{ marginTop: "1rem", fontSize: "0.85rem" }}>
        Each deposit posts into Cash on hand and clears the customer payment out of Undeposited Funds (it does not touch
        the bank feed — moving the envelope cash to Chase is the separate Bank Deposit transfer). The hub records the
        deposit id against the row and never creates it twice; rows already deposited in QBO are marked accordingly.
      </p>
    </>
  );
}
