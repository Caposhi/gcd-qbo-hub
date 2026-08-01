"use client";

/**
 * Recharts client islands for the Tekmetric Operations page.
 *
 * Same approach as the reporting page: interactive charts are client
 * components embedded in the RSC page. The page passes already-normalized,
 * already-computed derived metrics down as props — no data fetching or math
 * happens here, only rendering.
 */
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  TekAdvisorPerformance,
  TekRevenueByMake,
  TekTechUtilization,
} from "@/lib/tekmetric/types";
import { CHART, axisProps, gridProps, barCursor, GcdTooltip, money } from "@/app/components/chart-theme";

// Utilization thresholds map to the semantic tokens (green / amber / red).
const UTIL_OK = CHART.netIncome;   // success green
const UTIL_WARN = CHART.expense;   // warning ochre
const UTIL_BAD = "#C81E1E";        // --danger

function ChartCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="card" style={{ marginTop: "1rem" }}>
      <h3 className="card-title">{title}</h3>
      {subtitle && <p className="card-subtitle" style={{ margin: "0 0 0.75rem" }}>{subtitle}</p>}
      <div style={{ width: "100%", height: 300 }}>
        <ResponsiveContainer width="100%" height="100%">
          {children as React.ReactElement}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function utilizationColor(pct: number): string {
  if (pct >= 85) return UTIL_OK;
  if (pct >= 60) return UTIL_WARN;
  return UTIL_BAD;
}

export function TekCharts({
  techUtilization,
  revenueByMake,
  advisorPerformance,
}: {
  techUtilization: TekTechUtilization[];
  revenueByMake: TekRevenueByMake[];
  advisorPerformance: TekAdvisorPerformance[];
}) {
  const utilData = techUtilization.map((t) => ({
    name: t.technicianName,
    utilizationPct: t.utilizationPct,
    billedHours: t.billedHours,
    effectiveLaborRate: t.effectiveLaborRate,
  }));
  const makeData = revenueByMake.slice(0, 8).map((m) => ({
    name: m.make,
    revenue: m.revenue,
    grossProfit: m.grossProfit,
  }));
  const advisorData = advisorPerformance.map((a) => ({
    name: a.advisorName,
    totalSales: a.totalSales,
    aro: a.aro,
  }));

  return (
    <>
      <ChartCard
        title="Technician utilization"
        subtitle="Billed hours ÷ available hours. Green ≥ 85%, amber ≥ 60%, red below."
      >
        <BarChart data={utilData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="name" {...axisProps} />
          <YAxis unit="%" {...axisProps} />
          <Tooltip content={<GcdTooltip fmt={(n) => `${Math.round(n)}%`} />} cursor={barCursor} />
          <Bar dataKey="utilizationPct" name="Utilization" radius={[6, 6, 0, 0]} maxBarSize={44}>
            {utilData.map((d, i) => (
              <Cell key={i} fill={utilizationColor(d.utilizationPct)} />
            ))}
          </Bar>
        </BarChart>
      </ChartCard>

      <ChartCard title="Revenue by make" subtitle="Pre-tax revenue per vehicle make (top 8).">
        <BarChart data={makeData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="name" {...axisProps} />
          <YAxis tickFormatter={(v) => money(Number(v), true)} {...axisProps} />
          <Tooltip content={<GcdTooltip fmt={(n) => money(n)} />} cursor={barCursor} />
          <Bar dataKey="revenue" name="Revenue" radius={[6, 6, 0, 0]} maxBarSize={44}>
            {makeData.map((_, i) => (
              <Cell key={i} fill={CHART.make[i % CHART.make.length]} />
            ))}
          </Bar>
        </BarChart>
      </ChartCard>

      <ChartCard title="Advisor performance" subtitle="Total pre-tax sales by service advisor.">
        <BarChart data={advisorData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="name" {...axisProps} />
          <YAxis tickFormatter={(v) => money(Number(v), true)} {...axisProps} />
          <Tooltip content={<GcdTooltip fmt={(n) => money(n)} />} cursor={barCursor} />
          <Bar dataKey="totalSales" name="Total sales" fill={CHART.revenue} radius={[6, 6, 0, 0]} maxBarSize={44} />
        </BarChart>
      </ChartCard>
    </>
  );
}
