/**
 * Check Reception — pure fuzzy matching of a handwritten payee to a real QBO
 * vendor (no I/O, unit-tested).
 *
 * The read payee ("Interstate Batteries") rarely equals the QBO DisplayName
 * ("Interstate Batteries, Inc.") character-for-character, so we score candidates
 * by normalized equality, containment, and token overlap and return the best one
 * above a confidence threshold. This drives the "suggested vendor" prefill — the
 * owner still confirms, so a wrong guess is a one-click fix, never a silent post.
 */
import { normalizePayee } from "./classify";

/** Corporate suffixes that shouldn't dominate a token-overlap score. */
const STOPWORDS = new Set(["INC", "LLC", "CO", "CORP", "LTD", "THE", "AND", "OF", "COMPANY", "INCORPORATED"]);

/** Significant word tokens: uppercased alphanumerics, stopwords dropped. */
export function payeeTokens(s: string | null | undefined): string[] {
  return (s ?? "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/** 0..1 similarity between two names (normalized equality / containment / Jaccard). */
export function nameSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const na = normalizePayee(a);
  const nb = normalizePayee(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  // Full containment of the shorter inside the longer (e.g. "INTERSTATEBATTERIES"
  // ⊂ "INTERSTATEBATTERIESINC").
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (long.includes(short)) return 0.9;

  const ta = new Set(payeeTokens(a));
  const tb = new Set(payeeTokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export interface VendorOption {
  id: string;
  name: string;
}

export interface VendorMatch {
  id: string;
  name: string;
  score: number;
}

/**
 * Best vendor match for a read payee, or null if none clears `threshold`.
 * Deterministic: ties break on the higher name (stable ordering) so repeated
 * runs pick the same vendor.
 */
export function bestVendorMatch(
  payee: string | null | undefined,
  vendors: VendorOption[],
  threshold = 0.5
): VendorMatch | null {
  let best: VendorMatch | null = null;
  for (const v of vendors) {
    const score = nameSimilarity(payee, v.name);
    if (score < threshold) continue;
    if (!best || score > best.score || (score === best.score && v.name < best.name)) {
      best = { id: v.id, name: v.name, score };
    }
  }
  return best;
}
