// Today: the precomputed daily briefing (what today should look like) above
// the day's schedule and logs. Arrows / date picker browse other days (raw
// actions + logs — this replaced the Calendar page); briefing, slipped, and
// in-flight sections only show on the actual today.
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faComments, faArrowsRotate } from "@fortawesome/free-solid-svg-icons";
import { api, post, patch, type Action, type Todo, type Project, type Log, type Briefing } from "../api";
import TodoRow from "../components/TodoRow";
import LogCard from "../components/LogCard";
import { requestTalk } from "../talk";
import type { CaptureContext } from "../Capture";

const ACTION_STATUSES = ["scheduled", "in_progress", "done", "skipped", "canceled"] as const;
const DAY = 86400;

export default function Today(props: {
  refreshKey: number;
  onFocus: (ctx: CaptureContext | null) => void;
}) {
  const [dayOffset, setDayOffset] = useState(0);
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [generatedAt, setGeneratedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actions, setActions] = useState<Action[]>([]);
  const [overdue, setOverdue] = useState<Action[]>([]);
  const [logs, setLogs] = useState<Log[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const navigate = useNavigate();

  const day = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + dayOffset);
    return d;
  }, [dayOffset]);
  const dayStart = Math.floor(day.getTime() / 1000);
  const isToday = dayOffset === 0;

  const load = () => {
    if (isToday) {
      api<{ briefing: Briefing | null; generated_at: number | null }>("/briefing")
        .then((r) => {
          setBriefing(r.briefing);
          setGeneratedAt(r.generated_at);
        })
        .catch(() => {});
      api<Action[]>(`/actions?from=${dayStart - 7 * DAY}&to=${dayStart}`)
        .then((past) => setOverdue(past.filter((a) => a.status === "scheduled")))
        .catch(() => {});
    }
    api<Action[]>(`/actions?from=${dayStart}&to=${dayStart + DAY}`)
      .then(setActions)
      .catch(() => {});
    api<Log[]>(`/logs?from=${dayStart}&to=${dayStart + DAY}`).then(setLogs).catch(() => {});
    api<Todo[]>("/todos?all=1").then(setTodos).catch(() => {});
    api<Project[]>("/projects").then(setProjects).catch(() => {});
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [props.refreshKey, dayStart]);

  useEffect(() => {
    props.onFocus(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      const r = await post<{ briefing: Briefing; generated_at: number }>("/briefing/refresh");
      setBriefing(r.briefing);
      setGeneratedAt(r.generated_at);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setRefreshing(false);
    }
  }

  const todoTitle = useMemo(() => new Map(todos.map((t) => [t.id, t.title])), [todos]);
  const projectName = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);
  const title = (a: Action) => a.title ?? (a.todo_id ? todoTitle.get(a.todo_id) : null) ?? "untitled";
  const inFlight = todos.filter(
    (t) =>
      t.status === "in_progress" &&
      !actions.some((a) => a.todo_id === t.id),
  );

  const actionRow = (a: Action, showDay = false) => (
    <div key={a.id} className={`action-row status-${a.status}`} onClick={() => navigate(`/actions/${a.id}`)}>
      <span className="time">
        {a.all_day
          ? showDay
            ? new Date((a.scheduled_start ?? 0) * 1000).toLocaleDateString(undefined, {
                weekday: "short",
              })
            : "all day"
          : new Date((a.scheduled_start ?? a.started_at ?? a.created_at) * 1000).toLocaleTimeString(
              undefined,
              { hour: "numeric", minute: "2-digit" },
            )}
      </span>
      <span className="title">{title(a)}</span>
      <select
        value={a.status}
        onClick={(e) => e.stopPropagation()}
        onChange={async (e) => {
          await patch(`/actions/${a.id}`, { status: e.target.value });
          props.onFocus({ type: "action", id: a.id, label: title(a) });
          load();
        }}
      >
        {ACTION_STATUSES.map((s) => (
          <option key={s} value={s}>
            {s.replace("_", " ")}
          </option>
        ))}
      </select>
    </div>
  );

  const sorted = [...actions].sort(
    (a, b) => (b.all_day - a.all_day) || (a.scheduled_start ?? 0) - (b.scheduled_start ?? 0),
  );

  const bullets = (items: string[]) => (
    <ul className="brief-list">
      {items.map((x, i) => (
        <li key={i}>{x}</li>
      ))}
    </ul>
  );

  const isoDate = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;

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

      {isToday && (
        <>
          <div className="today-tools bar">
            <button
              className={`h2-toggle refresh ${refreshing ? "spin" : ""}`}
              title={
                generatedAt
                  ? `Recompute (last: ${new Date(generatedAt * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })})`
                  : "Compute briefing"
              }
              onClick={() => void refresh()}
              disabled={refreshing}
            >
              <FontAwesomeIcon icon={faArrowsRotate} />
            </button>
            <button className="plan-btn" onClick={() => requestTalk(null, { mode: "plan" })}>
              <FontAwesomeIcon icon={faComments} /> Discuss
            </button>
          </div>
          {error && <p className="error">Briefing refresh failed: {error}</p>}

          {!briefing && !refreshing && (
            <p className="empty">No briefing yet — tap ↻ to compute one, or just start talking.</p>
          )}
          {briefing && (
            <div className="briefing">
              <p className="headline">{briefing.headline}</p>
              {briefing.today.length > 0 && (
                <section className="brief-section">
                  <h2>Plans &amp; commitments</h2>
                  {bullets(briefing.today)}
                </section>
              )}
              {briefing.oneoffs.length > 0 && (
                <section className="brief-section">
                  <h2>Loose threads</h2>
                  {bullets(briefing.oneoffs)}
                </section>
              )}
              {briefing.projects.length > 0 && (
                <section className="brief-section">
                  <h2>Projects</h2>
                  <ul className="brief-list projects">
                    {briefing.projects.map((p, i) => (
                      <li key={i}>
                        {p.project_id ? (
                          <Link to={`/projects/${p.project_id}`}>{p.name}</Link>
                        ) : (
                          <strong>{p.name}</strong>
                        )}
                        {" — "}
                        {p.line}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {(briefing.tomorrow.length > 0 || briefing.week.length > 0) && (
                <section className="brief-section">
                  <h2>Coming up</h2>
                  {bullets([...briefing.tomorrow, ...briefing.week])}
                </section>
              )}
            </div>
          )}
        </>
      )}

      {sorted.length > 0 && (
        <section>
          <h2>Schedule</h2>
          {sorted.map((a) => actionRow(a))}
        </section>
      )}
      {!isToday && sorted.length === 0 && <p className="empty">No actions this day.</p>}

      {isToday && overdue.length > 0 && (
        <section>
          <h2>Slipped</h2>
          {overdue.map((a) => actionRow(a, true))}
        </section>
      )}

      {isToday && inFlight.length > 0 && (
        <section>
          <h2>In flight</h2>
          {inFlight.map((t) => (
            <TodoRow key={t.id} todo={t} onChanged={load} />
          ))}
        </section>
      )}

      {logs.length > 0 && (
        <section>
          <h2>Logs</h2>
          {logs.map((l) => (
            <LogCard
              key={l.id}
              log={l}
              onClick={() => props.onFocus({ type: "log", id: l.id, label: l.summary.slice(0, 40) })}
              attachment={
                l.todo_id
                  ? { label: `todo: ${todoTitle.get(l.todo_id) ?? l.todo_id}`, to: `/todos/${l.todo_id}` }
                  : l.project_id
                    ? { label: `project: ${projectName.get(l.project_id) ?? l.project_id}`, to: `/projects/${l.project_id}` }
                    : l.action_id
                      ? { label: `action #${l.action_id}`, to: `/actions/${l.action_id}` }
                      : null
              }
            />
          ))}
        </section>
      )}
    </div>
  );
}
