// Chat history: past capture sessions (newest first) and a replay page.
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faTrashCan } from "@fortawesome/free-solid-svg-icons";
import {
  api,
  del,
  type SessionSummary,
  type CaptureSession,
  type Message,
  type Todo,
  type Project,
  type EventRecord,
} from "../api";
import EventFeed from "../components/EventFeed";
import type { CaptureContext } from "../Capture";

function contextLabel(
  s: { context_type: string | null; context_id: number | null; about_session_id?: number | null },
  todos: Todo[],
  projects: Project[],
): string | null {
  if (s.about_session_id) return `about chat #${s.about_session_id}`;
  if (!s.context_type || !s.context_id) return null;
  if (s.context_type === "todo") {
    return `todo: ${todos.find((t) => t.id === s.context_id)?.title ?? `#${s.context_id}`}`;
  }
  if (s.context_type === "project") {
    return `project: ${projects.find((p) => p.id === s.context_id)?.name ?? `#${s.context_id}`}`;
  }
  return `${s.context_type} #${s.context_id}`;
}

export function Sessions(props: {
  refreshKey: number;
  onFocus: (ctx: CaptureContext | null) => void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const navigate = useNavigate();

  const load = () => {
    api<SessionSummary[]>("/sessions").then(setSessions).catch(() => {});
    api<Todo[]>("/todos?all=1").then(setTodos).catch(() => {});
    api<Project[]>("/projects").then(setProjects).catch(() => {});
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [props.refreshKey]);

  async function deleteSession(id: number) {
    if (!window.confirm("Delete this chat? Journal logs stay, but the audio and transcript are gone for good.")) {
      return;
    }
    await del(`/sessions/${id}`).catch(() => {});
    load();
  }

  useEffect(() => {
    props.onFocus(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const byDay = useMemo(() => {
    const groups = new Map<string, SessionSummary[]>();
    for (const s of sessions) {
      const day = new Date(s.started_at * 1000).toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
      (groups.get(day) ?? groups.set(day, []).get(day)!).push(s);
    }
    return [...groups.entries()];
  }, [sessions]);

  return (
    <div className="sessions">
      {sessions.length === 0 && <p className="empty">No chats yet — tap Talk.</p>}
      {byDay.map(([day, list]) => (
        <section key={day}>
          <h2>{day}</h2>
          {list.map((s) => {
            const label = contextLabel(s, todos, projects);
            return (
              <div key={s.id} className="session-row" onClick={() => navigate(`/sessions/${s.id}`)}>
                <div className="session-head">
                  <span className="time">
                    {new Date(s.started_at * 1000).toLocaleTimeString(undefined, {
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </span>
                  {label && <span className="attachment">{label}</span>}
                  <span className="count">{s.message_count} msg</span>
                  <button
                    className="link trash"
                    title="Delete chat"
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteSession(s.id);
                    }}
                  >
                    <FontAwesomeIcon icon={faTrashCan} />
                  </button>
                </div>
                {s.first_text && <p className="snippet">{s.first_text.slice(0, 140)}</p>}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}

export function SessionView(props: {
  refreshKey: number;
  onFocus: (ctx: CaptureContext | null) => void;
}) {
  const sessionId = Number(useParams().id);
  const [data, setData] = useState<{
    session: CaptureSession & { started_at?: number };
    messages: Message[];
    events?: EventRecord[];
  } | null>(null);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [openThoughts, setOpenThoughts] = useState<Set<number>>(new Set());
  const navigate = useNavigate();

  useEffect(() => {
    api<{ session: CaptureSession; messages: Message[]; events: EventRecord[] }>(`/sessions/${sessionId}`)
      .then(setData)
      .catch(() => {});
    api<Todo[]>("/todos?all=1").then(setTodos).catch(() => {});
    api<Project[]>("/projects").then(setProjects).catch(() => {});
  }, [props.refreshKey, sessionId]);

  // Talk from a replay page talks ABOUT this chat, not where the chat happened.
  useEffect(() => {
    if (!data) return;
    const when = data.session.started_at
      ? new Date(data.session.started_at * 1000).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : `#${sessionId}`;
    props.onFocus({ type: "session", id: sessionId, label: when });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.session.id]);

  if (!data) return <p className="empty">Loading…</p>;
  const label = contextLabel(data.session, todos, projects);

  // Events hang off the user message that triggered the turn; show them under
  // the assistant reply that follows it, like the live overlay does.
  const feedByUserMsg = new Map<number, EventRecord[]>();
  for (const e of data.events ?? []) {
    if (e.message_id == null) continue;
    (feedByUserMsg.get(e.message_id) ?? feedByUserMsg.set(e.message_id, []).get(e.message_id)!).push(e);
  }
  let lastUserMsgId: number | null = null;

  const toggleThoughts = (id: number) =>
    setOpenThoughts((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="tasks session-page">
      <div className="page-head">
        <div className="page-nav">
          <Link className="back" to="/sessions">
            ‹ Chats
          </Link>
          <div className="page-meta">
            <button
              className="link trash"
              title="Delete chat"
              onClick={async () => {
                if (
                  !window.confirm(
                    "Delete this chat? Journal logs stay, but the audio and transcript are gone for good.",
                  )
                ) {
                  return;
                }
                await del(`/sessions/${sessionId}`).catch(() => {});
                navigate("/sessions");
              }}
            >
              <FontAwesomeIcon icon={faTrashCan} />
            </button>
          </div>
        </div>
        {label && (
          <p className="page-title context-title">
            <span className="attachment">{label}</span>
          </p>
        )}
      </div>

      <div className="chat replay">
        {data.messages
          .filter((m) => m.text)
          .map((m) => {
            if (m.role === "user") lastUserMsgId = m.id;
            const feed = m.role === "assistant" && lastUserMsgId != null
              ? feedByUserMsg.get(lastUserMsgId)
              : undefined;
            return (
              <div key={m.id} className={`bubble ${m.role}`}>
                {m.role === "assistant" && m.thinking && (
                  <>
                    <button className="link thinking-toggle" onClick={() => toggleThoughts(m.id)}>
                      {openThoughts.has(m.id) ? "hide thoughts" : "thoughts"}
                    </button>
                    {openThoughts.has(m.id) && <p className="thinking expanded">{m.thinking}</p>}
                  </>
                )}
                <p>{m.text}</p>
                {feed && feed.length > 0 && (
                  <EventFeed events={feed} todos={todos} projects={projects} />
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}
