// A log's permalink page: the full card plus the audit trail of what the
// agent did in the turns that touched it.
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Log, type Todo, type Project, type EventRecord } from "../api";
import LogCard from "../components/LogCard";
import EventFeed from "../components/EventFeed";
import type { CaptureContext } from "../Capture";

export default function LogView(props: {
  refreshKey: number;
  onFocus: (ctx: CaptureContext | null) => void;
}) {
  const logId = Number(useParams().id);
  const [log, setLog] = useState<Log | null>(null);
  const [events, setEvents] = useState<EventRecord[] | null>(null);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);

  const load = () => {
    api<Log>(`/logs/${logId}`).then(setLog).catch(() => {});
    api<EventRecord[]>(`/logs/${logId}/events`).then(setEvents).catch(() => {});
    api<Todo[]>("/todos?all=1").then(setTodos).catch(() => {});
    api<Project[]>("/projects").then(setProjects).catch(() => {});
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [props.refreshKey, logId]);

  useEffect(() => {
    if (log) props.onFocus({ type: "log", id: log.id, label: log.summary.slice(0, 40) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [log?.id]);

  if (!log) return <p className="empty">Loading…</p>;

  const attachment = log.todo_id
    ? {
        label: `todo: ${todos.find((t) => t.id === log.todo_id)?.title ?? log.todo_id}`,
        to: `/todos/${log.todo_id}`,
      }
    : log.project_id
      ? {
          label: `project: ${projects.find((p) => p.id === log.project_id)?.name ?? log.project_id}`,
          to: `/projects/${log.project_id}`,
        }
      : null;

  return (
    <div className="tasks log-page">
      <div className="page-head">
        <div className="page-nav">
          <Link className="back" to="/logs">
            ‹ Logs
          </Link>
          <span className="kind">
            {new Date(log.occurred_at * 1000).toLocaleString(undefined, {
              weekday: "short",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </span>
        </div>
      </div>

      <LogCard log={log} attachment={attachment} />

      <section>
        <h2>What the agent did this turn</h2>
        {events === null && <p className="empty">Loading…</p>}
        {events?.length === 0 && <p className="empty">No recorded actions.</p>}
        {events && events.length > 0 && (
          <EventFeed events={events} todos={todos} projects={projects} className="page-feed" />
        )}
      </section>
    </div>
  );
}
