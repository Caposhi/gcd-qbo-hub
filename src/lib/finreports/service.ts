/**
 * Financial Reports — fetch-through cache + capability probe (Phase 1, IO layer).
 *
 * The only file in this module that touches Prisma or the network. Everything it
 * returns is a shape from the pure layer (statement.ts / tabular.ts), so the page
 * and GCD Pal read identical, already-validated data.
 *
 * Caching mirrors the projections `getReportSnapshot` pattern: keyed by
 * (reportKey, period, basis), served from `fin_report_snapshot` while fresh, and
 * refreshed through QBO otherwise. A QBO outage falls back to the last good
 * snapshot rather than failing the page.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getQboEnvironment } from "@/lib/config-store";
import { getContext, query, type QboContext } from "@/lib/qbo/client";
import { fetchReportEntity } from "@/lib/qbo/reports";
import { parseQboReport } from "@/lib/projections/reports/qbo";
import { buildStatement, withComparison, withPctOfRevenue, validateStatement, type StatementIssue } from "./statement";
import { buildTabular } from "./tabular";
import { basisFor, getReport, type ReportDef } from "./catalog";
import {
  capabilitiesFromCounts,
  capabilitiesStale,
  parseCapabilities,
  NO_CAPABILITIES,
  type Capabilities,
} from "./capabilities";
import type { AccountingBasis, Statement, StatementPeriod, TabularReport } from "./types";

/** Statements are cheap to re-derive but QBO is slow; 6h matches projections. */
export const SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;

function toDate(d: string): Date {
  return new Date(`${d}T00:00:00.000Z`);
}

/** Cache key component for a basis (agings take none). */
function basisKey(basis: AccountingBasis | null): string {
  return basis ?? "none";
}

export interface LoadOptions {
  /** Override the report's default basis (ignored when it takes none). */
  basis?: AccountingBasis;
  /** Comparison period for statements — adds priorValue/deltas. */
  comparison?: StatementPeriod;
  maxAgeMs?: number;
  forceRefresh?: boolean;
  /** Reuse an open QBO context so several reports share one token refresh. */
  ctx?: QboContext;
}

export interface LoadedStatement {
  report: Statement;
  /** Non-empty when a subtotal/total didn't tie — never present as fact. */
  issues: StatementIssue[];
  fetchedAt: Date;
  refreshed: boolean;
}

export interface LoadedTabular {
  report: TabularReport;
  fetchedAt: Date;
  refreshed: boolean;
}

/** Read a cached payload for (key, period, basis) when fresh enough. */
async function readCache(
  reportKey: string,
  period: StatementPeriod,
  basis: AccountingBasis | null,
  maxAgeMs: number,
  forceRefresh: boolean
): Promise<{ payload: unknown; fetchedAt: Date } | null> {
  const row = await prisma.finReportSnapshot.findUnique({
    where: {
      reportKey_periodStart_periodEnd_basis: {
        reportKey,
        periodStart: toDate(period.start),
        periodEnd: toDate(period.end),
        basis: basisKey(basis),
      },
    },
  });
  if (!row) return null;
  if (forceRefresh) return null;
  if (Date.now() - row.fetchedAt.getTime() > maxAgeMs) return null;
  return { payload: row.payloadJson, fetchedAt: row.fetchedAt };
}

async function writeCache(
  reportKey: string,
  period: StatementPeriod,
  basis: AccountingBasis | null,
  payload: unknown
): Promise<Date> {
  const row = await prisma.finReportSnapshot.upsert({
    where: {
      reportKey_periodStart_periodEnd_basis: {
        reportKey,
        periodStart: toDate(period.start),
        periodEnd: toDate(period.end),
        basis: basisKey(basis),
      },
    },
    create: {
      reportKey,
      periodStart: toDate(period.start),
      periodEnd: toDate(period.end),
      basis: basisKey(basis),
      payloadJson: payload as Prisma.InputJsonValue,
    },
    update: { payloadJson: payload as Prisma.InputJsonValue, fetchedAt: new Date() },
  });
  return row.fetchedAt;
}

/** Fetch + shape one report for a period (no cache). */
async function fetchShaped(
  def: ReportDef,
  period: StatementPeriod,
  basis: AccountingBasis | null,
  ctx: QboContext
): Promise<Statement | TabularReport> {
  const raw = await fetchReportEntity(
    def.entity,
    { startDate: period.start, endDate: period.end, method: basis },
    ctx
  );
  const parsed = parseQboReport(raw);
  const common = {
    key: def.key,
    title: def.title,
    period,
    basis: (basis ?? "accrual") as AccountingBasis,
    report: parsed,
    fetchedAt: new Date().toISOString(),
  };
  return def.shape === "statement"
    ? buildStatement(common)
    : buildTabular({ ...common, labelColumn: def.labelColumn });
}

/**
 * Load a hierarchical statement (P&L / Balance Sheet / Cash Flow) for a period,
 * optionally joined to a comparison period, with % of revenue applied and the
 * subtotal checksum evaluated.
 *
 * Throws when the report key isn't a statement — callers should branch on
 * `def.shape` (or use {@link loadReport}).
 */
