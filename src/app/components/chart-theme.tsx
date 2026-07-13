"use client";
/* =============================================================================
   GCD chart theme — shared Recharts config for every chart in the hub.
   This REPLACES the ad-hoc dark palette in the current Charts.tsx / charts.tsx.
   The <GcdTooltip> here is the fix for the "low-contrast hover popups" complaint:
   a white card, navy text, soft navy shadow — never a dark-on-dark bubble.
   Suggested path: src/app/components/chart-theme.tsx
   ========================================================================== */
import React from "react";

/* Brand-derived data-viz palette (light surface). Royal is the workhorse;
   net-income / positive series is success green; aging ramps royal -> red. */
export const CHART = {
  revenue: "#18479F",       // royal — primary series / bars
  netIncome: "#1E8E4E",     // success — profit line
  bar: "#18479F",           // single-hue category bars (use opacity for de-emphasis)
  barAlt: "#182848",        // navy — a second category set
  expense: "#C77A00",       // warning ochre — expense bars
  aging: ["#2E63C9", "#5B84D6", "#C77A00", "#E0631E", "#C81E1E"], // current -> 91+
  make: ["#18479F", "#2E63C9", "#5B84D6", "#1E8E4E", "#C77A00", "#8A6BBF", "#4C5766", "#C3CDDB"],
  grid: "#DCE3EC",          // --gray-200
  axis: "#6B7889",          // --text-muted
} as const;

export const axisProps = {
  stroke: CHART.grid,
  tick: { fill: CHART.axis, fontSize: 11, fontFamily: "var(--font-body)" },
  tickLine: false,
  axisLine: { stroke: CHART.grid },
} as const;

export const gridProps = { stroke: CHART.grid, strokeDasharray: "3 3", vertical: false } as const;
/* Hover cursor: a faint navy wash, NOT the old translucent white that vanished on light. */
export const barCursor = { fill: "rgba(24,40,72,0.05)" } as const;

export function money(v: number, compact = false): string {
  if (compact) {
    const a = Math.abs(v);
    if (a >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
    if (a >= 1e3) return "$" + Math.round(v / 1e3) + "K";
  }
  return "$" + Math.round(v).toLocaleString("en-US");
}
export function percent(frac: number): string { return (frac * 100).toFixed(1) + "%"; }

/* -----------------------------------------------------------------------------
   GcdTooltip — pass as <Tooltip content={<GcdTooltip fmt={money} />} />
   White card · 1px subtle border · navy title · muted labels · shadow-lg.
   Give each series a `name` and (optionally) a `color`; we echo the swatch.
   -------------------------------------------------------------------------- */
export function GcdTooltip({
  active, payload, label, fmt = (n: number) => money(n),
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; color?: string; payload?: Record<string, unknown> }>;
  label?: string | number;
  fmt?: (n: number) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid var(--border-subtle)",
        borderRadius: 12,
        boxShadow: "var(--shadow-lg)",
        padding: "10px 13px",
        fontSize: 12,
        color: "var(--text-strong)",
        minWidth: 150,
        pointerEvents: "none",
      }}
    >
      {label !== undefined && (
        <div style={{ fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 13, marginBottom: 6, color: "var(--navy-blue)" }}>
          {label}
        </div>
      )}
      {payload.map((p, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginTop: i ? 3 : 0 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--text-muted)" }}>
            <span style={{ width: 9, height: 9, borderRadius: 3, background: p.color || CHART.revenue }} />
            {p.name}
          </span>
          <span style={{ fontWeight: 700, color: "var(--navy-blue)" }}>{fmt(Number(p.value ?? 0))}</span>
        </div>
      ))}
    </div>
  );
}

/* Legend chip row you can drop above any chart */
export function Legend({ items }: { items: Array<{ label: string; color: string; line?: boolean }> }) {
  return (
    <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
      {items.map((it, i) => (
        <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12.5, color: "var(--text-body)" }}>
          <span style={{ width: it.line ? 14 : 11, height: it.line ? 3 : 11, borderRadius: it.line ? 2 : 3, background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}
