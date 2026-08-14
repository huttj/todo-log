// Curated cross-provider model catalog. One entry per model the app offers;
// the settings UI, config validation, request routing, and cost math all key
// off this table. Anthropic runs on the house key (or the user's, when added);
// every other provider requires a user key (BYOK).
//
// Cost tiers ($–$$$$) are normalized ACROSS the whole catalog, not within a
// provider: they're log-spaced buckets over a blended $/MTok (input-weighted,
// since agent workloads read far more than they write).

export type ProviderId = "anthropic" | "openai" | "moonshot" | "groq" | "cerebras";
/** Which HTTP protocol the provider speaks: Anthropic Messages, or OpenAI
 * chat-completions (everyone else — served by the adapter in llm.ts). */
export type Wire = "anthropic" | "openai";
/** How the model exposes reasoning: Anthropic adaptive thinking, an OpenAI
 * `reasoning_effort` knob, or nothing tunable. */
export type ThinkingKind = "adaptive" | "effort" | "none";

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  wire: Wire;
  baseUrl: string;
  /** Hint shown next to the key input. */
  keyHint: string;
}

export interface ModelInfo {
  /** Stable slug stored in users.agent_config ("sonnet" et al. predate BYOK). */
  slug: string;
  provider: ProviderId;
  /** The model string sent over the wire. */
  apiId: string;
  label: string;
  /** $ / MTok, list price. */
  input: number;
  output: number;
  thinking: ThinkingKind;
  /** Provider reliably honors response_format json_schema (used by briefing). */
  jsonSchema: boolean;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    wire: "anthropic",
    baseUrl: "https://api.anthropic.com",
    keyHint: "console.anthropic.com → API keys (sk-ant-…)",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    wire: "openai",
    baseUrl: "https://api.openai.com/v1",
    keyHint: "platform.openai.com → API keys (sk-…)",
  },
  moonshot: {
    id: "moonshot",
    label: "Moonshot (Kimi)",
    wire: "openai",
    baseUrl: "https://api.moonshot.ai/v1",
    keyHint: "platform.moonshot.ai → API keys",
  },
  groq: {
    id: "groq",
    label: "Groq",
    wire: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    keyHint: "console.groq.com → API keys (gsk_…)",
  },
  cerebras: {
    id: "cerebras",
    label: "Cerebras",
    wire: "openai",
    baseUrl: "https://api.cerebras.ai/v1",
    keyHint: "cloud.cerebras.ai → API keys (csk-…)",
  },
};

export const MODELS: Record<string, ModelInfo> = {
  // Anthropic — slugs predate BYOK and live in stored agent_config; keep them.
  sonnet: { slug: "sonnet", provider: "anthropic", apiId: "claude-sonnet-5", label: "Sonnet 5", input: 3, output: 15, thinking: "adaptive", jsonSchema: true },
  opus: { slug: "opus", provider: "anthropic", apiId: "claude-opus-5", label: "Opus 5", input: 5, output: 25, thinking: "adaptive", jsonSchema: true },
  haiku: { slug: "haiku", provider: "anthropic", apiId: "claude-haiku-4-5", label: "Haiku 4.5", input: 1, output: 5, thinking: "none", jsonSchema: true },
  // OpenAI — GPT-5.6 family (July 2026).
  "gpt-sol": { slug: "gpt-sol", provider: "openai", apiId: "gpt-5.6-sol", label: "GPT-5.6 Sol", input: 5, output: 30, thinking: "effort", jsonSchema: true },
  "gpt-terra": { slug: "gpt-terra", provider: "openai", apiId: "gpt-5.6-terra", label: "GPT-5.6 Terra", input: 2, output: 12, thinking: "effort", jsonSchema: true },
  "gpt-luna": { slug: "gpt-luna", provider: "openai", apiId: "gpt-5.6-luna", label: "GPT-5.6 Luna", input: 0.2, output: 1.2, thinking: "effort", jsonSchema: true },
  // Moonshot direct — IDs verified against platform.kimi.ai 2026-08-14.
  "kimi-k3": { slug: "kimi-k3", provider: "moonshot", apiId: "kimi-k3", label: "Kimi K3", input: 3, output: 15, thinking: "none", jsonSchema: false },
  "kimi-k2.6": { slug: "kimi-k2.6", provider: "moonshot", apiId: "kimi-k2.6", label: "Kimi K2.6", input: 0.95, output: 4, thinking: "none", jsonSchema: false },
  // Groq — fast serving of open models (production models only; their
  // preview tier churns — Kimi K2 and Llama 4 both vanished from it).
  "groq-gpt-oss": { slug: "groq-gpt-oss", provider: "groq", apiId: "openai/gpt-oss-120b", label: "GPT-OSS 120B", input: 0.15, output: 0.6, thinking: "effort", jsonSchema: false },
  "groq-gpt-oss-20b": { slug: "groq-gpt-oss-20b", provider: "groq", apiId: "openai/gpt-oss-20b", label: "GPT-OSS 20B", input: 0.075, output: 0.3, thinking: "effort", jsonSchema: false },
  "groq-llama33": { slug: "groq-llama33", provider: "groq", apiId: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", input: 0.59, output: 0.79, thinking: "none", jsonSchema: false },
  // Cerebras.
  "cerebras-gpt-oss": { slug: "cerebras-gpt-oss", provider: "cerebras", apiId: "gpt-oss-120b", label: "GPT-OSS 120B", input: 0.35, output: 0.75, thinking: "effort", jsonSchema: false },
};

export function isModelSlug(v: unknown): v is string {
  return typeof v === "string" && v in MODELS;
}

export function modelByApiId(apiId: string): ModelInfo | null {
  for (const m of Object.values(MODELS)) if (m.apiId === apiId) return m;
  return null;
}

/** 1–4 ($–$$$$), log-spaced buckets over blended $/MTok across the catalog. */
export function costTier(m: ModelInfo): number {
  const blended = 0.7 * m.input + 0.3 * m.output;
  if (blended < 1) return 1;
  if (blended < 3.5) return 2;
  if (blended < 8) return 3;
  return 4;
}
