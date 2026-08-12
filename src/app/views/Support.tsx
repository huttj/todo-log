// Human support chat — no AI. Users get their one thread; admins get every
// thread. Voice notes transcribe server-side and keep their audio playable.
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faMicrophone,
  faStop,
  faPaperPlane,
  faChevronLeft,
  faPlay,
} from "@fortawesome/free-solid-svg-icons";
import { api, post, type Me } from "../api";
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

  if (props.me?.is_admin && !threadParam) return <ThreadList />;
  const threadUserId = props.me?.is_admin ? Number(threadParam) : undefined;
  return <SupportThread me={props.me ?? null} threadUserId={threadUserId} />;
}

function ThreadList() {
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
    <div className="tasks support-page">
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
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"send" | "voice" | null>(null);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
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
    return () => window.clearInterval(t);
  }, [load]);

  async function sendText() {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy("send");
    setError(null);
    try {
      await post(`${base}/messages`, { text });
      setDraft("");
      load();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(null);
    }
  }

  async function startVoice() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mt = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/mp4")
          ? "audio/mp4"
          : "";
      const rec = new MediaRecorder(stream, mt ? { mimeType: mt } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        if (blob.size < 1000) return;
        setBusy("voice");
        try {
          const res = await fetch(`/api${base}/voice`, {
            method: "POST",
            headers: { "content-type": blob.type },
            body: blob,
          });
          if (!res.ok) {
            const err = (await res.json().catch(() => ({}))) as { error?: string };
            throw new Error(err.error ?? "voice message failed");
          }
          load();
        } catch (e) {
          setError(String((e as Error).message ?? e));
        } finally {
          setBusy(null);
        }
      };
      // Support notes cap at 2 minutes — keeps Whisper accurate.
      const stopTimer = window.setTimeout(() => rec.state === "recording" && rec.stop(), 120_000);
      rec.onerror = () => window.clearTimeout(stopTimer);
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }

  const mine = (m: SupportMessage) => m.sender_id === props.me?.id;

  return (
    <div className="tasks support-page">
      {threadUserId != null && (
        <div className="page-nav">
          <Link className="back" to="/support">
            <FontAwesomeIcon icon={faChevronLeft} /> Support chats
          </Link>
        </div>
      )}
      {threadUserId == null && <h2>Support</h2>}
      {threadUserId == null && messages.length === 0 && (
        <p className="empty">
          Something broken, confusing, or missing? Talk or type — a human reads this and will get
          back to you (you'll get a notification).
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
              <audio className="support-audio" controls preload="none" src={`/api/support/audio/${m.id}`}>
                <FontAwesomeIcon icon={faPlay} />
              </audio>
            )}
            <span className="support-when">{when(m.created_at)}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {busy === "voice" && <p className="empty">Transcribing your voice note…</p>}
      {error && <p className="error">{error}</p>}

      <div className="composer support-composer">
        <textarea
          placeholder={recording ? "Recording — tap stop to send…" : "Talk or type…"}
          value={draft}
          rows={2}
          disabled={recording}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void sendText();
            }
          }}
        />
        <button
          className={`icon-btn mic-btn ${recording ? "recording" : ""}`}
          title={recording ? "Stop and send" : "Record a voice note"}
          onClick={() => (recording ? recorderRef.current?.stop() : void startVoice())}
        >
          <FontAwesomeIcon icon={recording ? faStop : faMicrophone} />
        </button>
        <button
          className="icon-btn send-btn"
          disabled={!draft.trim() || busy != null}
          title="Send"
          onClick={() => void sendText()}
        >
          <FontAwesomeIcon icon={faPaperPlane} />
        </button>
      </div>
    </div>
  );
}
