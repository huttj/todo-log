// Settings: spend roll-ups with filters, top-level agent defaults, per-use
// model / thinking overrides, regeneration schedules, and agent memory.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import Select from "react-select";
import { api, post } from "../api";
import { fmtCost } from "../fmt";
import type { CaptureContext } from "../Capture";
import { pushSupported, pushEnabled, enablePush, disablePush } from "../push";

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

interface UsageRow {
  day: string;
  kind: string;
  model: string;
  n: number;
  input: number;
  output: number;
  cache_read: number;
  cost: number;
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

const MODEL_OPTS = [
  { value: "sonnet", label: "Sonnet 5" },
  { value: "opus", label: "Opus 5" },
  { value: "haiku", label: "Haiku 4.5" },
];

const THINKING_OPTS = [
  { value: "off", label: "off" },
  { value: "low", label: "light" },
  { value: "medium", label: "normal" },
  { value: "high", label: "deep" },
];

interface Opt {
  value: string;
  label: string;
}

/** react-select wrapper: compact, non-searchable, string-valued. */
function Sel(props: {
  options: Opt[];
  value: string | null;
  onChange: (v: string | null) => void;
  isDisabled?: boolean;
  width?: number;
}) {
  return (
    <Select
      classNamePrefix="rs"
      options={props.options}
      value={props.options.find((o) => o.value === props.value) ?? null}
      isSearchable={false}
      isDisabled={props.isDisabled}
      onChange={(v) => props.onChange((v as Opt | null)?.value ?? null)}
      styles={{ container: (b) => ({ ...b, minWidth: props.width ?? 110 }) }}
    />
  );
}

function MultiSel(props: {
  options: Opt[];
  value: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  return (
    <Select
      classNamePrefix="rs"
      options={props.options}
      value={props.options.filter((o) => props.value.includes(o.value))}
      isMulti
      isSearchable={false}
      placeholder={props.placeholder}
      onChange={(v) => props.onChange(((v ?? []) as Opt[]).map((x) => x.value))}
      styles={{ container: (b) => ({ ...b, minWidth: 150 }) }}
    />
  );
}

const localISO = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysAgoISO = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localISO(d);
};

export default function Settings(props: {
  refreshKey: number;
  onFocus: (ctx: CaptureContext | null) => void;
}) {
  const [cfg, setCfg] = useState<AgentConfig | null>(null);
  const [urows, setUrows] = useState<UsageRow[]>([]);
  const [saved, setSaved] = useState(false);
  const [memories, setMemories] = useState<{ key: string; content: string }[]>([]);
  const [newKey, setNewKey] = useState("");
  const [newContent, setNewContent] = useState("");
  // Spend filters: use/model narrow everything; the date range narrows the
  // table only (the summary keeps its fixed windows).
  const [filterUses, setFilterUses] = useState<string[]>([]);
  const [filterModels, setFilterModels] = useState<string[]>([]);
  const [fromDay, setFromDay] = useState("");
  const [toDay, setToDay] = useState("");

  useEffect(() => {
    props.onFocus(null);
    api<AgentConfig>("/settings/agent").then(setCfg).catch(() => {});
    api<{ rows: UsageRow[] }>(`/usage/table?tzoff=${new Date().getTimezoneOffset()}`)
      .then((r) => setUrows(r.rows))
      .catch(() => {});
    api<{ key: string; content: string }[]>("/memory").then(setMemories).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.refreshKey]);

  const spend = useMemo(() => {
    const base = urows.filter(
      (r) =>
        (filterUses.length === 0 || filterUses.includes(r.kind)) &&
        (filterModels.length === 0 || filterModels.includes(r.model)),
    );
    const today = localISO(new Date());
    const d7 = daysAgoISO(6);
    const d30 = daysAgoISO(29);
    const sum = (rows: UsageRow[]) => rows.reduce((acc, r) => acc + r.cost, 0);
    const tableRows = base.filter(
      (r) => (!fromDay || r.day >= fromDay) && (!toDay || r.day <= toDay),
    );
    // Group by use, models as sub-rows, both ordered by cost.
    const byKind = new Map<string, Map<string, UsageRow>>();
    for (const r of tableRows) {
      const models = byKind.get(r.kind) ?? byKind.set(r.kind, new Map()).get(r.kind)!;
      const agg =
        models.get(r.model) ??
        models
          .set(r.model, { day: "", kind: r.kind, model: r.model, n: 0, input: 0, output: 0, cache_read: 0, cost: 0 })
          .get(r.model)!;
      agg.n += r.n;
      agg.input += r.input;
      agg.output += r.output;
      agg.cache_read += r.cache_read;
      agg.cost += r.cost;
    }
    const groups = [...byKind.entries()]
      .map(([kind, models]) => ({
        kind,
        models: [...models.values()].sort((a, b) => b.cost - a.cost),
      }))
      .sort((a, b) => sumCost(b.models) - sumCost(a.models));
    const total = { n: 0, input: 0, output: 0, cache_read: 0, cost: 0 };
    for (const r of tableRows) {
      total.n += r.n;
      total.input += r.input;
      total.output += r.output;
      total.cache_read += r.cache_read;
      total.cost += r.cost;
    }
    return {
      today: sum(base.filter((r) => r.day === today)),
      week: sum(base.filter((r) => r.day >= d7)),
      month: sum(base.filter((r) => r.day >= d30)),
      allTime: sum(base),
      groups,
      total,
    };
  }, [urows, filterUses, filterModels, fromDay, toDay]);

  const useOpts = useMemo(
    () =>
      [...new Set(urows.map((r) => r.kind))].map((k) => ({ value: k, label: KIND_LABELS[k] ?? k })),
    [urows],
  );
  const modelOpts = useMemo(
    () =>
      [...new Set(urows.map((r) => r.model))].map((m) => ({
        value: m,
        label: m.replace("claude-", ""),
      })),
    [urows],
  );

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

  const INHERIT = { value: "inherit", label: "default" };
  const modelSelect = (value: Model | null, onChange: (m: Model | null) => void, allowInherit: boolean) => (
    <Sel
      options={allowInherit ? [INHERIT, ...MODEL_OPTS] : MODEL_OPTS}
      value={value ?? (allowInherit ? "inherit" : null)}
      onChange={(v) => onChange(v === "inherit" || v == null ? null : (v as Model))}
    />
  );
  const thinkingSelect = (
    value: Thinking | null,
    onChange: (t: Thinking | null) => void,
    allowInherit: boolean,
    disabled = false,
  ) => (
    <Sel
      options={allowInherit ? [INHERIT, ...THINKING_OPTS] : THINKING_OPTS}
      value={value ?? (allowInherit ? "inherit" : null)}
      onChange={(v) => onChange(v === "inherit" || v == null ? null : (v as Thinking))}
      isDisabled={disabled}
      width={100}
    />
  );

  const hourOpts = (from: number) =>
    Array.from({ length: 24 }, (_, h) => ({ value: String(h + from), label: `${h + from}:00` }));

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
        <Sel
          options={[{ value: "0", label: offLabel }, ...[2, 3, 4, 6, 8, 12, 24].map((h) => ({ value: String(h), label: `${h}h` }))]}
          value={String(value.interval_hours)}
          onChange={(v) => onChange({ ...value, interval_hours: Number(v ?? 0) })}
        />
        <span>between</span>
        <Sel
          options={hourOpts(0)}
          value={String(value.start_hour)}
          onChange={(v) => onChange({ ...value, start_hour: Number(v ?? 0) })}
          width={90}
        />
        <span>and</span>
        <Sel
          options={hourOpts(1)}
          value={String(value.end_hour)}
          onChange={(v) => onChange({ ...value, end_hour: Number(v ?? 24) })}
          width={90}
        />
      </div>
      {extra}
      <p className="hint-left">{hint}</p>
    </section>
  );

