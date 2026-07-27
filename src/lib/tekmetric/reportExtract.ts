/**
 * Tekmetric End of Day Report extraction (vision) — reads an uploaded
 * screenshot or PDF of the shop's own report so an owner correcting a month
 * (see overrides.ts) doesn't have to retype numbers by hand.
 *
 * DEFINITION NOTE (read before changing the extracted fields): the report's
 * own bottom-line "Profit" subtracts a labor cost. Our system does NOT — the
 * Tekmetric API never exposes technician wage data, so normalize.ts treats
 * labor as zero-cost for every month (see its "Gross profit definition" doc
 * comment). If a correction used the report's Profit as-is, an overridden
 * month would sit on a different margin definition than every other month
 * and show a fake cliff in the Ops History trend. So this reads the report's
 * bottom "Total" row (which includes Fees — matching how our own
 * roRevenuePreTaxCents is computed) PLUS the Labor row's Cost, and
 * deriveOverrideFromReport() adds that labor cost back onto the report's
 * Profit to reproduce OUR definition, not the report's.
 *
 * Review-first, like Check Reception: this only reads and computes — nothing
 * is saved until the owner confirms the pre-filled "Correct a month" form.
 */
import Anthropic from "@anthropic-ai/sdk";
import { round2 } from "./normalize";

const MODEL = "claude-opus-4-8";
const MAX_FILE_BYTES = 28 * 1024 * 1024;

export function isReportReaderConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

const SYSTEM_PROMPT = `You read a Tekmetric "End of Day Report" screenshot or PDF for an auto-repair shop.

Read these fields EXACTLY as printed — do not calculate, round, or infer anything:
- periodStart / periodEnd: the date range shown at the top next to "Custom" (e.g. "Jul 1, 2024 - Jul 31, 2024"), normalized to YYYY-MM-DD.
- totalRepairOrders: "Total RO's" from the top summary strip ("How effective are your shops at selling work?").
- grandNetSales: the "Net Sales" figure on the FINAL "Total" row of the Profit Summary table — the very last row, which includes Fees. This is NOT the "Total w/o Fees" row just above it.
- grandCost: the "Cost" figure on that same final "Total" row.
- grandProfit: the "Profit $" figure on that same final "Total" row.
- laborCost: the "Cost" figure on the "Labor" row of the Profit Summary table.

If the image doesn't look like a Tekmetric End of Day Report, or a field is illegible or absent, use null for that field and explain what's wrong in \`notes\`. Never fabricate a value.`;

const REPORT_TOOL: Anthropic.Tool = {
  name: "report_eod_figures",
  description: "Report the figures read from the Tekmetric End of Day Report.",
  input_schema: {
    type: "object",
    properties: {
      periodStart: { type: ["string", "null"], description: "Report start date, YYYY-MM-DD, or null." },
      periodEnd: { type: ["string", "null"], description: "Report end date, YYYY-MM-DD, or null." },
      totalRepairOrders: { type: ["number", "null"], description: "'Total RO's' from the top strip, or null." },
      grandNetSales: { type: ["number", "null"], description: "Final Profit Summary 'Total' row's Net Sales, or null." },
      grandCost: { type: ["number", "null"], description: "Final Profit Summary 'Total' row's Cost, or null." },
      grandProfit: { type: ["number", "null"], description: "Final Profit Summary 'Total' row's Profit $, or null." },
      laborCost: { type: ["number", "null"], description: "Profit Summary 'Labor' row's Cost, or null." },
      notes: { type: "string", description: "Anything unclear, illegible, or unexpected about the file." },
    },
    required: [
      "periodStart",
      "periodEnd",
      "totalRepairOrders",
      "grandNetSales",
      "grandCost",
      "grandProfit",
      "laborCost",
      "notes",
    ],
    additionalProperties: false,
  },
};

export interface ExtractedReportFigures {
  periodStart: string | null;
  periodEnd: string | null;
  totalRepairOrders: number | null;
  grandNetSales: number | null;
  grandCost: number | null;
  grandProfit: number | null;
  laborCost: number | null;
  notes: string;
}

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** Read one End of Day Report file (image or PDF). Throws if unconfigured, oversized, or unreadable. */
export async function extractEndOfDayReport(file: Buffer, mediaType: string): Promise<ExtractedReportFigures> {
  if (!isReportReaderConfigured()) {
    throw new Error("Report reader is not configured (ANTHROPIC_API_KEY is unset).");
  }
  if (file.byteLength > MAX_FILE_BYTES) {
    throw new Error(
      `File is ${(file.byteLength / 1024 / 1024).toFixed(1)}MB — over the ${(MAX_FILE_BYTES / 1024 / 1024).toFixed(0)}MB limit.`
    );
  }
  const isPdf = mediaType === "application/pdf";
  if (!isPdf && !IMAGE_MEDIA_TYPES.has(mediaType)) {
    throw new Error(`Unsupported file type "${mediaType}" — upload a PNG/JPEG/WEBP screenshot or a PDF.`);
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const data = file.toString("base64");
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    tools: [REPORT_TOOL],
    tool_choice: { type: "tool", name: "report_eod_figures" },
    messages: [
      {
        role: "user",
        content: [
          isPdf
            ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
            : { type: "image", source: { type: "base64", media_type: mediaType as ImageMediaType, data } },
          { type: "text", text: "Read this Tekmetric End of Day Report. Use the report_eod_figures tool." },
        ],
      },
    ],
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "report_eod_figures"
  );
  const raw = toolUse?.input as Partial<ExtractedReportFigures> | undefined;
  if (!raw) throw new Error("The report reader didn't return anything usable — try re-uploading.");

  const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    periodStart: typeof raw.periodStart === "string" ? raw.periodStart : null,
    periodEnd: typeof raw.periodEnd === "string" ? raw.periodEnd : null,
    totalRepairOrders: numOrNull(raw.totalRepairOrders),
    grandNetSales: numOrNull(raw.grandNetSales),
    grandCost: numOrNull(raw.grandCost),
    grandProfit: numOrNull(raw.grandProfit),
    laborCost: numOrNull(raw.laborCost),
    notes: typeof raw.notes === "string" ? raw.notes : "",
  };
}

export interface ReportDerivedOverride {
  roCount: number;
  aro: number;
  grossProfit: number;
  grossMarginPct: number;
}

/**
 * Turn extracted figures into our override fields. grossProfit adds the
 * report's own Labor Cost back onto its Profit — see this file's header for
 * why: it re-derives OUR zero-labor-cost definition rather than using the
 * report's (different) one.
 */
export function deriveOverrideFromReport(figures: {
  totalRepairOrders: number;
  grandNetSales: number;
  grandProfit: number;
  laborCost: number;
}): ReportDerivedOverride {
  const roCount = Math.max(0, Math.round(figures.totalRepairOrders));
  const revenue = round2(figures.grandNetSales);
  const aro = roCount > 0 ? round2(revenue / roCount) : 0;
  const grossProfit = round2(figures.grandProfit + figures.laborCost);
  const grossMarginPct = revenue > 0 ? round2((grossProfit / revenue) * 100) : 0;
  return { roCount, aro, grossProfit, grossMarginPct };
}
