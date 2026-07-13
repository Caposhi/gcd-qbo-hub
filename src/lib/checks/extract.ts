/**
 * Check Reception — read handwritten checks from a Chase check-image PDF with
 * Claude vision (claude-opus-4-8, the latest, most capable Claude).
 *
 * Chase lets you download the month's cleared checks as a PDF, one check image
 * per page. We hand that PDF to Claude as a document block and ask it to read
 * each check into structured fields — check number, amount, date, payee, memo —
 * plus a self-reported confidence. Handwriting is imperfect, so this is a
 * best-effort READ only: nothing is written to QBO here. The owner confirms or
 * corrects every check before it posts (see actions.ts), and low-confidence or
 * incomplete reads are held for review (see classify.ts).
 *
 * Structured output is forced via a single tool so we get valid JSON, not prose.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ExtractedCheck } from "./classify";

const MODEL = "claude-opus-4-8";

/** ~32MB is Anthropic's PDF ceiling; keep a margin and fail clearly if over. */
const MAX_PDF_BYTES = 28 * 1024 * 1024;

export function isCheckReaderConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

const SYSTEM_PROMPT = `You read scanned images of business checks written by German Car Depot (an auto-repair shop) and drawn on their Chase checking account. Each page of the PDF is ONE check.

For every page, transcribe exactly what the check shows. Do not guess or infer beyond what is legible.

Read these fields per check:
- checkNumber: the pre-printed check number, usually top-right (digits only).
- amount: the dollar amount. Prefer the numeric box; cross-check against the written-out legal line. Return a number (e.g. 250.00), no currency symbol or commas.
- date: the date written on the check, normalized to YYYY-MM-DD. If the year is abbreviated, assume the 2000s.
- payee: the name on the "Pay to the order of" line, transcribed as written.
- memo: the memo/for line, if any.
- confidence: your honest confidence in THIS check's reading — "high" if all fields are clearly legible, "medium" if some fields required judgment, "low" if handwriting is hard to read or a key field is unclear/missing.

If a field is genuinely illegible or absent, use null for that field (and lower the confidence). Never fabricate a value. Report one entry per page, in page order.`;

const REPORT_TOOL: Anthropic.Tool = {
  name: "report_checks",
  description: "Report every check read from the PDF, one entry per page in page order.",
  input_schema: {
    type: "object",
    properties: {
      checks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            page: { type: "integer", description: "1-based page number this check is on." },
            checkNumber: { type: ["string", "null"], description: "Pre-printed check number, digits only, or null." },
            amount: { type: ["number", "null"], description: "Dollar amount as a number, or null if illegible." },
            date: { type: ["string", "null"], description: "Check date as YYYY-MM-DD, or null." },
            payee: { type: ["string", "null"], description: "Pay-to-the-order-of name as written, or null." },
            memo: { type: ["string", "null"], description: "Memo/for line, or null." },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
          },
          required: ["page", "checkNumber", "amount", "date", "payee", "memo", "confidence"],
          additionalProperties: false,
        },
      },
    },
    required: ["checks"],
    additionalProperties: false,
  },
};

export interface CheckExtractionResult {
  checks: ExtractedCheck[];
  usage: { inputTokens: number; outputTokens: number };
}

function coerce(raw: any, index: number): ExtractedCheck {
  const conf = raw?.confidence === "high" || raw?.confidence === "low" ? raw.confidence : "medium";
  const amount =
    raw?.amount === null || raw?.amount === undefined || Number.isNaN(Number(raw.amount))
      ? null
      : Number(Number(raw.amount).toFixed(2));
  const str = (v: unknown) => (v === null || v === undefined ? null : String(v).trim() || null);
  return {
    page: Number.isFinite(Number(raw?.page)) ? Number(raw.page) : index + 1,
    checkNumber: str(raw?.checkNumber),
    amount,
    date: str(raw?.date),
    payee: str(raw?.payee),
    memo: str(raw?.memo),
    confidence: conf,
  };
}

/**
 * Read every check in a PDF. `pdf` is the raw file bytes. Returns one
 * ExtractedCheck per page (best-effort). Throws if the reader is unconfigured,
 * the file is too large, or the model returns nothing usable.
 */
export async function extractChecksFromPdf(pdf: Buffer | Uint8Array): Promise<CheckExtractionResult> {
  if (!isCheckReaderConfigured()) {
    throw new Error("Check reader is not configured (ANTHROPIC_API_KEY is unset).");
  }
  const bytes = Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw new Error(
      `PDF is ${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB — over the ${(MAX_PDF_BYTES / 1024 / 1024).toFixed(
        0
      )}MB limit. Split it into smaller batches (fewer pages per file).`
    );
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    tools: [REPORT_TOOL],
    tool_choice: { type: "tool", name: "report_checks" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: bytes.toString("base64") },
          },
          {
            type: "text",
            text: "Read every check in this PDF. One check per page. Use the report_checks tool.",
          },
        ],
      },
    ],
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "report_checks"
  );
  const rawChecks = (toolUse?.input as { checks?: unknown[] } | undefined)?.checks;
  if (!Array.isArray(rawChecks)) {
    throw new Error("The check reader did not return any structured checks — try re-uploading the PDF.");
  }

  const checks = rawChecks.map((c, i) => coerce(c, i)).sort((a, b) => a.page - b.page);
  return {
    checks,
    usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
  };
}
