// Full search results page (Enter from the omni search) — real embeds:
// project cards, todo rows, and complete log cards, with matches highlighted.
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faXmark } from "@fortawesome/free-solid-svg-icons";
import { api, type Project, type Todo, type Log } from "../api";
import LogCard from "../components/LogCard";
import { highlight } from "../highlight";
import type { CaptureContext } from "../Capture";

interface Results {
  projects: Project[];
  todos: Todo[];
  logs: Log[];
}

export default function SearchResults(props: {
  refreshKey: number;
  onFocus: (ctx: CaptureContext | null) => void;
}) {
  const [params, setParams] = useSearchParams();
  const q = (params.get("q") ?? "").trim();
  const sort = params.get("sort") ?? "blend";
  const setSort = (s: string) =>
    setParams(s === "blend" ? { q } : { q, sort: s });
  const [query, setQuery] = useState(q);
  const [results, setResults] = useState<Results | null>(null);
  const [allTodos, setAllTodos] = useState<Todo[]>([]);
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    props.onFocus(null);
    api<Todo[]>("/todos?all=1").then(setAllTodos).catch(() => {});
    api<Project[]>("/projects").then(setAllProjects).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.refreshKey]);

  useEffect(() => {
    setQuery(q);
    if (q.length < 2) {
      setResults(null);
      return;
    }
    api<Results>(`/search?q=${encodeURIComponent(q)}&sort=${sort}`).then(setResults).catch(() => {});
  }, [q, sort, props.refreshKey]);

  const total = results
    ? results.projects.length + results.todos.length + results.logs.length
    : 0;

  const todoTitle = new Map(allTodos.map((t) => [t.id, t.title]));
  const projectName = new Map(allProjects.map((p) => [p.id, p.name]));

  return (
    <div className="tasks search-page">
      <form
        className="page-search"
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim().length >= 2) setParams({ q: query.trim() });
        }}
      >
        <input
          placeholder="Search projects, todos, logs…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button
            type="button"
            className="clear-q"
            title="Clear"
            onClick={() => {
              setQuery("");
              setParams({});
            }}
          >
            <FontAwesomeIcon icon={faXmark} />
          </button>
        )}
      </form>

      {q.length >= 2 && results && (
        <div className="search-meta">
          <p className="hint-left">
            {total} result{total === 1 ? "" : "s"} for “{q}”
          </p>
          <div className="settings-tabs sort-tabs">
            {[
              { key: "blend", label: "Best" },
              { key: "recent", label: "Recent" },
              { key: "match", label: "Similar" },
            ].map((s) => (
              <button key={s.key} className={sort === s.key ? "on" : ""} onClick={() => setSort(s.key)}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {q.length < 2 && <p className="empty">Type at least two characters and press Enter.</p>}
      {results && total === 0 && <p className="empty">Nothing found for “{q}”.</p>}

      {results && results.projects.length > 0 && (
        <section>
          <h2>Projects</h2>
          <div className="project-cards">
            {results.projects.map((p) => (
              <button
                key={p.id}
                className={`project-card status-${p.status}`}
                onClick={() => navigate(`/projects/${p.id}`)}
              >
                <span className="name">{highlight(p.name, q)}</span>
                <span className="meta">
                  <span className="kind">{p.kind}</span>
                  {p.status !== "active" && <span className="kind">{p.status}</span>}
                </span>
                {p.description && <span className="desc">{highlight(p.description, q)}</span>}
                {p.priority && (
                  <span className="desc">priority — {highlight(p.priority, q)}</span>
                )}
              </button>
            ))}
          </div>
        </section>
      )}

      {results && results.todos.length > 0 && (
        <section>
          <h2>Todos</h2>
          {results.todos.map((t) => (
            <div key={t.id} className="todo-row search-todo" onClick={() => navigate(`/todos/${t.id}`)}>
              <div className="todo-main">
                <span className="title">{highlight(t.title, q)}</span>
                {t.next_planned != null && (
                  <span className="sched-chip">
                    {new Date(t.next_planned * 1000).toLocaleDateString(undefined, {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                )}
                <span className="kind">{t.status.replace("_", " ")}</span>
              </div>
              {t.details && <p className="search-detail">{highlight(t.details, q)}</p>}
            </div>
          ))}
        </section>
      )}

      {results && results.logs.length > 0 && (
        <section>
          <h2>Logs</h2>
          {results.logs.map((l) => (
            <LogCard
              key={l.id}
              log={l}
              highlightQuery={q}
              attachment={
                l.todo_id
                  ? { label: `todo: ${todoTitle.get(l.todo_id) ?? l.todo_id}`, to: `/todos/${l.todo_id}` }
                  : l.project_id
                    ? {
                        label: `project: ${projectName.get(l.project_id) ?? l.project_id}`,
                        to: `/projects/${l.project_id}`,
                      }
                    : null
              }
            />
          ))}
        </section>
      )}
    </div>
  );
}
