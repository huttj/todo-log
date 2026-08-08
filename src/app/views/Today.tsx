// Today: the answer to "what should I do today?" — today's schedule (all-day
// plans first), anything overdue, what's in flight, and the planning agent.
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faWandMagicSparkles } from "@fortawesome/free-solid-svg-icons";
import { api, patch, type Action, type Todo } from "../api";
import TodoRow from "../components/TodoRow";
import { requestTalk } from "../talk";
import type { CaptureContext } from "../Capture";

const ACTION_STATUSES = ["scheduled", "in_progress", "done", "skipped", "canceled"] as const;
const DAY = 86400;

export default function Today(props: {
  refreshKey: number;
  onFocus: (ctx: CaptureContext | null) => void;
}) {
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
    api<Action[]>(`/actions?from=${dayStart}&to=${dayStart + DAY}`)
      .then(setActions)
      .catch(() => {});
    // Look back a week for scheduled things that never happened.
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

  // All-day plans first, then the timed schedule.
  const sorted = [...actions].sort(
    (a, b) => (b.all_day - a.all_day) || (a.scheduled_start ?? 0) - (b.scheduled_start ?? 0),
  );

  return (
    <div className="tasks today">
      <div className="today-head">
        <h2 className="today-title">
          {new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
        </h2>
        <button className="plan-btn" onClick={() => requestTalk(null, { mode: "plan" })}>
          <FontAwesomeIcon icon={faWandMagicSparkles} /> Plan my day
        </button>
      </div>

      {sorted.length === 0 && (
        <p className="empty">Nothing planned yet — tap “Plan my day” to talk it through.</p>
      )}
      {sorted.map((a) => actionRow(a))}

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
