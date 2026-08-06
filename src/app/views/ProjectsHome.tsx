import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Project, type Todo } from "../api";
import TodoRow from "../components/TodoRow";
import type { CaptureContext } from "../Capture";

const isClosed = (t: Todo) => t.status === "done" || t.status === "abandoned";
const defaultVisible = (t: Todo) => !isClosed(t);

export default function ProjectsHome(props: {
  refreshKey: number;
  onFocus: (ctx: CaptureContext | null) => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [showInactive, setShowInactive] = useState(false);
  const navigate = useNavigate();

  const load = () => {
    api<Project[]>("/projects").then(setProjects).catch(() => {});
    api<Todo[]>("/todos?all=1").then(setTodos).catch(() => {});
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [props.refreshKey]);

  // Home = no specific focus.
  useEffect(() => {
    props.onFocus(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inbox = todos.filter((t) => !t.project_id).filter(defaultVisible);
  const openCount = (p: Project) => todos.filter((t) => t.project_id === p.id && !isClosed(t)).length;
  const visibleProjects = projects.filter((p) => showInactive || p.status === "active");
  const inactiveCount = projects.filter((p) => p.status !== "active").length;

  return (
    <div className="tasks">
      <div className="project-cards">
        {visibleProjects.map((p) => (
          <button
            key={p.id}
            className={`project-card status-${p.status}`}
            onClick={() => navigate(`/projects/${p.id}`)}
          >
            <span className="name">{p.name}</span>
            <span className="meta">
              <span className="kind">{p.kind}</span>
              {p.status !== "active" && <span className="kind">{p.status}</span>}
              <span className="count">{openCount(p)} open</span>
            </span>
            {p.description && <span className="desc">{p.description}</span>}
          </button>
        ))}
        {visibleProjects.length === 0 && <p className="empty">No active projects — talk to create one.</p>}
      </div>
      {inactiveCount > 0 && (
        <label className="show-closed">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          show {inactiveCount} inactive project{inactiveCount > 1 ? "s" : ""}
        </label>
      )}

      <section className="inbox-section">
        <h2>Inbox</h2>
        {inbox.length === 0 && <p className="empty">Nothing here — unfiled todos land in the inbox.</p>}
        {inbox.map((t) => (
          <TodoRow key={t.id} todo={t} onChanged={load} />
        ))}
      </section>
    </div>
  );
}
