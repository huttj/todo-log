import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, patch, type Action, type Todo } from "../api";
import type { CaptureContext } from "../Capture";

const ACTION_STATUSES = ["scheduled", "in_progress", "done", "skipped", "canceled"] as const;

export default function Calendar(props: {
  refreshKey: number;
  onFocus: (ctx: CaptureContext | null) => void;
}) {
  const [dayOffset, setDayOffset] = useState(0);
  const [actions, setActions] = useState<Action[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const navigate = useNavigate();

  const day = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + dayOffset);
    return d;
  }, [dayOffset]);

  const load = () => {
    const from = Math.floor(day.getTime() / 1000);
    api<Action[]>(`/actions?from=${from}&to=${from + 86400}`).then(setActions).catch(() => {});
    api<Todo[]>("/todos?all=1").then(setTodos).catch(() => {});
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [props.refreshKey, day]);

  const todoTitle = useMemo(() => new Map(todos.map((t) => [t.id, t.title])), [todos]);

  return (
    <div className="calendar">
      <div className="day-nav">
        <button onClick={() => setDayOffset(dayOffset - 1)}>‹</button>
        <h2 onClick={() => setDayOffset(0)}>
          {day.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
          {dayOffset === 0 && " (today)"}
        </h2>
        <button onClick={() => setDayOffset(dayOffset + 1)}>›</button>
      </div>

      {actions.length === 0 && <p className="empty">No actions this day.</p>}
      {actions.map((a) => {
        const when = a.scheduled_start ?? a.started_at ?? a.created_at;
        const title = a.title ?? (a.todo_id ? todoTitle.get(a.todo_id) : null) ?? "untitled";
        return (
          <div
            key={a.id}
            className={`action-row status-${a.status}`}
            onClick={() => navigate(`/actions/${a.id}`)}
          >
            <span className="time">
              {new Date(when * 1000).toLocaleTimeString(undefined, {
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
            <span className="title">{title}</span>
            <select
              value={a.status}
              onClick={(e) => e.stopPropagation()}
              onChange={async (e) => {
                await patch(`/actions/${a.id}`, { status: e.target.value });
                props.onFocus({ type: "action", id: a.id, label: title });
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
      })}
      <p className="hint">Google Calendar overlay lands with the projection sync (next milestone).</p>
    </div>
  );
}