  return (
    <div className="tasks settings">
      <section>
        <h2>Spend</h2>
        <p className="spend-totals">
          Today <strong>{fmtCost(spend.today)}</strong> · last 7 days{" "}
          <strong>{fmtCost(spend.week)}</strong> · last 30 days <strong>{fmtCost(spend.month)}</strong>
          <span className="spend-alltime"> · all-time {fmtCost(spend.allTime)}</span>
        </p>
        <div className="spend-filters">
          <MultiSel options={useOpts} value={filterUses} onChange={setFilterUses} placeholder="all uses" />
          <MultiSel
            options={modelOpts}
            value={filterModels}
            onChange={setFilterModels}
            placeholder="all models"
          />
          <input type="date" value={fromDay} onChange={(e) => setFromDay(e.target.value)} title="From" />
          <span className="range-sep">–</span>
          <input type="date" value={toDay} onChange={(e) => setToDay(e.target.value)} title="To" />
          {(fromDay || toDay) && (
            <button
              className="link"
              onClick={() => {
                setFromDay("");
                setToDay("");
              }}
            >
              clear dates
            </button>
          )}
        </div>
        {spend.groups.length === 0 ? (
          <p className="empty">Nothing in this range.</p>
        ) : (
          <table className="spend-table">
            <thead>
              <tr>
                <th>use</th>
                <th>model</th>
                <th>calls</th>
                <th>in</th>
                <th>out</th>
                <th>cached</th>
                <th>cost</th>
              </tr>
            </thead>
            <tbody>
              {spend.groups.map((g) =>
                g.models.map((m, i) => (
                  <tr key={`${g.kind}-${m.model}`}>
                    {i === 0 && (
                      <td className="use-cell" rowSpan={g.models.length}>
                        {KIND_LABELS[g.kind] ?? g.kind}
                      </td>
                    )}
                    <td>{m.model.replace("claude-", "")}</td>
                    <td>{m.n}</td>
                    <td>{(m.input / 1000).toFixed(1)}k</td>
                    <td>{(m.output / 1000).toFixed(1)}k</td>
                    <td>{(m.cache_read / 1000).toFixed(0)}k</td>
                    <td>{fmtCost(m.cost)}</td>
                  </tr>
                )),
              )}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>total</td>
                <td>{spend.total.n}</td>
                <td>{(spend.total.input / 1000).toFixed(1)}k</td>
                <td>{(spend.total.output / 1000).toFixed(1)}k</td>
                <td>{(spend.total.cache_read / 1000).toFixed(0)}k</td>
                <td>{fmtCost(spend.total.cost)}</td>
              </tr>
            </tfoot>
          </table>
        )}
        <p className="hint-left">
          Use and model filters apply everywhere; the date range narrows the table only.
        </p>
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
          ? "Chats can also rewrite the overview when they change the day's picture — plus this schedule and the refresh button on Today."
          : "Chats never touch the overview — outside this schedule, only the refresh button on Today recomputes it.",
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
        <CheckinNowButton />,
      )}

      <TextSizeSection />

      <PushSection />

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

