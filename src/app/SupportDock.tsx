// The Talk dock, support flavor: same bottom composer feel, but messages go
// to the human support thread — no AI. Voice notes transcribe and send on
// stop; typing always works.
import { useEffect, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faMicrophone, faStop, faPaperPlane } from "@fortawesome/free-solid-svg-icons";
import { post } from "./api";

export const SUPPORT_SENT_EVENT = "todolog:support-sent";

export default function SupportDock(props: {
  /** Admin: target thread; unset = the signed-in user's own thread. */
  threadUserId?: number;
  autoStart: boolean;
  onClose: () => void;
}) {
  const base = props.threadUserId != null ? `/support/threads/${props.threadUserId}` : "/support";
  const [draft, setDraft] = useState("");
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState<"send" | "voice" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (props.autoStart) void startVoice();
    else draftRef.current?.focus();
    return () => {
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sent = () => window.dispatchEvent(new CustomEvent(SUPPORT_SENT_EVENT));

  async function sendText() {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy("send");
    setError(null);
    try {
      await post(`${base}/messages`, { text });
      setDraft("");
      sent();
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
          sent();
        } catch (e) {
          setError(String((e as Error).message ?? e));
        } finally {
          setBusy(null);
        }
      };
      // 2-minute cap keeps Whisper accurate.
      window.setTimeout(() => rec.state === "recording" && rec.stop(), 120_000);
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }

  return (
    <div className="capture-dock support-dock">
      <header>
        <span className="context-chip">
          <strong>{props.threadUserId != null ? "Support reply" : "Support"}</strong>
        </span>
        <button className="done-btn" onClick={props.onClose}>
          Close
        </button>
      </header>
      {busy === "voice" && <p className="empty">Transcribing and sending…</p>}
      {error && <p className="error">{error}</p>}
      <div className="composer">
        <div className="draft-area">
          <textarea
            ref={draftRef}
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
        </div>
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
