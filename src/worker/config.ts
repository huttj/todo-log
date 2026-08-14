// Per-user agent configuration: top-level defaults with per-use-case
// overrides (chat / briefing / checkin), plus the briefing refresh schedule.
// Stored as JSON in users.agent_config. Model values are catalog slugs
// (catalog.ts); whether a slug is actually usable (provider key on file) is
// resolved at request time in llm.ts, falling back to the house Anthropic key.
import type { UserRow } from "./types";
import { MODELS, PROVIDERS, isModelSlug, type ProviderId, type ThinkingKind, type Wire } from "./catalog";

export type ThinkingLevel = "off" | "low" | "medium" | "high";
export type UseCase = "chat" | "briefing" | "checkin" | "distill";

export interface UseCaseSetting {
  model: string | null; // catalog slug; null = inherit default
  thinking: ThinkingLevel | null;
}

export interface RefreshSchedule {
  /** 0 = never (manual only for the briefing; off for check-ins). */
  interval_hours: number;
  start_hour: number;
  end_hour: number;
}

export interface AgentConfig {
  default: { model: string; thinking: ThinkingLevel };
  overrides: Record<UseCase, UseCaseSetting>;
  briefing_refresh: RefreshSchedule;
  checkin_schedule: RefreshSchedule;
  /** Opt-in: chats may rewrite the overview via the update_briefing tool. */
  chat_briefing_updates: boolean;
  /** Todo Log's built-in Anthropic key. Off + no user keys = no AI (the agent
   * auto-replies with a pointer to the Models page). Later this ties to
   * billing: enabled by adding a card, disabled by removing it. */
  builtin_ai: boolean;
}

const THINKING_LEVELS: ThinkingLevel[] = ["off", "low", "medium", "high"];

export function defaultConfig(): AgentConfig {
  return {
    default: { model: "sonnet", thinking: "medium" },
    overrides: {
      // Haiku holds up well for filing turns at ~1/3 the cost — chat defaults
      // to it; the default model covers the rest.
      chat: { model: "haiku", thinking: null },
      briefing: { model: null, thinking: null },
      checkin: { model: null, thinking: null },
      distill: { model: null, thinking: null },
    },
    briefing_refresh: { interval_hours: 4, start_hour: 6, end_hour: 23 },
    checkin_schedule: { interval_hours: 3, start_hour: 8, end_hour: 22 },
    chat_briefing_updates: false,
    builtin_ai: true,
  };
}

/** Parse stored config, tolerating the legacy {model, thinking:boolean} shape. */
export function parseConfig(raw: string | null): AgentConfig {
  const cfg = defaultConfig();
  if (!raw) return cfg;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Legacy shape
    if (typeof parsed.thinking === "boolean" || (parsed.model && !parsed.default)) {
      if (parsed.model === "haiku") cfg.default.model = "haiku";
      if (parsed.thinking === false) cfg.default.thinking = "off";
      return cfg;
    }
    const d = parsed.default as Record<string, unknown> | undefined;
    if (d) {
      if (isModelSlug(d.model)) cfg.default.model = d.model;
      if (THINKING_LEVELS.includes(d.thinking as ThinkingLevel)) {
        cfg.default.thinking = d.thinking as ThinkingLevel;
      }
    }
    const ov = parsed.overrides as Record<string, Record<string, unknown>> | undefined;
    for (const uc of ["chat", "briefing", "checkin", "distill"] as UseCase[]) {
      const o = ov?.[uc];
      if (!o) continue;
      if (isModelSlug(o.model)) cfg.overrides[uc].model = o.model;
      if (THINKING_LEVELS.includes(o.thinking as ThinkingLevel)) {
        cfg.overrides[uc].thinking = o.thinking as ThinkingLevel;
      }
    }
    const readSchedule = (raw2: unknown, into: RefreshSchedule) => {
      const r = raw2 as Record<string, unknown> | undefined;
      if (!r) return;
      const n = Number(r.interval_hours);
      if ([0, 2, 3, 4, 6, 8, 12, 24].includes(n)) into.interval_hours = n;
      const sh = Number(r.start_hour);
      const eh = Number(r.end_hour);
      if (Number.isInteger(sh) && sh >= 0 && sh <= 23) into.start_hour = sh;
      if (Number.isInteger(eh) && eh >= 1 && eh <= 24) into.end_hour = eh;
    };
    readSchedule(parsed.briefing_refresh, cfg.briefing_refresh);
    readSchedule(parsed.checkin_schedule, cfg.checkin_schedule);
    if (typeof parsed.chat_briefing_updates === "boolean") {
      cfg.chat_briefing_updates = parsed.chat_briefing_updates;
    }
    if (typeof parsed.builtin_ai === "boolean") cfg.builtin_ai = parsed.builtin_ai;
    return cfg;
  } catch {
    return cfg;
  }
}

export interface ResolvedUseCase {
  /** Catalog slug (stored in config) and the wire-level model string. */
  slug: string;
  modelId: string;
  provider: ProviderId;
  wire: Wire;
  thinking: ThinkingLevel;
  thinkingKind: ThinkingKind;
  jsonSchema: boolean;
}

/** Build a resolution for a specific slug (also the llm.ts fallback path). */
export function resolveSlug(slug: string, thinking: ThinkingLevel): ResolvedUseCase {
  const m = MODELS[slug] ?? MODELS.sonnet;
  return {
    slug: m.slug,
    modelId: m.apiId,
    provider: m.provider,
    wire: PROVIDERS[m.provider].wire,
    // Non-thinking models run with thinking off regardless of the setting.
    thinking: m.thinking === "none" ? "off" : thinking,
    thinkingKind: m.thinking,
    jsonSchema: m.jsonSchema,
  };
}

export function resolveUseCase(user: UserRow, useCase: UseCase): ResolvedUseCase {
  const cfg = parseConfig(user.agent_config);
  const o = cfg.overrides[useCase];
  return resolveSlug(o.model ?? cfg.default.model, o.thinking ?? cfg.default.thinking);
}

/** Request params for the resolved setting, wire-aware. Anthropic adaptive
 * thinking + effort; OpenAI-wire reasoning models get reasoning_effort; plain
 * models get nothing. */
export function modelParams(r: ResolvedUseCase): Record<string, unknown> {
  if (r.thinkingKind === "adaptive") {
    if (r.thinking === "off") return { thinking: { type: "disabled" } };
    return {
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: r.thinking },
    };
  }
  if (r.thinkingKind === "effort" && r.thinking !== "off") {
    return { reasoning_effort: r.thinking };
  }
  return {};
}
