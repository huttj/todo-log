// Model management: per-service API keys (BYOK) and which model runs each
// use. Adding a key unlocks that service's models in the pickers; removing it
// falls everything on that service back to the built-in Claude models.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Select from "react-select";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faAsterisk,
  faCircleNodes,
  faMoon,
  faBolt,
  faMicrochip,
} from "@fortawesome/free-solid-svg-icons";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  api,
  post,
  del,
  type AgentConfig,
  type CatalogModel,
  type ModelsInfo,
  type ProviderStatus,
  type ThinkingLevel,
} from "../api";
import { fmtCost } from "../fmt";
import type { CaptureContext } from "../Capture";

// Solid-set proxies (FA has no AI-brand glyphs): Claude's starburst, a node
// mesh for OpenAI, moon for Moonshot, bolt/chip for the speed shops.
const PROVIDER_ICONS: Record<string, IconDefinition> = {
  anthropic: faAsterisk,
  openai: faCircleNodes,
  moonshot: faMoon,
  groq: faBolt,
  cerebras: faMicrochip,
};

const USE_CASES: { key: keyof AgentConfig["overrides"]; label: string }[] = [
  { key: "chat", label: "Chat" },
  { key: "briefing", label: "Overview" },
  { key: "checkin", label: "Notifications" },
  { key: "distill", label: "Learning distill" },
];

const THINKING_OPTS = [
  { value: "off", label: "off" },
  { value: "low", label: "light" },
  { value: "medium", label: "normal" },
  { value: "high", label: "deep" },
];

interface ModelOpt {
  value: string;
  label: string;
  tier: number;
  provider: string;
}

const INHERIT: ModelOpt = { value: "inherit", label: "default", tier: 0, provider: "" };

function ModelSel(props: {
  info: ModelsInfo;
  value: string | null;
  onChange: (v: string | null) => void;
  allowInherit: boolean;
}) {
  const groups = useMemo(() => {
    const opt = (m: CatalogModel): ModelOpt => ({
      value: m.slug,
      label: m.label,
      tier: m.tier,
      provider: m.provider,
    });
    return [
      ...(props.allowInherit ? [{ label: "", options: [INHERIT] }] : []),
      ...props.info.providers
        .map((p) => ({
          label: p.label,
          options: props.info.models.filter((m) => m.available && m.provider === p.id).map(opt),
        }))
        .filter((g) => g.options.length > 0),
    ];
  }, [props.info, props.allowInherit]);
  const flat = groups.flatMap((g) => g.options);
  return (
    <Select
      classNamePrefix="rs"
      options={groups}
      isSearchable
      placeholder="model…"
      value={flat.find((o) => o.value === (props.value ?? (props.allowInherit ? "inherit" : null))) ?? null}
      onChange={(v) => {
        const val = (v as ModelOpt | null)?.value ?? null;
        props.onChange(val === "inherit" ? null : val);
      }}
      formatOptionLabel={(o: ModelOpt) =>
        o.value === "inherit" ? (
          <span className="model-opt inherit">default</span>
        ) : (
          <span className="model-opt">
            <FontAwesomeIcon icon={PROVIDER_ICONS[o.provider] ?? faCircleNodes} className="model-ico" />
            <span>{o.label}</span>
            <span className="model-tier">{"$".repeat(o.tier)}</span>
          </span>
        )
      }
      styles={{ container: (b) => ({ ...b, minWidth: 190 }) }}
    />
  );
}

function ThinkingSel(props: {
  value: string | null;
  onChange: (v: ThinkingLevel | null) => void;
  allowInherit: boolean;
  isDisabled?: boolean;
}) {
  const options = props.allowInherit
    ? [{ value: "inherit", label: "default" }, ...THINKING_OPTS]
    : THINKING_OPTS;
  return (
    <Select
      classNamePrefix="rs"
      options={options}
      isSearchable={false}
      isDisabled={props.isDisabled}
      value={options.find((o) => o.value === (props.value ?? (props.allowInherit ? "inherit" : null))) ?? null}
      onChange={(v) => {
        const val = (v as { value: string } | null)?.value ?? null;
        props.onChange(val === "inherit" || val == null ? null : (val as ThinkingLevel));
      }}
      styles={{ container: (b) => ({ ...b, minWidth: 100 }) }}
    />
  );
}

