import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/roles";
import { RequireAuth } from "../components/RequireAuth";
import { ingestDepositFilesAction } from "./actions";

export const dynamic = "force-dynamic";

function money(v: unknown): string {
  return `$${Number(v).toFixed(2)}`;
}

export default async function DepositReconciliationPage() {
  const user = await getSessionUser();
  if (!user) return <RequireAuth />;
  const editable = can(user.role, "edit_mappings");

  const payouts = await prisma.depPayout.findMany({
    orderBy: [{ settlementDate: "desc" }, { createdAt: "desc" }],
    include: { _count: { select: { lines: true } } },
    take: 100,
  });

  return (
    <>
      <h1>🏦 Deposit Reconciliation</h1>
      <p className="sub">
        Drop your processor exports and the hub reconstructs each payout into the exact QBO deposit it should become —
        Chase Paymentech (gross card sales by batch date) and Tekmetric/Stripe (payouts + charges, netted by fee). Each
        deposit is gated by an exact-sum checksum; anything that doesn&apos;t tie is flagged, never posted.
      </p>

      {editable ? (
        <form action={ingestDepositFilesAction} className="notice" style={{ display: "grid", gap: "0.6rem" }}>
          <strong>File reception center</strong>
          <span className="muted" style={{ fontSize: "0.85rem" }}>
            Drop CSVs: the Chase <em>Paymentech</em> settlement, and both Tekmetric files (the <em>payouts</em> export
            and the <em>Payments/charges</em> export). Re-dropping the same files does nothing (idempotent).
          </span>
          <input type="file" name="files" multiple accept=".csv,text/csv" />
          <div>
            <button className="btn" type="submit">Ingest files</button>
          </div>
        </form>
      ) : (
        <p className="muted">Ingesting files requires owner_admin.</p>
      )}

      <h2>Proposed deposits</h2>
      {payouts.length === 0 ? (
        <p className="muted">No payouts ingested yet. Drop your processor CSVs above.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Settlement</th><th>Processor</th><th>Gross</th><th>Fee</th><th>Net (deposit)</th>
                <th>Lines</th><th>Status</th><th>Source</th>
              </tr>
            </thead>
            <tbody>
              {payouts.map((p) => (
                <tr key={p.id}>
                  <td>{p.settlementDate}</td>
                  <td className="muted">{p.processor}</td>
                  <td className="muted">{money(p.grossAmount)}</td>
                  <td className="muted">{money(p.feeAmount)}</td>
                  <td><strong>{money(p.netAmount)}</strong></td>
                  <td>{p._count.lines}</td>
                  <td>
                    {p.status === "proposed" ? (
                      <span className="badge ok">proposed</span>
                    ) : p.status === "created" ? (
                      <span className="badge ok">created</span>
                    ) : (
                      <span className="badge warn">
                        needs review{p.deltaCents ? ` (Δ ${(p.deltaCents / 100).toFixed(2)})` : ""}
                      </span>
                    )}
                  </td>
                  <td className="muted" style={{ fontSize: "0.78rem" }}>{p.sourceRef ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="muted" style={{ marginTop: "1rem" }}>
        Next step (needs the live QBO connection): for each <em>proposed</em> deposit, locate the matching
        Undeposited-Funds payments (and Tekmetric fee entries) and create the QBO Bank Deposit so the bank-feed line
        auto-matches. That runs behind the rollout ladder (propose → create-you-match → auto). See
        <code> docs/DEPOSIT_RECONCILIATION.md</code>.
      </p>
    </>
  );
}
