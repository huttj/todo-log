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
): Promise<SupportMessageRow> {
  const row = await env.DB.prepare(
    `INSERT INTO support_messages (user_id, sender_id, text, r2_key, created_at)
     VALUES (?, ?, ?, ?, ?) RETURNING *`,
  )
    .bind(threadUserId, sender.id, text, r2Key, now())
    .first<SupportMessageRow>();

  const snippet = text.slice(0, 140);
  const fromAdmin = isAdmin(env, sender.email) && sender.id !== threadUserId;
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

async function storeVoice(
  env: Env,
  threadUserId: number,
  sender: UserRow,
  audio: ArrayBuffer,
  contentType: string,
): Promise<SupportMessageRow | { error: string }> {
  if (audio.byteLength === 0) return { error: "empty audio" };
  if (audio.byteLength > 25 * 1024 * 1024) return { error: "recording too large" };
  let text: string;
  try {
    text = (await transcribe(env, audio)).text;
  } catch {
    return { error: "transcription failed — try again or type it" };
  }
  const key = `support/${threadUserId}/${Date.now()}-${sender.id}.webm`;
  await env.MEDIA.put(key, audio, { httpMetadata: { contentType } });
  return addMessage(env, threadUserId, sender, text || "(inaudible)", key);
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
  const body = await c.req.json<{ text?: string }>();
  const text = body.text?.trim();
  if (!text) return c.json({ error: "text required" }, 400);
  const user = c.get("user");
  return c.json(await addMessage(c.env, user.id, user, text.slice(0, 4000), null));
});

support.post("/support/voice", async (c) => {
  const user = c.get("user");
  const result = await storeVoice(
    c.env,
    user.id,
    user,
    await c.req.arrayBuffer(),
    c.req.header("content-type") ?? "audio/webm",
  );
  return "error" in result ? c.json(result, 400) : c.json(result);
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
  const body = await c.req.json<{ text?: string }>();
  const text = body.text?.trim();
  if (!text) return c.json({ error: "text required" }, 400);
  return c.json(
    await addMessage(c.env, Number(c.req.param("uid")), c.get("user"), text.slice(0, 4000), null),
  );
});

support.post("/support/threads/:uid/voice", async (c) => {
  if (!adminOnly(c)) return c.json({ error: "not found" }, 404);
  const result = await storeVoice(
    c.env,
    Number(c.req.param("uid")),
    c.get("user"),
    await c.req.arrayBuffer(),
    c.req.header("content-type") ?? "audio/webm",
  );
  return "error" in result ? c.json(result, 400) : c.json(result);
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
