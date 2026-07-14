import { ReceiptText } from "lucide-react";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/roles";
import { RequireAuth } from "../components/RequireAuth";
import { Combobox, type ComboOption } from "./Combobox";
import {
  ingestCheckPdfAction,
  classifyCheckAction,
  skipCheckAction,
  createCheckAction,
  createAllReadyChecksAction,
} from "./actions";

export const dynamic = "force-dynamic";

function money(v: unknown): string {
  return v === null || v === undefined ? "—" : `$${Number(v).toFixed(2)}`;
}

/**
 * QBO vendor + category lists for the typeahead dropdowns. Best-effort: if QBO
 * isn't connected the review form degrades to free-text inputs (empty lists).
 */
async function loadQboLists(): Promise<{ vendors: ComboOption[]; categories: ComboOption[]; reached: boolean }> {
  try {
    const { getQboEnvironment } = await import("@/lib/config-store");
    const { getContext } = await import("@/lib/qbo/client");
    const { listVendors, listCategories } = await import("@/lib/checks/qbo-check");
    const ctx = await getContext(await getQboEnvironment());
    const [vendors, categories] = await Promise.all([listVendors(ctx), listCategories(ctx)]);
    return {
      vendors: vendors.map((v) => ({ id: v.id, name: v.name })),
      categories: categories.map((c) => ({ id: c.id, name: c.name, hint: c.accountType })),
      reached: true,
    };
  } catch {
    return { vendors: [], categories: [], reached: false };
  }
}

