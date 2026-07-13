"use client";

/**
 * Projection & sensitivity charts (Projections v2, Phase 2) — client islands.
 *
 * ProjectionChart tells the runway story: Net Income (bars, flow) against Ending
 * Cash (line, stock) on one dollar axis, with a zero reference line so a cash
 * shortfall is obvious. TornadoChart ranks which single driver swings the target
 * most. Colors are the validated dark-surface palette from reporting/format.ts.
 */
import {
  ResponsiveContainer,
  ComposedChart,
  BarChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  Cell,
} from "recharts";
import { money } from "../reporting/format";
import { CHART, axisProps, gridProps, barCursor, GcdTooltip } from "@/app/components/chart-theme";

export interface ProjRow {
  label: string;
  netIncome: number;
  endingCash: number;
}

export function ProjectionChart({ data }: { data: ProjRow[] }) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <CartesianGrid {...gridProps} />
        <XAxis dataKey="label" {...axisProps} interval="preserveStartEnd" minTickGap={24} />
        <YAxis {...axisProps} tickFormatter={(v) => money(Number(v), { compact: true })} width={68} />
        <Tooltip content={<GcdTooltip fmt={(n) => money(n)} />} cursor={barCursor} />
        <Legend wrapperStyle={{ fontSize: "0.8rem", color: "var(--text-muted)" }} />
        <ReferenceLine y={0} stroke={CHART.axis} strokeDasharray="2 2" />
        <Bar dataKey="netIncome" name="Net Income" fill={CHART.netIncome} radius={[6, 6, 0, 0]} maxBarSize={40} />
        <Line
          dataKey="endingCash"
          name="Ending Cash"
          type="monotone"
          stroke={CHART.revenue}
          strokeWidth={2}
          dot={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export interface TornadoDatum {
  label: string;
  swing: number;
  low: number;
  high: number;
  base: number;
}

/** Which lever moves the target most — single-hue horizontal bars, largest first. */
export function TornadoChart({ data, metricLabel }: { data: TornadoDatum[]; metricLabel: string }) {
  if (data.length === 0) return null;
  const height = Math.max(160, data.length * 40 + 24);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
        <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" {...axisProps} tickFormatter={(v) => money(Number(v), { compact: true })} />
        <YAxis type="category" dataKey="label" {...axisProps} width={150} tickLine={false} />
        <Tooltip content={<TornadoTooltip metricLabel={metricLabel} />} cursor={barCursor} />
        <Bar dataKey="swing" radius={[0, 6, 6, 0]} maxBarSize={28}>
          {data.map((_, i) => (
            <Cell key={i} fill={CHART.bar} fillOpacity={i === 0 ? 1 : 0.7} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Light-card tooltip for the tornado: shows the swing and its low→high range. */
function TornadoTooltip({
  active,
  payload,
  metricLabel,
}: {
  active?: boolean;
  payload?: Array<{ payload?: TornadoDatum }>;
  metricLabel?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
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
        minWidth: 180,
        pointerEvents: "none",
      }}
    >
      <div style={{ fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 13, marginBottom: 6, color: "var(--navy-blue)" }}>
        {d.label}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
        <span style={{ color: "var(--text-muted)" }}>{metricLabel ?? "Metric"} swing</span>
        <span style={{ fontWeight: 700, color: "var(--navy-blue)" }}>{money(d.swing)}</span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, marginTop: 3, color: "var(--text-muted)" }}>
        <span>Range</span>
        <span>{money(d.low)} → {money(d.high)}</span>
      </div>
    </div>
  );
}
