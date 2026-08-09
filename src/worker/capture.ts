// Capture pipeline: sessions → messages → audio segments → send (agent turn).
// Segments upload as they're recorded (a pause closes a segment) and
// transcribe in the background via waitUntil; the cron sweep heals stragglers.
import { Hono } from "hono";
import type { AppContext } from "./auth";
import { requireEnabled } from "./auth";
import {
  now,
  createSession,
  getSession,
  sessionMessages,
  sessionEvents,
  getOwnedMessage,
  messageSegments,
  getOwnedSegment,
  setSegmentTranscript,
  insertRow,
  getEntity,
} from "./db";
import { transcribe } from "./transcribe";
import { runTurn } from "./agent";
import { generateBriefing } from "./briefing";
import type { AudioSegmentRow, LogRow, MessageRow, SessionRow } from "./types";

export const capture = new Hono<AppContext>();
capture.use("*", requireEnabled);

capture.post("/sessions", async (c) => {
  const body = await c.req
    .json<{ context_type?: string; context_id?: number; mode?: string; notification_id?: number }>()
    .catch(() => ({}) as Record<string, never>);
  const mode = body.mode === "plan" ? "plan" : null;
  const reNotificationId = typeof body.notification_id === "number" ? body.notification_id : null;
  // A past chat as context is stored in its own column — the context_type
  // CHECK predates it and can't be widened in place on remote D1.
  if (body.context_type === "session" && body.context_id) {
    const session = await createSession(c.env, c.get("user").id, {
      type: null,
      id: null,
      aboutSessionId: body.context_id,
      mode,
      reNotificationId,
    });
    return c.json(session);
  }
  const type = ["project", "todo", "action", "log"].includes(body.context_type ?? "")
    ? (body.context_type as string)
    : null;
  const session = await createSession(c.env, c.get("user").id, {
    type,
    id: type && body.context_id ? body.context_id : null,
    mode,
    reNotificationId,
  });
  return c.json(session);
});

