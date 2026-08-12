// Omni search: overlay with debounced search across projects, todos, and logs.
// Arrow keys move a highlight through the flattened result list (focus stays
// in the input); Enter opens the highlighted hit, hover keeps it in sync.
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
  const [active, setActive] = useState(0);
  // Enter opens the arrowed-to hit; without arrowing it opens the full
  // results page instead.
  const [arrowed, setArrowed] = useState(false);
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

  useEffect(() => {
    setActive(0);
    setArrowed(false);
  }, [results]);

  useEffect(() => {
    document.querySelector(".search-hit.active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const go = (path: string) => {
    props.onClose();
    navigate(path);
  };

  // One flat, ordered list of navigation targets mirroring render order.
  const flat: string[] = results
    ? [
        ...results.projects.map((p) => `/projects/${p.id}`),
        ...results.todos.map((t) => `/todos/${t.id}`),
        ...results.logs.map((l) => `/logs/${l.id}`),
      ]
    : [];
  const todosAt = results?.projects.length ?? 0;
  const logsAt = todosAt + (results?.todos.length ?? 0);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      props.onClose();
    } else if (e.key === "ArrowDown" && flat.length > 0) {
      e.preventDefault();
      setArrowed(true);
      setActive((a) => Math.min(a + 1, flat.length - 1));
    } else if (e.key === "ArrowUp" && flat.length > 0) {
      e.preventDefault();
      setArrowed(true);
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (arrowed && flat[active]) go(flat[active]);
      else if (query.trim().length >= 2) go(`/search?q=${encodeURIComponent(query.trim())}`);
    }
  };

  const hit = (index: number, path: string, title: string, kind: string) => (
    <button
      key={path}
      className={`search-hit${index === active ? " active" : ""}`}
      onClick={() => go(path)}
      onMouseEnter={() => setActive(index)}
    >
      <span className="title">{title}</span>
      <span className="kind">{kind}</span>
    </button>
  );

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
            onKeyDown={onKeyDown}
          />
          <button className="link" onClick={props.onClose} title="Close">
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>

        {query.trim().length >= 2 && (
          <p className="search-hint">↑↓ to pick · Enter opens it · Enter (no pick) shows all results</p>
        )}
        {searching && <p className="empty">Searching…</p>}
        {empty && !searching && <p className="empty">Nothing found for “{query.trim()}”.</p>}

        {results && results.projects.length > 0 && (
          <section>
            <h3>Projects</h3>
            {results.projects.map((p, i) => hit(i, `/projects/${p.id}`, p.name, p.status))}
          </section>
        )}
        {results && results.todos.length > 0 && (
          <section>
            <h3>Todos</h3>
            {results.todos.map((t, i) =>
              hit(todosAt + i, `/todos/${t.id}`, t.title, t.status.replace("_", " ")),
            )}
          </section>
        )}
        {results && results.logs.length > 0 && (
          <section>
            <h3>Logs</h3>
            {results.logs.map((l, i) =>
              hit(
                logsAt + i,
                `/logs/${l.id}`,
                l.summary.slice(0, 90),
                new Date(l.occurred_at * 1000).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                }),
              ),
            )}
          </section>
        )}
      </div>
    </div>
  );
}
