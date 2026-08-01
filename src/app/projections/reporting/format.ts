/**
 * Display formatting for the Reporting page (Phase 1). Pure helpers, safe to
 * import from both server and client components.
 */
import type { Delta, KpiFormat, Sentiment } from "@/lib/projections/reports";

/* The chart palette now lives in the shared GCD theme (src/app/components/
   chart-theme.tsx) so every chart draws from the same brand tokens. This file
   keeps only the value/label formatters used across server and client. */

export function money(v: number, opts: { compact?: boolean } = {}): string {
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    notation: opts.compact ? "compact" : "standard",
    minimumFractionDigits: opts.compact ? 0 : 2,
    maximumFractionDigits: opts.compact ? 1 : 2,
  });
}

/** A fraction (0.125) → "12.5%". */
export function percent(v: number, digits = 1): string {
  return `${(v * 100).toFixed(digits)}%`;
}

export function formatValue(value: number, format: KpiFormat): string {
  return format === "percent" ? percent(value) : money(value);
}

const ARROW: Record<Delta["direction"], string> = { up: "▲", down: "▼", flat: "—" };

/** The status class for coloring a delta good/bad/neutral (maps to CSS badges). */
export function sentimentClass(s: Sentiment): string {
  return s === "good" ? "ok" : s === "bad" ? "danger" : "muted";
}

/** e.g. "▲ 12.5% ($1,204.00)" — the % omitted when previous was 0. */
export function formatDelta(delta: Delta, format: KpiFormat): string {
  const arrow = ARROW[delta.direction];
  const abs =
    format === "percent"
      ? `${(delta.absolute * 100).toFixed(1)} pts`
      : money(Math.abs(delta.absolute));
  const pct = delta.pct === null ? "—" : percent(Math.abs(delta.pct));
  return `${arrow} ${pct} (${abs})`;
}
