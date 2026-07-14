"use client";

/**
 * Interactive Recharts islands for the Reporting page (Phase 1).
 *
 * Client components rendered inside the RSC page. Each chart is clickable:
 * selecting a bar / bucket drills into the underlying rows in a detail panel
 * beneath the chart. Colors come from the validated dark-surface palette in
 * format.ts (dataviz skill); text stays on the theme's ink tokens, never the
 * series color.
 */
import { useState } from "react";
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
  Cell,
} from "recharts";
import type { TrendPoint, CategoryDatum } from "@/lib/projections/report-service";
import type { AgingNormalized } from "@/lib/projections/reports";
import { money, percent } from "./format";
import { CHART, axisProps, gridProps, barCursor, GcdTooltip } from "@/app/components/chart-theme";

function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card" style={{ minWidth: 0 }}>
      <h3 style={{ margin: "0 0 0.15rem" }}>{title}</h3>
      {subtitle && (
        <p className="muted" style={{ margin: "0 0 0.75rem", fontSize: "0.8rem" }}>
          {subtitle}
        </p>
      )}
      {children}
    </div>
  );
}

function EmptyNote({ label }: { label: string }) {
  return (
    <p className="muted" style={{ fontSize: "0.85rem", padding: "1.5rem 0", textAlign: "center" }}>
      No {label} for this range.
    </p>
  );
}

/** Revenue & Net Income over time — two series, ONE dollar axis (no dual-axis). */
export function TrendChart({ data }: { data: TrendPoint[] }) {
  if (data.length === 0) return <ChartCard title="Revenue & Net Income"><EmptyNote label="trend data" /></ChartCard>;
  return (
    <ChartCard title="Revenue & Net Income" subtitle="Per period across the selected range">
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="period" {...axisProps} />
          <YAxis {...axisProps} tickFormatter={(v) => money(Number(v), { compact: true })} width={64} />
          <Tooltip content={<GcdTooltip fmt={(n) => money(n)} />} cursor={barCursor} />
          <Legend wrapperStyle={{ fontSize: "0.8rem", color: "var(--text-muted)" }} />
          <Bar dataKey="revenue" name="Revenue" fill={CHART.revenue} radius={[6, 6, 0, 0]} maxBarSize={44} />
          <Line
            dataKey="netIncome"
            name="Net Income"
            type="monotone"
            stroke={CHART.netIncome}
            strokeWidth={2}
            dot={{ r: 3, fill: CHART.netIncome }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

/** Single-hue horizontal bars; click a bar to drill into its share of the total. */
export function CategoryChart({
  title,
  subtitle,
  data,
  unit = "revenue",
}: {
  title: string;
  subtitle?: string;
  data: CategoryDatum[];
  unit?: string;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  if (data.length === 0) return <ChartCard title={title}><EmptyNote label={unit} /></ChartCard>;
  const total = data.reduce((a, d) => a + d.value, 0);
  const height = Math.max(180, data.length * 34 + 24);
  const sel = selected !== null ? data[selected] : null;

  return (
    <ChartCard title={title} subtitle={subtitle ?? "Click a bar to see its share"}>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
          <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" horizontal={false} />
          <XAxis type="number" {...axisProps} tickFormatter={(v) => money(Number(v), { compact: true })} />
          <YAxis type="category" dataKey="name" {...axisProps} width={130} tickLine={false} />
          <Tooltip content={<GcdTooltip fmt={(n) => money(n)} />} cursor={barCursor} />
          <Bar
            dataKey="value"
            radius={[0, 6, 6, 0]}
            maxBarSize={26}
            onClick={(_, index) => setSelected((cur) => (cur === index ? null : index))}
            cursor="pointer"
          >
            {data.map((_, i) => (
              <Cell
                key={i}
                fill={CHART.bar}
                fillOpacity={selected === null || selected === i ? 1 : 0.45}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      {sel && (
        <div className="notice" style={{ marginTop: "0.5rem" }}>
          <strong>{sel.name}</strong> — {money(sel.value)}{" "}
          <span className="muted">
            ({total !== 0 ? percent(sel.value / total) : "—"} of{" "}
            {money(total, { compact: true })})
          </span>
        </div>
      )}
    </ChartCard>
  );
}

/**
 * A/R or A/P aging by bucket (severity ramp: current → 91+). Click a bucket to
 * drill into which customers/vendors sit in it, largest first.
 */
export function AgingChart({
  title,
  aging,
  entityLabel,
}: {
  title: string;
  aging: AgingNormalized;
  entityLabel: string;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const chartData = aging.bucketLabels.map((label, i) => ({
    bucket: label,
    amount: aging.totals[i] ?? 0,
    index: i,
  }));
  if (aging.total === 0) return <ChartCard title={title}><EmptyNote label="open balances" /></ChartCard>;

  const drill =
    selected !== null
      ? [...aging.rows]
          .map((r) => ({ name: r.name, amount: r.buckets[selected] ?? 0 }))
          .filter((r) => Math.abs(r.amount) >= 0.005)
          .sort((a, b) => b.amount - a.amount)
      : [];

  return (
    <ChartCard title={title} subtitle={`Total ${money(aging.total)} · click a bucket to drill in`}>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="bucket" {...axisProps} />
          <YAxis {...axisProps} tickFormatter={(v) => money(Number(v), { compact: true })} width={64} />
          <Tooltip content={<GcdTooltip fmt={(n) => money(n)} />} cursor={barCursor} />
          <Bar
            dataKey="amount"
            radius={[6, 6, 0, 0]}
            maxBarSize={56}
            onClick={(_, index) => setSelected((cur) => (cur === index ? null : index))}
            cursor="pointer"
          >
            {chartData.map((_, i) => (
              <Cell
                key={i}
                fill={CHART.aging[Math.min(i, CHART.aging.length - 1)]}
                fillOpacity={selected === null || selected === i ? 1 : 0.45}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      {selected !== null && (
        <div style={{ marginTop: "0.5rem" }}>
          <div className="muted" style={{ fontSize: "0.8rem", marginBottom: "0.35rem" }}>
            {entityLabel} in <strong>{aging.bucketLabels[selected]}</strong>
          </div>
          {drill.length === 0 ? (
            <p className="muted" style={{ fontSize: "0.85rem" }}>Nothing in this bucket.</p>
          ) : (
            <div className="table-wrap">
              <table className="gcd">
                <thead>
                  <tr>
                    <th>{entityLabel}</th>
                    <th className="num">Open</th>
                  </tr>
                </thead>
                <tbody>
                  {drill.slice(0, 12).map((r) => (
                    <tr key={r.name}>
                      <td>{r.name}</td>
                      <td style={{ textAlign: "right" }}>{money(r.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </ChartCard>
  );
}
