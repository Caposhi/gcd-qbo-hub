"use client";

/**
 * QBO-style filter bar for the Reporting page (Phase 1).
 *
 * Client island: the controls write the active filters into the URL search
 * params and navigate, so the server component re-runs `loadReporting` and
 * every KPI/chart recomputes from the new range/comparison/method. Modeled on
 * QBO's report filters (date-range presets, comparison, accounting method).
 */
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useTransition } from "react";
import {
  RANGE_PRESETS,
  type RangePreset,
  type ComparisonMode,
  type AccountingMethod,
  type Granularity,
} from "@/lib/projections/reports";

const selectStyle: React.CSSProperties = {
  padding: "0.35rem 0.5rem",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--panel-2)",
  color: "var(--text)",
};

export interface FilterState {
  preset: RangePreset;
  comparison: ComparisonMode;
  method: AccountingMethod;
  granularity: Granularity;
  customStart?: string;
  customEnd?: string;
}

export function FilterBar({ state }: { state: FilterState }) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const update = useCallback(
    (patch: Partial<Record<string, string>>) => {
      const next = new URLSearchParams(params.toString());
      next.set("tab", "reporting");
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === "") next.delete(k);
        else next.set(k, v);
      }
      startTransition(() => router.push(`/projections?${next.toString()}`));
    },
    [params, router]
  );

  return (
    <div
      className="card"
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "1rem",
        alignItems: "flex-end",
        opacity: pending ? 0.6 : 1,
      }}
      aria-busy={pending}
    >
      <label className="kv" style={{ display: "grid", gap: "0.25rem" }}>
        <span className="muted">Date range</span>
        <select
          style={selectStyle}
          value={state.preset}
          onChange={(e) => update({ preset: e.target.value })}
        >
          {RANGE_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </label>

      {state.preset === "custom" && (
        <>
          <label className="kv" style={{ display: "grid", gap: "0.25rem" }}>
            <span className="muted">Start</span>
            <input
              type="date"
              style={selectStyle}
              defaultValue={state.customStart}
              onChange={(e) => update({ start: e.target.value })}
            />
          </label>
          <label className="kv" style={{ display: "grid", gap: "0.25rem" }}>
            <span className="muted">End</span>
            <input
              type="date"
              style={selectStyle}
              defaultValue={state.customEnd}
              onChange={(e) => update({ end: e.target.value })}
            />
          </label>
        </>
      )}

      <label className="kv" style={{ display: "grid", gap: "0.25rem" }}>
        <span className="muted">Compare to</span>
        <select
          style={selectStyle}
          value={state.comparison}
          onChange={(e) => update({ cmp: e.target.value })}
        >
          <option value="prior_period">Prior period</option>
          <option value="prior_year">Prior year</option>
        </select>
      </label>

      <label className="kv" style={{ display: "grid", gap: "0.25rem" }}>
        <span className="muted">Method</span>
        <select
          style={selectStyle}
          value={state.method}
          onChange={(e) => update({ method: e.target.value })}
        >
          <option value="accrual">Accrual</option>
          <option value="cash">Cash</option>
        </select>
      </label>

      <label className="kv" style={{ display: "grid", gap: "0.25rem" }}>
        <span className="muted">Trend by</span>
        <select
          style={selectStyle}
          value={state.granularity}
          onChange={(e) => update({ gran: e.target.value })}
        >
          <option value="month">Month</option>
          <option value="quarter">Quarter</option>
          <option value="year">Year</option>
        </select>
      </label>
    </div>
  );
}
