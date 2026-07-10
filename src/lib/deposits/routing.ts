/**
 * Route a downloaded bank-feed line to the processor that produced it.
 *
 * The bank description's `ORIG CO NAME` cleanly separates the two (verified):
 *   "ORIG CO NAME:PAYMENTECH …"        → Chase Paymentech
 *   "ORIG CO NAME:Tekmetric Paymen …"  → Tekmetric Payments
 */
import type { Processor } from "./types";

export function classifyBankLine(description: string): Processor | null {
  const s = String(description ?? "").toUpperCase();
  if (s.includes("PAYMENTECH")) return "paymentech";
  if (s.includes("TEKMETRIC")) return "tekmetric";
  return null;
}
