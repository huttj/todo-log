// Stitched multi-segment audio player with a highlighted word transcript,
// seek slider, and the persisted global speed. Works for a log's utterance
// (logId) or a chat message (messageId). Extracted from LogCard.
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type LogTranscript, type SegmentDetail } from "../api";
import { getSpeed, setGlobalSpeed, nextSpeed } from "../audio";

export default function TranscriptPlayer(props: {
  logId?: number;
  messageId?: number;
  autoPlay?: boolean;
  emptyNote?: string;
  /** Chat-bubble mode: just the clickable transcript + a corner play/pause —
   * no bar, no nested box. Words seek. */
  minimal?: boolean;
}) {
  const [segs, setSegs] = useState<SegmentDetail[] | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(getSpeed);
  const [pos, setPos] = useState(0);
  const [current, setCurrent] = useState<{ seg: number; word: number }>({ seg: -1, word: -1 });
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const speedRef = useRef(getSpeed());
  const tickerRef = useRef<number | null>(null);
  const autoPlayed = useRef(false);
  // One pre-buffered player per segment — rolling to the next is instant
  // instead of stalling on a fresh fetch+decode.
  const playersRef = useRef<HTMLAudioElement[]>([]);

  const segDuration = (s: SegmentDetail) =>
    s.duration_sec ?? (s.words && s.words.length > 0 ? s.words[s.words.length - 1].end : 0);
  const total = useMemo(() => (segs ?? []).reduce((acc, s) => acc + segDuration(s), 0), [segs]);
  const baseOf = (idx: number) => (segs ?? []).slice(0, idx).reduce((acc, s) => acc + segDuration(s), 0);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      let list: { id: number }[] = [];
      if (props.logId != null) {
        list = (await api<LogTranscript>(`/logs/${props.logId}/transcript`)).segments;
      } else if (props.messageId != null) {
        list = (await api<{ segments: { id: number }[] }>(`/messages/${props.messageId}`)).segments;
      }
      const details = await Promise.all(list.map((s) => api<SegmentDetail>(`/segments/${s.id}`)));
      if (!alive) return;
      playersRef.current = details.map((s) => {
        const a = new Audio(`/api/audio/${s.id}`);
        a.preload = "auto";
        return a;
      });
      setSegs(details);
    };
    load().catch(() => setSegs([]));
    return () => {
      alive = false;
      if (tickerRef.current) window.clearInterval(tickerRef.current);
      audioRef.current?.pause();
      for (const a of playersRef.current) a.pause();
      playersRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.logId, props.messageId]);

  useEffect(() => {
    if (props.autoPlay && segs && segs.length > 0 && !autoPlayed.current) {
      autoPlayed.current = true;
      playSegment(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segs]);

  const stop = () => {
    if (tickerRef.current) window.clearInterval(tickerRef.current);
    tickerRef.current = null;
    audioRef.current?.pause();
    audioRef.current = null;
    setPlaying(false);
    setCurrent({ seg: -1, word: -1 });
  };

  // Pause keeps the player and position; toggling resumes where it left off.
  const togglePlay = () => {
    const audio = audioRef.current;
    if (playing && audio) {
      audio.pause();
      setPlaying(false);
    } else if (audio) {
      setPlaying(true);
      void audio.play().catch(stop);
    } else {
      playSegment(0);
    }
  };

  const playSegment = (segIdx: number, at = 0, opts: { overlapPrev?: boolean } = {}) => {
    if (!segs || segIdx >= segs.length) {
      stop();
      setPos(0);
      return;
    }
    if (tickerRef.current) window.clearInterval(tickerRef.current);
    const prev = audioRef.current;
    if (prev) {
      prev.ontimeupdate = null;
      prev.onended = null;
      // On an early roll the previous tail keeps playing out under the next
      // segment's start — that overlap is what kills the audible gap.
      if (!opts.overlapPrev) prev.pause();
    }
    const audio = playersRef.current[segIdx] ?? new Audio(`/api/audio/${segs[segIdx].id}`);
    audioRef.current = audio;
    audio.playbackRate = speedRef.current;
    audio.currentTime = at;
    const base = baseOf(segIdx);
    audio.ontimeupdate = () => {
      const t = audio.currentTime;
      setPos(base + t);
      const words = segs[segIdx].words;
      if (!words) return;
      setCurrent({ seg: segIdx, word: words.findIndex((w) => t >= w.start && t < w.end + 0.15) });
    };
    // Early roll: start the next segment before this one ends, with enough
    // lead to swallow play()'s own startup latency (timeupdate is too
    // coarse, so poll finely while playing).
    let rolled = false;
    const roll = () => {
      if (rolled) return;
      rolled = true;
      playSegment(segIdx + 1, 0, { overlapPrev: true });
    };
    const hasNext = segIdx + 1 < segs.length;
    if (hasNext) {
      tickerRef.current = window.setInterval(() => {
        if (audio.paused || rolled) return;
        const remaining = (audio.duration - audio.currentTime) / (audio.playbackRate || 1);
        if (Number.isFinite(remaining) && remaining <= 0.18) roll();
      }, 20);
    }
    audio.onended = () => {
      if (hasNext) roll();
      else {
        stop();
        setPos(0);
      }
    };
    setPlaying(true);
    setCurrent({ seg: segIdx, word: -1 });
    void audio.play().catch(stop);
  };

  const cycleSpeed = () => {
    const next = nextSpeed(speedRef.current);
    speedRef.current = next;
    setSpeed(next);
    setGlobalSpeed(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  const seek = (target: number) => {
    if (!segs) return;
    let idx = 0;
    let offset = target;
    while (idx < segs.length - 1 && offset > segDuration(segs[idx])) {
      offset -= segDuration(segs[idx]);
      idx += 1;
    }
    setPos(target);
    playSegment(idx, Math.max(0, offset));
  };

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  if (!segs) return <p className="segment-transcript">…</p>;
  if (segs.length === 0) {
    return (
      <p className="segment-transcript full">{props.emptyNote ?? "No audio (typed input)."}</p>
    );
  }

  const words = (
    <p className="word-transcript">
      {segs.map((seg, si) =>
        seg.words && seg.words.length > 0 ? (
          seg.words.map((w, wi) => (
            <span
              key={`${si}-${wi}`}
              className={current.seg === si && current.word === wi ? "current" : ""}
              onClick={() => playSegment(si, w.start)}
            >
              {w.word}{" "}
            </span>
          ))
        ) : (
          <span key={`${si}-t`} onClick={() => playSegment(si)}>
            {seg.transcript ?? ""}{" "}
          </span>
        ),
      )}
    </p>
  );

  if (props.minimal) {
    return (
      <div className="inline-transcript" onClick={(e) => e.stopPropagation()}>
        {words}
        <button
          className="msg-play corner"
          title={playing ? "Pause" : "Play (tap a word to jump)"}
          onClick={togglePlay}
        >
          {playing ? "⏸" : "▶"}
        </button>
      </div>
    );
  }

  return (
    <div className="segment-transcript full combined" onClick={(e) => e.stopPropagation()}>
      <div className="player-bar">
        <button className="play-btn" onClick={togglePlay}>
          {playing ? "⏸" : "▶"}
        </button>
        <input
          type="range"
          className="seek"
          min={0}
          max={Math.max(1, total)}
          step={0.1}
          value={Math.min(pos, total)}
          onChange={(e) => seek(Number(e.target.value))}
        />
        <span className="clock">
          {fmt(pos)} / {fmt(total)}
        </span>
        <button className="speed-btn" onClick={cycleSpeed} title="Playback speed (global)">
          {speed}×
        </button>
      </div>
      {words}
    </div>
  );
}
