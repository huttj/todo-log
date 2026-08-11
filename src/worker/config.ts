// Per-user agent configuration: top-level defaults with per-use-case
// overrides (chat / briefing / checkin), plus the briefing refresh schedule.
// Stored as JSON in users.agent_config.
import type { UserRow } from "./types";

export type ThinkingLevel = "off" | "low" | "medium" | "high";
export type ModelChoice = "sonnet" | "opus" | "haiku";
export type UseCase = "chat" | "briefing" | "checkin";

export interface UseCaseSetting {
  model: ModelChoice | null; // null = inherit default
  thinking: ThinkingLevel | null;
}

export interface AgentConfig {
  default: { model: ModelChoice; thinking: ThinkingLevel };
  overrides: Record<UseCase, UseCaseSetting>;
  briefing_refresh: { interval_hours: number; start_hour: number; end_hour: number };
}

export const MODEL_IDS: Record<ModelChoice, string> = {
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-5",
  haiku: "claude-haiku-4-5",
};

const THINKING_LEVELS: ThinkingLevel[] = ["off", "low", "medium", "high"];
const MODELS: ModelChoice[] = ["sonnet", "opus", "haiku"];

export function defaultConfig(): AgentConfig {
  return {
    default: { model: "sonnet", thinking: "medium" },
    overrides: {
      chat: { model: null, thinking: null },
      briefing: { model: null, thinking: null },
      checkin: { model: null, thinking: null },
    },
    briefing_refresh: { interval_hours: 4, start_hour: 6, end_hour: 23 },
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
      if (MODELS.includes(d.model as ModelChoice)) cfg.default.model = d.model as ModelChoice;
      if (THINKING_LEVELS.includes(d.thinking as ThinkingLevel)) {
        cfg.default.thinking = d.thinking as ThinkingLevel;
      }
    }
    const ov = parsed.overrides as Record<string, Record<string, unknown>> | undefined;
    for (const uc of ["chat", "briefing", "checkin"] as UseCase[]) {
      const o = ov?.[uc];
      if (!o) continue;
      if (MODELS.includes(o.model as ModelChoice)) cfg.overrides[uc].model = o.model as ModelChoice;
      if (THINKING_LEVELS.includes(o.thinking as ThinkingLevel)) {
        cfg.overrides[uc].thinking = o.thinking as ThinkingLevel;
      }
    }
    const br = parsed.briefing_refresh as Record<string, unknown> | undefined;
    if (br) {
      const n = Number(br.interval_hours);
      if ([0, 2, 4, 6, 8, 12, 24].includes(n)) cfg.briefing_refresh.interval_hours = n;
      const sh = Number(br.start_hour);
      const eh = Number(br.end_hour);
      if (Number.isInteger(sh) && sh >= 0 && sh <= 23) cfg.briefing_refresh.start_hour = sh;
      if (Number.isInteger(eh) && eh >= 1 && eh <= 24) cfg.briefing_refresh.end_hour = eh;
    }
    return cfg;
  } catch {
    return cfg;
  }
}

export interface ResolvedUseCase {
  modelId: string;
  model: ModelChoice;
  thinking: ThinkingLevel;
}

export function resolveUseCase(user: UserRow, useCase: UseCase): ResolvedUseCase {
  const cfg = parseConfig(user.agent_config);
  const o = cfg.overrides[useCase];
  const model = o.model ?? cfg.default.model;
  // Haiku 4.5 has no adaptive thinking — force off.
  const thinking = model === "haiku" ? "off" : (o.thinking ?? cfg.default.thinking);
  return { modelId: MODEL_IDS[model], model, thinking };
}

/** Request params for the resolved setting (thinking + effort, model-aware).
 * Haiku: no thinking/effort params at all. Sonnet: disabled, or adaptive with
 * the chosen effort. */
export function modelParams(r: ResolvedUseCase): Record<string, unknown> {
  if (r.model === "haiku") return {};
  if (r.thinking === "off") return { thinking: { type: "disabled" } };
  return {
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: r.thinking },
  };
}
