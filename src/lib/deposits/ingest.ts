/**
 * File reception center — detect a dropped CSV and turn it into proposed
 * deposits. Pure logic (no DB/QBO): the server action persists the result.
 *
 * Supported today (CSV): Chase Paymentech settlement, Stripe/Tekmetric payouts,
 * Stripe/Tekmetric charges. Tekmetric needs BOTH the payouts and charges files
 * to reconstruct membership (see stripe.ts). PDF ingestion is a future add.
 */
import { parseCsv } from "./csv";
import { parsePaymentechCsv } from "./paymentech";
import {
  parseStripePayouts,
  parseStripeCharges,
  reconstructTekmetricPayouts,
  type TekmetricReconstruction,
} from "./stripe";
import type { ExpectedDeposit } from "./types";

export type FileType = "paymentech" | "stripe_payouts" | "stripe_charges" | "unknown";

export interface NamedFile {
  name: string;
  text: string;
}

function headerSet(text: string): Set<string> {
  const rows = parseCsv(text.split("\n").slice(0, 1).join("\n") + "\n_");
  const first = rows[0] ?? {};
  return new Set(Object.keys(first).map((h) => h.toLowerCase().replace(/\s+/g, " ").trim()));
}

export function detectFileType(text: string): FileType {
  const h = headerSet(text);
  const has = (...ks: string[]) => ks.every((k) => h.has(k));
  if (has("card brand") && (h.has("batch #") || h.has("batch date"))) return "paymentech";
  if (h.has("arrival date (utc)") || (h.has("statement descriptor") && h.has("trace id")))
    return "stripe_payouts";
  if (h.has("fee") && (h.has("created date (utc)") || h.has("application fee"))) return "stripe_charges";
  return "unknown";
}

export interface IngestResult {
  paymentechDeposits: ExpectedDeposit[];
  tekmetric: TekmetricReconstruction | null;
  detected: Record<string, FileType>;
  /** Files whose type we couldn't recognize. */
  unknown: string[];
  /** Human-readable notes (e.g. "charges provided without a payouts file"). */
  notes: string[];
}

export function buildProposalsFromFiles(files: NamedFile[]): IngestResult {
  const detected: Record<string, FileType> = {};
  const paymentechDeposits: ExpectedDeposit[] = [];
  const unknown: string[] = [];
  const notes: string[] = [];
  let payoutsText: string | null = null;
  let chargesText: string | null = null;

  for (const f of files) {
    const type = detectFileType(f.text);
    detected[f.name] = type;
    if (type === "paymentech") paymentechDeposits.push(...parsePaymentechCsv(f.text));
    else if (type === "stripe_payouts") payoutsText = f.text;
    else if (type === "stripe_charges") chargesText = f.text;
    else unknown.push(f.name);
  }

  let tekmetric: TekmetricReconstruction | null = null;
  if (payoutsText && chargesText) {
    tekmetric = reconstructTekmetricPayouts(
      parseStripePayouts(payoutsText),
      parseStripeCharges(chargesText)
    );
  } else if (payoutsText || chargesText) {
    notes.push(
      "Tekmetric needs BOTH the payouts and the payments (charges) files to reconstruct deposits — only one was provided."
    );
  }

  return { paymentechDeposits, tekmetric, detected, unknown, notes };
}
