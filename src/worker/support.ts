// Human-to-human support chat. One thread per user; any admin can respond.
// No AI anywhere in this file — messages are stored and relayed, that's it.
import { Hono } from "hono";
import type { AppContext } from "./auth";
import { requireEnabled } from "./auth";
import { now, setNotification } from "./db";
import { pushToUser } from "./push";
import { isAdmin } from "./signup";
import { transcribe } from "./transcribe";
import type { Env, UserRow } from "./types";

export interface SupportMessageRow {
  id: number;
  user_id: number;
  sender_id: number;
  text: string;
  r2_key: string | null;
  words_json: string | null;
  as_admin: number;
  created_at: number;
}

export const support = new Hono<AppContext>();
support.use("*", requireEnabled);

async function enabledAdmins(env: Env): Promise<UserRow[]> {
  const r = await env.DB.prepare(`SELECT * FROM users WHERE enabled = 1`).all<UserRow>();
  return r.results.filter((u) => isAdmin(env, u.email));
}

/** Store a message and notify the other side (bell + push, deep-linking
 * straight into the chat). */
async function addMessage(
  env: Env,
  threadUserId: number,
  sender: UserRow,
  text: string,
  r2Key: string | null,
  asAdmin: boolean,
  wordsJson: string | null = null,
): Promise<SupportMessageRow> {
  const row = await env.DB.prepare(
    `INSERT INTO support_messages (user_id, sender_id, text, r2_key, words_json, as_admin, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  )
    .bind(threadUserId, sender.id, text, r2Key, r2Key ? wordsJson : null, asAdmin ? 1 : 0, now())
    .first<SupportMessageRow>();

  const snippet = text.slice(0, 140);
  const fromAdmin = asAdmin && sender.id !== threadUserId;
  if (fromAdmin) {
    await setNotification(env, threadUserId, "support", "Support replied", snippet).catch(() => {});
    await pushToUser(env, threadUserId, {
      title: "Todo Log support replied",
      body: snippet,
      url: "/support",
    }).catch(() => {});
  } else {
    for (const admin of await enabledAdmins(env)) {
      if (admin.id === sender.id) continue;
      await setNotification(
        env,
        admin.id,
        `support:${threadUserId}`,
        `Support: ${sender.name ?? sender.email}`,
        snippet,
      ).catch(() => {});
      await pushToUser(env, admin.id, {
        title: `Support message from ${sender.name ?? sender.email}`,
        body: snippet,
        url: `/support?u=${threadUserId}`,
      }).catch(() => {});
    }
  }
  return row!;
}

/** A message's attached audio must be one the sender transcribed themselves. */
function ownAudioKey(sender: UserRow, key: unknown): string | null {
  return typeof key === "string" && key.startsWith(`support/tmp/${sender.id}/`) ? key : null;
}

/** Word timings from the client's transcribe round-trip (bounded, shape-checked). */
function cleanWords(v: unknown): string | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > 2000) return null;
  const words = (v as Record<string, unknown>[])
    .filter((w) => typeof w.word === "string" && typeof w.start === "number" && typeof w.end === "number")
    .map((w) => ({ word: w.word, start: w.start, end: w.end }));
  return words.length ? JSON.stringify(words) : null;
}

// -- User side ---------------------------------------------------------------

support.get("/support/messages", async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT * FROM support_messages WHERE user_id = ? ORDER BY id`,
  )
    .bind(c.get("user").id)
    .all<SupportMessageRow>();
  return c.json({ messages: r.results });
});

support.post("/support/messages", async (c) => {
  const body = await c.req.json<{ text?: string; r2_key?: string; words?: unknown }>();
  const text = body.text?.trim();
  if (!text) return c.json({ error: "text required" }, 400);
  const user = c.get("user");
  return c.json(
    await addMessage(
      c.env,
      user.id,
      user,
      text.slice(0, 4000),
      ownAudioKey(user, body.r2_key),
      false,
      cleanWords(body.words),
    ),
  );
});

// Transcribe a voice note WITHOUT sending: audio parks in R2, transcript
// goes to the composer, and Send remains an explicit act.
support.post("/support/transcribe", async (c) => {
  const user = c.get("user");
  const audio = await c.req.arrayBuffer();
  if (audio.byteLength === 0) return c.json({ error: "empty audio" }, 400);
  if (audio.byteLength > 25 * 1024 * 1024) return c.json({ error: "recording too large" }, 413);
  let text: string;
  let words: unknown = null;
  try {
    const t = await transcribe(c.env, audio);
    text = t.text;
    words = t.words;
  } catch {
    return c.json({ error: "transcription failed — try again or type it" }, 502);
  }
  const key = `support/tmp/${user.id}/${Date.now()}.webm`;
  await c.env.MEDIA.put(key, audio, {
    httpMetadata: { contentType: c.req.header("content-type") ?? "audio/webm" },
  });
  return c.json({ text, r2_key: key, words });
});

// -- Admin side --------------------------------------------------------------

const adminOnly = (c: { env: Env; get: (k: "user") => UserRow }) => isAdmin(c.env, c.get("user").email);

support.get("/support/threads", async (c) => {
  if (!adminOnly(c)) return c.json({ error: "not found" }, 404);
  const r = await c.env.DB.prepare(
    `SELECT m.user_id, u.email, u.name,
            MAX(m.id) AS last_id,
            (SELECT text FROM support_messages WHERE user_id = m.user_id ORDER BY id DESC LIMIT 1) AS last_text,
            (SELECT sender_id FROM support_messages WHERE user_id = m.user_id ORDER BY id DESC LIMIT 1) AS last_sender_id,
            (SELECT created_at FROM support_messages WHERE user_id = m.user_id ORDER BY id DESC LIMIT 1) AS last_at
     FROM support_messages m JOIN users u ON u.id = m.user_id
     GROUP BY m.user_id ORDER BY last_id DESC`,
  ).all();
  return c.json({ threads: r.results });
});

support.get("/support/threads/:uid/messages", async (c) => {
  if (!adminOnly(c)) return c.json({ error: "not found" }, 404);
  const r = await c.env.DB.prepare(
    `SELECT * FROM support_messages WHERE user_id = ? ORDER BY id`,
  )
    .bind(Number(c.req.param("uid")))
    .all<SupportMessageRow>();
  return c.json({ messages: r.results });
});

support.post("/support/threads/:uid/messages", async (c) => {
  if (!adminOnly(c)) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{ text?: string; r2_key?: string; words?: unknown }>();
  const text = body.text?.trim();
  if (!text) return c.json({ error: "text required" }, 400);
  const sender = c.get("user");
  return c.json(
    await addMessage(
      c.env,
      Number(c.req.param("uid")),
      sender,
      text.slice(0, 4000),
      ownAudioKey(sender, body.r2_key),
      true,
      cleanWords(body.words),
    ),
  );
});

// Audio playback: the thread's owner or any admin.
support.get("/support/audio/:id", async (c) => {
  const user = c.get("user");
  const msg = await c.env.DB.prepare(`SELECT * FROM support_messages WHERE id = ?`)
    .bind(Number(c.req.param("id")))
    .first<SupportMessageRow>();
  if (!msg || !msg.r2_key) return c.json({ error: "not found" }, 404);
  if (msg.user_id !== user.id && !isAdmin(c.env, user.email)) {
    return c.json({ error: "not found" }, 404);
  }
  const object = await c.env.MEDIA.get(msg.r2_key);
  if (!object) return c.json({ error: "audio missing" }, 404);
  return new Response(object.body as ReadableStream, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "audio/webm",
      "cache-control": "private, max-age=3600",
    },
  });
});
