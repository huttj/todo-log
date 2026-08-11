// Settings: budget roll-ups, top-level agent defaults, per-use-case model /
// thinking overrides, and the overview (briefing) regeneration schedule.
import { useEffect, useState, type ReactNode } from "react";
import { api, post, type UsageSummary } from "../api";
import { fmtCost } from "../fmt";
import type { CaptureContext } from "../Capture";

type Model = "sonnet" | "opus" | "haiku";
type Thinking = "off" | "low" | "medium" | "high";

interface UseCaseSetting {
  model: Model | null;
  thinking: Thinking | null;
}

interface Schedule {
  interval_hours: number;
  start_hour: number;
  end_hour: number;
}

interface AgentConfig {
  default: { model: Model; thinking: Thinking };
  overrides: {
    chat: UseCaseSetting;
    briefing: UseCaseSetting;
    checkin: UseCaseSetting;
    distill: UseCaseSetting;
  };
  briefing_refresh: Schedule;
  checkin_schedule: Schedule;
  chat_briefing_updates: boolean;
}

const KIND_LABELS: Record<string, string> = {
  turn: "chat",
  briefing: "overview",
  checkin: "check-in",
  distill: "learning distill",
};

const USE_CASES: { key: "chat" | "briefing" | "checkin" | "distill"; label: string }[] = [
  { key: "chat", label: "Chat" },
  { key: "briefing", label: "Overview" },
  { key: "checkin", label: "Notifications" },
  { key: "distill", label: "Learning distill" },
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
  const [memories, setMemories] = useState<{ key: string; content: string }[]>([]);
  const [newKey, setNewKey] = useState("");
  const [newContent, setNewContent] = useState("");

  useEffect(() => {
    props.onFocus(null);
    api<AgentConfig>("/settings/agent").then(setCfg).catch(() => {});
    api<UsageSummary>("/usage/summary").then(setUsage).catch(() => {});
    api<{ key: string; content: string }[]>("/memory").then(setMemories).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.refreshKey]);

  async function saveMemory(key: string, content: string) {
    try {
      await post("/memory", { key, content });
      if (!content.trim()) setMemories((ms) => ms.filter((m) => m.key !== key));
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } catch {
      /* transient */
    }
  }

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
      <option value="opus">Opus 5</option>
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

  const scheduleSection = (
    heading: string,
    value: Schedule,
    offLabel: string,
    onChange: (s: Schedule) => void,
    hint: string,
    extra?: ReactNode,
  ) => (
    <section>
      <h2>{heading}</h2>
      <div className="setting-row">
        <span>Every</span>
        <select
          value={value.interval_hours}
          onChange={(e) => onChange({ ...value, interval_hours: Number(e.target.value) })}
        >
          <option value={0}>{offLabel}</option>
          {[2, 3, 4, 6, 8, 12, 24].map((h) => (
            <option key={h} value={h}>
              {h}h
            </option>
          ))}
        </select>
        <span>between</span>
        <select
          value={value.start_hour}
          onChange={(e) => onChange({ ...value, start_hour: Number(e.target.value) })}
        >
          {Array.from({ length: 24 }, (_, h) => (
            <option key={h} value={h}>
              {h}:00
            </option>
          ))}
        </select>
        <span>and</span>
        <select
          value={value.end_hour}
          onChange={(e) => onChange({ ...value, end_hour: Number(e.target.value) })}
        >
          {Array.from({ length: 24 }, (_, h) => (
            <option key={h + 1} value={h + 1}>
              {h + 1}:00
            </option>
          ))}
        </select>
      </div>
      {extra}
      <p className="hint-left">{hint}</p>
    </section>
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
                      <td>{KIND_LABELS[k.kind] ?? k.kind}</td>
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

      {scheduleSection(
        "Overview regeneration",
        cfg.briefing_refresh,
        "manual only",
        (s) => save({ ...cfg, briefing_refresh: s }),
        cfg.chat_briefing_updates
          ? "Chats can also rewrite the overview when they change the day's picture — plus this schedule and ↻ on Today."
          : "Chats never touch the overview — outside this schedule, only ↻ on Today recomputes it.",
        <label className="setting-row toggle-row">
          <input
            type="checkbox"
            checked={cfg.chat_briefing_updates}
            onChange={(e) => save({ ...cfg, chat_briefing_updates: e.target.checked })}
          />
          <span>Chats may rewrite the overview when they change the day's picture</span>
        </label>,
      )}

      {scheduleSection(
        "Check-in notifications",
        cfg.checkin_schedule,
        "off",
        (s) => save({ ...cfg, checkin_schedule: s }),
        "The agent looks at what's open and may leave one short check-in note; it skips when you've chatted within the hour.",
      )}

      <section>
        <h2>Agent memory</h2>
        {memories.length === 0 && <p className="empty">Nothing saved yet — the agent adds notes as it learns.</p>}
        {memories.map((m) => (
          <div className="memory-item" key={m.key}>
            <div className="memory-head">
              <strong>{m.key}</strong>
              <button
                className="link trash"
                title="Delete this note"
                onClick={() => {
                  if (window.confirm(`Delete the "${m.key}" note?`)) void saveMemory(m.key, "");
                }}
              >
                ×
              </button>
            </div>
            <textarea
              value={m.content}
              rows={2}
              onChange={(e) =>
                setMemories((ms) => ms.map((x) => (x.key === m.key ? { ...x, content: e.target.value } : x)))
              }
              onBlur={(e) => void saveMemory(m.key, e.target.value)}
            />
          </div>
        ))}
        <div className="memory-item memory-new">
          <input
            placeholder="new-note-key"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
          />
          <textarea
            placeholder="What should the agent remember?"
            rows={2}
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
          />
          <button
            className="link"
            disabled={!newKey.trim() || !newContent.trim()}
            onClick={async () => {
              await saveMemory(newKey.trim(), newContent.trim());
              setMemories((ms) => [...ms, { key: newKey.trim(), content: newContent.trim() }]);
              setNewKey("");
              setNewContent("");
            }}
          >
            add note
          </button>
        </div>
        <p className="hint-left">
          These notes are shown to the agent at the start of every conversation. Edits save when you
          click away; clearing a note deletes it.
        </p>
      </section>

      {saved && <p className="hint-left">saved</p>}
    </div>
  );
}
