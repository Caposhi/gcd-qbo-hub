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

  it("recovers a positive trend with strong confidence on a clean series", () => {
    expect(base.months).toBe(12);
    expect(base.roCount.monthlyGrowthPct).toBeGreaterThan(0);
    expect(base.aro.monthlyGrowthPct).toBeGreaterThan(0);
    expect(base.roCount.confidence).toBe("strong"); // perfectly linear → r2≈1
    expect(base.lastLabel).toBe("Dec 2025");
  });

  it("fits the current level near the last observed month", () => {
    // Last month (i=11): roCount 100+11*5 = 155, aro 600+11*10 = 710.
    expect(base.roCount.current).toBeCloseTo(155, 0);
    expect(base.aro.current).toBeCloseTo(710, 0);
    expect(base.grossMarginPct.current).toBeCloseTo(55, 4);
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

describe("confidence damping (don't extrapolate noise)", () => {
  it("holds a weak (near-zero R²) trend flat instead of projecting a decline/climb", () => {
    // A zig-zag with no real trend → low R² → 'weak'. The raw slope is tiny but
    // nonzero; the effective (damped) growth must be 0 so the forecast is flat.
    const noisy: OpsMonth[] = [100, 120, 95, 125, 90, 130, 100, 118, 92, 128].map((ro, i) => ({
      start: monthAfter("2025-01-01", i).start,
      label: monthAfter("2025-01-01", i).label,
      roCount: ro,
      carCount: ro,
      aro: 600,
      revenue: ro * 600,
      grossProfit: ro * 600 * 0.55,
      grossMarginPct: 55,
    }));
    const base = deriveOpsBaseline(noisy);
    expect(base.roCount.confidence).toBe("weak");
    expect(base.roCount.effectiveMonthlyGrowthPct).toBe(0); // damped to flat
    const rows = projectOps(base, { horizonMonths: 6 });
    // Every projected month equals the first — no drift from noise.
    for (const r of rows) expect(r.roCount).toBe(rows[0].roCount);
  });

  it("still lets an explicit override drive a trend even when the fit is weak", () => {
    const noisy: OpsMonth[] = [100, 120, 95, 125, 90, 130].map((ro, i) => ({
      start: monthAfter("2025-01-01", i).start,
      label: monthAfter("2025-01-01", i).label,
      roCount: ro,
      carCount: ro,
      aro: 600,
      revenue: ro * 600,
      grossProfit: ro * 600 * 0.55,
      grossMarginPct: 55,
    }));
    const rows = projectOps(deriveOpsBaseline(noisy), { horizonMonths: 3, roMonthlyGrowthPct: 0.1 });
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
    expect(dirty.aro.confidence).toBe("strong");
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
