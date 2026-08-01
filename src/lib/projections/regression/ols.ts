/**
 * Ordinary least-squares linear regression (Projections engine v2, Phase 2).
 *
 * The hybrid projections method (locked decision) derives baseline coefficients
 * from our own QBO history via *auditable* regression, and surfaces them as
 * editable defaults with a confidence signal (R², sample size). This is that
 * regression — deliberately simple and pure so every derived number can be
 * traced back to the points that produced it and unit-tested in isolation (§20).
 */

export interface Point {
  x: number;
  y: number;
}

export interface Fit {
  /** y ≈ slope·x + intercept */
  slope: number;
  intercept: number;
  /** Coefficient of determination in [0,1]; 0 when undefined (n<2 or no x/y variance). */
  r2: number;
  /** Number of points used. */
  n: number;
  /** Mean of the y values (handy as a fallback "average" coefficient). */
  meanY: number;
  meanX: number;
}

const EMPTY_FIT: Fit = { slope: 0, intercept: 0, r2: 0, n: 0, meanY: 0, meanX: 0 };

/**
 * Fit y = slope·x + intercept over the given points.
 *
 * Robust by construction: fewer than 2 points, or zero variance in x, yields a
 * flat fit (slope 0, intercept = meanY, r2 0) rather than NaN/Infinity — so a
 * derived default is always a finite, usable number.
 */
export function linearRegression(points: Point[]): Fit {
  const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const n = pts.length;
  if (n === 0) return { ...EMPTY_FIT };

  const meanX = pts.reduce((s, p) => s + p.x, 0) / n;
  const meanY = pts.reduce((s, p) => s + p.y, 0) / n;
  if (n < 2) return { ...EMPTY_FIT, n, meanX, meanY, intercept: meanY };

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of pts) {
    const dx = p.x - meanX;
    const dy = p.y - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }

  if (sxx === 0) {
    // No variance in x → can't fit a slope; fall back to the flat mean.
    return { slope: 0, intercept: meanY, r2: 0, n, meanX, meanY };
  }

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  const r2 = syy === 0 ? 1 : clamp01((sxy * sxy) / (sxx * syy));
  return { slope, intercept, r2, n, meanX, meanY };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Predict y at a given x from a fit. */
export function predict(fit: Fit, x: number): number {
  return fit.slope * x + fit.intercept;
}

/**
 * A qualitative confidence band for a fit, used to colour the UI's confidence
 * signal. Weighs both R² and sample size — a great R² on 3 months is not strong.
 */
export type Confidence = "strong" | "moderate" | "weak";
export function confidenceOf(r2: number, n: number): Confidence {
  if (n < 3) return "weak";
  if (r2 >= 0.7 && n >= 6) return "strong";
  if (r2 >= 0.4 && n >= 4) return "moderate";
  return "weak";
}
