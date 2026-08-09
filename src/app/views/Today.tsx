// Today: the precomputed daily briefing (what today should look like) above
// the actual schedule. The briefing regenerates after every chat turn, on cron
// staleness, and via the refresh button; "Discuss" opens a planning chat that
// starts from it.
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faComments, faArrowsRotate } from "@fortawesome/free-solid-svg-icons";
import { api, post, patch, type Action, type Todo, type Briefing } from "../api";
import TodoRow from "../components/TodoRow";
import { requestTalk } from "../talk";
import type { CaptureContext } from "../Capture";

const ACTION_STATUSES = ["scheduled", "in_progress", "done", "skipped", "canceled"] as const;
const DAY = 86400;

export default function Today(props: {
  refreshKey: number;
  onFocus: (ctx: CaptureContext | null) => void;
}) {
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [generatedAt, setGeneratedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [actions, setActions] = useState<Action[]>([]);
  const [overdue, setOverdue] = useState<Action[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const navigate = useNavigate();

  const dayStart = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  }, []);

  const load = () => {
    api<{ briefing: Briefing | null; generated_at: number | null }>("/briefing")
      .then((r) => {
        setBriefing(r.briefing);
        setGeneratedAt(r.generated_at);
      })
      .catch(() => {});
    api<Action[]>(`/actions?from=${dayStart}&to=${dayStart + DAY}`)
      .then(setActions)
      .catch(() => {});
    api<Action[]>(`/actions?from=${dayStart - 7 * DAY}&to=${dayStart}`)
      .then((past) => setOverdue(past.filter((a) => a.status === "scheduled")))
      .catch(() => {});
    api<Todo[]>("/todos").then(setTodos).catch(() => {});
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [props.refreshKey]);

  useEffect(() => {
    props.onFocus(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    setRefreshing(true);
    try {
      const r = await post<{ briefing: Briefing; generated_at: number }>("/briefing/refresh");
      setBriefing(r.briefing);
      setGeneratedAt(r.generated_at);
    } catch {
      /* transient — the stale briefing stays up */
    } finally {
      setRefreshing(false);
    }
  }

  const todoTitle = useMemo(() => new Map(todos.map((t) => [t.id, t.title])), [todos]);
  const title = (a: Action) => a.title ?? (a.todo_id ? todoTitle.get(a.todo_id) : null) ?? "untitled";
  const inFlight = todos.filter(
    (t) => t.status === "in_progress" && !actions.some((a) => a.todo_id === t.id),
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

  return (
    <div className="tasks today">
      <div className="today-head">
        <h2 className="today-title">
          {new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
        </h2>
        <div className="today-tools">
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
      </div>

      {!briefing && (
        <p className="empty">
          No briefing yet — it computes after your next chat, or tap ↻ to build one now.
        </p>
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

      {sorted.length > 0 && (
        <section>
          <h2>Schedule</h2>
          {sorted.map((a) => actionRow(a))}
        </section>
      )}

      {overdue.length > 0 && (
        <section>
          <h2>Slipped</h2>
          {overdue.map((a) => actionRow(a, true))}
        </section>
      )}

      {inFlight.length > 0 && (
        <section>
          <h2>In flight</h2>
          {inFlight.map((t) => (
            <TodoRow key={t.id} todo={t} onChanged={load} />
          ))}
        </section>
      )}
    </div>
  );
}
