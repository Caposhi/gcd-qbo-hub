/**
 * Manual per-month overrides for the Tekmetric top-line KPIs (`tek_month_overrides`).
 *
 * For when a live Tekmetric pull is REPRODUCIBLY wrong — not a one-off
 * rate-limit blip (those are refused at write time by `looksLikePartialMonth`
 * in snapshot.ts) but the same bad shape every time it's re-fetched — and an
 * owner has cross-checked the real figures against Tekmetric's own report.
 *
 * Revenue and gross margin are never stored: they're always DERIVED from
 * roCount/aro/grossProfit (see `deriveDerived`) so an override can't drift out
 * of the "revenue = ARO × RO count" identity the rest of the app relies on.
 *
 * `readMonthOverride` is a pure cache read; `saveMonthOverride`/
 * `clearMonthOverride` are the only mutations, and every call MUST be gated by
 * the caller with `requirePermission("override_tekmetric_ops")`. Both write an
 * append-only `TekMonthOverrideEvent` so a correction's history (who changed
 * what, from what) is never lost even as the current row is overwritten.
 */
import { prisma } from "@/lib/db";
import { round2 } from "./normalize";

export interface MonthOverrideInput {
  periodStart: string; // "YYYY-MM-DD", first of month
  periodEnd: string;
  roCount: number;
  carCount: number;
  aro: number;
  grossProfit: number;
  note?: string;
  byEmail: string;
}

export interface MonthOverrideValues {
  roCount: number;
  carCount: number;
  aro: number;
  grossProfit: number;
  /** Derived: aro × roCount. */
  revenue: number;
  /** Derived: grossProfit / revenue × 100 (0 when revenue is 0). */
  grossMarginPct: number;
  overriddenByEmail: string;
  overriddenAt: Date;
  note: string | null;
}

function deriveDerived(roCount: number, aro: number, grossProfit: number): { revenue: number; grossMarginPct: number } {
  const revenue = round2(roCount * aro);
  const grossMarginPct = revenue > 0 ? round2((grossProfit / revenue) * 100) : 0;
  return { revenue, grossMarginPct };
}

function toSnapshot(row: {
  roCount: number;
  carCount: number;
  aro: unknown;
  grossProfit: unknown;
  note: string | null;
}) {
  return {
    roCount: row.roCount,
    carCount: row.carCount,
    aro: Number(row.aro),
    grossProfit: Number(row.grossProfit),
    note: row.note,
  };
}

/** Cache-only read of the active override for a calendar month, if any. */
export async function readMonthOverride(periodStart: string): Promise<MonthOverrideValues | null> {
  const row = await prisma.tekMonthOverride.findUnique({
    where: { periodStart: new Date(`${periodStart}T00:00:00.000Z`) },
  });
  if (!row || !row.active) return null;
  const aro = Number(row.aro);
  const grossProfit = Number(row.grossProfit);
  return {
    roCount: row.roCount,
    carCount: row.carCount,
    aro,
    grossProfit,
    ...deriveDerived(row.roCount, aro, grossProfit),
    overriddenByEmail: row.overriddenByEmail,
    overriddenAt: row.updatedAt,
    note: row.note,
  };
}

/** Create or replace the active override for a month. Logs a create/update event. */
export async function saveMonthOverride(input: MonthOverrideInput): Promise<void> {
  const periodStart = new Date(`${input.periodStart}T00:00:00.000Z`);
  const periodEnd = new Date(`${input.periodEnd}T00:00:00.000Z`);
  const note = input.note?.trim() || null;

  const existing = await prisma.tekMonthOverride.findUnique({ where: { periodStart } });
  const newSnapshot = { roCount: input.roCount, carCount: input.carCount, aro: input.aro, grossProfit: input.grossProfit, note };

  const saved = await prisma.tekMonthOverride.upsert({
    where: { periodStart },
    create: {
      periodStart,
      periodEnd,
      roCount: input.roCount,
      carCount: input.carCount,
      aro: input.aro,
      grossProfit: input.grossProfit,
      note,
      overriddenByEmail: input.byEmail,
    },
    update: {
      periodEnd,
      roCount: input.roCount,
      carCount: input.carCount,
      aro: input.aro,
      grossProfit: input.grossProfit,
      note,
      active: true,
      overriddenByEmail: input.byEmail,
    },
  });

  await prisma.tekMonthOverrideEvent.create({
    data: {
      overrideId: saved.id,
      eventType: existing ? "update" : "create",
      previousJson: existing ? (toSnapshot(existing) as unknown as object) : undefined,
      newJson: newSnapshot as unknown as object,
      changedByEmail: input.byEmail,
      note,
    },
  });
}

/** Deactivate a month's override (reverts reads to the raw Tekmetric pull). Logs a clear event. */
export async function clearMonthOverride(periodStart: string, byEmail: string, note?: string): Promise<void> {
  const existing = await prisma.tekMonthOverride.findUnique({
    where: { periodStart: new Date(`${periodStart}T00:00:00.000Z`) },
  });
  if (!existing || !existing.active) return; // already cleared / never existed — nothing to log

  await prisma.tekMonthOverride.update({ where: { id: existing.id }, data: { active: false } });
  await prisma.tekMonthOverrideEvent.create({
    data: {
      overrideId: existing.id,
      eventType: "clear",
      previousJson: toSnapshot(existing) as unknown as object,
      newJson: undefined,
      changedByEmail: byEmail,
      note: note?.trim() || null,
    },
  });
}
