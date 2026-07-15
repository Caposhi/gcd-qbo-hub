import { describe, it, expect } from "vitest";
import {
  deriveOpsBaseline,
  projectOps,
  summarizeOpsProjection,
  monthAfter,
  looksLikePartialMonth,
  type OpsMonth,
} from "@/lib/tekmetric/forecast";

/** Build a clean upward history: RO count and ARO both grow steadily. */
function history(): OpsMonth[] {
  const out: OpsMonth[] = [];
  for (let i = 0; i < 12; i++) {
    const roCount = 100 + i * 5; // +5 ROs/month
    const aro = 600 + i * 10; // +$10/month
    out.push({
      start: monthAfter("2025-01-01", i).start,
      label: monthAfter("2025-01-01", i).label,
      roCount,
      carCount: Math.round(roCount * 0.9),
      aro,
      revenue: roCount * aro,
      grossProfit: roCount * aro * 0.55,
      grossMarginPct: 55,
    });
  }
  return out;
}

describe("monthAfter", () => {
  it("advances months and rolls over the year", () => {
    expect(monthAfter("2026-07-01", 1)).toEqual({ start: "2026-08-01", label: "Aug 2026" });
    expect(monthAfter("2026-12-01", 1)).toEqual({ start: "2027-01-01", label: "Jan 2027" });
    expect(monthAfter("2026-01-01", 12)).toEqual({ start: "2027-01-01", label: "Jan 2027" });
  });
});

describe("deriveOpsBaseline", () => {
  const base = deriveOpsBaseline(history());

  it("recovers a positive month-over-month trend on a clean rising series", () => {
    expect(base.months).toBe(12);
    expect(base.roCount.monthlyGrowthPct).toBeGreaterThan(0);
    expect(base.aro.monthlyGrowthPct).toBeGreaterThan(0);
    // The latest month sits above the shop's own average on a rising series.
    expect(base.roCount.standing).toBe("above");
    expect(base.aro.standing).toBe("above");
    expect(base.lastLabel).toBe("Dec 2025");
  });

  it("anchors the current level at the robust median of the last 3 months", () => {
    // Last 3 (i=9,10,11): roCount 145/150/155 → median 150; aro 690/700/710 → 700.
    expect(base.roCount.current).toBeCloseTo(150, 4);
    expect(base.aro.current).toBeCloseTo(700, 4);
    expect(base.grossMarginPct.current).toBeCloseTo(55, 4);
  });

  it("reports the mean and a flat trend for a trendless margin", () => {
    // Margin is a constant 55 → mean 55, no drift, standing 'typical'.
    expect(base.grossMarginPct.mean).toBeCloseTo(55, 4);
    expect(base.grossMarginPct.monthlyGrowthPct).toBeCloseTo(0, 6);
    expect(base.grossMarginPct.standing).toBe("typical");
  });
});

describe("projectOps", () => {
  const base = deriveOpsBaseline(history());

  it("projects the derived trend forward and ties revenue to ARO × RO count", () => {
    const rows = projectOps(base, { horizonMonths: 6 });
    expect(rows).toHaveLength(6);
    expect(rows[0].label).toBe("Jan 2026"); // month after Dec 2025
    for (const r of rows) {
      expect(r.revenue).toBeCloseTo(r.roCount * r.aro, 4);
      expect(r.grossProfit).toBeCloseTo((r.revenue * r.grossMarginPct) / 100, 4);
    }
    // Growing drivers → later months exceed earlier ones.
    expect(rows[5].revenue).toBeGreaterThan(rows[0].revenue);
  });

  it("honors scenario overrides over the derived trend", () => {
    const flat = projectOps(base, { horizonMonths: 3, roMonthlyGrowthPct: 0, aroMonthlyGrowthPct: 0 });
    // With zero growth, every month equals the current level.
    expect(flat[0].roCount).toBeCloseTo(base.roCount.current, 4);
    expect(flat[2].roCount).toBeCloseTo(base.roCount.current, 4);

    const richMargin = projectOps(base, { horizonMonths: 2, grossMarginPct: 70 });
    expect(richMargin[0].grossMarginPct).toBe(70);
    expect(richMargin[0].grossProfit).toBeCloseTo((richMargin[0].revenue * 70) / 100, 4);
  });

  it("clamps horizon to 1–24 and never returns negatives", () => {
    expect(projectOps(base, { horizonMonths: 0 })).toHaveLength(1);
    expect(projectOps(base, { horizonMonths: 999 })).toHaveLength(24);
    const crash = projectOps(base, { horizonMonths: 6, roMonthlyGrowthPct: -0.9 });
    for (const r of crash) expect(r.roCount).toBeGreaterThanOrEqual(0);
  });
});

