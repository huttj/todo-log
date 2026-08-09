import type {
  Env,
  UserRow,
  ProjectRow,
  TodoRow,
  ActionRow,
  LogRow,
  SessionRow,
  MessageRow,
  AudioSegmentRow,
  EventRow,
  NotificationRow,
  AgentMemoryRow,
  BriefingRow,
  EntityType,
} from "./types";

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// Users / auth
// ---------------------------------------------------------------------------

/** Upsert on sign-in; allowlisted emails come in enabled. */
export async function upsertUser(
  env: Env,
  input: { googleSub: string; email: string; name: string | null },
): Promise<UserRow> {
  const allowlisted = env.ALLOWLIST_EMAILS.split(",")
    .map((e) => e.trim().toLowerCase())
    .includes(input.email.toLowerCase());
  const row = await env.DB.prepare(
    `INSERT INTO users (google_sub, email, name, enabled, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET google_sub = excluded.google_sub, name = excluded.name
     RETURNING *`,
  )
    .bind(input.googleSub, input.email, input.name, allowlisted ? 1 : 0, now())
    .first<UserRow>();
  if (!row) throw new Error("user upsert returned no row");
  return row;
}

export async function getUser(env: Env, id: number): Promise<UserRow | null> {
  return env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first<UserRow>();
}

