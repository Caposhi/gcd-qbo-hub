/**
 * Typed accessor for the DB `config` key/value store with change history
 * (§12, §15). Every write records a ConfigChange (who/when/old→new) so a
 * rollout-stage or environment flip is auditable — never a silent prod env
 * edit (§12, §22).
 */
import { prisma } from "@/lib/db";
import {
  CONFIG_KEYS,
  DEFAULT_ROLLOUT_STAGE,
  DEFAULT_SPREADSHEET_ID,
} from "@/lib/cashsheet/config";
import {
  ROLLOUT_STAGES,
  environmentForStage,
  type RolloutStage,
  type QboEnvironment,
} from "@/lib/cashsheet/rollout";

export async function getConfig(key: string, fallback: string): Promise<string> {
  const row = await prisma.config.findUnique({ where: { key } });
  return row?.value ?? fallback;
}

/** Set a config value and append an audited change record. */
export async function setConfig(
  key: string,
  value: string,
  changedBy: string | null,
  reason?: string
): Promise<void> {
  const existing = await prisma.config.findUnique({ where: { key } });
  const config = await prisma.config.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
  await prisma.configChange.create({
    data: {
      configId: config.id,
      key,
      oldValue: existing?.value ?? null,
      newValue: value,
      changedBy,
      reason,
    },
  });
}

export async function getRolloutStage(): Promise<RolloutStage> {
  const v = await getConfig(CONFIG_KEYS.rolloutStage, DEFAULT_ROLLOUT_STAGE);
  return (ROLLOUT_STAGES as string[]).includes(v) ? (v as RolloutStage) : DEFAULT_ROLLOUT_STAGE;
}

/**
 * Change the rollout stage. Guards the ladder: you may only move ONE step at a
 * time (no skipping stages, §12), and only forward/backward by one. This makes
 * "jump straight to live_auto" impossible even by an admin fat-finger.
 */
export async function setRolloutStage(
  next: RolloutStage,
  changedBy: string | null,
  reason?: string
): Promise<void> {
  const current = await getRolloutStage();
  const ci = ROLLOUT_STAGES.indexOf(current);
  const ni = ROLLOUT_STAGES.indexOf(next);
  if (ni === -1) throw new Error(`Unknown rollout stage: ${next}`);
  if (Math.abs(ni - ci) > 1) {
    throw new Error(
      `Rollout stages must be advanced one step at a time (§12). Current "${current}" → requested "${next}".`
    );
  }
  await setConfig(CONFIG_KEYS.rolloutStage, next, changedBy, reason);
}

/**
 * The QBO environment is DERIVED from the rollout stage — the single source of
 * truth — so the dashboard, actions, and the sync engine can never disagree
 * (dry_run/sandbox_* → sandbox; live_* → live). Advancing the ladder to a live
 * stage flips the environment everywhere at once; there is no separate env flag
 * to fall out of sync (§12, §16).
 */
export async function getQboEnvironment(): Promise<QboEnvironment> {
  return environmentForStage(await getRolloutStage());
}

export async function getSpreadsheetId(): Promise<string> {
  return getConfig(CONFIG_KEYS.spreadsheetId, process.env.GOOGLE_SHEET_ID || DEFAULT_SPREADSHEET_ID);
}

/**
 * Whether the sync writes back to the sheet (§4): the hidden row UUID plus the
 * visible status columns. Defaults OFF so the system never edits the workbook
 * until an owner deliberately enables it (and grants the service account
 * Editor access). Turning it on is an audited config change like any other.
 */
export async function getSheetWritebackEnabled(): Promise<boolean> {
  return (await getConfig(CONFIG_KEYS.sheetWriteback, "false")) === "true";
}
