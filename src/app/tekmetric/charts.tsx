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

// Palette drawn from the hub's CSS custom properties (dark theme).
const ACCENT = "#2ec4b6";
const ACCENT_2 = "#4cc9f0";
const OK = "#06d6a0";
const WARN = "#ffb703";
const DANGER = "#ef476f";
const GRID = "#26456b";
const TEXT = "#93b4cc";
const MAKE_PALETTE = [ACCENT, ACCENT_2, OK, WARN, "#9b5de5", "#f15bb5", "#00bbf9", "#fee440"];

const axisProps = { stroke: TEXT, fontSize: 12, tickLine: false } as const;

function money(v: number): string {
  return `$${Math.round(v).toLocaleString("en-US")}`;
}

const tooltipStyle = {
  background: "#1b3350",
  border: "1px solid #26456b",
  borderRadius: 8,
  color: "#e0fbfc",
} as const;

function ChartCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="card" style={{ marginTop: "1rem" }}>
      <h3 style={{ marginBottom: subtitle ? 2 : 8 }}>{title}</h3>
      {subtitle && <p className="muted" style={{ margin: "0 0 0.5rem", fontSize: "0.8rem" }}>{subtitle}</p>}
      <div style={{ width: "100%", height: 300 }}>
        <ResponsiveContainer width="100%" height="100%">
          {children as React.ReactElement}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function utilizationColor(pct: number): string {
  if (pct >= 85) return OK;
  if (pct >= 60) return WARN;
  return DANGER;
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
          <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="name" {...axisProps} />
          <YAxis unit="%" {...axisProps} />
          <Tooltip
            contentStyle={tooltipStyle}
            cursor={{ fill: "rgba(255,255,255,0.04)" }}
            formatter={(value: number, key: string) =>
              key === "utilizationPct" ? [`${value}%`, "Utilization"] : [value, key]
            }
          />
          <Bar dataKey="utilizationPct" radius={[4, 4, 0, 0]}>
            {utilData.map((d, i) => (
              <Cell key={i} fill={utilizationColor(d.utilizationPct)} />
            ))}
          </Bar>
        </BarChart>
      </ChartCard>

      <ChartCard title="Revenue by make" subtitle="Pre-tax revenue per vehicle make (top 8).">
        <BarChart data={makeData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
          <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="name" {...axisProps} />
          <YAxis tickFormatter={money} {...axisProps} />
          <Tooltip
            contentStyle={tooltipStyle}
            cursor={{ fill: "rgba(255,255,255,0.04)" }}
            formatter={(value: number, key: string) => [money(value), key === "revenue" ? "Revenue" : "Gross profit"]}
          />
          <Bar dataKey="revenue" radius={[4, 4, 0, 0]}>
            {makeData.map((_, i) => (
              <Cell key={i} fill={MAKE_PALETTE[i % MAKE_PALETTE.length]} />
            ))}
          </Bar>
        </BarChart>
      </ChartCard>

      <ChartCard title="Advisor performance" subtitle="Total pre-tax sales by service advisor.">
        <BarChart data={advisorData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
          <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="name" {...axisProps} />
          <YAxis tickFormatter={money} {...axisProps} />
          <Tooltip
            contentStyle={tooltipStyle}
            cursor={{ fill: "rgba(255,255,255,0.04)" }}
            formatter={(value: number, key: string) => [money(value), key === "totalSales" ? "Total sales" : "ARO"]}
          />
          <Bar dataKey="totalSales" fill={ACCENT_2} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ChartCard>
    </>
  );
}