export async function saveGoogleTokens(
  env: Env,
  userId: number,
  t: { accessToken: string; refreshToken: string | null; expiresAt: number; scopes: string | null },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO google_tokens (user_id, access_token, refresh_token, expires_at, scopes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = COALESCE(excluded.refresh_token, google_tokens.refresh_token),
       expires_at = excluded.expires_at,
       scopes = excluded.scopes,
       updated_at = excluded.updated_at`,
  )
    .bind(userId, t.accessToken, t.refreshToken, t.expiresAt, t.scopes, now())
    .run();
}

export async function insertProspect(
  env: Env,
  input: { email: string; name: string | null; note: string | null; wantsBetaCall: boolean },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO prospects (email, name, note, wants_beta_call, created_at) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(input.email, input.name, input.note, input.wantsBetaCall ? 1 : 0, now())
    .run();
}

// ---------------------------------------------------------------------------
// Generic entity helpers (projects / todos / actions / logs)
// ---------------------------------------------------------------------------

export const ENTITY_TABLES: Record<EntityType, string> = {
  project: "projects",
  todo: "todos",
  action: "actions",
  log: "logs",
};

export async function getEntity<T>(
  env: Env,
  type: EntityType,
  userId: number,
  id: number,
): Promise<T | null> {
  return env.DB.prepare(`SELECT * FROM ${ENTITY_TABLES[type]} WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .first<T>();
}

/** Insert with column map; returns the new row. Columns are code-controlled. */
export async function insertRow<T>(
  env: Env,
  table: string,
  cols: Record<string, unknown>,
): Promise<T> {
  const names = Object.keys(cols);
  const row = await env.DB.prepare(
    `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")}) RETURNING *`,
  )
    .bind(...names.map((n) => cols[n]))
    .first<T>();
  if (!row) throw new Error(`insert into ${table} returned no row`);
  return row;
}

/** Update by id+user with column map; returns the updated row or null. */
export async function updateRow<T>(
  env: Env,
  table: string,
  userId: number,
  id: number,
  cols: Record<string, unknown>,
): Promise<T | null> {
  const names = Object.keys(cols);
  if (names.length === 0) {
    return env.DB.prepare(`SELECT * FROM ${table} WHERE id = ? AND user_id = ?`)
      .bind(id, userId)
      .first<T>();
  }
  return env.DB.prepare(
    `UPDATE ${table} SET ${names.map((n) => `${n} = ?`).join(", ")} WHERE id = ? AND user_id = ? RETURNING *`,
  )
    .bind(...names.map((n) => cols[n]), id, userId)
    .first<T>();
}

// ---------------------------------------------------------------------------
// Queries used by views and the agent's context snapshot
// ---------------------------------------------------------------------------

export async function listProjects(env: Env, userId: number): Promise<ProjectRow[]> {
  const r = await env.DB.prepare(
    `SELECT * FROM projects WHERE user_id = ? ORDER BY status = 'active' DESC, name`,
  )
    .bind(userId)
    .all<ProjectRow>();
  return r.results;
}

export async function listTodos(
  env: Env,
  userId: number,
  opts: { includeClosed?: boolean } = {},
): Promise<TodoRow[]> {
  const where = opts.includeClosed ? "" : `AND status NOT IN ('done','abandoned')`;
  const r = await env.DB.prepare(
    `SELECT * FROM todos WHERE user_id = ? ${where} ORDER BY updated_at DESC LIMIT 200`,
  )
    .bind(userId)
    .all<TodoRow>();
  return r.results;
}

export async function listTodosForProject(env: Env, userId: number, projectId: number): Promise<TodoRow[]> {
  const r = await env.DB.prepare(
    `SELECT * FROM todos WHERE user_id = ? AND project_id = ? ORDER BY updated_at DESC LIMIT 100`,
  )
    .bind(userId, projectId)
    .all<TodoRow>();
  return r.results;
}

export async function actionsForTodo(env: Env, userId: number, todoId: number): Promise<ActionRow[]> {
  const r = await env.DB.prepare(
    `SELECT * FROM actions WHERE user_id = ? AND todo_id = ? ORDER BY COALESCE(scheduled_start, started_at, created_at) DESC LIMIT 30`,
  )
    .bind(userId, todoId)
    .all<ActionRow>();
  return r.results;
}

/** Text search across projects, todos, and logs for the agent's search tool. */
export async function searchAll(
  env: Env,
  userId: number,
  query: string,
): Promise<{ projects: ProjectRow[]; todos: TodoRow[]; logs: LogRow[] }> {
  const like = `%${query.replaceAll("%", "").replaceAll("_", "")}%`;
  const [projects, todos, logs] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM projects WHERE user_id = ? AND (name LIKE ? OR description LIKE ?) LIMIT 10`,
    )
      .bind(userId, like, like)
      .all<ProjectRow>(),
    env.DB.prepare(
      `SELECT * FROM todos WHERE user_id = ? AND (title LIKE ? OR outcome LIKE ? OR details LIKE ?) ORDER BY updated_at DESC LIMIT 15`,
    )
      .bind(userId, like, like, like)
      .all<TodoRow>(),
    env.DB.prepare(
      `SELECT * FROM logs WHERE user_id = ? AND summary LIKE ? ORDER BY occurred_at DESC LIMIT 15`,
    )
      .bind(userId, like)
      .all<LogRow>(),
  ]);
  return { projects: projects.results, todos: todos.results, logs: logs.results };
}

export async function listActions(
  env: Env,
  userId: number,
  range: { from: number; to: number },
): Promise<ActionRow[]> {
  const r = await env.DB.prepare(
    `SELECT * FROM actions WHERE user_id = ?
     AND (
       (scheduled_start IS NOT NULL AND scheduled_start >= ? AND scheduled_start < ?)
       OR (started_at IS NOT NULL AND started_at >= ? AND started_at < ?)
       OR (scheduled_start IS NULL AND started_at IS NULL AND created_at >= ? AND created_at < ?)
     )
     ORDER BY COALESCE(scheduled_start, started_at, created_at)`,
  )
    .bind(userId, range.from, range.to, range.from, range.to, range.from, range.to)
    .all<ActionRow>();
  return r.results;
}

export async function listLogs(
  env: Env,
  userId: number,
  filter: {
    todoId?: number;
    actionId?: number;
    projectId?: number;
    from?: number;
    to?: number;
    limit?: number;
  },
): Promise<LogRow[]> {
  const conds = ["user_id = ?"];
  const binds: unknown[] = [userId];
  if (filter.todoId) (conds.push("todo_id = ?"), binds.push(filter.todoId));
  if (filter.actionId) (conds.push("action_id = ?"), binds.push(filter.actionId));
  if (filter.projectId) (conds.push("project_id = ?"), binds.push(filter.projectId));
  if (filter.from) (conds.push("occurred_at >= ?"), binds.push(filter.from));
  if (filter.to) (conds.push("occurred_at < ?"), binds.push(filter.to));
  const r = await env.DB.prepare(
    `SELECT * FROM logs WHERE ${conds.join(" AND ")} ORDER BY occurred_at DESC LIMIT ?`,
  )
    .bind(...binds, filter.limit ?? 100)
    .all<LogRow>();
  return r.results;
}

// ---------------------------------------------------------------------------
// Sessions / messages / audio segments
// ---------------------------------------------------------------------------

export async function createSession(
  env: Env,
  userId: number,
  context: {
    type: string | null;
    id: number | null;
    aboutSessionId?: number | null;
    mode?: string | null;
    reNotificationId?: number | null;
  },
): Promise<SessionRow> {
  return insertRow<SessionRow>(env, "sessions", {
    user_id: userId,
    context_type: context.type,
    context_id: context.id,
    about_session_id: context.aboutSessionId ?? null,
    mode: context.mode ?? null,
    re_notification_id: context.reNotificationId ?? null,
    started_at: now(),
  });
}

export async function getSession(env: Env, userId: number, id: number): Promise<SessionRow | null> {
  return env.DB.prepare(`SELECT * FROM sessions WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .first<SessionRow>();
}

export async function sessionMessages(env: Env, sessionId: number): Promise<MessageRow[]> {
  const r = await env.DB.prepare(
    `SELECT * FROM messages WHERE session_id = ? ORDER BY id`,
  )
    .bind(sessionId)
    .all<MessageRow>();
  return r.results;
}

/** Conversation order for a session's messages. Id order lies: a user message
 * row is created when recording starts, so with queued sends the next
 * utterance's row can predate the previous turn's reply. Pair each assistant
 * reply behind its user message via reply_to; pre-reply_to rows fall back to
 * zipping one orphan reply per sent user message. */
export function conversationOrder(messages: MessageRow[]): MessageRow[] {
  const byReply = new Map<number, MessageRow[]>();
  const orphans: MessageRow[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    if (m.reply_to) {
      const arr = byReply.get(m.reply_to) ?? [];
      arr.push(m);
      byReply.set(m.reply_to, arr);
    } else {
      orphans.push(m);
    }
  }
  const out: MessageRow[] = [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    out.push(m);
    const replies = byReply.get(m.id);
    if (replies) out.push(...replies);
    else if (m.text && orphans.length) out.push(orphans.shift()!);
  }
  out.push(...orphans);
  return out;
}

/** Message with an ownership check via its session. */
export async function getOwnedMessage(
  env: Env,
  userId: number,
  messageId: number,
): Promise<(MessageRow & { user_id: number; context_type: string | null; context_id: number | null }) | null> {
  return env.DB.prepare(
    `SELECT m.*, s.user_id, s.context_type, s.context_id FROM messages m
     JOIN sessions s ON s.id = m.session_id
     WHERE m.id = ? AND s.user_id = ?`,
  )
    .bind(messageId, userId)
    .first();
}

export async function messageSegments(env: Env, messageId: number): Promise<AudioSegmentRow[]> {
  const r = await env.DB.prepare(
    `SELECT * FROM audio_segments WHERE message_id = ? ORDER BY seq`,
  )
    .bind(messageId)
    .all<AudioSegmentRow>();
  return r.results;
}

export async function getOwnedSegment(
  env: Env,
  userId: number,
  segmentId: number,
): Promise<AudioSegmentRow | null> {
  return env.DB.prepare(
    `SELECT a.* FROM audio_segments a
     JOIN messages m ON m.id = a.message_id
     JOIN sessions s ON s.id = m.session_id
     WHERE a.id = ? AND s.user_id = ?`,
  )
    .bind(segmentId, userId)
    .first<AudioSegmentRow>();
}

export async function setSegmentTranscript(
  env: Env,
  segmentId: number,
  transcript: string,
  words: unknown[] | null,
): Promise<void> {
  await env.DB.prepare(`UPDATE audio_segments SET transcript = ?, words_json = ? WHERE id = ?`)
    .bind(transcript, words ? JSON.stringify(words) : null, segmentId)
    .run();
}

/** Untranscribed segments past a grace period — the cron sweep's worklist. */
export async function stuckSegments(env: Env, olderThan: number, limit = 5): Promise<AudioSegmentRow[]> {
  const r = await env.DB.prepare(
    `SELECT * FROM audio_segments WHERE transcript IS NULL AND created_at < ? ORDER BY id LIMIT ?`,
  )
    .bind(olderThan, limit)
    .all<AudioSegmentRow>();
  return r.results;
}

// ---------------------------------------------------------------------------
// Events (audit trail) / corrections / learnings
// ---------------------------------------------------------------------------

export async function insertEvent(
  env: Env,
  e: {
    userId: number;
    sessionId?: number | null;
    messageId?: number | null;
    entityType: EntityType;
    entityId: number;
    kind: string;
    logId?: number | null;
    payload?: unknown;
  },
): Promise<EventRow> {
  return insertRow<EventRow>(env, "events", {
    user_id: e.userId,
    session_id: e.sessionId ?? null,
    message_id: e.messageId ?? null,
    entity_type: e.entityType,
    entity_id: e.entityId,
    kind: e.kind,
    log_id: e.logId ?? null,
    payload_json: e.payload != null ? JSON.stringify(e.payload) : null,
    undone: 0,
    created_at: now(),
  });
}

export async function getEvent(env: Env, userId: number, id: number): Promise<EventRow | null> {
  return env.DB.prepare(`SELECT * FROM events WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .first<EventRow>();
}

/** Every event in a session, oldest first — the replay page's change feed. */
export async function sessionEvents(env: Env, sessionId: number): Promise<EventRow[]> {
  const r = await env.DB.prepare(`SELECT * FROM events WHERE session_id = ? ORDER BY id`)
    .bind(sessionId)
    .all<EventRow>();
  return r.results;
}

export async function recentSessionEvents(env: Env, sessionId: number): Promise<EventRow[]> {
  const r = await env.DB.prepare(
    `SELECT * FROM events WHERE session_id = ? ORDER BY id DESC LIMIT 30`,
  )
    .bind(sessionId)
    .all<EventRow>();
  return r.results.reverse();
}

export async function fileCorrection(
  env: Env,
  userId: number,
  sessionId: number | null,
  description: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO corrections (user_id, session_id, description, status, created_at)
     VALUES (?, ?, ?, 'pending', ?)`,
  )
    .bind(userId, sessionId, description, now())
    .run();
}

export async function pendingCorrections(
  env: Env,
): Promise<{ id: number; user_id: number; description: string }[]> {
  const r = await env.DB.prepare(
    `SELECT id, user_id, description FROM corrections WHERE status = 'pending' ORDER BY id LIMIT 20`,
  ).all<{ id: number; user_id: number; description: string }>();
  return r.results;
}

export async function markCorrectionsProcessed(env: Env, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await env.DB.prepare(
    `UPDATE corrections SET status = 'processed' WHERE id IN (${ids.map(() => "?").join(",")})`,
  )
    .bind(...ids)
    .run();
}

// ---------------------------------------------------------------------------
// Notifications (agent-controlled, one living row per slot) / agent memory
// ---------------------------------------------------------------------------

export async function setNotification(
  env: Env,
  userId: number,
  slot: string,
  title: string,
  body: string | null,
): Promise<void> {
  const t = now();
  await env.DB.prepare(
    `INSERT INTO notifications (user_id, slot, title, body, read, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(user_id, slot) DO UPDATE SET
       title = excluded.title, body = excluded.body, read = 0, dismissed_at = NULL,
       updated_at = excluded.updated_at`,
  )
    .bind(userId, slot, title, body, t, t)
    .run();
}

/** Agent's clear = user's dismiss: keep the row as history. */
export async function clearNotification(env: Env, userId: number, slot: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE notifications SET dismissed_at = ? WHERE user_id = ? AND slot = ? AND dismissed_at IS NULL`,
  )
    .bind(now(), userId, slot)
    .run();
}

export async function dismissNotification(env: Env, userId: number, id: number): Promise<void> {
  await env.DB.prepare(`UPDATE notifications SET dismissed_at = ? WHERE id = ? AND user_id = ?`)
    .bind(now(), id, userId)
    .run();
}

/** Active (non-dismissed) notifications, newest first. */
export async function listNotifications(env: Env, userId: number): Promise<NotificationRow[]> {
  const r = await env.DB.prepare(
    `SELECT * FROM notifications WHERE user_id = ? AND dismissed_at IS NULL ORDER BY updated_at DESC`,
  )
    .bind(userId)
    .all<NotificationRow>();
  return r.results;
}

export async function getNotificationById(
  env: Env,
  userId: number,
  id: number,
): Promise<NotificationRow | null> {
  return env.DB.prepare(`SELECT * FROM notifications WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .first<NotificationRow>();
}

export async function getBriefing(env: Env, userId: number): Promise<BriefingRow | null> {
  return env.DB.prepare(`SELECT * FROM briefings WHERE user_id = ?`)
    .bind(userId)
    .first<BriefingRow>();
}

export async function setBriefing(env: Env, userId: number, contentJson: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO briefings (user_id, content_json, generated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET content_json = excluded.content_json, generated_at = excluded.generated_at`,
  )
    .bind(userId, contentJson, now())
    .run();
}

export async function saveMemory(env: Env, userId: number, key: string, content: string): Promise<void> {
  if (!content.trim()) {
    await env.DB.prepare(`DELETE FROM agent_memory WHERE user_id = ? AND key = ?`)
      .bind(userId, key)
      .run();
    return;
  }
  await env.DB.prepare(
    `INSERT INTO agent_memory (user_id, key, content, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
  )
    .bind(userId, key, content.trim(), now())
    .run();
}

export async function listMemories(env: Env, userId: number): Promise<AgentMemoryRow[]> {
  const r = await env.DB.prepare(
    `SELECT * FROM agent_memory WHERE user_id = ? ORDER BY key`,
  )
    .bind(userId)
    .all<AgentMemoryRow>();
  return r.results;
}

export async function enabledUsers(env: Env): Promise<UserRow[]> {
  const r = await env.DB.prepare(`SELECT * FROM users WHERE enabled = 1`).all<UserRow>();
  return r.results;
}

export async function getLearnings(env: Env, userId: number): Promise<string> {
  const row = await env.DB.prepare(`SELECT content FROM learnings WHERE user_id = ?`)
    .bind(userId)
    .first<{ content: string }>();
  return row?.content ?? "";
}

export async function setLearnings(env: Env, userId: number, content: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO learnings (user_id, content, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
  )
    .bind(userId, content, now())
    .run();
}
