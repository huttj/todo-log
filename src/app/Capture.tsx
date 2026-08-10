// Capture dock (non-blocking). Recording is one icon; Send is fire-and-forget:
// it immediately ends the recording, dumps the utterance out of the composer
// into the chat as a queued item, and processes in the background — the user
// can start the next recording right away. Pure voice sends let the server
// assemble the transcript (correct segment order); edited/typed drafts wait
// for outstanding transcripts and send the final text. Nothing is lost:
// segments upload as they close and the draft persists until sent.
import { useEffect, useRef, useState, useCallback } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faMicrophone, faStop, faPaperPlane } from "@fortawesome/free-solid-svg-icons";
import "@fortawesome/fontawesome-svg-core/styles.css";
import { post, api, uploadSegment, type CaptureSession, type Segment, type FeedItem } from "./api";
import { renderEntityRefs } from "./refs";
import TranscriptPlayer from "./components/TranscriptPlayer";

// Short segments transcribe reliably (Workers AI Whisper degrades on long
// clips) and give near-live transcript feedback.
const MAX_SEGMENT_MS = 25_000;
const DRAFT_KEY = "todolog.draft";

export interface CaptureContext {
  type: "project" | "todo" | "action" | "log" | "session" | "today";
  id: number;
  label: string;
}

interface ChatEntry {
  id: number;
  role: "user" | "assistant";
  text: string;
  thinking?: string;
  feed?: FeedItem[];
  live?: boolean;
  /** Assistant entry whose turn hasn't reached the agent yet (voice note
   * still assembling) — rendered as nothing, no dots. */
  pending?: boolean;
  /** User voice note whose transcript hasn't landed yet. */
  transcribing?: boolean;
  showThinking?: boolean;
  /** Long change feeds collapse behind "+N more changes". */
  showFeed?: boolean;
  questions?: { question: string; suggestions?: string[] }[];
  questionsAnswered?: boolean;
  /** Voice message's server id — enables the transcript player. */
  msgId?: number;
  hasAudio?: boolean;
  showPlayer?: boolean;
}

interface QueuedSend {
  msgId: number | null;
  /** Typed or hand-edited — send the text verbatim (after folding in any
   * still-pending transcripts). Pure voice sends go text-less and let the
   * server assemble segments in order. */
  dirty: boolean;
  text: string;
  hadSegments: boolean;
  appended: Set<number>;
  userEntryId: number;
  assistantEntryId: number;
}