export default async function CheckReceptionPage() {
  const user = await getSessionUser();
  if (!user) return <RequireAuth />;
  const editable = can(user.role, "edit_mappings");

  const checks = await prisma.chkCheck.findMany({
    orderBy: [{ createdAt: "desc" }, { page: "asc" }],
    take: 300,
    include: { batch: { select: { fileName: true, createdAt: true } } },
  });
  const readyCount = checks.filter((c) => c.status === "ready" && !c.qboPurchaseId).length;

  // Only pay the QBO round-trip when there are checks to classify.
  const needsForms = editable && checks.some((c) => c.status !== "created" && c.status !== "skipped");
  const { vendors, categories, reached } = needsForms
    ? await loadQboLists()
    : { vendors: [], categories: [], reached: true };

  const lastIngest = await prisma.chkEvent.findFirst({
    where: { eventType: { in: ["ingest", "ingest_error"] } },
    orderBy: { createdAt: "desc" },
  });
  const lastBatch = await prisma.chkEvent.findFirst({
    where: { eventType: "create_batch" },
    orderBy: { createdAt: "desc" },
  });
  const learned = await prisma.chkPayeeMapping.count({ where: { active: true } });

  return (
    <>
      <div className="accent-bar" />
      <h1>Check reception</h1>
      <p className="page-desc">
        Drop the Chase PDF of cleared check images (one check per page). The hub reads each handwritten check with
        Claude vision, proposes the vendor and expense category from what it has learned, and — once you confirm —
        creates the QBO Check so the Chase bank-feed line matches itself. Handwriting is imperfect, so every check is
        shown for review before anything is written to QuickBooks.
      </p>

      {editable ? (
        <form
          action={ingestCheckPdfAction}
          className="card"
          style={{
            borderStyle: "dashed",
            borderColor: "var(--border-default)",
            display: "grid",
            gap: "0.6rem",
            justifyItems: "start",
          }}
        >
          <ReceiptText size={28} strokeWidth={1.5} color="var(--royal-blue)" aria-hidden />
          <h3 className="card-title">Check PDF reception</h3>
          <p className="card-subtitle" style={{ marginTop: 0 }}>
            Chase → download cleared checks as a PDF (choose <em>one check per page</em> for the clearest read).
            Re-dropping the same file does nothing (idempotent).
          </p>
          <input type="file" name="file" accept=".pdf,application/pdf" />
          <div>
            <button className="btn primary" type="submit">Read checks</button>
          </div>
        </form>
      ) : (
        <p className="card-subtitle">Reading checks requires owner_admin.</p>
      )}

      {editable && readyCount > 0 && (
        <form action={createAllReadyChecksAction} className="row-actions" style={{ margin: "0.75rem 0 0.5rem" }}>
          <button className="btn primary" type="submit">Create all {readyCount} ready check{readyCount === 1 ? "" : "s"}</button>
          <span className="card-subtitle" style={{ alignSelf: "center" }}>
            Posts every confirmed check to QBO (duplicate check numbers are refused). Then match each in the Chase bank
            feed.
          </span>
        </form>
      )}

      {lastIngest && (
        <p className="card-subtitle">
          {lastIngest.message} · {lastIngest.createdAt.toISOString().replace("T", " ").slice(0, 19)} UTC
        </p>
      )}
      {lastBatch && (
        <p className="card-subtitle">
          {lastBatch.message} · {lastBatch.createdAt.toISOString().replace("T", " ").slice(0, 19)} UTC
        </p>
      )}
      <p className="card-subtitle" style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
        <span className="badge info">
          {learned} learned mapping{learned === 1 ? "" : "s"}
        </span>
        <span>
          Payee→category. The first check to a payee is confirmed by hand; later checks to the same payee pre-fill.
        </span>
      </p>

      <h2>Checks</h2>
      {checks.length === 0 ? (
        <div className="card" style={{ textAlign: "center" }}>
          <p className="card-subtitle">No checks read yet. Drop a Chase check-image PDF above.</p>
        </div>
      ) : (
        <div style={{ display: "grid", gap: "0.75rem" }}>
          {checks.map((c) => {
            const badge =
              c.status === "created" ? (
                <span className="badge ok">created</span>
              ) : c.status === "ready" ? (
                <span className="badge ok">ready</span>
              ) : c.status === "skipped" ? (
                <span className="badge muted">skipped</span>
              ) : (
                <span className="badge warn">needs review</span>
              );
            return (
              <div key={c.id} className="card" style={{ display: "grid", gap: "0.5rem" }}>
                <div style={{ display: "flex", gap: "0.75rem", alignItems: "baseline", flexWrap: "wrap" }}>
                  <strong>Check #{c.checkNumber ?? "??"}</strong>
                  <span>{money(c.amount)}</span>
                  <span className="card-subtitle">{c.checkDate ?? "no date"}</span>
                  <span className="card-subtitle">→ {c.payeeResolved ?? c.payeeRaw ?? "unknown payee"}</span>
                  {badge}
                  <span className="card-subtitle" style={{ fontSize: "0.72rem" }}>
                    conf: {c.confidence ?? "?"} · {c.batch?.fileName ?? "PDF"} p{c.page}
                  </span>
                </div>
                {c.statusReason && (
                  <div className="card-subtitle">{c.statusReason}</div>
                )}
                {c.status === "created" && c.qboPurchaseId && (
                  <div className="card-subtitle">
                    QBO Purchase {c.qboPurchaseId} · categorized to {c.categoryAccountName ?? "?"}. Match it in the Chase
                    bank feed.
                  </div>
                )}

                {editable && c.status !== "created" && c.status !== "skipped" && (
                  <form action={classifyCheckAction} style={{ display: "grid", gap: "0.6rem" }}>
                    <input type="hidden" name="checkId" value={c.id} />
                    <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
                      <div className="field" style={{ width: 110 }}>
                        <label>Check #</label>
                        <input className="input" name="checkNumber" defaultValue={c.checkNumber ?? ""} />
                      </div>
                      <div className="field" style={{ width: 130 }}>
                        <label>Amount</label>
                        <input className="input" name="amount" defaultValue={c.amount !== null ? Number(c.amount).toFixed(2) : ""} />
                      </div>
                      <div className="field" style={{ width: 150 }}>
                        <label>Date</label>
                        <input className="input" name="checkDate" defaultValue={c.checkDate ?? ""} placeholder="YYYY-MM-DD" />
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
                      <div className="field" style={{ width: 240 }}>
                        <label>Payee (as read) · optional</label>
                        <input className="input" name="payee" defaultValue={c.payeeResolved ?? c.payeeRaw ?? ""} />
                        {c.payeeRaw && c.payeeResolved && c.payeeRaw !== c.payeeResolved && (
                          <span className="card-subtitle" style={{ display: "block", fontSize: "0.68rem" }}>
                            read as “{c.payeeRaw}”
                          </span>
                        )}
                      </div>
                      <div className="field">
                        <label>QBO vendor{c.qboVendorId ? " (suggested)" : ""}</label>
                        <Combobox
                          name="vendor"
                          options={vendors}
                          defaultName={c.qboVendorName ?? c.payeeResolved ?? c.payeeRaw ?? ""}
                          defaultId={c.qboVendorId ?? ""}
                          allowCreate
                          placeholder="Type to search vendors…"
                          width={240}
                        />
                      </div>
                    </div>
                    <div className="field">
                      <label>Expense category{c.categoryAccountId ? " (suggested)" : ""}</label>
                      <Combobox
                        name="category"
                        options={categories}
                        defaultName={c.categoryAccountName ?? ""}
                        defaultId={c.categoryAccountId ?? ""}
                        placeholder="Type to search categories…"
                        width={320}
                      />
                    </div>
                    {!reached && (
                      <span className="card-subtitle" style={{ fontSize: "0.7rem" }}>
                        QBO not reached — vendor/category lists are empty; type the exact name.
                      </span>
                    )}
                    <label className="card-subtitle" style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
                      <input type="checkbox" name="remember" defaultChecked /> Remember this payee → category for next
                      time
                    </label>
                    <div className="row-actions" style={{ margin: 0 }}>
                      <button className="btn primary" type="submit">Confirm</button>
                    </div>
                  </form>
                )}

                {editable && c.status === "ready" && !c.qboPurchaseId && (
                  <div className="row-actions" style={{ margin: 0 }}>
                    <form action={createCheckAction}>
                      <input type="hidden" name="checkId" value={c.id} />
                      <button className="btn primary" type="submit">Create check in QBO</button>
                    </form>
                    <form action={skipCheckAction}>
                      <input type="hidden" name="checkId" value={c.id} />
                      <button className="btn ghost" type="submit">Skip</button>
                    </form>
                  </div>
                )}
                {editable && c.status === "needs_review" && (
                  <form action={skipCheckAction}>
                    <input type="hidden" name="checkId" value={c.id} />
                    <button className="btn ghost" type="submit">Skip this check</button>
                  </form>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="card-subtitle" style={{ marginTop: "1rem" }}>
        Runs behind the rollout ladder (read → confirm → create-you-match → auto). Nothing posts unless the stage allows
        live posting and QBO is connected; a check number already in QBO is never posted twice.
      </p>
    </>
  );
}
