import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faEye, faEyeSlash } from "@fortawesome/free-solid-svg-icons";
import { api, type Project, type Todo } from "../api";
import { fmtCost } from "../fmt";
import TodoRow from "../components/TodoRow";
import type { CaptureContext } from "../Capture";

const isClosed = (t: Todo) => t.status === "done" || t.status === "abandoned";

/** Right-aligned eye toggle for section headings ("show the hidden ones"). */
function HeadToggle(props: { on: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      className={`h2-toggle ${props.on ? "on" : ""}`}
      title={`${props.on ? "Hide" : "Show"} ${props.label}`}
      onClick={props.onToggle}
    >
      <FontAwesomeIcon icon={props.on ? faEyeSlash : faEye} />
    </button>
  );
}

export default function ProjectsHome(props: {
  refreshKey: number;
  onFocus: (ctx: CaptureContext | null) => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [costs, setCosts] = useState<Record<number, number>>({});
  const [showInactive, setShowInactive] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const navigate = useNavigate();

  const load = () => {
    api<Project[]>("/projects").then(setProjects).catch(() => {});
    api<Todo[]>("/todos?all=1").then(setTodos).catch(() => {});
    api<Record<number, number>>("/usage/projects").then(setCosts).catch(() => {});
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [props.refreshKey]);

  // Home = no specific focus.
  useEffect(() => {
    props.onFocus(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inbox = todos.filter((t) => !t.project_id).filter((t) => showClosed || !isClosed(t));
  const closedInboxCount = todos.filter((t) => !t.project_id && isClosed(t)).length;
  const openCount = (p: Project) => todos.filter((t) => t.project_id === p.id && !isClosed(t)).length;
  const visibleProjects = projects.filter((p) => showInactive || p.status === "active");
  const inactiveCount = projects.filter((p) => p.status !== "active").length;

  return (
    <div className="tasks">
      <section>
        <h2>
          Projects
          {inactiveCount > 0 && (
            <HeadToggle
              on={showInactive}
              label={`${inactiveCount} inactive project${inactiveCount > 1 ? "s" : ""}`}
              onToggle={() => setShowInactive((x) => !x)}
            />
          )}
        </h2>
        <div className="project-cards">
          {visibleProjects.map((p) => (
            <button
              key={p.id}
              className={`project-card status-${p.status}`}
              onClick={() => navigate(`/projects/${p.id}`)}
            >
              {(costs[p.id] ?? 0) > 0 && (
                <span className="card-cost" title="Agent spend on this project">
                  {fmtCost(costs[p.id])}
                </span>
              )}
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
      </section>

      <section className="inbox-section">
        <h2>
          Inbox
          {closedInboxCount > 0 && (
            <HeadToggle
              on={showClosed}
              label={`${closedInboxCount} completed task${closedInboxCount > 1 ? "s" : ""}`}
              onToggle={() => setShowClosed((x) => !x)}
            />
          )}
        </h2>
        {inbox.length === 0 && <p className="empty">Nothing here — unfiled todos land in the inbox.</p>}
        {inbox.map((t) => (
          <TodoRow key={t.id} todo={t} onChanged={load} />
        ))}
      </section>
    </div>
  );
}