export async function loadStatement(
  reportKey: string,
  period: StatementPeriod,
  opts: LoadOptions = {}
): Promise<LoadedStatement> {
  const def = getReport(reportKey);
  if (!def) throw new Error(`Unknown report "${reportKey}"`);
  if (def.shape !== "statement") throw new Error(`Report "${reportKey}" is not a statement`);

  const basis = basisFor(def, opts.basis);
  const maxAge = opts.maxAgeMs ?? SNAPSHOT_TTL_MS;
  const forceRefresh = opts.forceRefresh ?? false;

  const cached = await readCache(def.key, period, basis, maxAge, forceRefresh);
  let current: Statement;
  let fetchedAt: Date;
  let refreshed = false;

  if (cached) {
    current = cached.payload as Statement;
    fetchedAt = cached.fetchedAt;
  } else {
    const ctx = opts.ctx ?? (await getContext(await getQboEnvironment()));
    try {
      current = (await fetchShaped(def, period, basis, ctx)) as Statement;
      fetchedAt = await writeCache(def.key, period, basis, current);
      refreshed = true;
    } catch (err) {
      // QBO unreachable → fall back to any stale snapshot rather than 500.
      const stale = await readCache(def.key, period, basis, Number.MAX_SAFE_INTEGER, false);
      if (!stale) throw err;
      current = stale.payload as Statement;
      fetchedAt = stale.fetchedAt;
    }
  }

  if (opts.comparison) {
    const priorCached = await readCache(def.key, opts.comparison, basis, maxAge, forceRefresh);
    let prior: Statement | null = null;
    if (priorCached) {
      prior = priorCached.payload as Statement;
    } else {
      try {
        const ctx = opts.ctx ?? (await getContext(await getQboEnvironment()));
        prior = (await fetchShaped(def, opts.comparison, basis, ctx)) as Statement;
        await writeCache(def.key, opts.comparison, basis, prior);
        refreshed = true;
      } catch {
        prior = null; // comparison is optional context, never fatal
      }
    }
    if (prior) current = withComparison(current, prior);
  }

  current = withPctOfRevenue(current);
  return { report: current, issues: validateStatement(current), fetchedAt, refreshed };
}

/** Load a flat tabular report (trial balance, agings, vendor expenses, …). */
export async function loadTabular(
  reportKey: string,
  period: StatementPeriod,
  opts: LoadOptions = {}
): Promise<LoadedTabular> {
  const def = getReport(reportKey);
  if (!def) throw new Error(`Unknown report "${reportKey}"`);
  if (def.shape !== "tabular") throw new Error(`Report "${reportKey}" is not tabular`);

  const basis = basisFor(def, opts.basis);
  const maxAge = opts.maxAgeMs ?? SNAPSHOT_TTL_MS;
  const cached = await readCache(def.key, period, basis, maxAge, opts.forceRefresh ?? false);
  if (cached) {
    return { report: cached.payload as TabularReport, fetchedAt: cached.fetchedAt, refreshed: false };
  }
  const ctx = opts.ctx ?? (await getContext(await getQboEnvironment()));
  try {
    const report = (await fetchShaped(def, period, basis, ctx)) as TabularReport;
    const fetchedAt = await writeCache(def.key, period, basis, report);
    return { report, fetchedAt, refreshed: true };
  } catch (err) {
    const stale = await readCache(def.key, period, basis, Number.MAX_SAFE_INTEGER, false);
    if (!stale) throw err;
    return { report: stale.payload as TabularReport, fetchedAt: stale.fetchedAt, refreshed: false };
  }
}

/** Load either shape — convenience for generic callers (GCD Pal, exports). */
export async function loadReport(
  reportKey: string,
  period: StatementPeriod,
  opts: LoadOptions = {}
): Promise<LoadedStatement | LoadedTabular> {
  const def = getReport(reportKey);
  if (!def) throw new Error(`Unknown report "${reportKey}"`);
  return def.shape === "statement" ? loadStatement(reportKey, period, opts) : loadTabular(reportKey, period, opts);
}

// --- capability probe ------------------------------------------------------

async function countOf(ctx: QboContext, statement: string): Promise<number> {
  try {
    const res = await query<{ QueryResponse?: { totalCount?: number } }>(ctx, statement);
    return Number(res.QueryResponse?.totalCount ?? 0);
  } catch {
    return 0; // an unsupported/denied entity simply means "feature not in use"
  }
}

/**
 * Ask QBO which optional features the company actually uses, and cache it. Called
 * rarely (weekly TTL) — capabilities change when someone reconfigures QuickBooks,
 * not during a reporting session.
 */
export async function probeCapabilities(ctx?: QboContext): Promise<Capabilities> {
  const context = ctx ?? (await getContext(await getQboEnvironment()));
  const [activeClasses, budgets, inventoryItems] = await Promise.all([
    countOf(context, "select count(*) from Class where Active = true"),
    countOf(context, "select count(*) from Budget"),
    countOf(context, "select count(*) from Item where Type = 'Inventory'"),
  ]);
  const caps = capabilitiesFromCounts({
    activeClasses,
    budgets,
    inventoryItems,
    probedAt: new Date().toISOString(),
  });
  await prisma.finCapability.upsert({
    where: { singleton: "company" },
    create: { singleton: "company", payloadJson: caps as unknown as Prisma.InputJsonValue },
    update: { payloadJson: caps as unknown as Prisma.InputJsonValue, probedAt: new Date() },
  });
  return caps;
}

/**
 * Cached capabilities, re-probing when stale or absent. Never throws: if QBO
 * can't be reached we return "no optional features", which hides the optional
 * reports rather than breaking the page.
 */
export async function getCapabilities(opts: { forceRefresh?: boolean; ctx?: QboContext } = {}): Promise<Capabilities> {
  const row = await prisma.finCapability.findUnique({ where: { singleton: "company" } });
  const cached = row ? parseCapabilities(row.payloadJson) : NO_CAPABILITIES;
  if (!opts.forceRefresh && row && !capabilitiesStale(cached, new Date())) return cached;
  try {
    return await probeCapabilities(opts.ctx);
  } catch {
    return cached;
  }
}
