// Settings: budget roll-ups, top-level agent defaults, per-use-case model /
// thinking overrides, and the overview (briefing) regeneration schedule.
import { useEffect, useState } from "react";
import { api, post, type UsageSummary } from "../api";
import { fmtCost } from "../fmt";
import type { CaptureContext } from "../Capture";

type Model = "sonnet" | "haiku";
type Thinking = "off" | "low" | "medium" | "high";

interface UseCaseSetting {
  model: Model | null;
  thinking: Thinking | null;
}

interface AgentConfig {
  default: { model: Model; thinking: Thinking };
  overrides: { chat: UseCaseSetting; briefing: UseCaseSetting; checkin: UseCaseSetting };
  briefing_refresh: { interval_hours: number; start_hour: number; end_hour: number };
}

const USE_CASES: { key: "chat" | "briefing" | "checkin"; label: string }[] = [
  { key: "chat", label: "Chat" },
  { key: "briefing", label: "Overview" },
  { key: "checkin", label: "Notifications" },
];

const THINKING_LABELS: Record<Thinking, string> = {
  off: "off",
  low: "light",
  medium: "normal",
  high: "deep",
};

export default function Settings(props: {
  refreshKey: number;
  onFocus: (ctx: CaptureContext | null) => void;
}) {
  const [cfg, setCfg] = useState<AgentConfig | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    props.onFocus(null);
    api<AgentConfig>("/settings/agent").then(setCfg).catch(() => {});
    api<UsageSummary>("/usage/summary").then(setUsage).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.refreshKey]);

  async function save(next: AgentConfig) {
    setCfg(next);
    try {
      await post("/settings/agent", next);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } catch {
      /* transient */
    }
  }

  if (!cfg) return <p className="empty">Loading…</p>;

  const modelSelect = (
    value: Model | null,
    onChange: (m: Model | null) => void,
    allowInherit: boolean,
  ) => (
    <select
      value={value ?? "inherit"}
      onChange={(e) => onChange(e.target.value === "inherit" ? null : (e.target.value as Model))}
    >
      {allowInherit && <option value="inherit">default</option>}
      <option value="sonnet">Sonnet 5</option>
      <option value="haiku">Haiku 4.5</option>
    </select>
  );

  const thinkingSelect = (
    value: Thinking | null,
    onChange: (t: Thinking | null) => void,
    allowInherit: boolean,
    disabled = false,
  ) => (
    <select
      value={value ?? "inherit"}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === "inherit" ? null : (e.target.value as Thinking))}
    >
      {allowInherit && <option value="inherit">default</option>}
      {(Object.keys(THINKING_LABELS) as Thinking[]).map((t) => (
        <option key={t} value={t}>
          {THINKING_LABELS[t]}
        </option>
      ))}
    </select>
  );

  return (
    <div className="tasks settings">
      <section>
        <h2>Spend</h2>
        {usage ? (
          <>
            <p className="spend-totals">
              Last 7 days <strong>{fmtCost(usage.week)}</strong> · all-time{" "}
              <strong>{fmtCost(usage.all_time)}</strong>
            </p>
            {usage.by_kind.length > 0 && (
              <table className="spend-table">
                <thead>
                  <tr>
                    <th>use</th>
                    <th>model</th>
                    <th>calls</th>
                    <th>in</th>
                    <th>out</th>
                    <th>cached</th>
                    <th>cost (7d)</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.by_kind.map((k, i) => (
                    <tr key={i}>
                      <td>{k.kind === "briefing" ? "overview" : k.kind}</td>
                      <td>{k.model.replace("claude-", "")}</td>
                      <td>{k.n}</td>
                      <td>{(k.input / 1000).toFixed(1)}k</td>
                      <td>{(k.output / 1000).toFixed(1)}k</td>
                      <td>{(k.cache_read / 1000).toFixed(0)}k</td>
                      <td>{fmtCost(k.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        ) : (
          <p className="empty">No usage recorded yet.</p>
        )}
      </section>

      <section>
        <h2>Agent defaults</h2>
        <div className="setting-row">
          <span>Model</span>
          {modelSelect(cfg.default.model, (m) => save({ ...cfg, default: { ...cfg.default, model: m ?? "sonnet" } }), false)}
          <span>Thinking</span>
          {thinkingSelect(
            cfg.default.thinking,
            (t) => save({ ...cfg, default: { ...cfg.default, thinking: t ?? "medium" } }),
            false,
            cfg.default.model === "haiku",
          )}
        </div>
        {cfg.default.model === "haiku" && (
          <p className="hint-left">Haiku doesn't support thinking — it runs off.</p>
        )}
      </section>

      <section>
        <h2>Per-use overrides</h2>
        {USE_CASES.map(({ key, label }) => {
          const o = cfg.overrides[key];
          const effModel = o.model ?? cfg.default.model;
          return (
            <div className="setting-row" key={key}>
              <span className="uc">{label}</span>
              {modelSelect(o.model, (m) =>
                save({ ...cfg, overrides: { ...cfg.overrides, [key]: { ...o, model: m } } }),
                true,
              )}
              {thinkingSelect(
                o.thinking,
                (t) => save({ ...cfg, overrides: { ...cfg.overrides, [key]: { ...o, thinking: t } } }),
                true,
                effModel === "haiku",
              )}
            </div>
          );
        })}
        <p className="hint-left">
          "default" inherits the agent defaults above. Planning chats always think deeply when
          thinking is on.
        </p>
      </section>

      <section>
        <h2>Overview regeneration</h2>
        <div className="setting-row">
          <span>Every</span>
          <select
            value={cfg.briefing_refresh.interval_hours}
            onChange={(e) =>
              save({
                ...cfg,
                briefing_refresh: { ...cfg.briefing_refresh, interval_hours: Number(e.target.value) },
              })
            }
          >
            <option value={0}>manual / chat only</option>
            {[2, 4, 6, 8, 12, 24].map((h) => (
              <option key={h} value={h}>
                {h}h
              </option>
            ))}
          </select>
          <span>between</span>
          <select
            value={cfg.briefing_refresh.start_hour}
            onChange={(e) =>
              save({
                ...cfg,
                briefing_refresh: { ...cfg.briefing_refresh, start_hour: Number(e.target.value) },
              })
            }
          >
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {h}:00
              </option>
            ))}
          </select>
          <span>and</span>
          <select
            value={cfg.briefing_refresh.end_hour}
            onChange={(e) =>
              save({
                ...cfg,
                briefing_refresh: { ...cfg.briefing_refresh, end_hour: Number(e.target.value) },
              })
            }
          >
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h + 1} value={h + 1}>
                {h + 1}:00
              </option>
            ))}
          </select>
        </div>
        <p className="hint-left">
          The overview also updates when the agent decides a chat changed the day, and via ↻ on
          Today.
        </p>
      </section>

      {saved && <p className="hint-left">saved</p>}
    </div>
  );
}
