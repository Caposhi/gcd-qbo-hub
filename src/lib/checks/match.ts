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

/** Levenshtein edit distance between two strings. */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

/** 0..1 character-level similarity (1 − editDistance / longerLength). */
export function editRatio(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

/** Token-set similarity where near-equal tokens (e.g. BATTERY/BATTERIES) count. */
function tokenSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const ta = payeeTokens(a);
  const tb = payeeTokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const [small, large] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  let matched = 0;
  for (const t of small) {
    const best = Math.max(...large.map((u) => editRatio(t, u)));
    if (best >= 0.75) matched++;
  }
  // Divide by the larger token count so extra tokens dilute the score.
  return matched / Math.max(ta.length, tb.length);
}

/**
 * 0..1 similarity between two payee/vendor names. Combines: normalized equality,
 * containment (a read name inside the fuller QBO name), character edit-ratio
 * (catches singular/plural and small spelling drift like "Battery"/"Batteries"),
 * and token-set overlap. The max of these — deliberately forgiving so an existing
 * vendor is found before a near-duplicate is ever created. Every suggestion is
 * still shown for review, so a loose match is a one-click correction, not a
 * silent post.
 */
export function nameSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const na = normalizePayee(a);
  const nb = normalizePayee(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  // Require a meaningful stem so a 2–3 char fragment doesn't "contain"-match.
  const containment = short.length >= 4 && long.includes(short) ? 0.93 : 0;
  return Math.max(containment, editRatio(na, nb), tokenSimilarity(a, b));
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
  threshold = 0.68
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
