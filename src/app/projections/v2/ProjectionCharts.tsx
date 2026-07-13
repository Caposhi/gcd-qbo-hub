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
import { CHART_COLORS, money } from "../reporting/format";

const tooltipStyle: React.CSSProperties = {
  background: "var(--panel)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text)",
  fontSize: "0.8rem",
};
const axisProps = { stroke: CHART_COLORS.axis, tick: { fill: CHART_COLORS.axis, fontSize: 11 } } as const;

export interface ProjRow {
  label: string;
  netIncome: number;
  endingCash: number;
}

export function ProjectionChart({ data }: { data: ProjRow[] }) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="label" {...axisProps} interval="preserveStartEnd" minTickGap={24} />
        <YAxis {...axisProps} tickFormatter={(v) => money(Number(v), { compact: true })} width={68} />
        <Tooltip
          contentStyle={tooltipStyle}
          formatter={(v: number, name) => [money(Number(v)), name]}
          cursor={{ fill: "rgba(255,255,255,0.04)" }}
        />
        <Legend wrapperStyle={{ fontSize: "0.8rem", color: "var(--muted)" }} />
        <ReferenceLine y={0} stroke={CHART_COLORS.axis} strokeDasharray="2 2" />
        <Bar dataKey="netIncome" name="Net Income" fill={CHART_COLORS.netIncome} radius={[3, 3, 0, 0]} maxBarSize={40} />
        <Line
          dataKey="endingCash"
          name="Ending Cash"
          type="monotone"
          stroke={CHART_COLORS.revenue}
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
        <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" {...axisProps} tickFormatter={(v) => money(Number(v), { compact: true })} />
        <YAxis type="category" dataKey="label" {...axisProps} width={150} tickLine={false} />
        <Tooltip
          contentStyle={tooltipStyle}
          cursor={{ fill: "rgba(255,255,255,0.04)" }}
          formatter={(v: number, _n, item) => {
            const d = item?.payload as TornadoDatum | undefined;
            return d
              ? [`${money(d.swing)}  ( ${money(d.low)} → ${money(d.high)} )`, `${metricLabel} swing`]
              : [money(Number(v)), "swing"];
          }}
        />
        <Bar dataKey="swing" radius={[0, 4, 4, 0]} maxBarSize={28}>
          {data.map((_, i) => (
            <Cell key={i} fill={CHART_COLORS.bar} fillOpacity={i === 0 ? 1 : 0.7} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