// Session history: past conversations, newest first. Only SENT messages count
// (text stays NULL until send) — opening the dock or recording without sending
// creates a session + message that shouldn't surface as an empty chat.
capture.get("/sessions", async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT s.*,
       (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.text IS NOT NULL) AS message_count,
       (SELECT m.text FROM messages m WHERE m.session_id = s.id AND m.role = 'user' AND m.text IS NOT NULL
        ORDER BY m.id LIMIT 1) AS first_text
     FROM sessions s
     WHERE s.user_id = ?
     ORDER BY s.id DESC LIMIT 50`,
  )
    .bind(c.get("user").id)
    .all();
  return c.json(r.results.filter((s) => (s.message_count as number) > 0));
});

capture.get("/sessions/:id", async (c) => {
  const session = await getSession(c.env, c.get("user").id, Number(c.req.param("id")));
  if (!session) return c.json({ error: "not found" }, 404);
  const messages = await sessionMessages(c.env, session.id);
  const events = await sessionEvents(c.env, session.id);
  return c.json({ session, messages, events });
});

// Delete a chat: messages, audio, and its events links go; journal logs stay
// (their message link is severed, so quote audio is gone too).
capture.delete("/sessions/:id", async (c) => {
  const user = c.get("user");
  const session = await getSession(c.env, user.id, Number(c.req.param("id")));
  if (!session) return c.json({ error: "not found" }, 404);

  const messages = await sessionMessages(c.env, session.id);
  const messageIds = messages.map((m) => m.id);
  if (messageIds.length > 0) {
    const ph = messageIds.map(() => "?").join(",");
    const segs = await c.env.DB.prepare(
      `SELECT id, r2_key FROM audio_segments WHERE message_id IN (${ph})`,
    )
      .bind(...messageIds)
      .all<{ id: number; r2_key: string }>();
    for (const seg of segs.results) {
      await c.env.MEDIA.delete(seg.r2_key).catch(() => {});
    }
    await c.env.DB.prepare(`DELETE FROM audio_segments WHERE message_id IN (${ph})`)
      .bind(...messageIds)
      .run();
    await c.env.DB.prepare(`UPDATE logs SET message_id = NULL WHERE message_id IN (${ph})`)
      .bind(...messageIds)
      .run();
    await c.env.DB.prepare(
      `UPDATE events SET message_id = NULL WHERE message_id IN (${ph})`,
    )
      .bind(...messageIds)
      .run();
  }
  await c.env.DB.prepare(`UPDATE events SET session_id = NULL WHERE session_id = ?`)
    .bind(session.id)
    .run();
  await c.env.DB.prepare(`UPDATE corrections SET session_id = NULL WHERE session_id = ?`)
    .bind(session.id)
    .run();
  await c.env.DB.prepare(`DELETE FROM messages WHERE session_id = ?`).bind(session.id).run();
  await c.env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(session.id).run();
  return c.json({ ok: true });
});

capture.post("/sessions/:id/done", async (c) => {
  const session = await getSession(c.env, c.get("user").id, Number(c.req.param("id")));
  if (!session) return c.json({ error: "not found" }, 404);
  await c.env.DB.prepare(`UPDATE sessions SET ended_at = ? WHERE id = ?`)
    .bind(now(), session.id)
    .run();
  return c.json({ ok: true });
});

capture.post("/sessions/:id/messages", async (c) => {
  const session = await getSession(c.env, c.get("user").id, Number(c.req.param("id")));
  if (!session) return c.json({ error: "not found" }, 404);
  if (session.ended_at) return c.json({ error: "session is done" }, 400);
  const message = await insertRow<MessageRow>(c.env, "messages", {
    session_id: session.id,
    role: "user",
    text: null,
    created_at: now(),
  });
  return c.json(message);
});

// Upload one audio segment (raw body). Transcription runs in the background.
capture.post("/messages/:id/segments", async (c) => {
  const user = c.get("user");
  const message = await getOwnedMessage(c.env, user.id, Number(c.req.param("id")));
  if (!message) return c.json({ error: "not found" }, 404);
  const seq = Number(c.req.query("seq") ?? "0");
  const duration = Number(c.req.query("duration") ?? "0") || null;
  const audio = await c.req.arrayBuffer();
  if (audio.byteLength === 0) return c.json({ error: "empty audio" }, 400);
  if (audio.byteLength > 25 * 1024 * 1024) return c.json({ error: "segment too large" }, 413);

  const r2Key = `audio/${user.id}/${message.id}/${seq}.webm`;
  await c.env.MEDIA.put(r2Key, audio, {
    httpMetadata: { contentType: c.req.header("content-type") ?? "audio/webm" },
  });
  const segment = await insertRow<AudioSegmentRow>(c.env, "audio_segments", {
    message_id: message.id,
    seq,
    r2_key: r2Key,
    duration_sec: duration,
    transcript: null,
    words_json: null,
    created_at: now(),
  });

  c.executionCtx.waitUntil(
    (async () => {
      try {
        const { text, words } = await transcribe(c.env, audio);
        await setSegmentTranscript(c.env, segment.id, text, words);
      } catch (err) {
        console.error(`segment ${segment.id} transcription failed:`, err);
        // Leave transcript NULL — the cron sweep retries.
      }
    })(),
  );

  return c.json(segment);
});

// Poll transcription progress for the live-ish transcript display.
capture.get("/messages/:id", async (c) => {
  const message = await getOwnedMessage(c.env, c.get("user").id, Number(c.req.param("id")));
  if (!message) return c.json({ error: "not found" }, 404);
  const segments = await messageSegments(c.env, message.id);
  return c.json({ message, segments });
});

// Send: finalize the transcript (transcribing any stragglers inline — segments
// are short) and run the agent turn, streamed back as SSE: thinking deltas,
// reply text deltas, and change-feed items as each tool call lands.
capture.post("/messages/:id/send", async (c) => {
  const user = c.get("user");
  const message = await getOwnedMessage(c.env, user.id, Number(c.req.param("id")));
  if (!message) return c.json({ error: "not found" }, 404);
  if (message.text) return c.json({ error: "already sent" }, 400);

  const body = await c.req.json<{ text?: string }>().catch(() => ({}) as { text?: string });
  let text = body.text?.trim() ?? "";

  if (!text) {
    const segments = await messageSegments(c.env, message.id);
    if (segments.length === 0) return c.json({ error: "nothing to send" }, 400);
    const parts: string[] = [];
    for (const seg of segments) {
      if (seg.transcript) {
        parts.push(seg.transcript);
        continue;
      }
      const object = await c.env.MEDIA.get(seg.r2_key);
      if (!object) continue;
      try {
        const { text: t, words } = await transcribe(c.env, await object.arrayBuffer());
        await setSegmentTranscript(c.env, seg.id, t, words);
        parts.push(t);
      } catch (err) {
        console.error(`inline transcription of segment ${seg.id} failed:`, err);
      }
    }
    text = parts.join(" ").trim();
    if (!text) return c.json({ error: "transcription failed — try again in a moment" }, 502);
  }

  await c.env.DB.prepare(`UPDATE messages SET text = ? WHERE id = ?`)
    .bind(text, message.id)
    .run();

  const session = (await getSession(c.env, user.id, message.session_id)) as SessionRow;

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const emit = (obj: unknown) =>
    writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)).catch(() => {});

  c.executionCtx.waitUntil(
    (async () => {
      try {
        void emit({ type: "text", text });
        const result = await runTurn(c.env, user, session, message.id, text, (e) => void emit(e));
        await insertRow<MessageRow>(c.env, "messages", {
          session_id: session.id,
          role: "assistant",
          text: result.reply,
          thinking: result.thinking || null,
          reply_to: message.id,
          created_at: now(),
        });
        await emit({ type: "done", reply: result.reply, feed: result.feed });
        await writer.close().catch(() => {});
        // Every turn can change what today looks like — recompute the briefing
        // (after closing the stream so the client never waits on it).
        await generateBriefing(c.env, user).catch((err) =>
          console.error("briefing regeneration after turn failed:", err),
        );
      } catch (err) {
        await emit({ type: "error", error: err instanceof Error ? err.message : String(err) });
        await writer.close().catch(() => {});
      }
    })(),
  );

  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
});

// Segment transcript + word timestamps for the interactive (click-to-seek,
// highlight-while-playing) transcript under a quote's audio player.
capture.get("/segments/:id", async (c) => {
  const segment = await getOwnedSegment(c.env, c.get("user").id, Number(c.req.param("id")));
  if (!segment) return c.json({ error: "not found" }, 404);
  let words: unknown = null;
  try {
    words = segment.words_json ? JSON.parse(segment.words_json) : null;
  } catch {
    words = null;
  }
  return c.json({
    id: segment.id,
    transcript: segment.transcript,
    duration_sec: segment.duration_sec,
    words,
  });
});

// Single log (permalink page).
capture.get("/logs/:id", async (c) => {
  const log = await getEntity<LogRow>(c.env, "log", c.get("user").id, Number(c.req.param("id")));
  if (!log) return c.json({ error: "not found" }, 404);
  return c.json(log);
});

// Everything the agent did in the turn that produced this log (the audit
// trail for the log's permalink page).
capture.get("/logs/:id/events", async (c) => {
  const user = c.get("user");
  const log = await getEntity<LogRow>(c.env, "log", user.id, Number(c.req.param("id")));
  if (!log) return c.json({ error: "not found" }, 404);
  // Every turn that touched this log: the originating turn, plus any later
  // turn (e.g. a reprocess) whose events reference the log — and ALL events
  // from those turns, so restructuring shows up whole.
  const touching = await c.env.DB.prepare(
    `SELECT DISTINCT message_id FROM events WHERE user_id = ?
     AND ((entity_type = 'log' AND entity_id = ?) OR log_id = ?) AND message_id IS NOT NULL`,
  )
    .bind(user.id, log.id, log.id)
    .all<{ message_id: number }>();
  const messageIds = new Set<number>(touching.results.map((x) => x.message_id));
  if (log.message_id) messageIds.add(log.message_id);
  if (messageIds.size === 0) {
    const r = await c.env.DB.prepare(
      `SELECT * FROM events WHERE user_id = ?
       AND ((entity_type = 'log' AND entity_id = ?) OR log_id = ?) ORDER BY id`,
    )
      .bind(user.id, log.id, log.id)
      .all();
    return c.json(r.results);
  }
  const ids = [...messageIds];
  const r = await c.env.DB.prepare(
    `SELECT * FROM events WHERE user_id = ? AND message_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`,
  )
    .bind(user.id, ...ids)
    .all();
  return c.json(r.results);
});

// Full transcript of the utterance behind a log (all segments, in order).
capture.get("/logs/:id/transcript", async (c) => {
  const log = await getEntity<LogRow>(c.env, "log", c.get("user").id, Number(c.req.param("id")));
  if (!log) return c.json({ error: "not found" }, 404);
  if (!log.message_id) return c.json({ segments: [] });
  const segments = await messageSegments(c.env, log.message_id);
  return c.json({
    segments: segments.map((s) => ({ id: s.id, seq: s.seq, transcript: s.transcript })),
  });
});

// Manual re-transcription (the dock's retry button for a stuck segment).
capture.post("/segments/:id/transcribe", async (c) => {
  const segment = await getOwnedSegment(c.env, c.get("user").id, Number(c.req.param("id")));
  if (!segment) return c.json({ error: "not found" }, 404);
  const object = await c.env.MEDIA.get(segment.r2_key);
  if (!object) return c.json({ error: "audio missing" }, 404);
  try {
    const { text, words } = await transcribe(c.env, await object.arrayBuffer());
    await setSegmentTranscript(c.env, segment.id, text, words);
    return c.json({ id: segment.id, transcript: text });
  } catch (err) {
    console.error(`manual re-transcribe of segment ${segment.id} failed:`, err);
    return c.json({ error: "transcription failed — try again" }, 502);
  }
});

// Authenticated audio playback for quote deep-links.
capture.get("/audio/:segmentId", async (c) => {
  const segment = await getOwnedSegment(c.env, c.get("user").id, Number(c.req.param("segmentId")));
  if (!segment) return c.json({ error: "not found" }, 404);
  const object = await c.env.MEDIA.get(segment.r2_key);
  if (!object) return c.json({ error: "audio missing" }, 404);
  return new Response(object.body as ReadableStream, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "audio/webm",
      "cache-control": "private, max-age=3600",
    },
  });
});
