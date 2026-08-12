// Human support chat — no AI. Users get their one thread; admins get every
// thread. Voice notes transcribe server-side and keep their audio playable.
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faChevronLeft } from "@fortawesome/free-solid-svg-icons";
import { api, type Me } from "../api";
import { SUPPORT_SENT_EVENT } from "../SupportDock";
import type { CaptureContext } from "../Capture";

interface SupportMessage {
  id: number;
  user_id: number;
  sender_id: number;
  text: string;
  r2_key: string | null;
  created_at: number;
}

interface Thread {
  user_id: number;
  email: string;
  name: string | null;
  last_text: string;
  last_sender_id: number;
  last_at: number;
}

const POLL_MS = 8000;

function when(ts: number): string {
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function Support(props: {
  refreshKey: number;
  onFocus: (ctx: CaptureContext | null) => void;
  me?: Me | null;
}) {
  const [params] = useSearchParams();
  const threadParam = params.get("u");

  useEffect(() => {
    props.onFocus(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Everyone — admins included — gets their own thread here; the admin inbox
  // lives on the Settings Support tab. ?u= still deep-links a user's thread.
  const threadUserId = props.me?.is_admin && threadParam ? Number(threadParam) : undefined;
  return <SupportThread me={props.me ?? null} threadUserId={threadUserId} />;
}

export function SupportThreadList() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const load = () => {
    api<{ threads: Thread[] }>("/support/threads").then((r) => setThreads(r.threads)).catch(() => {});
  };
  useEffect(() => {
    load();
    const t = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(t);
  }, []);

  return (
    <div className="support-inbox">
      <h2>Support chats</h2>
      {threads.length === 0 && <p className="empty">No support messages yet.</p>}
      {threads.map((t) => (
        <Link key={t.user_id} className="support-thread-row" to={`/support?u=${t.user_id}`}>
          <div className="user-id">
            <strong>{t.name ?? t.email}</strong>
            {t.name && <span className="user-mail">{t.email}</span>}
          </div>
          <span className="user-since">{when(t.last_at)}</span>
          <p className="snippet">
            {t.last_sender_id === t.user_id ? "" : "you: "}
            {t.last_text.slice(0, 120)}
          </p>
        </Link>
      ))}
    </div>
  );
}

function SupportThread(props: { me: Me | null; threadUserId?: number }) {
  const { threadUserId } = props;
  const base = threadUserId != null ? `/support/threads/${threadUserId}` : "/support";
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const endRef = useRef<HTMLDivElement | null>(null);
  const lastIdRef = useRef(0);

  const load = useCallback(() => {
    api<{ messages: SupportMessage[] }>(`${base}/messages`)
      .then((r) => {
        setMessages(r.messages);
        const last = r.messages[r.messages.length - 1];
        if (last && last.id !== lastIdRef.current) {
          lastIdRef.current = last.id;
          window.setTimeout(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
        }
      })
      .catch(() => {});
  }, [base]);

  useEffect(() => {
    load();
    const t = window.setInterval(load, POLL_MS);
    window.addEventListener(SUPPORT_SENT_EVENT, load);
    return () => {
      window.clearInterval(t);
      window.removeEventListener(SUPPORT_SENT_EVENT, load);
    };
  }, [load]);

  const mine = (m: SupportMessage) => m.sender_id === props.me?.id;

  return (
    <div className="tasks support-page">
      {threadUserId != null && (
        <div className="page-nav">
          <Link className="back" to="/settings?tab=support">
            <FontAwesomeIcon icon={faChevronLeft} /> Support chats
          </Link>
        </div>
      )}
      {threadUserId == null && <h2>Support</h2>}
      {threadUserId == null && messages.length === 0 && (
        <p className="empty">
          Something broken, confusing, or missing? Hit Talk below — a human reads this and will
          get back to you (you'll get a notification).
        </p>
      )}

      <div className="support-chat">
        {messages.map((m) => (
          <div key={m.id} className={`bubble ${mine(m) ? "user" : "assistant"} support-bubble`}>
            {!mine(m) && m.sender_id !== m.user_id && (
              <span className="support-who">Todo Log support</span>
            )}
            <p>{m.text}</p>
            {m.r2_key && (
              <audio className="support-audio" controls preload="none" src={`/api/support/audio/${m.id}`} />
            )}
            <span className="support-when">{when(m.created_at)}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}
