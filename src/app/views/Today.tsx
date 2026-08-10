// Today: the precomputed daily briefing (what today should look like) above
// the day's schedule (scheduled todos) and logs. Arrows / date picker browse
// other days; briefing, slipped, and in-flight sections only show on today.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowsRotate } from "@fortawesome/free-solid-svg-icons";
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
import { renderEntityRefs } from "../refs";
import type { CaptureContext } from "../Capture";

const SLOT_STATUSES = ["planned", "done", "skipped"] as const;
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
  const [scheduled, setScheduled] = useState<ScheduleEntry[]>([]);
  const [overdue, setOverdue] = useState<ScheduleEntry[]>([]);
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
      api<{ briefing: Briefing | null; generated_at: number | null; has_prev?: boolean }>("/briefing")
        .then((r) => {
          setBriefing(r.briefing);
          setGeneratedAt(r.generated_at);
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
    api<Todo[]>("/todos?all=1").then(setTodos).catch(() => {});
    api<Project[]>("/projects").then(setProjects).catch(() => {});
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [props.refreshKey, dayStart]);

  // Talk from this page = a planning-flavored session about the day.
  useEffect(() => {
    props.onFocus({
      type: "today",
      id: 0,
      label: new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }),
    });
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
  const inFlight = todos.filter(
    (t) => t.status === "in_progress" && !scheduled.some((s) => s.id === t.id),
  );


  const scheduledRow = (s: ScheduleEntry, showDay = false) => (
    <div
      key={s.schedule_id}
      className={`action-row status-${s.slot_status === "planned" ? s.status : s.slot_status}`}
      onClick={() => navigate(`/todos/${s.id}`)}
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
      <span className="title">{s.title}</span>
      <select
        value={s.slot_status}
        onClick={(e) => e.stopPropagation()}
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
    </div>
  );

  const sorted = [...scheduled].sort(
    (a, b) => (b.slot_all_day - a.slot_all_day) || (a.slot_start - b.slot_start),
  );

  // [the agent's own words](todo:12) become links; legacy bare tokens fall
  // back to entity titles. Shared renderer with the chat bubbles.
  const renderRefs = (text: string) =>
    renderEntityRefs(text, { todo: todoTitle, project: projectName });

  const [seeMore, setSeeMore] = useState<Set<string>>(new Set());
  const toggleMore = (key: string) =>
    setSeeMore((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const briefCard = (key: string, heading: string, items: ReactNode[], more: ReactNode[]) => {
    if (items.length + more.length === 0) return null;
    const expanded = seeMore.has(key);
    return (
      <div className="briefing brief-card">
        <section className="brief-section">
          <h2>{heading}</h2>
          <ul className={`brief-list ${key}`}>
            {items.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
            {expanded &&
              more.map((x, i) => (
                <li key={`m${i}`} className="more-item">
                  {x}
                </li>
              ))}
          </ul>
          {more.length > 0 && (
            <button className="link see-more" onClick={() => toggleMore(key)}>
              {expanded ? "see less" : `see ${more.length} more`}
            </button>
          )}
        </section>
      </div>
    );
  };

  const projectLine = (p: BriefingProjectLine) => (
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
                (briefing.today ?? []).map(renderRefs),
                (briefing.today_more ?? []).map(renderRefs),
              )}
              {briefCard(
                "oneoffs",
                "Loose threads",
                (briefing.oneoffs ?? []).map(renderRefs),
                (briefing.oneoffs_more ?? []).map(renderRefs),
              )}
              {briefCard(
                "coming",
                "Coming up",
                [
                  ...(briefing.coming ?? []),
                  ...(briefing.tomorrow ?? []),
                  ...(briefing.week ?? []),
                ].map(renderRefs),
                (briefing.coming_more ?? []).map(renderRefs),
              )}
              {briefCard(
                "projects",
                "Projects",
                (briefing.projects ?? []).map(projectLine),
                (briefing.projects_more ?? []).map(projectLine),
              )}
            </>
          )}
          <div className="brief-refresh">
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

      {sorted.length > 0 && (
        <section>
          <h2>Schedule</h2>
          {sorted.map((s) => scheduledRow(s))}
        </section>
      )}
      {!isToday && sorted.length === 0 && <p className="empty">Nothing scheduled this day.</p>}

      {isToday && overdue.length > 0 && (
        <section>
          <h2>Slipped</h2>
          {overdue.map((s) => scheduledRow(s, true))}
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
                    : null
              }
            />
          ))}
        </section>
      )}
    </div>
  );
}
