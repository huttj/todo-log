import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, patch, type Project, type Todo, type Log } from "../api";
import { fmtCost } from "../fmt";
import TodoRow from "../components/TodoRow";
import LogCard from "../components/LogCard";
import type { CaptureContext } from "../Capture";

const isClosed = (t: Todo) => t.status === "done" || t.status === "abandoned";

export default function ProjectView(props: {
  refreshKey: number;
  onFocus: (ctx: CaptureContext | null) => void;
}) {
  const projectId = Number(useParams().id);
  const [projects, setProjects] = useState<Project[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [logs, setLogs] = useState<Log[] | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [spend, setSpend] = useState(0);

  const load = () => {
    api<Project[]>("/projects").then(setProjects).catch(() => {});
    api<Todo[]>("/todos?all=1").then(setTodos).catch(() => {});
    api<Log[]>(`/logs?project_id=${projectId}&limit=25`).then(setLogs).catch(() => {});
    api<{ cost: number }>(`/usage/entity?type=project&id=${projectId}`)
      .then((r) => setSpend(r.cost))
      .catch(() => {});
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [props.refreshKey, projectId]);

  const project = projects.find((p) => p.id === projectId);

  useEffect(() => {
    if (project) props.onFocus({ type: "project", id: project.id, label: project.name });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, project?.name]);

  if (!project) return <p className="empty">{projects.length ? "Project not found." : "Loading…"}</p>;

  const own = todos.filter((t) => t.project_id === projectId);
  const visible = own.filter((t) => showClosed || !isClosed(t));
  const todoTitle = new Map(own.map((t) => [t.id, t.title]));

  return (
    <div className="tasks project-page">
      <div className="page-head">
        <div className="page-nav">
          <Link className="back" to="/">
            ‹ Projects
          </Link>
          <div className="page-meta">
            <span className="kind">{project.kind}</span>
            <select
              value={project.status}
              onChange={async (e) => {
                await patch(`/projects/${project.id}`, { status: e.target.value });
                load();
              }}
            >
              <option value="active">active</option>
              <option value="paused">paused</option>
              <option value="completed">completed</option>
              <option value="abandoned">abandoned</option>
            </select>
          </div>
        </div>
        <h2 className="page-title">{project.name}</h2>
      </div>
      {project.description && <p className="description">{project.description}</p>}
      {project.priority && (
        <p className="priority-line">
          <span className="pri-label">priority</span> {project.priority}
        </p>
      )}
      {spend > 0 && (
        <p className="entity-cost" title="Agent spend on turns that touched this project">
          agent spend {fmtCost(spend)}
        </p>
      )}

      <section>
        <h2>Todos</h2>
        {visible.length === 0 && <p className="empty">No todos yet — tap Talk to add some.</p>}
        {visible.map((t) => (
          <TodoRow key={t.id} todo={t} onChanged={load} />
        ))}
        {own.some(isClosed) && (
          <label className="show-closed">
            <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
            show all closed
          </label>
        )}
      </section>

      <section>
        <h2>Project log</h2>
        {logs === null && <p className="empty">Loading…</p>}
        {logs?.length === 0 && <p className="empty">Nothing logged yet</p>}
        {logs?.map((l) => (
          <LogCard
            key={l.id}
            log={l}
            attachment={
              l.todo_id
                ? { label: `todo: ${todoTitle.get(l.todo_id) ?? l.todo_id}`, to: `/todos/${l.todo_id}` }
                : l.action_id
                  ? { label: `action #${l.action_id}`, to: `/actions/${l.action_id}` }
                  : null
            }
          />
        ))}
      </section>
    </div>
  );
}
