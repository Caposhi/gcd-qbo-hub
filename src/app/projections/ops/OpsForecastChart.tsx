"use client";

/**
 * Operations forecast chart — projected monthly revenue (bars) with gross profit
 * (line) on one dollar axis. Themed with the shared GCD chart theme.
 */
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { CHART, axisProps, gridProps, barCursor, GcdTooltip } from "@/app/components/chart-theme";
import { money } from "../reporting/format";

export interface OpsChartRow {
  label: string;
  revenue: number;
  grossProfit: number;
}

export function OpsForecastChart({ data }: { data: OpsChartRow[] }) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <CartesianGrid {...gridProps} />
        <XAxis dataKey="label" {...axisProps} interval="preserveStartEnd" minTickGap={20} />
        <YAxis {...axisProps} tickFormatter={(v) => money(Number(v), { compact: true })} width={68} />
        <Tooltip content={<GcdTooltip fmt={(n) => money(n)} />} cursor={barCursor} />
        <Legend wrapperStyle={{ fontSize: "0.8rem", color: "var(--text-muted)" }} />
        <Bar dataKey="revenue" name="Revenue" fill={CHART.revenue} radius={[6, 6, 0, 0]} maxBarSize={40} />
        <Line
          dataKey="grossProfit"
          name="Gross profit"
          type="monotone"
          stroke={CHART.netIncome}
          strokeWidth={2}
          dot={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
