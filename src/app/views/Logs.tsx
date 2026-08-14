import { useEffect, useMemo, useState } from "react";
import { api, type Log, type Todo, type Project } from "../api";
import LogCard, { logAttachments } from "../components/LogCard";
import type { CaptureContext } from "../Capture";

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function toDateInput(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function Logs(props: {
  refreshKey: number;
  onFocus: (ctx: CaptureContext | null) => void;
}) {
  // null = recent stream (reverse-chron); a Date = that single day.
  const [day, setDay] = useState<Date | null>(null);
  const [logs, setLogs] = useState<Log[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [showInactive, setShowInactive] = useState(false);

  useEffect(() => {
    const range = day
      ? (() => {
          const from = Math.floor(startOfDay(day).getTime() / 1000);
          return `&from=${from}&to=${from + 86400}`;
        })()
      : "";
    api<Log[]>(`/logs?limit=100${range}`).then(setLogs).catch(() => {});
    api<Todo[]>("/todos?all=1").then(setTodos).catch(() => {});
    api<Project[]>("/projects").then(setProjects).catch(() => {});
  }, [props.refreshKey, day]);

  const todoTitle = useMemo(() => new Map(todos.map((t) => [t.id, t.title])), [todos]);
  const projectName = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);

  // Logs hide by default only when EVERY project they touch (the direct link
  // AND their todo's project) is inactive — a log that also pertains to an
  // active project stays visible. Computed independently of the toggle so the
  // checkbox stays on screen while checked.
  const inactiveProjects = useMemo(
    () => new Set(projects.filter((p) => p.status !== "active").map((p) => p.id)),
    [projects],
  );
  const todoProject = useMemo(() => new Map(todos.map((t) => [t.id, t.project_id])), [todos]);
  const hideable = useMemo(() => {
    const hidden = new Set<number>();
    for (const l of logs) {
      const linked = [
        ...(l.project_ids ?? []),
        ...(l.todo_ids ?? []).map((id) => todoProject.get(id)),
      ].filter((id): id is number => id != null);
      if (linked.length > 0 && linked.every((id) => inactiveProjects.has(id))) hidden.add(l.id);
    }
    return hidden;
  }, [logs, inactiveProjects, todoProject]);
  const visibleLogs = useMemo(
    () => (showInactive ? logs : logs.filter((l) => !hideable.has(l.id))),
    [logs, showInactive, hideable],
  );
  const hiddenCount = hideable.size;

  const byDay = useMemo(() => {
    const groups = new Map<string, Log[]>();
    for (const l of visibleLogs) {
      const key = new Date(l.occurred_at * 1000).toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(l);
    }
    return [...groups.entries()];
  }, [visibleLogs]);

  const step = (delta: number) => {
    const base = day ?? startOfDay(new Date());
    const next = new Date(base);
    next.setDate(next.getDate() + delta);
    setDay(next);
  };

  return (
    <div className="logs">
      <div className="day-nav">
        <button onClick={() => step(-1)}>‹</button>
        <div className="day-center">
          <h2 onClick={() => setDay(null)}>
            {day
              ? day.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })
              : "Recent"}
          </h2>
          <div className="day-sub">
            <input
              type="date"
              className="date-pick"
              value={day ? toDateInput(day) : ""}
              onChange={(e) => {
                if (!e.target.value) return setDay(null);
                const [y, m, d] = e.target.value.split("-").map(Number);
                setDay(new Date(y, m - 1, d));
              }}
            />
            <button
              className="link clear-day"
              title="Back to recent"
              onClick={() => setDay(null)}
              style={{ visibility: day ? "visible" : "hidden" }}
            >
              ✕
            </button>
          </div>
        </div>
        <button onClick={() => step(1)} disabled={!day && true}>
          ›
        </button>
      </div>

      {logs.length === 0 && (
        <p className="empty">{day ? "Nothing logged this day." : "Nothing logged yet — tap Talk."}</p>
      )}
      {hiddenCount > 0 && (
        <label className="show-closed">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          show {hiddenCount} log{hiddenCount > 1 ? "s" : ""} from inactive projects
        </label>
      )}
      {byDay.map(([dayLabel, entries]) => (
        <section key={dayLabel}>
          {!day && <h2>{dayLabel}</h2>}
          {entries.map((l) => (
            <LogCard
              key={l.id}
              log={l}
              onClick={() =>
                props.onFocus({ type: "log", id: l.id, label: l.summary.slice(0, 40) })
              }
              attachments={logAttachments(l, { todoTitle, projectName })}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
