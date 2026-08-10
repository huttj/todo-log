// The full journal entry card — summary, kind badge, attachment chip, full
// utterance transcript, and quotes with audio sliced to the quoted moment.
// Shared by the Logs page, project pages, and todo pages.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowsRotate } from "@fortawesome/free-solid-svg-icons";
import { api, type Log, type Quote, type SegmentDetail, type TranscriptWord } from "../api";
import { requestTalk } from "../talk";
import TranscriptPlayer from "./TranscriptPlayer";
import { getSpeed, setGlobalSpeed, nextSpeed } from "../audio";
import { fmtCost } from "../fmt";

export interface LogAttachment {
  label: string;
  to: string;
}

export default function LogCard(props: {
  log: Log;
  attachment?: LogAttachment | null;
  onClick?: () => void;
}) {
  const { log } = props;
  const [showQuotes, setShowQuotes] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const navigate = useNavigate();
  const quotes: Quote[] = useMemo(() => {
    try {
      return log.quotes_json ? (JSON.parse(log.quotes_json) as Quote[]) : [];
    } catch {
      return [];
    }
  }, [log.quotes_json]);

  const time = new Date(log.occurred_at * 1000).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div className={`log-card ${log.kind}`} onClick={props.onClick}>
      <div className="log-head">
        <Link className="time" to={`/logs/${log.id}`} onClick={(e) => e.stopPropagation()}>
          {time}
        </Link>
        {log.kind === "reflection" && <span className="kind">reflection</span>}
        {(log.cost_usd ?? 0) > 0 && (
          <span className="log-cost" title="Cost of the agent turn behind this log">
            {fmtCost(log.cost_usd!)}
          </span>
        )}
        {props.attachment && (
          <Link
            className="attachment"
            to={props.attachment.to}
            onClick={(e) => e.stopPropagation()}
          >
            {props.attachment.label}
          </Link>
        )}
        <button
          className="link reprocess"
          title="Talk about / reprocess this log"
          onClick={(e) => {
            e.stopPropagation();
            requestTalk({ type: "log", id: log.id, label: log.summary.slice(0, 40) });
          }}
        >
          <FontAwesomeIcon icon={faArrowsRotate} />
        </button>
      </div>
      <p
        className="log-summary"
        onClick={(e) => {
          e.stopPropagation();
          navigate(`/logs/${log.id}`);
        }}
      >
        {log.summary}
      </p>
      {showFull && <TranscriptPlayer logId={log.id} emptyNote="No audio for this log (typed input)." />}
      {(quotes.length > 0 || log.message_id) && (
        <div className="log-toggles">
          {quotes.length > 0 ? (
            <button
              className="link"
              onClick={(e) => {
                e.stopPropagation();
                setShowQuotes(!showQuotes);
              }}
            >
              {showQuotes ? "hide quotes" : `${quotes.length} quote${quotes.length > 1 ? "s" : ""}`}
            </button>
          ) : (
            <span />
          )}
          {log.message_id && (
            <button
              className="link"
              onClick={(e) => {
                e.stopPropagation();
                setShowFull(!showFull);
              }}
            >
              {showFull ? "hide full transcript" : "show full transcript"}
            </button>
          )}
        </div>
      )}
      {showQuotes && quotes.map((q, i) => <QuoteBlock key={i} quote={q} />)}
    </div>
  );
}

function QuoteBlock(props: { quote: Quote }) {
  const { quote } = props;
  const [open, setOpen] = useState(false);
  const window =
    quote.start != null && quote.end != null && quote.end > quote.start
      ? { start: quote.start, end: quote.end }
      : undefined;

  return (
    <blockquote onClick={(e) => e.stopPropagation()}>
      “{quote.text}”
      {quote.segment_id && (
        <>
          <button className="link transcript-toggle" onClick={() => setOpen(!open)}>
            {open ? "hide transcript" : "show transcript"}
          </button>
          {open && <InteractiveTranscript segmentId={quote.segment_id} window={window} />}
        </>
      )}
    </blockquote>
  );
}

/** Words highlight during playback; clicking a word seeks the audio. With a
 * time window, both the transcript and playback are sliced to the quote. */
function InteractiveTranscript(props: {
  segmentId: number;
  window?: { start: number; end: number };
}) {
  const [seg, setSeg] = useState<SegmentDetail | null>(null);
  const [currentIdx, setCurrentIdx] = useState(-1);
  const [speed, setSpeed] = useState(getSpeed);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const win = props.window;

  const cycleSpeed = () => {
    const next = nextSpeed(speed);
    setSpeed(next);
    setGlobalSpeed(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  useEffect(() => {
    api<SegmentDetail>(`/segments/${props.segmentId}`).then(setSeg).catch(() => {});
  }, [props.segmentId]);

  const words = useMemo(() => {
    if (!seg?.words) return null;
    if (!win) return seg.words;
    return seg.words.filter((w) => w.end >= win.start - 0.05 && w.start <= win.end + 0.05);
  }, [seg, win]);

  const onTimeUpdate = () => {
    const audio = audioRef.current;
    if (!words || !audio) return;
    const t = audio.currentTime;
    if (win && t > win.end + 0.25 && !audio.paused) {
      audio.pause();
      setCurrentIdx(-1);
      return;
    }
    setCurrentIdx(words.findIndex((w) => t >= w.start && t < w.end + 0.15));
  };

  const seekTo = (w: TranscriptWord) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = w.start;
    void audio.play();
  };

  if (!seg) return <p className="segment-transcript">…</p>;

  return (
    <div className="segment-transcript">
      <div className="player-bar">
        <audio
          ref={audioRef}
          controls
          preload="metadata"
          src={`/api/audio/${props.segmentId}`}
          onLoadedMetadata={() => {
            const audio = audioRef.current;
            if (!audio) return;
            audio.playbackRate = speed;
            if (win) audio.currentTime = win.start;
          }}
        onPlay={() => {
          const audio = audioRef.current;
          if (win && audio && (audio.currentTime < win.start - 0.1 || audio.currentTime > win.end)) {
            audio.currentTime = win.start;
          }
        }}
          onTimeUpdate={onTimeUpdate}
          onEnded={() => setCurrentIdx(-1)}
        />
        <button className="speed-btn" onClick={cycleSpeed} title="Playback speed">
          {speed}×
        </button>
      </div>
      {words && words.length > 0 ? (
        <p className="word-transcript">
          {words.map((w, i) => (
            <span key={i} className={i === currentIdx ? "current" : ""} onClick={() => seekTo(w)}>
              {w.word}{" "}
            </span>
          ))}
        </p>
      ) : (
        <p>{seg.transcript ?? "(no transcript)"}</p>
      )}
    </div>
  );
}