function KeyRow(props: { p: ProviderStatus; onChanged: () => void }) {
  const { p } = props;
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function add() {
    setBusy(true);
    setErr(null);
    try {
      await post("/settings/keys", { provider: p.id, key: key.trim() });
      setKey("");
      setEditing(false);
      props.onChanged();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const back = p.id === "anthropic" ? "the built-in key" : "the built-in Claude models";
    if (!window.confirm(`Remove your ${p.label} key? Anything using it falls back to ${back}.`)) return;
    await del(`/settings/keys/${p.id}`).catch(() => {});
    props.onChanged();
  }

  return (
    <div className="key-row">
      <span className="key-name">
        <FontAwesomeIcon icon={PROVIDER_ICONS[p.id] ?? faCircleNodes} className="model-ico" />
        {p.label}
      </span>
      {p.has_key ? (
        <>
          <span className="key-tail">····{p.tail}</span>
          <span className="key-spend">{fmtCost(p.spend)} spent</span>
          <button className="link trash" title={`Remove your ${p.label} key`} onClick={() => void remove()}>
            ×
          </button>
        </>
      ) : editing ? (
        <>
          <input
            type="password"
            placeholder={p.key_hint}
            value={key}
            autoFocus
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && key.trim().length >= 8) void add();
            }}
          />
          <button className="link" disabled={busy || key.trim().length < 8} onClick={() => void add()}>
            {busy ? "checking…" : "save"}
          </button>
          {!busy && (
            <button className="link" onClick={() => setEditing(false)}>
              cancel
            </button>
          )}
        </>
      ) : (
        <button className="link" onClick={() => setEditing(true)}>
          add key
        </button>
      )}
      {err && <p className="error key-err">{err}</p>}
    </div>
  );
}

export default function Models(props: {
  refreshKey: number;
  onFocus: (ctx: CaptureContext | null) => void;
}) {
  const [info, setInfo] = useState<ModelsInfo | null>(null);
  const [cfg, setCfg] = useState<AgentConfig | null>(null);
  const [saved, setSaved] = useState(false);

  const load = () => {
    api<ModelsInfo>("/settings/models").then(setInfo).catch(() => {});
    api<AgentConfig>("/settings/agent").then(setCfg).catch(() => {});
  };
  useEffect(() => {
    props.onFocus(null);
    load();
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

  if (!info || !cfg) return <p className="empty">Loading…</p>;

  const canThink = (slug: string) => info.models.find((m) => m.slug === slug)?.thinking ?? true;

  return (
    <div className="tasks settings">
      <p className="settings-back">
        <Link to="/settings">← Settings</Link>
      </p>

      <section>
        <h2>Todo Log's AI (Anthropic)</h2>
        <label className="setting-row toggle-row">
          <input
            type="checkbox"
            checked={cfg.builtin_ai}
            onChange={(e) => {
              void save({ ...cfg, builtin_ai: e.target.checked }).then(() =>
                api<ModelsInfo>("/settings/models").then(setInfo).catch(() => {}),
              );
            }}
          />
          <span>Claude models on Todo Log's account — no key needed</span>
        </label>
        <p className="hint-left">
          Included while Todo Log is in beta. Turn it off to run entirely on your own keys below;
          with it off and no keys added, the agent can't respond.
        </p>
      </section>

      <section>
        <h2>Your API keys</h2>
        {info.providers.map((p) => (
          <KeyRow key={p.id} p={p} onChanged={load} />
        ))}
        <p className="hint-left">
          One key per service — adding one unlocks its models below, billed to your own account.
          Keys are encrypted, never shown again after saving, and checked against the service when
          you add them.
        </p>
      </section>

      <section>
        <h2>Agent defaults</h2>
        <div className="setting-row">
          <span>Model</span>
          <ModelSel
            info={info}
            value={cfg.default.model}
            allowInherit={false}
            onChange={(m) => save({ ...cfg, default: { ...cfg.default, model: m ?? "sonnet" } })}
          />
          <span>Thinking</span>
          <ThinkingSel
            value={cfg.default.thinking}
            allowInherit={false}
            isDisabled={!canThink(cfg.default.model)}
            onChange={(t) => save({ ...cfg, default: { ...cfg.default, thinking: t ?? "medium" } })}
          />
        </div>
        {!canThink(cfg.default.model) && (
          <p className="hint-left">This model doesn't support thinking — it runs off.</p>
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
              <ModelSel
                info={info}
                value={o.model}
                allowInherit
                onChange={(m) =>
                  save({ ...cfg, overrides: { ...cfg.overrides, [key]: { ...o, model: m } } })
                }
              />
              <ThinkingSel
                value={o.thinking}
                allowInherit
                isDisabled={!canThink(effModel)}
                onChange={(t) =>
                  save({ ...cfg, overrides: { ...cfg.overrides, [key]: { ...o, thinking: t } } })
                }
              />
            </div>
          );
        })}
        <p className="hint-left">
          "default" inherits the agent defaults above. Dollar signs rank cost across every model
          here, $ (cheapest) to $$$$. Planning chats always think deeply when thinking is on.
        </p>
      </section>

      {saved && <p className="hint-left">saved</p>}
    </div>
  );
}