/** Build a monthly history from a list of RO counts (ARO/margin held constant). */
function roHistory(counts: number[]): OpsMonth[] {
  return counts.map((ro, i) => ({
    start: monthAfter("2025-01-01", i).start,
    label: monthAfter("2025-01-01", i).label,
    roCount: ro,
    carCount: ro,
    aro: 600,
    revenue: ro * 600,
    grossProfit: ro * 600 * 0.55,
    grossMarginPct: 55,
  }));
}

describe("robust trend (moves with the pattern, resists noise)", () => {
  it("projects flat when the early and recent windows sit at the same level", () => {
    // First 3 and last 3 share the median {90,100,130}→100, so there's no net
    // drift and the projection holds flat — without any 'held flat' special case.
    const base = deriveOpsBaseline(roHistory([100, 130, 90, 110, 95, 120, 100, 130, 90]));
    expect(base.roCount.monthlyGrowthPct).toBeCloseTo(0, 6);
    const rows = projectOps(base, { horizonMonths: 6 });
    for (const r of rows) expect(r.roCount).toBe(rows[0].roCount);
  });

  it("a single spike doesn't dominate the trend or the current level", () => {
    // Flat at 100 with one 500 spike in the middle. Median windows ignore it, so
    // growth stays ~0 and the current level stays 100 — no runaway from one month.
    const base = deriveOpsBaseline(roHistory([100, 100, 100, 100, 500, 100, 100, 100, 100]));
    expect(base.roCount.monthlyGrowthPct).toBeCloseTo(0, 6);
    expect(base.roCount.current).toBeCloseTo(100, 4);
    const rows = projectOps(base, { horizonMonths: 3 });
    for (const r of rows) expect(r.roCount).toBeCloseTo(100, 4);
  });

  it("projects a genuine decline when recent months sit below earlier ones", () => {
    // Steps down 200→120: recent window median well below the early window.
    const base = deriveOpsBaseline(roHistory([200, 190, 180, 170, 160, 150, 140, 130, 120]));
    expect(base.roCount.monthlyGrowthPct).toBeLessThan(0);
    const rows = projectOps(base, { horizonMonths: 6 });
    expect(rows[5].roCount).toBeLessThan(rows[0].roCount); // continues to decline
  });

  it("lets an explicit override replace the derived trend", () => {
    const base = deriveOpsBaseline(roHistory([100, 120, 95, 125, 90, 130]));
    const rows = projectOps(base, { horizonMonths: 3, roMonthlyGrowthPct: 0.1 });
    expect(rows[2].roCount).toBeGreaterThan(rows[0].roCount);
  });
});

