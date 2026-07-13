/**
 * Anthropic client for the AI C-suite (Phase 3).
 *
 * One agent turn = a persona system prompt + the SHARED monthly data context
 * (prompt-cached so every agent reuses it cheaply) + a task prompt, constrained
 * to structured JSON via `output_config.format`. Model is `claude-opus-4-8` with
 * adaptive thinking, matching the existing assistant. Returns the parsed JSON
 * plus redacted token usage for the budget tracker.
 *
 * Mirrors src/lib/anthropic/assistant.ts conventions: read-only, degrades when
 * `ANTHROPIC_API_KEY` is unset. No cost is ever incurred at import time.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Usage } from "./budget";

const MODEL = "claude-opus-4-8";

export function isCouncilConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export class CouncilNotConfiguredError extends Error {
  constructor() {
    super("AI council is not configured (ANTHROPIC_API_KEY is unset).");
    this.name = "CouncilNotConfiguredError";
  }
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentTurnParams {
  /** Persona system prompt (agent voice + scope). */
  personaSystem: string;
  /** Shared monthly data context — identical bytes across agents so it caches. */
  sharedContext: string;
  /** The task for this turn (first-pass, debate, synthesis, audit, board). */
  task: string;
  /** JSON schema the response must satisfy. */
  schema: Record<string, unknown>;
  effort?: Effort;
  maxTokens?: number;
}

export interface AgentTurnResult {
  /** Parsed JSON object (validate with parseInsight / parseBoardReport). */
  data: unknown;
  usage: Usage;
}

function mapUsage(u: Anthropic.Usage): Usage {
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Run a single structured agent turn. The shared context is the cached prefix
 * (first system block); the persona prompt is a second system block; the task is
 * the user turn — so the expensive shared context is written to cache once and
 * read at ~0.1× by every subsequent agent.
 */
export async function runAgentTurn(params: AgentTurnParams): Promise<AgentTurnResult> {
  if (!isCouncilConfigured()) throw new CouncilNotConfiguredError();
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Built as a plain object so `output_config` (effort + structured-output
  // format) passes through regardless of the installed SDK's typed surface.
  const body: Record<string, unknown> = {
    model: MODEL,
    max_tokens: params.maxTokens ?? 4096,
    thinking: { type: "adaptive" },
    output_config: {
      effort: params.effort ?? "medium",
      format: { type: "json_schema", schema: params.schema },
    },
    system: [
      { type: "text", text: params.sharedContext, cache_control: { type: "ephemeral" } },
      { type: "text", text: params.personaSystem },
    ],
    messages: [{ role: "user", content: params.task }],
  };

  const response = await client.messages.create(
    body as unknown as Anthropic.MessageCreateParamsNonStreaming
  );

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  let data: unknown = {};
  try {
    data = JSON.parse(text);
  } catch {
    // Leave data as {} — callers validate/coerce, so a non-JSON response degrades
    // to an empty (safe) insight rather than throwing.
    data = {};
  }

  return { data, usage: mapUsage(response.usage) };
}
