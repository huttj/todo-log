// Today: the precomputed daily briefing (what today should look like) above
// the day's schedule (scheduled todos) and logs. Arrows / date picker browse
// other days; briefing, slipped, and in-flight sections only show on today.
// Every entry is dismissable (eye icon) — dismissed ones hide behind "see
// more" for the rest of the day (server-side per date, so the overview
// generator sees them and re-hides regenerated equivalents).
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowsRotate, faEye, faEyeSlash, faMicrophone } from "@fortawesome/free-solid-svg-icons";
import {
  api,
  post,
  patch,
  type Todo,
  type ScheduleEntry,
  type Project,
  type Log,
  type Briefing,
  type BriefingProjectLine,
} from "../api";
import TodoRow from "../components/TodoRow";
import LogCard from "../components/LogCard";
import HoldTalk from "../components/HoldTalk";
import { renderEntityRefs } from "../refs";
import { requestTalk } from "../talk";
import { fmtCost } from "../fmt";
import type { CaptureContext } from "../Capture";

const SLOT_STATUSES = ["planned", "done", "skipped"] as const;
const DAY = 86400;

/** An entry with a stable dismissal key. */
interface Entry {
  k: string;
  node: ReactNode;
  label?: string;
}

export default function Today(props: {
  refreshKey: number;
  onFocus: (ctx: CaptureContext | null) => void;
}) {
  const [dayOffset, setDayOffset] = useState(0);
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [generatedAt, setGeneratedAt] = useState<number | null>(null);
  const [briefCost, setBriefCost] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scheduled, setScheduled] = useState<ScheduleEntry[]>([]);
  const [overdue, setOverdue] = useState<ScheduleEntry[]>([]);
  const [logs, setLogs] = useState<Log[]>([]);
  const [daySpend, setDaySpend] = useState(0);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);

  const day = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + dayOffset);
    return d;
  }, [dayOffset]);
  const dayStart = Math.floor(day.getTime() / 1000);
  const isToday = dayOffset === 0;
  const isoDate = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;

  const load = () => {
    if (isToday) {
      api<{
        briefing: Briefing | null;
        generated_at: number | null;
        cost_usd?: number | null;
        has_prev?: boolean;
      }>("/briefing")
        .then((r) => {
          setBriefing(r.briefing);
          setGeneratedAt(r.generated_at);
          setBriefCost(r.cost_usd ?? null);
        })
        .catch(() => {});
      api<ScheduleEntry[]>(`/schedule?from=${dayStart - 7 * DAY}&to=${dayStart}`)
        .then((past) => setOverdue(past.filter((s) => s.slot_status === "planned")))
        .catch(() => {});
    }
    api<ScheduleEntry[]>(`/schedule?from=${dayStart}&to=${dayStart + DAY}`)
      .then(setScheduled)
      .catch(() => {});
    api<Log[]>(`/logs?from=${dayStart}&to=${dayStart + DAY}`).then(setLogs).catch(() => {});
    api<{ cost: number }>(`/usage/day?from=${dayStart}&to=${dayStart + DAY}`)
      .then((r) => setDaySpend(r.cost))
      .catch(() => {});
    api<Todo[]>("/todos?all=1").then(setTodos).catch(() => {});
    api<Project[]>("/projects").then(setProjects).catch(() => {});
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [props.refreshKey, dayStart]);

  // Talk from this page is a plain session — the agent fetches the overview
  // itself when the conversation needs it.
  useEffect(() => {
    props.onFocus(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -- Dismissals (server-side, per date — the overview generator reads them
  // and re-hides regenerated equivalents) -----------------------------------
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const loadDismissed = () => {
    api<{ keys: string[] }>(`/dismissals?day=${isoDate}`)
      .then((r) => setDismissed(new Set(r.keys)))
      .catch(() => {});
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(loadDismissed, [isoDate, props.refreshKey]);
  const toggleDismiss = (k: string, label?: string) => {
    const next = new Set(dismissed);
    const dismissing = !next.has(k);
    if (dismissing) next.add(k);
    else next.delete(k);
    setDismissed(next);
    void post("/dismissals", { day: isoDate, key: k, label, dismissed: dismissing }).catch(() => {});
  };

  const dismissBtn = (k: string, restore = false, label?: string) => (
    <button
      className="dismiss-btn"
      title={restore ? "Bring it back" : "Hide for today"}
      onClick={(e) => {
        e.stopPropagation();
        toggleDismiss(k, label);
      }}
    >
      <FontAwesomeIcon icon={restore ? faEyeSlash : faEye} />
    </button>
  );

  const [seeMore, setSeeMore] = useState<Set<string>>(new Set());
  const toggleMore = (key: string) =>
    setSeeMore((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      const r = await post<{ briefing: Briefing; generated_at: number; cost_usd?: number | null }>(
        "/briefing/refresh",
      );
      setBriefing(r.briefing);
      setGeneratedAt(r.generated_at);
      setBriefCost(r.cost_usd ?? null);
      loadDismissed();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setRefreshing(false);
    }
  }

  const todoTitle = useMemo(() => new Map(todos.map((t) => [t.id, t.title])), [todos]);
  const projectName = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);
  const inFlight = todos.filter(
    (t) => t.status === "in_progress" && !scheduled.some((s) => s.id === t.id),
  );

  const scheduledRow = (s: ScheduleEntry, showDay = false, restore = false) => (
    <div
      key={s.schedule_id}
      className={`action-row status-${s.slot_status === "planned" ? s.status : s.slot_status} ${restore ? "hidden-item" : ""}`}
    >
      <span className="time">
        {s.slot_all_day
          ? showDay
            ? new Date(s.slot_start * 1000).toLocaleDateString(undefined, { weekday: "short" })
            : "any time"
          : new Date(s.slot_start * 1000).toLocaleTimeString(undefined, {
              hour: "numeric",
              minute: "2-digit",
            })}
      </span>
      <span className="title">
        <Link to={`/todos/${s.id}`}>{s.title}</Link>
      </span>
      <select
        value={s.slot_status}
        onChange={async (e) => {
          await patch(`/schedule/${s.schedule_id}`, { status: e.target.value });
          props.onFocus({ type: "todo", id: s.id, label: s.title });
          load();
        }}
      >
        {SLOT_STATUSES.map((st) => (
          <option key={st} value={st}>
            {st}
          </option>
        ))}
      </select>
      {dismissBtn(`sched:${s.schedule_id}`, restore, s.title)}
    </div>
  );

  const sorted = [...scheduled].sort(
    (a, b) => (b.slot_all_day - a.slot_all_day) || (a.slot_start - b.slot_start),
  );

  // [the agent's own words](todo:12) become links; legacy bare tokens fall
  // back to entity titles. Shared renderer with the chat bubbles.
  const renderRefs = (text: string) =>
    renderEntityRefs(text, { todo: todoTitle, project: projectName });

  /** A section of dismissable rows: dismissed ones collapse behind "see more". */
  const rowSection = (secKey: string, heading: string, entries: Entry[]) => {
    if (entries.length === 0) return null;
    const shown = entries.filter((e) => !dismissed.has(e.k));
    const hidden = entries.filter((e) => dismissed.has(e.k));
    const open = seeMore.has(secKey);
    return (
      <section>
        <h2>{heading}</h2>
        {shown.map((e) => e.node)}
        {open && hidden.map((e) => e.node)}
        {hidden.length > 0 && (
          <button className="link see-more" onClick={() => toggleMore(secKey)}>
            {open ? "hide dismissed" : `see ${hidden.length} more`}
          </button>
        )}
      </section>
    );
  };

  // All briefing lines show by default; each is dismissable and dismissed
  // ones drop behind "see more".
  const briefCard = (key: string, heading: string, entries: Entry[], action?: ReactNode) => {
    if (entries.length === 0) return null;
    const shown = entries.filter((e) => !dismissed.has(e.k));
    const hidden = entries.filter((e) => dismissed.has(e.k));
    const expanded = seeMore.has(key);
    return (
      <div className="briefing brief-card">
        <section className="brief-section">
          <h2>
            {heading}
            {action}
          </h2>
          <ul className={`brief-list ${key}`}>
            {shown.map((e) => (
              <li key={e.k}>
                {e.node}
                {dismissBtn(e.k, false, e.label)}
              </li>
            ))}
            {expanded &&
              hidden.map((e) => (
                <li key={e.k} className="more-item hidden-item">
                  {e.node}
                  {dismissBtn(e.k, true, e.label)}
                </li>
              ))}
          </ul>
          {hidden.length > 0 && (
            <button className="link see-more" onClick={() => toggleMore(key)}>
              {expanded ? "hide dismissed" : `see ${hidden.length} more`}
            </button>
          )}
        </section>
      </div>
    );
  };

  // The style guide has lines start with the linked project name; only trust
  // a leading link when its text actually is the name (a "[Moving](project:3)"
  // opener still gets the name prefixed), and only skip the prefix then
  // (avoids "Back Taxes — Back Taxes — ...").
  const startsWithName = (p: BriefingProjectLine) => {
    const m = p.line.trimStart().match(/^\[([^\]]+)\]/);
    if (!m) return false;
    const linked = m[1].toLowerCase();
    const name = p.name.toLowerCase();
    return linked === name || linked.includes(name) || name.includes(linked);
  };
  const projectLine = (p: BriefingProjectLine) =>
    startsWithName(p) ? (
      <>{renderRefs(p.line)}</>
    ) : (
      <>
        {p.project_id ? (
          <Link className="brief-ref" to={`/projects/${p.project_id}`}>
            {p.name}
          </Link>
        ) : (
          <strong>{p.name}</strong>
        )}
        {" — "}
        {renderRefs(p.line)}
      </>
    );

  const lineEntries = (section: string, lines: string[]): Entry[] =>
    lines.map((t) => ({ k: `b:${section}:${t.slice(0, 80)}`, label: t.slice(0, 300), node: renderRefs(t) }));

  const threads = briefing
    ? [...(briefing.oneoffs ?? []), ...(briefing.oneoffs_more ?? [])]
    : [];

  return (
    <div className="tasks today">
      <div className="day-nav">
        <button onClick={() => setDayOffset(dayOffset - 1)}>‹</button>
        <div className="day-center">
          <h2 onClick={() => setDayOffset(0)}>
            {day.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
            {isToday && " (today)"}
          </h2>
          <input
            type="date"
            className="date-pick"
            value={isoDate}
            onChange={(e) => {
              const picked = new Date(`${e.target.value}T00:00:00`);
              if (!Number.isNaN(picked.getTime())) {
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                setDayOffset(Math.round((picked.getTime() - today.getTime()) / (DAY * 1000)));
              }
            }}
          />
        </div>
        <button onClick={() => setDayOffset(dayOffset + 1)}>›</button>
      </div>
      {daySpend > 0 && (
        <p className="day-cost" title="Total agent spend this day">
          agent spend {isToday ? "so far " : ""}
          {fmtCost(daySpend)}
        </p>
      )}

      {isToday && (
        <>
          {!briefing && !refreshing && (
            <p className="empty">No briefing yet — tap ↻ below to compute one, or just start talking.</p>
          )}
          {briefing && (
            <>
              <div className="briefing brief-card">
                <section className="brief-section">
                  <h2>Overview</h2>
                  <p className="headline">{renderRefs(briefing.headline)}</p>
                </section>
              </div>
              {briefCard(
                "today",
                "Plans & commitments",
                lineEntries("today", [...(briefing.today ?? []), ...(briefing.today_more ?? [])]),
              )}
              {briefCard(
                "oneoffs",
                "Loose threads",
                lineEntries("oneoffs", threads),
                <HoldTalk
                  className="thread-talk"
                  title="Talk through these threads · hold or drag up to record"
                  onOpen={(autoStart) =>
                    requestTalk(null, {
                      seed: ["**Loose threads:**", "", ...threads.map((x) => `- ${x}`)].join("\n"),
                      autoStart,
                    })
                  }
                >
                  <FontAwesomeIcon icon={faMicrophone} /> talk
                </HoldTalk>,
              )}
              {briefCard(
                "coming",
                "Coming up",
                lineEntries("coming", [
                  ...(briefing.coming ?? []),
                  ...(briefing.tomorrow ?? []),
                  ...(briefing.week ?? []),
                  ...(briefing.coming_more ?? []),
                ]),
              )}
              {briefCard(
                "projects",
                "Projects",
                [...(briefing.projects ?? []), ...(briefing.projects_more ?? [])].map((p) => ({
                  k: `b:proj:${p.name}:${p.line.slice(0, 60)}`,
                  label: p.line.slice(0, 300),
                  node: projectLine(p),
                })),
              )}
            </>
          )}
          <div className="brief-refresh">
            <span className="brief-cost" title="Cost of the last generation">
              {briefCost != null && briefCost > 0 ? `generated for ${fmtCost(briefCost)}` : ""}
            </span>
            {error && <span className="error">Briefing refresh failed: {error}</span>}
            <button
              className={`h2-toggle refresh ${refreshing ? "spin" : ""}`}
              title={
                generatedAt
                  ? `Recompute briefing (last: ${new Date(generatedAt * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })})`
                  : "Compute briefing"
              }
              onClick={() => void refresh()}
              disabled={refreshing}
            >
              <FontAwesomeIcon icon={faArrowsRotate} />
            </button>
          </div>
        </>
      )}

      {rowSection(
        "schedule",
        "Schedule",
        sorted.map((s) => ({ k: `sched:${s.schedule_id}`, node: scheduledRow(s, false, dismissed.has(`sched:${s.schedule_id}`)) })),
      )}
      {!isToday && sorted.length === 0 && <p className="empty">Nothing scheduled this day.</p>}

      {isToday &&
        rowSection(
          "slipped",
          "Slipped",
          overdue.map((s) => ({ k: `sched:${s.schedule_id}`, node: scheduledRow(s, true, dismissed.has(`sched:${s.schedule_id}`)) })),
        )}

      {isToday &&
        rowSection(
          "inflight",
          "In flight",
          inFlight.map((t) => ({
            k: `todo:${t.id}`,
            node: (
              <div key={t.id} className={`dismiss-row ${dismissed.has(`todo:${t.id}`) ? "hidden-item" : ""}`}>
                <TodoRow todo={t} onChanged={load} />
                {dismissBtn(`todo:${t.id}`, dismissed.has(`todo:${t.id}`), t.title)}
              </div>
            ),
          })),
        )}

      {rowSection(
        "logs",
        "Logs",
        logs.map((l) => ({
          k: `log:${l.id}`,
          node: (
            <div key={l.id} className={`dismiss-row ${dismissed.has(`log:${l.id}`) ? "hidden-item" : ""}`}>
              <LogCard
                log={l}
                onClick={() => props.onFocus({ type: "log", id: l.id, label: l.summary.slice(0, 40) })}
                attachment={
                  l.todo_id
                    ? { label: `todo: ${todoTitle.get(l.todo_id) ?? l.todo_id}`, to: `/todos/${l.todo_id}` }
                    : l.project_id
                      ? { label: `project: ${projectName.get(l.project_id) ?? l.project_id}`, to: `/projects/${l.project_id}` }
                      : null
                }
              />
              {dismissBtn(`log:${l.id}`, dismissed.has(`log:${l.id}`), l.summary.slice(0, 120))}
            </div>
          ),
        })),
      )}
    </div>
  );
}