let entrySeq = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function Capture(props: {
  context: CaptureContext | null;
  mode?: "plan";
  replyTo?: { id: number; title: string; body?: string | null };
  seed?: string;
  autoStart: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [ctx, setCtx] = useState<CaptureContext | null>(props.context);
  const [sessionStarted, setSessionStarted] = useState(false);
  const [recording, setRecording] = useState(false);
  /** Dock height in px while user-resized; null = default (content-sized). */
  const [dockHeight, setDockHeight] = useState<number | null>(null);
  const [messageId, setMessageId] = useState<number | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [transcribing, setTranscribing] = useState(false);
  // Seeded openings (loose thread, notification reply) show as an agent bubble.
  const [chat, setChat] = useState<ChatEntry[]>(() => {
    const opener =
      props.seed ??
      (props.replyTo
        ? props.replyTo.body
          ? `${props.replyTo.title}\n${props.replyTo.body}`
          : props.replyTo.title
        : null);
    return opener ? [{ id: ++entrySeq, role: "assistant", text: opener }] : [];
  });
  const [draft, setDraft] = useState(() => localStorage.getItem(DRAFT_KEY) ?? "");
  const [error, setError] = useState<string | null>(null);

  const sessionRef = useRef<CaptureSession | null>(null);
  const ctxRef = useRef<CaptureContext | null>(props.context);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const cancelledRef = useRef(false);
  const seqRef = useRef(0);
  const messageIdRef = useRef<number | null>(null);
  const appendedSegs = useRef(new Set<number>());
  const rollTimerRef = useRef<number | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  // Refs mirror the upload/closing counters so the background queue can wait
  // on them without re-rendering.
  const uploadsRef = useRef(0);
  const closingRef = useRef(0);
  // A restored draft is user-owned text.
  const dirtyRef = useRef((localStorage.getItem(DRAFT_KEY) ?? "").trim().length > 0);
  const queueRef = useRef<QueuedSend[]>([]);
  const processingRef = useRef(false);

  const bumpUploads = (d: number) => {
    uploadsRef.current += d;
  };
  const bumpClosing = (d: number) => {
    closingRef.current = Math.max(0, closingRef.current + d);
  };

  // Draft survives closes/reloads until it's actually sent.
  useEffect(() => {
    if (draft) localStorage.setItem(DRAFT_KEY, draft);
    else localStorage.removeItem(DRAFT_KEY);
  }, [draft]);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Scrolling over the dock must never scroll the page behind it. When the
  // chat has scrollable overflow its own scrolling + overscroll-behavior
  // handle it; otherwise swallow the wheel (except over the textarea and
  // expanded-thinking, which scroll themselves).
  useEffect(() => {
    const el = dockRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest("textarea, .thinking")) return;
      const chat = el.querySelector(".chat");
      if (!chat || chat.scrollHeight <= chat.clientHeight) e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat]);

  // Auto-grow the draft box with its content.
  useEffect(() => {
    const el = draftRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, window.innerHeight * 0.3)}px`;
  }, [draft]);

  // Poll segment transcripts for the current (unsent) message; append each new
  // one into the editable draft.
  useEffect(() => {
    if (!messageId) return;
    const timer = window.setInterval(() => {
      api<{ segments: Segment[] }>(`/messages/${messageId}`)
        .then((r) => {
          if (messageIdRef.current !== messageId) return;
          setSegments(r.segments);
          let stillPending = false;
          for (const seg of r.segments) {
            if (!seg.transcript) {
              stillPending = true;
              continue;
            }
            if (!appendedSegs.current.has(seg.id)) {
              appendedSegs.current.add(seg.id);
              setDraft((d) => (d.trim() ? `${d.trimEnd()} ${seg.transcript}` : seg.transcript!));
            }
          }
          setTranscribing(stillPending);
        })
        .catch(() => {});
    }, 1200);
    return () => window.clearInterval(timer);
  }, [messageId]);

  const ensureSession = useCallback(async (): Promise<CaptureSession> => {
    if (sessionRef.current) return sessionRef.current;
    const s = await post<CaptureSession>("/sessions", {
      context_type: ctxRef.current?.type,
      context_id: ctxRef.current?.id,
      mode: props.mode,
      notification_id: props.replyTo?.id,
      seed_text: props.seed,
    });
    sessionRef.current = s;
    setSessionStarted(true);
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ensureMessage = useCallback(async (): Promise<number> => {
    if (messageIdRef.current) return messageIdRef.current;
    const session = await ensureSession();
    const m = await post<{ id: number }>(`/sessions/${session.id}/messages`);
    messageIdRef.current = m.id;
    seqRef.current = 0;
    appendedSegs.current.clear();
    setMessageId(m.id);
    return m.id;
  }, [ensureSession]);

  const ensureStream = useCallback(async (): Promise<MediaStream> => {
    if (streamRef.current) return streamRef.current;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;
    return stream;
  }, []);

  const mimeType = () =>
    typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/mp4")
        ? "audio/mp4"
        : "";

  const startSegment = useCallback(async () => {
    setError(null);
    cancelledRef.current = false;
    const [stream, msgId] = await Promise.all([ensureStream(), ensureMessage()]);
    const mt = mimeType();
    const recorder = new MediaRecorder(stream, mt ? { mimeType: mt } : undefined);
    const chunks: Blob[] = [];
    const seq = seqRef.current++;
    const startedAt = Date.now();
    let rolled = false;
    const roll = () => {
      // Close this segment and open the next without a gap. Driven primarily
      // by ondataavailable because setTimeout is throttled in background tabs.
      if (rolled || recorder.state !== "recording") return;
      rolled = true;
      const isCurrent = recorderRef.current === recorder;
      bumpClosing(1);
      recorder.stop();
      if (isCurrent) void startSegment();
    };
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
      if (Date.now() - startedAt >= MAX_SEGMENT_MS) roll();
    };
    recorder.onstop = () => {
      try {
        if (cancelledRef.current) return;
        const duration = (Date.now() - startedAt) / 1000;
        if (duration < 0.4 || chunks.length === 0) return;
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        bumpUploads(1);
        // Only flag the composer as transcribing if this segment's transcript
        // will actually land there — after Send the message belongs to the
        // chat (the queue folds late transcripts in server-side).
        if (messageIdRef.current === msgId) setTranscribing(true);
        uploadSegment(msgId, seq, duration, blob)
          .catch((e) => setError(String(e.message ?? e)))
          .finally(() => bumpUploads(-1));
      } finally {
        bumpClosing(-1);
      }
    };
    // 1s timeslice: chunk delivery doubles as our throttling-proof clock.
    recorder.start(1000);
    recorderRef.current = recorder;
    rollTimerRef.current = window.setTimeout(roll, MAX_SEGMENT_MS + 2000);
  }, [ensureStream, ensureMessage]);

  const stopSegment = useCallback((cancelled = false) => {
    if (rollTimerRef.current) window.clearTimeout(rollTimerRef.current);
    cancelledRef.current = cancelled;
    const r = recorderRef.current;
    recorderRef.current = null;
    if (r && r.state === "recording") {
      bumpClosing(1);
      r.stop();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startRecording = useCallback(() => {
    setRecording(true);
    startSegment().catch((err) => {
      setError(String(err.message ?? err));
      setRecording(false);
    });
  }, [startSegment]);

  const stopRecording = useCallback(() => {
    stopSegment();
    setRecording(false);
  }, [stopSegment]);

  const autoStarted = useRef(false);
  useEffect(() => {
    if (props.autoStart && !autoStarted.current) {
      autoStarted.current = true;
      startRecording();
    }
  }, [props.autoStart, startRecording]);

  // Composer indicator: only transcription that will land in the box. The
  // global upload/closing counters gate the send queue but cover already-sent
  // messages too, so they must not drive it.
  const busy = transcribing;
  const hasContent = draft.trim().length > 0 || seqRef.current > 0;

  const updateEntry = (id: number, fn: (e: ChatEntry) => ChatEntry) =>
    setChat((c) => c.map((e) => (e.id === id ? fn(e) : e)));

  // -- Fire-and-forget send queue -------------------------------------------

  function requestSend() {
    if (!hasContent) return;
    if (recording) stopRecording();
    const item: QueuedSend = {
      msgId: messageIdRef.current,
      hadSegments: seqRef.current > 0,
      dirty: dirtyRef.current || seqRef.current === 0,
      text: draft.trim(),
      appended: new Set(appendedSegs.current),
      userEntryId: ++entrySeq,
      assistantEntryId: ++entrySeq,
    };
    // Composer empties immediately — the utterance now lives in the chat.
    messageIdRef.current = null;
    setMessageId(null);
    setSegments([]);
    appendedSegs.current.clear();
    seqRef.current = 0;
    setDraft("");
    dirtyRef.current = false;
    setTranscribing(false);
    setError(null);
    setChat((c) => [
      ...c,
      { id: item.userEntryId, role: "user", text: item.text, transcribing: item.hadSegments },
      {
        id: item.assistantEntryId,
        role: "assistant",
        text: "",
        thinking: "",
        feed: [],
        live: true,
        pending: true,
      },
    ]);
    queueRef.current.push(item);
    void processQueue();
  }

  /** Send a canned answer (question chip) as its own message. */
  function sendText(text: string, fromEntryId: number) {
    updateEntry(fromEntryId, (e) => ({ ...e, questionsAnswered: true }));
    const item: QueuedSend = {
      msgId: null,
      hadSegments: false,
      dirty: true,
      text,
      appended: new Set(),
      userEntryId: ++entrySeq,
      assistantEntryId: ++entrySeq,
    };
    setChat((c) => [
      ...c,
      { id: item.userEntryId, role: "user", text },
      { id: item.assistantEntryId, role: "assistant", text: "", thinking: "", feed: [], live: true, pending: true },
    ]);
    queueRef.current.push(item);
    void processQueue();
  }

  async function processQueue() {
    if (processingRef.current) return;
    processingRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        const item = queueRef.current.shift()!;
        await processItem(item);
      }
    } finally {
      processingRef.current = false;
    }
  }

  async function processItem(item: QueuedSend) {
    try {
      let msgId = item.msgId;
      if (!msgId) {
        const session = await ensureSession();
        msgId = (await post<{ id: number }>(`/sessions/${session.id}/messages`)).id;
      }
      updateEntry(item.userEntryId, (e) => ({ ...e, msgId: msgId!, hasAudio: item.hadSegments }));
      // Wait for in-flight segment handoffs and uploads to land.
      while (uploadsRef.current > 0 || closingRef.current > 0) await sleep(200);
      // Edited drafts: fold any still-pending transcripts into the text so
      // nothing said is lost, then send the final text verbatim.
      if (item.dirty && item.hadSegments) {
        for (let tries = 0; tries < 120; tries++) {
          const r = await api<{ segments: Segment[] }>(`/messages/${msgId}`);
          const missing = r.segments.filter((s) => !item.appended.has(s.id));
          if (missing.every((s) => s.transcript)) {
            for (const s of missing.sort((a, b) => a.seq - b.seq)) {
              if (s.transcript) item.text = item.text ? `${item.text} ${s.transcript}` : s.transcript;
            }
            break;
          }
          await sleep(500);
        }
        updateEntry(item.userEntryId, (e) => ({ ...e, text: item.text, transcribing: false }));
      }

      const res = await fetch(`/api/messages/${msgId}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(item.dirty && item.text ? { text: item.text } : {}),
      });
      if (!res.ok || !res.body) {
        let message = res.statusText;
        try {
          message = ((await res.json()) as { error?: string }).error ?? message;
        } catch {
          /* not json */
        }
        throw new Error(message);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const evt = JSON.parse(line.slice(6)) as
            | { type: "text"; text: string }
            | { type: "iteration" }
            | { type: "thinking"; text: string }
            | { type: "delta"; text: string }
            | { type: "feed"; item: FeedItem }
            | { type: "questions"; questions: { question: string; suggestions?: string[] }[] }
            | { type: "done"; reply: string; feed: FeedItem[] }
            | { type: "error"; error: string };
          switch (evt.type) {
            case "text":
              // Transcript is final and in front of the model — now the
              // agent's dots may show.
              updateEntry(item.userEntryId, (e) => ({ ...e, text: evt.text, transcribing: false }));
              updateEntry(item.assistantEntryId, (e) => ({ ...e, pending: false }));
              break;
            case "iteration":
              // Reset visible reply text per iteration; thinking accumulates
              // across the whole turn so it can be toggled afterwards.
              updateEntry(item.assistantEntryId, (e) => ({ ...e, text: "" }));
              break;
            case "thinking":
              updateEntry(item.assistantEntryId, (e) => ({
                ...e,
                thinking: (e.thinking ?? "") + evt.text,
              }));
              break;
            case "delta":
              updateEntry(item.assistantEntryId, (e) => ({ ...e, text: e.text + evt.text }));
              break;
            case "feed":
              updateEntry(item.assistantEntryId, (e) => ({
                ...e,
                feed: [...(e.feed ?? []), evt.item],
              }));
              break;
            case "questions":
              updateEntry(item.assistantEntryId, (e) => ({
                ...e,
                questions: [...(e.questions ?? []), ...evt.questions],
              }));
              break;
            case "done":
              updateEntry(item.assistantEntryId, (e) => ({
                ...e,
                text: evt.reply,
                feed: evt.feed,
                live: false,
              }));
              props.onChanged();
              break;
            case "error":
              throw new Error(evt.error);
          }
        }
      }
    } catch (e) {
      setError(String((e as Error).message ?? e));
      updateEntry(item.userEntryId, (entry) => ({ ...entry, transcribing: false }));
      // Restore the utterance into the composer (if it's free) so the segment
      // pills — and their retry buttons — come back.
      const composerFree = messageIdRef.current === null && recorderRef.current === null;
      if (item.msgId && composerFree) {
        messageIdRef.current = item.msgId;
        setMessageId(item.msgId);
        appendedSegs.current = new Set(item.appended);
        seqRef.current = item.hadSegments ? 1 : 0;
        dirtyRef.current = item.dirty;
        setDraft(item.text);
        if (item.hadSegments) setTranscribing(true);
        updateEntry(item.assistantEntryId, (entry) => ({
          ...entry,
          live: false,
          pending: false,
          text: entry.text || "(send failed — restored to the composer below; retry the stuck segment or send again)",
        }));
      } else {
        updateEntry(item.assistantEntryId, (entry) => ({
          ...entry,
          live: false,
          pending: false,
          text: entry.text || "(send failed — the audio is saved server-side)",
        }));
      }
    }
  }

  async function undo(eventId: number) {
    try {
      await post(`/events/${eventId}/undo`);
      setChat((c) =>
        c.map((entry) => ({
          ...entry,
          feed: entry.feed?.map((f) => (f.event_id === eventId ? { ...f, kind: "undone" } : f)),
        })),
      );
      props.onChanged();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }

  /** Briefing updates aren't audit events — undo swaps the stored briefing. */
  async function undoBriefingItem(entryId: number, feedIndex: number) {
    try {
      await post("/briefing/undo");
      updateEntry(entryId, (e) => ({
        ...e,
        feed: e.feed?.map((f, i) => (i === feedIndex ? { ...f, kind: "undone" } : f)),
      }));
      props.onChanged();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }

  // Pill playback: one shared player; disabled while recording.
  const [playingSeg, setPlayingSeg] = useState<number | null>(null);
  const playerRef = useRef<HTMLAudioElement | null>(null);

  function togglePlay(segId: number) {
    if (recording) return;
    playerRef.current?.pause();
    if (playingSeg === segId) {
      setPlayingSeg(null);
      return;
    }
    const player = new Audio(`/api/audio/${segId}`);
    playerRef.current = player;
    player.onended = () => setPlayingSeg((cur) => (cur === segId ? null : cur));
    setPlayingSeg(segId);
    void player.play().catch(() => setPlayingSeg(null));
  }

  useEffect(() => {
    if (recording) {
      playerRef.current?.pause();
      setPlayingSeg(null);
    }
  }, [recording]);

  async function retryTranscribe(segmentId: number) {
    setError(null);
    setTranscribing(true);
    try {
      await post(`/segments/${segmentId}/transcribe`);
      // The poll picks up the fresh transcript and appends it to the draft.
    } catch (e) {
      setError(String((e as Error).message ?? e));
      setTranscribing(false);
    }
  }

  async function done() {
    // Close the dock without losing anything: segments are server-side and the
    // draft stays in localStorage.
    stopSegment();
    setRecording(false);
    if (sessionRef.current) await post(`/sessions/${sessionRef.current.id}/done`).catch(() => {});
    props.onClose();
  }

  function clearContext() {
    if (sessionStarted) return;
    ctxRef.current = null;
    setCtx(null);
  }

  // Handle: drag resizes the dock live, a fling snaps to full/default, and a
  // plain tap toggles between the two.
  const dockRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    grabOffset: number;
    bottom: number;
    startY: number;
    prevY: number;
    prevT: number;
    lastY: number;
    lastT: number;
    moved: boolean;
  } | null>(null);
  const MIN_DOCK = 190;
  const maxDock = () => window.innerHeight - 8;

  const handleDown = (e: React.PointerEvent) => {
    const rect = dockRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = {
      grabOffset: e.clientY - rect.top,
      bottom: rect.bottom,
      startY: e.clientY,
      prevY: e.clientY,
      prevT: e.timeStamp,
      lastY: e.clientY,
      lastT: e.timeStamp,
      moved: false,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const handleMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (Math.abs(e.clientY - d.startY) > 6) d.moved = true;
    if (d.moved) {
      setDockHeight(Math.min(maxDock(), Math.max(MIN_DOCK, d.bottom - e.clientY + d.grabOffset)));
    }
    d.prevY = d.lastY;
    d.prevT = d.lastT;
    d.lastY = e.clientY;
    d.lastT = e.timeStamp;
  };
  const handleUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (!d.moved) {
      // Tap: toggle default ↔ full.
      setDockHeight((h) => (h == null ? maxDock() : null));
      return;
    }
    // Fling: snap in the flick's direction; otherwise stay where dropped.
    const v = (d.lastY - d.prevY) / Math.max(1, d.lastT - d.prevT);
    if (v < -0.4) setDockHeight(maxDock());
    else if (v > 0.4) setDockHeight(null);
  };

  return (
    <div
      ref={dockRef}
      className={`capture-dock ${dockHeight != null ? "resized" : ""}`}
      style={dockHeight != null ? { height: dockHeight, maxHeight: "none" } : undefined}
    >
      <div
        className="dock-handle"
        title="Drag to resize · tap to toggle full screen"
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        onPointerCancel={() => (dragRef.current = null)}
      />
      <header>
        <span className="context-chip">
          {props.replyTo ? (
            <>
              re: <strong>{props.replyTo.title.slice(0, 48)}</strong>
            </>
          ) : props.mode === "plan" || ctx?.type === "today" ? (
            <strong>Planning the day</strong>
          ) : ctx ? (
            <>
              {ctx.type === "session" ? "chat" : ctx.type}: <strong>{ctx.label}</strong>
            </>
          ) : (
            "General"
          )}
          {ctx && !sessionStarted && (
            <button className="chip-clear" onClick={clearContext} title="Talk about something else">
              ×
            </button>
          )}
        </span>
        <button className="done-btn" onClick={done}>
          Close
        </button>
      </header>

      {chat.length > 0 && (
        <div className="chat">
          {chat.map((entry) => {
            if (entry.role === "assistant" && entry.pending) return null;
            return (
              <div key={entry.id} className={`bubble ${entry.role}`}>
                {entry.live && entry.thinking && <p className="thinking">{entry.thinking}</p>}
                {entry.role === "assistant" && !entry.live && entry.thinking && (
                  <>
                    <button
                      className="link thinking-toggle"
                      onClick={() =>
                        updateEntry(entry.id, (e) => ({ ...e, showThinking: !e.showThinking }))
                      }
                    >
                      {entry.showThinking ? "hide thoughts" : "thoughts"}
                    </button>
                    {entry.showThinking && <p className="thinking expanded">{entry.thinking}</p>}
                  </>
                )}
                {entry.text ? (
                  <p>{entry.role === "assistant" ? renderEntityRefs(entry.text) : entry.text}</p>
                ) : entry.live ? (
                  <TypingDots />
                ) : null}
                {entry.role === "assistant" && entry.questions && entry.questions.length > 0 && (
                  <div className="q-block">
                    {entry.questions.map((q, qi) => (
                      <div key={qi} className="q-item">
                        <p className="q-text">{q.question}</p>
                        {q.suggestions && q.suggestions.length > 0 && (
                          <div className="q-chips">
                            {q.suggestions.map((sug, sj) => (
                              <button
                                key={sj}
                                className="q-chip"
                                disabled={entry.questionsAnswered}
                                onClick={() => sendText(sug, entry.id)}
                              >
                                {sug}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {entry.role === "user" && entry.transcribing && (
                  <span className="transcribing-note">
                    <TypingDots /> transcribing
                  </span>
                )}
                {entry.role === "user" && entry.hasAudio && entry.msgId && !entry.transcribing && (
                  <>
                    <button
                      className="msg-play"
                      title="Play the recording"
                      onClick={() =>
                        updateEntry(entry.id, (e) => ({ ...e, showPlayer: !e.showPlayer }))
                      }
                    >
                      {entry.showPlayer ? "⏹" : "▶"}
                    </button>
                    {entry.showPlayer && <TranscriptPlayer messageId={entry.msgId} autoPlay />}
                  </>
                )}
                {entry.feed && entry.feed.length > 0 && (
                  <ul className="feed">
                    {(entry.feed.length > 5 && !entry.showFeed
                      ? entry.feed.slice(0, 4)
                      : entry.feed
                    ).map((f, fi) => (
                      <li key={`${f.event_id}-${fi}`} className={f.kind === "undone" ? "undone" : ""}>
                        <span>{f.label}</span>
                        {f.kind !== "undone" &&
                          !entry.live &&
                          (f.event_id !== 0 || f.kind === "briefing_updated") && (
                            <button
                              onClick={() =>
                                f.kind === "briefing_updated"
                                  ? undoBriefingItem(entry.id, fi)
                                  : undo(f.event_id)
                              }
                            >
                              undo
                            </button>
                          )}
                      </li>
                    ))}
                    {entry.feed.length > 5 && (
                      <li className="feed-toggle">
                        <button
                          className="link"
                          onClick={() =>
                            updateEntry(entry.id, (e) => ({ ...e, showFeed: !e.showFeed }))
                          }
                        >
                          {entry.showFeed
                            ? "show fewer"
                            : `+${entry.feed.length - 4} more changes`}
                        </button>
                      </li>
                    )}
                  </ul>
                )}
              </div>
            );
          })}
          <div ref={chatEndRef} />
        </div>
      )}

      {error && <p className="error">{error}</p>}

      {segments.some((s) => !s.transcript) && (
        <div className="seg-pills">
          {segments
            .filter((s) => !s.transcript)
            .map((s) => (
              <span key={s.id} className={`pill ${recording ? "disabled" : ""}`}>
                <button onClick={() => togglePlay(s.id)} disabled={recording} title="Play">
                  {playingSeg === s.id ? "⏸" : "▶"}
                  {s.duration_sec ? ` ${Math.round(s.duration_sec)}s` : ""}
                </button>
                <button
                  className="retry"
                  onClick={() => retryTranscribe(s.id)}
                  disabled={recording}
                  title="Retry transcription"
                >
                  ↻
                </button>
              </span>
            ))}
        </div>
      )}

      <div className="composer">
        <div className="draft-area">
          <textarea
            ref={draftRef}
            placeholder={recording ? "Listening — transcript lands here…" : "Talk or type…"}
            value={draft}
            rows={2}
            onChange={(e) => {
              dirtyRef.current = true;
              setDraft(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                requestSend();
              }
            }}
            disabled={recording}
          />
          {busy && <span className="transcribing">transcribing…</span>}
        </div>
        <button
          className={`icon-btn mic-btn ${recording ? "recording" : ""}`}
          onClick={recording ? stopRecording : startRecording}
          title={recording ? "Stop recording (doesn't send)" : "Record"}
        >
          <FontAwesomeIcon icon={recording ? faStop : faMicrophone} />
        </button>
        <button
          className="icon-btn send-btn"
          onClick={requestSend}
          disabled={!hasContent}
          title="Send"
        >
          <FontAwesomeIcon icon={faPaperPlane} />
        </button>
      </div>
    </div>
  );
}

function TypingDots() {
  return (
    <span className="typing-dots">
      <span />
      <span />
      <span />
    </span>
  );
}
