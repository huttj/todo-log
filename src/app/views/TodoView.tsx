import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, patch, type Project, type Todo, type Log } from "../api";
import { fmtCost } from "../fmt";
import LogCard from "../components/LogCard";
import type { CaptureContext } from "../Capture";
import { navHistory } from "../nav";

const TODO_STATUSES = ["idea", "in_progress", "done", "abandoned"] as const;

export default function TodoView(props: {
  refreshKey: number;
  onFocus: (ctx: CaptureContext | null) => void;
}) {
  const todoId = Number(useParams().id);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [logs, setLogs] = useState<Log[] | null>(null);
  const [spend, setSpend] = useState(0);
  const navigate = useNavigate();

  const load = () => {
    api<Todo[]>("/todos?all=1").then(setTodos).catch(() => {});
    api<Project[]>("/projects").then(setProjects).catch(() => {});
    api<Log[]>(`/logs?todo_id=${todoId}&limit=30`).then(setLogs).catch(() => {});
    api<{ cost: number }>(`/usage/entity?type=todo&id=${todoId}`)
      .then((r) => setSpend(r.cost))
      .catch(() => {});
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [props.refreshKey, todoId]);

  const todo = todos.find((t) => t.id === todoId);
  const project = todo?.project_id ? projects.find((p) => p.id === todo.project_id) : null;

  useEffect(() => {
    if (todo) props.onFocus({ type: "todo", id: todo.id, label: todo.title });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todo?.id, todo?.title]);

  if (!todo) return <p className="empty">{todos.length ? "Todo not found." : "Loading…"}</p>;

  return (
    <div className="tasks todo-page">
      <div className="page-head">
        <div className="page-nav">
          {(() => {
            const prev = navHistory.prev;
            let label: string | null = null;
            if (prev && (window.history.state as { idx?: number } | null)?.idx) {
              if (prev === "/") label = "Today";
              else if (prev === "/projects") label = "Projects";
              else if (prev.startsWith("/projects/")) {
                const pid = Number(prev.split("/")[2]);
                label = projects.find((x) => x.id === pid)?.name ?? "Project";
              } else if (prev === "/logs") label = "Logs";
              else if (prev.startsWith("/logs/")) label = "Log";
              else if (prev.startsWith("/sessions")) label = "Chats";
              else if (prev === "/settings") label = "Settings";
              else if (prev.startsWith("/todos/")) label = "Todo";
            }
            return label ? (
              <button className="back" onClick={() => navigate(-1)}>
                ‹ {label}
              </button>
            ) : (
              <Link className="back" to={project ? `/projects/${project.id}` : "/"}>
                ‹ {project ? project.name : "Today"}
              </Link>
            );
          })()}
          <div className="page-meta">
            <select
              value={todo.status}
              onChange={async (e) => {
                await patch(`/todos/${todo.id}`, { status: e.target.value });
                load();
              }}
            >
              {TODO_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.replace("_", " ")}
                </option>
              ))}
            </select>
          </div>
        </div>
        <h2 className="page-title">{todo.title}</h2>
      </div>
      {spend > 0 && (
        <p className="entity-cost" title="Agent spend on turns that touched this todo">
          agent spend {fmtCost(spend)}
        </p>
      )}

      {todo.outcome && (
        <p className="description">
          <strong>Outcome:</strong> {todo.outcome}
        </p>
      )}
      {todo.details && (
        <p className="description">
          <strong>Details:</strong> {todo.details}
        </p>
      )}

      <section>
        <h2>Log</h2>
        {logs === null && <p className="empty">Loading…</p>}
        {logs?.length === 0 && <p className="empty">Nothing logged yet — tap Talk while you work on it.</p>}
        {logs?.map((l) => (
          <LogCard key={l.id} log={l} />
        ))}
      </section>
    </div>
  );
}
