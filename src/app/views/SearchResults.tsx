// Full search results page (Enter from the omni search) — every hit,
// grouped and clickable.
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type Project, type Todo, type Log } from "../api";
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
  const [query, setQuery] = useState(q);
  const [results, setResults] = useState<Results | null>(null);

  useEffect(() => {
    props.onFocus(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setQuery(q);
    if (q.length < 2) {
      setResults(null);
      return;
    }
    api<Results>(`/search?q=${encodeURIComponent(q)}`).then(setResults).catch(() => {});
  }, [q, props.refreshKey]);

  const total = results
    ? results.projects.length + results.todos.length + results.logs.length
    : 0;

  return (
    <div className="tasks search-page">
      <form
        className="search-bar page-search"
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
      </form>

      {q.length >= 2 && results && (
        <p className="hint-left">
          {total} result{total === 1 ? "" : "s"} for “{q}”
        </p>
      )}
      {q.length < 2 && <p className="empty">Type at least two characters and press Enter.</p>}
      {results && total === 0 && <p className="empty">Nothing found for “{q}”.</p>}

      {results && results.projects.length > 0 && (
        <section>
          <h2>Projects</h2>
          {results.projects.map((p) => (
            <Link key={p.id} className="result-row" to={`/projects/${p.id}`}>
              <span className="title">{p.name}</span>
              <span className="kind">{p.status}</span>
            </Link>
          ))}
        </section>
      )}
      {results && results.todos.length > 0 && (
        <section>
          <h2>Todos</h2>
          {results.todos.map((t) => (
            <Link key={t.id} className="result-row" to={`/todos/${t.id}`}>
              <span className="title">{t.title}</span>
              <span className="kind">{t.status.replace("_", " ")}</span>
            </Link>
          ))}
        </section>
      )}
      {results && results.logs.length > 0 && (
        <section>
          <h2>Logs</h2>
          {results.logs.map((l) => (
            <Link key={l.id} className="result-row" to={`/logs/${l.id}`}>
              <span className="title">{l.title ?? l.summary.slice(0, 110)}</span>
              <span className="kind">
                {new Date(l.occurred_at * 1000).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })}
              </span>
            </Link>
          ))}
        </section>
      )}
    </div>
  );
}
