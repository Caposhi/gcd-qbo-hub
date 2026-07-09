/**
 * AI Report Assistant (prototype) — a Claude-powered assistant that answers
 * questions about German Car Depot's books using READ-ONLY tools over the hub's
 * own database (§1: "an AI chatbot/report-answering assistant familiar with the
 * business").
 *
 * Model: claude-opus-4-8 with adaptive thinking (the latest, most capable
 * Claude). The assistant has NO write access — its tools only read Cash Sheet
 * Sync data, so it can never post, edit, or delete anything. It is instructed
 * to answer strictly from tool results and never fabricate figures.
 */
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { BUSINESS_ENTITY } from "@/lib/cashsheet/config";
import { redact } from "@/lib/crypto";

const MODEL = "claude-opus-4-8";
const MAX_TOOL_ITERATIONS = 6;

export function isAssistantConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

const SYSTEM_PROMPT = `You are the GCD QBO Hub Report Assistant for ${BUSINESS_ENTITY} (trading as German Car Depot), an auto-repair shop.

You answer questions about the business's books as recorded in the Cash Sheet Sync module — the daily employee cash sheet that is synced to QuickBooks Online with a full audit trail.

Rules:
- Answer ONLY from the data returned by your tools. Never invent figures, transaction IDs, dates, or counts. If a tool returns nothing relevant, say so plainly.
- You are read-only. You cannot post, edit, delete, approve, or change anything in QBO or the hub — if asked to, explain that changes are made by an owner_admin through the dashboard.
- Customer invoice (INV) cash collections are audit-only and are never posted as new QBO revenue (to avoid double-counting) — reflect that when explaining income.
- Be concise and lead with the answer. Use plain dollar formatting like $1,080.00. When you cite a row, mention its tab and row number.
- If a question is outside the cash-sheet data you can see, say what you'd need and suggest the relevant dashboard page.`;

// ---- read-only tools ------------------------------------------------------

const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_sync_overview",
    description:
      "Get the latest Cash Sheet Sync run summary (mode, stage, rows scanned/posted/skipped/errored) plus current counts of rows by status. Use for 'how did the last sync go', totals, or attention items.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "query_cash_sheet_rows",
    description:
      "Query synced cash-sheet rows with optional filters. Returns up to 50 rows with their tab, row number, date, payee name, purpose, INV#, amounts, status, and QBO transaction id. Use to answer questions about specific transactions, purposes, months, or statuses.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Exact dashboard status to filter by, e.g. 'Posted', 'Audit Only', 'Unknown Purpose'." },
        tab: { type: "string", description: "Month tab name, e.g. 'Jul'." },
        purpose: { type: "string", description: "Case-insensitive substring of the Purpose field, e.g. 'PART'." },
        limit: { type: "integer", description: "Max rows to return (1-50, default 25)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_purpose_mappings",
    description:
      "List the active purpose→QBO mappings (which purposes post as expense/deposit/transfer, which are audit-only, which require manual approval). Use to explain how a purpose is categorized.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
];

function money(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

async function runTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "get_sync_overview": {
      const [lastRun, grouped] = await Promise.all([
        prisma.syncRun.findFirst({ orderBy: { startedAt: "desc" } }),
        prisma.sheetRow.groupBy({ by: ["status"], _count: { _all: true } }),
      ]);
      return {
        lastRun: lastRun && {
          startedAt: lastRun.startedAt,
          mode: lastRun.mode,
          rolloutStage: lastRun.rolloutStage,
          status: lastRun.status,
          rowsScanned: lastRun.rowsScanned,
          rowsPosted: lastRun.rowsPosted,
          rowsSkipped: lastRun.rowsSkipped,
          rowsError: lastRun.rowsError,
          tabsScanned: lastRun.tabsScanned,
        },
        statusCounts: Object.fromEntries(grouped.map((g) => [g.status, g._count._all])),
      };
    }
    case "query_cash_sheet_rows": {
      const where: Record<string, unknown> = {};
      if (typeof input.status === "string") where.status = input.status;
      if (typeof input.tab === "string") where.tabName = input.tab;
      if (typeof input.purpose === "string") where.purpose = { contains: input.purpose, mode: "insensitive" };
      const limit = Math.min(Math.max(Number(input.limit) || 25, 1), 50);
      const rows = await prisma.sheetRow.findMany({
        where,
        orderBy: [{ tabName: "asc" }, { rowNumberLastSeen: "asc" }],
        take: limit,
      });
      return {
        count: rows.length,
        rows: rows.map((r) => ({
          tab: r.tabName,
          row: r.rowNumberLastSeen,
          date: r.date ? r.date.toISOString().slice(0, 10) : null,
          name: r.name,
          purpose: r.purpose,
          inv: r.invNumber,
          amtCollected: money(r.amtCollected),
          amountPaidOut: money(r.amountPaidOut),
          bankDeposit: money(r.bankDeposit),
          status: r.status,
          qboTransactionId: r.qboTransactionId,
        })),
      };
    }
    case "list_purpose_mappings": {
      const maps = await prisma.purposeMapping.findMany({ where: { active: true }, orderBy: { normalizedPurpose: "asc" } });
      return maps.map((m) => ({
        purpose: m.purposePattern,
        action: m.qboAction,
        account: m.qboAccountName,
        auditOnly: m.auditOnly,
        requiresManualApproval: m.requiresManualApproval,
      }));
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface AssistantReply {
  text: string;
  /** Redacted usage for cost visibility (never secrets). */
  usage: { inputTokens: number; outputTokens: number; toolCalls: number };
}

/**
 * Answer a question given prior turns (plain text) + the new user message.
 * Runs a bounded manual tool loop. Adaptive thinking is on; the full response
 * content (including thinking + tool_use blocks) is echoed back each turn as
 * required when continuing on the same model.
 */
export async function askAssistant(history: ChatTurn[], userMessage: string): Promise<AssistantReply> {
  if (!isAssistantConfigured()) {
    throw new Error("Assistant is not configured (ANTHROPIC_API_KEY is unset).");
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const messages: Anthropic.MessageParam[] = [
    ...history.map((t) => ({ role: t.role, content: t.content }) as Anthropic.MessageParam),
    { role: "user", content: userMessage },
  ];

  let inputTokens = 0;
  let outputTokens = 0;
  let toolCalls = 0;

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8192,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });
    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;

    if (response.stop_reason !== "tool_use") {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { text: text || "(no answer)", usage: { inputTokens, outputTokens, toolCalls } };
    }

    // Echo the full assistant turn (thinking + tool_use blocks) back verbatim.
    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        toolCalls++;
        let result: unknown;
        try {
          result = await runTool(block.name, (block.input ?? {}) as Record<string, unknown>);
        } catch (err) {
          result = { error: String(err) };
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }
    }
    messages.push({ role: "user", content: toolResults });
  }

  return {
    text: "I wasn't able to finish looking that up (too many steps). Please narrow the question.",
    usage: { inputTokens, outputTokens, toolCalls },
  };
}

/** For logging/debug only — never expose the key. */
export function assistantKeyHint(): string {
  return redact(process.env.ANTHROPIC_API_KEY);
}