function sumCost(rows: { cost: number }[]): number {
  return rows.reduce((acc, r) => acc + r.cost, 0);
}

const TEXT_SIZES = [
  { value: "", label: "default" },
  { value: "110%", label: "medium" },
  { value: "122%", label: "large" },
  { value: "135%", label: "extra large" },
];

function TextSizeSection() {
  const [size, setSize] = useState(() => localStorage.getItem("todolog.textSize") ?? "");
  const apply = (v: string | null) => {
    const next = v ?? "";
    setSize(next);
    if (next) localStorage.setItem("todolog.textSize", next);
    else localStorage.removeItem("todolog.textSize");
    document.documentElement.style.fontSize = next || "";
  };
  return (
    <section>
      <h2>Text size</h2>
      <div className="setting-row">
        <Sel options={TEXT_SIZES} value={size} onChange={apply} width={140} />
        <span className="hint-left">per device — takes effect immediately</span>
      </div>
    </section>
  );
}

function TestPushButton() {
  const [sent, setSent] = useState(false);
  return (
    <button
      className="push-btn"
      onClick={async () => {
        await post("/push/test").catch(() => {});
        setSent(true);
        window.setTimeout(() => setSent(false), 4000);
      }}
    >
      {sent ? "sent — check your notifications" : "Send test notification"}
    </button>
  );
}

function CheckinNowButton() {
  const [result, setResult] = useState<string | null>(null);
  const MESSAGES: Record<string, string> = {
    sent: "check-in sent — see the bell / your device",
    skipped: "the agent looked and decided nothing needs saying",
    "nothing-open": "nothing open or scheduled to check in about",
    error: "check-in failed — try again",
  };
  return (
    <div className="setting-row">
      <button
        className="push-btn"
        disabled={result === "…"}
        onClick={async () => {
          setResult("…");
          try {
            const r = await post<{ result: string }>("/checkin/run");
            setResult(MESSAGES[r.result] ?? r.result);
          } catch {
            setResult(MESSAGES.error);
          }
        }}
      >
        Run a check-in now
      </button>
      {result && result !== "…" && <span className="hint-left">{result}</span>}
      {result === "…" && <span className="hint-left">thinking…</span>}
    </div>
  );
}

function PushSection() {
  const [state, setState] = useState<"unsupported" | "off" | "on" | "denied" | "busy">("busy");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      if (!pushSupported()) return setState("unsupported");
      if (Notification.permission === "denied") return setState("denied");
      setState((await pushEnabled()) ? "on" : "off");
    })();
  }, []);

  async function enable() {
    setErr(null);
    setState("busy");
    const r = await enablePush();
    if (r === "on") setState("on");
    else if (r === "denied") setState("denied");
    else {
      setErr("couldn't subscribe — try again");
      setState("off");
    }
  }

  async function disable() {
    setState("busy");
    try {
      await disablePush();
    } finally {
      setState("off");
    }
  }

  return (
    <section>
      <h2>Push notifications</h2>
      {state === "unsupported" && (
        <p className="hint-left">
          This browser doesn't support web push. On iPhone: add Todo Log to your Home Screen
          (Share → Add to Home Screen), then open it from there and enable push.
        </p>
      )}
      {state === "denied" && (
        <p className="hint-left">
          Notifications are blocked for this site — allow them in your browser settings, then
          reload.
        </p>
      )}
      {(state === "off" || state === "on" || state === "busy") && (
        <div className="setting-row">
          <button
            className="push-btn"
            disabled={state === "busy"}
            onClick={() => (state === "on" ? void disable() : void enable())}
          >
            {state === "on" ? "Disable on this device" : state === "busy" ? "…" : "Enable on this device"}
          </button>
          {state === "on" && <TestPushButton />}
        </div>
      )}
      {err && <p className="error">{err}</p>}
      <p className="hint-left">
        Check-in notifications arrive as system notifications. Each device subscribes separately;
        on iPhone this needs the Home Screen app.
      </p>
    </section>
  );
}
