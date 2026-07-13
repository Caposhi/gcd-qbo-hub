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
      <h1>🧾 Check Reception</h1>
      <p className="sub">
        Drop the Chase PDF of cleared check images (one check per page). The hub reads each handwritten check with
        Claude vision, proposes the vendor and expense category from what it has learned, and — once you confirm —
        creates the QBO Check so the Chase bank-feed line matches itself. Handwriting is imperfect, so every check is
        shown for review before anything is written to QuickBooks.
      </p>

      {editable ? (
        <form action={ingestCheckPdfAction} className="notice" style={{ display: "grid", gap: "0.6rem" }}>
          <strong>Check PDF reception</strong>
          <span className="muted" style={{ fontSize: "0.85rem" }}>
            Chase → download cleared checks as a PDF (choose <em>one check per page</em> for the clearest read).
            Re-dropping the same file does nothing (idempotent).
          </span>
          <input type="file" name="file" accept=".pdf,application/pdf" />
          <div>
            <button className="btn" type="submit">Read checks</button>
          </div>
        </form>
      ) : (
        <p className="muted">Reading checks requires owner_admin.</p>
      )}

      {editable && readyCount > 0 && (
        <form action={createAllReadyChecksAction} className="row-actions" style={{ margin: "0.75rem 0 0.5rem" }}>
          <button className="btn" type="submit">Create all {readyCount} ready check{readyCount === 1 ? "" : "s"}</button>
          <span className="muted" style={{ alignSelf: "center", fontSize: "0.85rem" }}>
            Posts every confirmed check to QBO (duplicate check numbers are refused). Then match each in the Chase bank
            feed.
          </span>
        </form>
      )}

      {lastIngest && (
        <p className="muted" style={{ fontSize: "0.8rem" }}>
          {lastIngest.message} · {lastIngest.createdAt.toISOString().replace("T", " ").slice(0, 19)} UTC
        </p>
      )}
      {lastBatch && (
        <p className="muted" style={{ fontSize: "0.8rem" }}>
          {lastBatch.message} · {lastBatch.createdAt.toISOString().replace("T", " ").slice(0, 19)} UTC
        </p>
      )}
      <p className="muted" style={{ fontSize: "0.8rem" }}>
        {learned} learned payee→category mapping{learned === 1 ? "" : "s"}. The first check to a payee is confirmed by
        hand; later checks to the same payee pre-fill.
      </p>

      <h2>Checks</h2>
      {checks.length === 0 ? (
        <p className="muted">No checks read yet. Drop a Chase check-image PDF above.</p>
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
              <div key={c.id} className="notice" style={{ display: "grid", gap: "0.5rem" }}>
                <div style={{ display: "flex", gap: "0.75rem", alignItems: "baseline", flexWrap: "wrap" }}>
                  <strong>Check #{c.checkNumber ?? "??"}</strong>
                  <span>{money(c.amount)}</span>
                  <span className="muted">{c.checkDate ?? "no date"}</span>
                  <span className="muted">→ {c.payeeResolved ?? c.payeeRaw ?? "unknown payee"}</span>
                  {badge}
                  <span className="muted" style={{ fontSize: "0.72rem" }}>
                    conf: {c.confidence ?? "?"} · {c.batch?.fileName ?? "PDF"} p{c.page}
                  </span>
                </div>
                {c.statusReason && (
                  <div className="muted" style={{ fontSize: "0.75rem" }}>{c.statusReason}</div>
                )}
                {c.status === "created" && c.qboPurchaseId && (
                  <div className="muted" style={{ fontSize: "0.78rem" }}>
                    QBO Purchase {c.qboPurchaseId} · categorized to {c.categoryAccountName ?? "?"}. Match it in the Chase
                    bank feed.
                  </div>
                )}

                {editable && c.status !== "created" && c.status !== "skipped" && (
                  <form action={classifyCheckAction} style={{ display: "grid", gap: "0.4rem" }}>
                    <input type="hidden" name="checkId" value={c.id} />
                    <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                      <label style={{ fontSize: "0.78rem" }}>
                        Check #
                        <br />
                        <input name="checkNumber" defaultValue={c.checkNumber ?? ""} style={{ width: 90 }} />
                      </label>
                      <label style={{ fontSize: "0.78rem" }}>
                        Amount
                        <br />
                        <input name="amount" defaultValue={c.amount !== null ? Number(c.amount).toFixed(2) : ""} style={{ width: 100 }} />
                      </label>
                      <label style={{ fontSize: "0.78rem" }}>
                        Date
                        <br />
                        <input name="checkDate" defaultValue={c.checkDate ?? ""} placeholder="YYYY-MM-DD" style={{ width: 120 }} />
                      </label>
                    </div>
                    <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                      <label style={{ fontSize: "0.78rem" }}>
                        Payee (as read) · optional
                        <br />
                        <input name="payee" defaultValue={c.payeeResolved ?? c.payeeRaw ?? ""} style={{ width: 220 }} />
                        {c.payeeRaw && c.payeeResolved && c.payeeRaw !== c.payeeResolved && (
                          <span style={{ display: "block", fontSize: "0.68rem", opacity: 0.55 }}>
                            read as “{c.payeeRaw}”
                          </span>
                        )}
                      </label>
                      <div style={{ fontSize: "0.78rem" }}>
                        QBO vendor{c.qboVendorId ? " (suggested)" : ""}
                        <br />
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
                    <div style={{ fontSize: "0.78rem" }}>
                      Expense category{c.categoryAccountId ? " (suggested)" : ""}
                      <br />
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
                      <span className="muted" style={{ fontSize: "0.7rem" }}>
                        QBO not reached — vendor/category lists are empty; type the exact name.
                      </span>
                    )}
                    <label style={{ fontSize: "0.78rem", display: "flex", gap: "0.35rem", alignItems: "center" }}>
                      <input type="checkbox" name="remember" defaultChecked /> Remember this payee → category for next
                      time
                    </label>
                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      <button className="btn secondary" type="submit">Confirm</button>
                    </div>
                  </form>
                )}

                {editable && c.status === "ready" && !c.qboPurchaseId && (
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <form action={createCheckAction}>
                      <input type="hidden" name="checkId" value={c.id} />
                      <button className="btn" type="submit">Create check in QBO</button>
                    </form>
                    <form action={skipCheckAction}>
                      <input type="hidden" name="checkId" value={c.id} />
                      <button className="btn secondary" type="submit">Skip</button>
                    </form>
                  </div>
                )}
                {editable && c.status === "needs_review" && (
                  <form action={skipCheckAction}>
                    <input type="hidden" name="checkId" value={c.id} />
                    <button className="btn secondary" type="submit">Skip this check</button>
                  </form>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="muted" style={{ marginTop: "1rem" }}>
        Runs behind the rollout ladder (read → confirm → create-you-match → auto). Nothing posts unless the stage allows
        live posting and QBO is connected; a check number already in QBO is never posted twice.
      </p>
    </>
  );
}
