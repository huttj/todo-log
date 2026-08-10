// LLM usage instrumentation: every invocation records its token counts (from
// response.usage) and a computed cost. Prices are $/MTok from the Anthropic
// price list; cache reads bill at 0.1x input, cache writes at 1.25x.
import type { Env } from "./types";
import { now, insertRow } from "./db";

const PRICES: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

function rates(model: string): { input: number; output: number } {
  // Sonnet 5 introductory pricing ($2/$10) runs through 2026-08-31.
  if (model === "claude-sonnet-5" && Date.now() < Date.parse("2026-09-01T00:00:00Z")) {
    return { input: 2, output: 10 };
  }
  return PRICES[model] ?? { input: 3, output: 15 };
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function emptyUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/** Add one API response's usage block into a running total. */
export function addUsage(
  total: UsageTotals,
  u: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  },
): void {
  total.input += u.input_tokens;
  total.output += u.output_tokens;
  total.cacheRead += u.cache_read_input_tokens ?? 0;
  total.cacheWrite += u.cache_creation_input_tokens ?? 0;
}

export function computeCost(model: string, u: UsageTotals): number {
  const r = rates(model);
  return (
    (u.input * r.input +
      u.cacheWrite * r.input * 1.25 +
      u.cacheRead * r.input * 0.1 +
      u.output * r.output) /
    1_000_000
  );
}

export async function recordUsage(
  env: Env,
  args: {
    userId: number;
    kind: "turn" | "briefing" | "checkin" | "distill";
    model: string;
    sessionId?: number | null;
    messageId?: number | null;
    usage: UsageTotals;
  },
): Promise<void> {
  try {
    await insertRow(env, "llm_usage", {
      user_id: args.userId,
      kind: args.kind,
      model: args.model,
      session_id: args.sessionId ?? null,
      message_id: args.messageId ?? null,
      input_tokens: args.usage.input,
      output_tokens: args.usage.output,
      cache_read_tokens: args.usage.cacheRead,
      cache_write_tokens: args.usage.cacheWrite,
      cost_usd: computeCost(args.model, args.usage),
      created_at: now(),
    });
  } catch (err) {
    // Instrumentation must never break the invocation it measures.
    console.error("usage recording failed:", err);
  }
}