describe("looksLikePartialMonth (bad-data guard)", () => {
  it("flags a meaningful RO count paired with an impossible margin", () => {
    // The real Apr-2026 corruption: 198 ROs but ~6.6% gross margin — impossible
    // when labor carries no COGS.
    expect(looksLikePartialMonth({ roCount: 198, grossMarginPct: 6.6, aro: 64 })).toBe(true);
  });

  it("flags a meaningful RO count with ~$0 ARO", () => {
    expect(looksLikePartialMonth({ roCount: 120, grossMarginPct: 55, aro: 0 })).toBe(true);
  });

  it("flags non-finite figures", () => {
    expect(looksLikePartialMonth({ roCount: NaN, grossMarginPct: 55, aro: 600 })).toBe(true);
  });

  it("passes a healthy month, and won't flag a genuinely tiny month", () => {
    expect(looksLikePartialMonth({ roCount: 150, grossMarginPct: 55, aro: 640 })).toBe(false);
    // A near-empty month (few ROs) is not treated as corrupt — the guard only
    // fires on a meaningful RO count, so a real slow month passes.
    expect(looksLikePartialMonth({ roCount: 3, grossMarginPct: 5, aro: 0 })).toBe(false);
  });
});

describe("deriveOpsBaseline — excludes corrupt months from the fit", () => {
  it("ignores a single partial month so it can't poison the baseline", () => {
    const clean = history(); // 12 clean upward months, Jan–Dec 2025
    // Corrupt the middle month into an impossible partial-pull shape.
    const poisoned = clean.map((m, i) =>
      i === 6 ? { ...m, grossProfit: m.revenue * 0.066, grossMarginPct: 6.6, aro: 60 } : m
    );

    const dirty = deriveOpsBaseline(poisoned);
    const pure = deriveOpsBaseline(clean);

    // The corrupt month is dropped from the fit (11 of 12 used) …
    expect(dirty.months).toBe(11);
    // … so the recovered trend and current level match the clean baseline, not a
    // margin dragged toward the 6.6% outlier.
    expect(dirty.grossMarginPct.current).toBeCloseTo(pure.grossMarginPct.current, 4);
    // ARO is still a clean rising series after the drop → latest sits above avg.
    expect(dirty.aro.standing).toBe("above");
  });

  it("keeps the full history when dropping bad months would leave too little", () => {
    // Only two clean months; the rest are corrupt. We can't fit on 2 points, so
    // the baseline falls back to the full set rather than returning nothing.
    const months: OpsMonth[] = [0, 1, 2, 3].map((i) => {
      const bad = i >= 2;
      return {
        start: monthAfter("2025-01-01", i).start,
        label: monthAfter("2025-01-01", i).label,
        roCount: 120,
        carCount: 108,
        aro: bad ? 0 : 600,
        revenue: bad ? 0 : 72000,
        grossProfit: bad ? 0 : 39600,
        grossMarginPct: bad ? 0 : 55,
      };
    });
    const base = deriveOpsBaseline(months);
    expect(base.months).toBe(4); // fell back to full history
  });
});

describe("summarizeOpsProjection", () => {
  it("totals revenue and gross profit and reports the ending month", () => {
    const base = deriveOpsBaseline(history());
    const rows = projectOps(base, { horizonMonths: 6 });
    const s = summarizeOpsProjection(rows);
    expect(s.horizonMonths).toBe(6);
    expect(s.totalRevenue).toBeCloseTo(rows.reduce((a, r) => a + r.revenue, 0), 2);
    expect(s.totalGrossProfit).toBeCloseTo(rows.reduce((a, r) => a + r.grossProfit, 0), 2);
    expect(s.endingMonthlyRevenue).toBeCloseTo(rows[5].revenue, 4);
    expect(s.avgGrossMarginPct).toBeCloseTo(55, 4);
  });

  it("handles a degenerate flat history without NaN/Infinity", () => {
    const flat: OpsMonth[] = Array.from({ length: 4 }, (_, i) => ({
      start: monthAfter("2025-01-01", i).start,
      label: monthAfter("2025-01-01", i).label,
      roCount: 100,
      carCount: 90,
      aro: 600,
      revenue: 60000,
      grossProfit: 33000,
      grossMarginPct: 55,
    }));
    const rows = projectOps(deriveOpsBaseline(flat), { horizonMonths: 3 });
    for (const r of rows) {
      expect(Number.isFinite(r.revenue)).toBe(true);
      expect(r.roCount).toBeCloseTo(100, 4);
    }
  });
});
