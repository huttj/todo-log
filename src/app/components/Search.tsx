// Omni search: overlay with debounced search across projects, todos, and logs.
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faMagnifyingGlass, faXmark } from "@fortawesome/free-solid-svg-icons";
import { api, type Project, type Todo, type Log } from "../api";

interface Results {
  projects: Project[];
  todos: Todo[];
  logs: Log[];
}

export default function Search(props: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Results | null>(null);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      return;
    }
    setSearching(true);
    timerRef.current = window.setTimeout(() => {
      api<Results>(`/search?q=${encodeURIComponent(q)}`)
        .then(setResults)
        .catch(() => {})
        .finally(() => setSearching(false));
    }, 250);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [query]);

  const go = (path: string) => {
    props.onClose();
    navigate(path);
  };

  const empty =
    results && results.projects.length === 0 && results.todos.length === 0 && results.logs.length === 0;

  return (
    <div className="search-overlay" onClick={props.onClose}>
      <div className="search-panel" onClick={(e) => e.stopPropagation()}>
        <div className="search-bar">
          <FontAwesomeIcon icon={faMagnifyingGlass} className="search-icon" />
          <input
            ref={inputRef}
            placeholder="Search projects, todos, logs…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && props.onClose()}
          />
          <button className="link" onClick={props.onClose} title="Close">
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>

        {searching && <p className="empty">Searching…</p>}
        {empty && !searching && <p className="empty">Nothing found for “{query.trim()}”.</p>}

        {results && results.projects.length > 0 && (
          <section>
            <h3>Projects</h3>
            {results.projects.map((p) => (
              <button key={p.id} className="search-hit" onClick={() => go(`/projects/${p.id}`)}>
                <span className="title">{p.name}</span>
                <span className="kind">{p.status}</span>
              </button>
            ))}
          </section>
        )}
        {results && results.todos.length > 0 && (
          <section>
            <h3>Todos</h3>
            {results.todos.map((t) => (
              <button key={t.id} className="search-hit" onClick={() => go(`/todos/${t.id}`)}>
                <span className="title">{t.title}</span>
                <span className="kind">{t.status.replace("_", " ")}</span>
              </button>
            ))}
          </section>
        )}
        {results && results.logs.length > 0 && (
          <section>
            <h3>Logs</h3>
            {results.logs.map((l) => (
              <button key={l.id} className="search-hit" onClick={() => go(`/logs/${l.id}`)}>
                <span className="title">{l.summary.slice(0, 90)}</span>
                <span className="kind">
                  {new Date(l.occurred_at * 1000).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
              </button>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
