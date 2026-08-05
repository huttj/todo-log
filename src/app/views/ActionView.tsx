// An action's page: what happened, when, its todo/project, and the logs and
// reflections attached to it — the "how did it go" record.
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, patch, type Action, type Todo, type Project, type Log } from "../api";
import LogCard from "../components/LogCard";
import type { CaptureContext } from "../Capture";

const ACTION_STATUSES = ["scheduled", "in_progress", "done", "skipped", "canceled"] as const;

export default function ActionView(props: {
  refreshKey: number;
  onFocus: (ctx: CaptureContext | null) => void;
}) {
  const actionId = Number(useParams().id);
  const [action, setAction] = useState<Action | null>(null);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [logs, setLogs] = useState<Log[] | null>(null);

  const load = () => {
    api<Action>(`/actions/${actionId}`).then(setAction).catch(() => {});
    api<Todo[]>("/todos?all=1").then(setTodos).catch(() => {});
    api<Project[]>("/projects").then(setProjects).catch(() => {});
    api<Log[]>(`/logs?action_id=${actionId}&limit=30`).then(setLogs).catch(() => {});
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [props.refreshKey, actionId]);

  const todo = action?.todo_id ? todos.find((t) => t.id === action.todo_id) : null;
  const project = action?.project_id ? projects.find((p) => p.id === action.project_id) : null;
  const title = action?.title ?? todo?.title ?? "untitled action";

  useEffect(() => {
    if (action) props.onFocus({ type: "action", id: action.id, label: title });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action?.id, title]);

  if (!action) return <p className="empty">Loading…</p>;

  const fmt = (ts: number | null) =>
    ts
      ? new Date(ts * 1000).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : null;
  const when =
    fmt(action.started_at) ?? fmt(action.scheduled_start) ?? fmt(action.created_at) ?? "";

  return (
    <div className="tasks action-page">
      <div className="page-head">
        <div className="page-nav">
          <Link className="back" to="/calendar">
            ‹ Calendar
          </Link>
          <div className="page-meta">
            <select
              value={action.status}
              onChange={async (e) => {
                await patch(`/actions/${action.id}`, { status: e.target.value });
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
        </div>
        <h2 className="page-title">{title}</h2>
        <div className="page-meta">
          <span className="kind">{when}</span>
          {todo && (
            <Link className="attachment" to={`/todos/${todo.id}`}>
              todo: {todo.title}
            </Link>
          )}
          {project && (
            <Link className="attachment" to={`/projects/${project.id}`}>
              project: {project.name}
            </Link>
          )}
        </div>
      </div>

      <section>
        <h2>Log</h2>
        {logs === null && <p className="empty">Loading…</p>}
        {logs?.length === 0 && (
          <p className="empty">Nothing yet — tap Talk and say how it went.</p>
        )}
        {logs?.map((l) => (
          <LogCard key={l.id} log={l} />
        ))}
      </section>
    </div>
  );
}
