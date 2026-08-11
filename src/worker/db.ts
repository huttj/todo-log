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
  ScheduleRow,
  TodoScheduleRow,
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

/** Schedule slots (joined with their todos) inside a time range — the
 * Today/schedule surface. A todo can appear once per slot. */
export async function listSchedule(
  env: Env,
  userId: number,
  range: { from: number; to: number },
): Promise<ScheduleRow[]> {
  const r = await env.DB.prepare(
    `SELECT s.id AS schedule_id, s.scheduled_start AS slot_start, s.all_day AS slot_all_day,
            s.status AS slot_status, t.*
     FROM todo_schedules s JOIN todos t ON t.id = s.todo_id AND t.user_id = s.user_id
     WHERE s.user_id = ? AND s.scheduled_start >= ? AND s.scheduled_start < ?
     ORDER BY s.all_day DESC, s.scheduled_start`,
  )
    .bind(userId, range.from, range.to)
    .all<ScheduleRow>();
  return r.results;
}

export async function createSlot(
  env: Env,
  userId: number,
  todoId: number,
  scheduledStart: number,
  allDay: boolean,
): Promise<TodoScheduleRow> {
  return insertRow<TodoScheduleRow>(env, "todo_schedules", {
    user_id: userId,
    todo_id: todoId,
    scheduled_start: scheduledStart,
    all_day: allDay ? 1 : 0,
    status: "planned",
    created_at: now(),
  });
}

export async function getSlot(env: Env, userId: number, id: number): Promise<TodoScheduleRow | null> {
  return env.DB.prepare(`SELECT * FROM todo_schedules WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .first<TodoScheduleRow>();
}

/** Future planned slots for a todo (excluding one slot, e.g. the one just
 * completed) — used to decide whether finishing a slot finishes the todo. */
export async function otherPlannedSlots(
  env: Env,
  userId: number,
  todoId: number,
  excludeSlotId: number,
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM todo_schedules
     WHERE user_id = ? AND todo_id = ? AND id != ? AND status = 'planned' AND scheduled_start >= ?`,
  )
    .bind(userId, todoId, excludeSlotId, now() - 86400)
    .first<{ n: number }>();
  return row?.n ?? 0;
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
  // Entity pages also surface logs from turns that touched the entity (via the
  // audit trail) — with one log per utterance, direct attachment alone would
  // hide the story from every entity but the one the log attached to.
  if (filter.todoId) {
    conds.push(
      `(todo_id = ? OR (message_id IS NOT NULL AND message_id IN
        (SELECT message_id FROM events WHERE entity_type = 'todo' AND entity_id = ? AND message_id IS NOT NULL)))`,
    );
    binds.push(filter.todoId, filter.todoId);
  }
  if (filter.actionId) (conds.push("action_id = ?"), binds.push(filter.actionId));
  if (filter.projectId) {
    conds.push(
      `(project_id = ?
        OR todo_id IN (SELECT id FROM todos WHERE user_id = ? AND project_id = ?)
        OR (message_id IS NOT NULL AND message_id IN
        (SELECT message_id FROM events WHERE entity_type = 'project' AND entity_id = ? AND message_id IS NOT NULL)))`,
    );
    binds.push(filter.projectId, userId, filter.projectId, filter.projectId);
  }
  if (filter.from) (conds.push("occurred_at >= ?"), binds.push(filter.from));
  if (filter.to) (conds.push("occurred_at < ?"), binds.push(filter.to));
  const r = await env.DB.prepare(
    `SELECT logs.*,
       (SELECT SUM(lu.cost_usd) FROM llm_usage lu WHERE lu.message_id = logs.message_id) AS cost_usd
     FROM logs WHERE ${conds.join(" AND ")} ORDER BY occurred_at DESC LIMIT ?`,
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
    seedText?: string | null;
  },
): Promise<SessionRow> {
  return insertRow<SessionRow>(env, "sessions", {
    user_id: userId,
    context_type: context.type,
    context_id: context.id,
    about_session_id: context.aboutSessionId ?? null,
    mode: context.mode ?? null,
    re_notification_id: context.reNotificationId ?? null,
    seed_text: context.seedText ?? null,
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
    `SELECT * FROM audio_segments WHERE transcript IS NULL AND transcribe_failures < 5
     AND created_at < ? ORDER BY id LIMIT ?`,
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

export async function setBriefing(
  env: Env,
  userId: number,
  contentJson: string,
  costUsd: number | null = null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO briefings (user_id, content_json, generated_at, cost_usd) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       prev_content_json = briefings.content_json,
       content_json = excluded.content_json,
       generated_at = excluded.generated_at,
       cost_usd = excluded.cost_usd`,
  )
    .bind(userId, contentJson, now(), costUsd)
    .run();
}

/** Swap current and previous briefing (undo doubles as redo). */
export async function undoBriefing(env: Env, userId: number): Promise<BriefingRow | null> {
  await env.DB.prepare(
    `UPDATE briefings SET content_json = prev_content_json, prev_content_json = content_json,
       generated_at = ? WHERE user_id = ? AND prev_content_json IS NOT NULL`,
  )
    .bind(now(), userId)
    .run();
  return getBriefing(env, userId);
}

// -- Today-view dismissals (JSON field on the briefing row) -----------------

type DismissMap = Record<string, { key: string; label: string | null }[]>;

async function readDismissMap(env: Env, userId: number): Promise<DismissMap> {
  const row = await env.DB.prepare(`SELECT dismissed_json FROM briefings WHERE user_id = ?`)
    .bind(userId)
    .first<{ dismissed_json: string | null }>();
  try {
    return row?.dismissed_json ? (JSON.parse(row.dismissed_json) as DismissMap) : {};
  } catch {
    return {};
  }
}

async function writeDismissMap(env: Env, userId: number, map: DismissMap): Promise<void> {
  // Prune days older than a week — dismissals are day-scoped.
  const floor = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  for (const d of Object.keys(map)) if (d < floor) delete map[d];
  // content_json 'null' is a valid empty briefing for rows created by a
  // dismissal before the first generation.
  await env.DB.prepare(
    `INSERT INTO briefings (user_id, content_json, generated_at, dismissed_json) VALUES (?, 'null', ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET dismissed_json = excluded.dismissed_json`,
  )
    .bind(userId, now(), JSON.stringify(map))
    .run();
}

export async function listDismissals(
  env: Env,
  userId: number,
  day: string,
): Promise<{ key: string; label: string | null }[]> {
  return (await readDismissMap(env, userId))[day] ?? [];
}

export async function setDismissal(
  env: Env,
  userId: number,
  day: string,
  key: string,
  label: string | null,
  dismissed: boolean,
): Promise<void> {
  const map = await readDismissMap(env, userId);
  const list = (map[day] ?? []).filter((x) => x.key !== key);
  if (dismissed) list.push({ key, label });
  map[day] = list;
  await writeDismissMap(env, userId, map);
}

/** Batch-add (the generator's re-hidden lines land in one write). */
export async function addDismissals(
  env: Env,
  userId: number,
  day: string,
  entries: { key: string; label: string | null }[],
): Promise<void> {
  if (entries.length === 0) return;
  const map = await readDismissMap(env, userId);
  const list = map[day] ?? [];
  for (const e of entries) {
    if (!list.some((x) => x.key === e.key)) list.push(e);
  }
  map[day] = list;
  await writeDismissMap(env, userId, map);
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
