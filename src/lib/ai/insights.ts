/**
 * Structured agent output — schemas + validation (AI C-suite, Phase 3) — pure.
 *
 * Every agent returns structured JSON that the UI renders with progressive
 * disclosure: a one-line takeaway → 2–4 insight bullets pinned beside the graphs
 * → an expandable full memo. The monthly run also produces a long-form board
 * report. This module defines the JSON schemas passed to the API's structured
 * output (`output_config.format`) AND validates/coerces on read (mirroring
 * `parseAssumptions`) so a malformed model response or stored row can never
 * crash the UI.
 *
 * IO-free and unit-tested (§20).
 */

export type Confidence = "high" | "medium" | "low";

export interface InsightReference {
  /** Which report/period the claim draws on, e.g. "P&L Jun 2026". */
  report: string;
  /** What the number says. */
  note: string;
}

export interface AgentInsight {
  /** One-line headline. */
  takeaway: string;
  /** 2–4 insight bullets (clamped on read). */
  bullets: string[];
  /** Expandable full memo (plain language). */
  memo: string;
  confidence: Confidence;
  /** Evidence pointers. */
  references: InsightReference[];
}

export interface BoardSection {
  heading: string;
  body: string;
}

export interface BoardReport {
  takeaway: string;
  /** Long-form end-of-month report body. */
  longForm: string;
  sections: BoardSection[];
  /** Governance concerns raised. */
  concerns: string[];
  /** Where the board agrees with the officers. */
  endorsements: string[];
}

// ── JSON schemas for output_config.format (no min/maxItems — enforced on read) ──

export const INSIGHT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    takeaway: { type: "string" },
    bullets: { type: "array", items: { type: "string" } },
    memo: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    references: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { report: { type: "string" }, note: { type: "string" } },
        required: ["report", "note"],
      },
    },
  },
  required: ["takeaway", "bullets", "memo", "confidence", "references"],
} as const;

export const BOARD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    takeaway: { type: "string" },
    longForm: { type: "string" },
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { heading: { type: "string" }, body: { type: "string" } },
        required: ["heading", "body"],
      },
    },
    concerns: { type: "array", items: { type: "string" } },
    endorsements: { type: "array", items: { type: "string" } },
  },
  required: ["takeaway", "longForm", "sections", "concerns", "endorsements"],
} as const;

// ── Validation / coercion ──────────────────────────────────────────────────

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function strArray(v: unknown): string[] {
  return (Array.isArray(v) ? v : []).map(str).filter((s) => s.trim() !== "");
}
function confidence(v: unknown): Confidence {
  return v === "high" || v === "medium" || v === "low" ? v : "medium";
}

/** Validate/coerce an agent insight. Bullets are clamped to 2–4 on read. */
export function parseInsight(json: unknown): AgentInsight {
  const o = obj(json);
  const bullets = strArray(o.bullets).slice(0, 4);
  const references: InsightReference[] = (Array.isArray(o.references) ? o.references : [])
    .map((r) => {
      const ro = obj(r);
      return { report: str(ro.report), note: str(ro.note) };
    })
    .filter((r) => r.report !== "" || r.note !== "");
  return {
    takeaway: str(o.takeaway) || "(no takeaway)",
    bullets,
    memo: str(o.memo),
    confidence: confidence(o.confidence),
    references,
  };
}

export function parseBoardReport(json: unknown): BoardReport {
  const o = obj(json);
  const sections: BoardSection[] = (Array.isArray(o.sections) ? o.sections : [])
    .map((s) => {
      const so = obj(s);
      return { heading: str(so.heading), body: str(so.body) };
    })
    .filter((s) => s.heading !== "" || s.body !== "");
  return {
    takeaway: str(o.takeaway) || "(no takeaway)",
    longForm: str(o.longForm),
    sections,
    concerns: strArray(o.concerns),
    endorsements: strArray(o.endorsements),
  };
}
