export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  AI: Ai;
  ANTHROPIC_API_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  /** Comma-separated emails auto-enabled on first sign-in. */
  ALLOWLIST_EMAILS: string;
  TIMEZONE: string;
  /** Web push (unset = push disabled). */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  /** Email Routing send binding (unset = no signup emails). */
  NOTIFY?: { send(message: unknown): Promise<void> };
}

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

export type TodoStatus = "idea" | "in_progress" | "done" | "abandoned";
export type ActionStatus = "scheduled" | "in_progress" | "done" | "skipped" | "canceled";
export type ProjectKind = "bounded" | "ongoing";
export type LogKind = "log" | "reflection";
export type EntityType = "project" | "todo" | "action" | "log";

export interface UserRow {
  id: number;
  google_sub: string | null;
  email: string;
  name: string | null;
  enabled: number;
  timezone: string | null;
  last_checkin_at: number | null;
  /** JSON: {"model": "sonnet"|"haiku", "thinking": boolean} */
  agent_config: string | null;
  created_at: number;
}

export interface ProjectRow {
  id: number;
  user_id: number;
  name: string;
  description: string | null;
  priority: string | null;
  kind: ProjectKind;
  status: "active" | "paused" | "completed" | "abandoned";
  created_at: number;
  updated_at: number;
}

export interface TodoRow {
  id: number;
  user_id: number;
  project_id: number | null;
  title: string;
  outcome: string | null;
  details: string | null;
  status: TodoStatus;
  /** When scheduled: epoch ts; local midnight when all_day. */
  scheduled_start: number | null;
  /** 1 = day-level ("any time" that day), no specific hour. */
  all_day: number;
  created_at: number;
  updated_at: number;
}

export interface ActionRow {
  id: number;
  user_id: number;
  todo_id: number | null;
  project_id: number | null;
  title: string | null;
  scheduled_start: number | null;
  scheduled_end: number | null;
  started_at: number | null;
  ended_at: number | null;
  status: ActionStatus;
  /** 1 = day-level schedule; scheduled_start is local midnight of the day. */
  all_day: number;
  gcal_event_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface LogRow {
  id: number;
  user_id: number;
  message_id: number | null;
  todo_id: number | null;
  action_id: number | null;
  project_id: number | null;
  kind: LogKind;
  title: string | null;
  summary: string;
  quotes_json: string | null;
  delivery_json: string | null;
  occurred_at: number;
  created_at: number;
}

export interface SessionRow {
  id: number;
  user_id: number;
  context_type: EntityType | null;
  context_id: number | null;
  /** Set when the context is a past chat ("talk about this conversation"). */
  about_session_id: number | null;
  /** 'plan' = day-planning session (planning prompt addendum). */
  mode: string | null;
  /** Set when the session started from a notification's reply button. */
  re_notification_id: number | null;
  /** Briefing text this session was opened to talk about (loose threads). */
  seed_text: string | null;
  started_at: number;
  ended_at: number | null;
}

/** A schedule slot joined with its todo (slot fields aliased slot_*). */
export interface ScheduleRow extends TodoRow {
  schedule_id: number;
  slot_start: number;
  slot_all_day: number;
  slot_status: string;
}

export interface TodoScheduleRow {
  id: number;
  user_id: number;
  todo_id: number;
  scheduled_start: number;
  all_day: number;
  status: string;
  created_at: number;
}

export interface NotificationRow {
  id: number;
  user_id: number;
  slot: string;
  title: string;
  body: string | null;
  read: number;
  dismissed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface BriefingRow {
  user_id: number;
  content_json: string;
  generated_at: number;
  cost_usd: number | null;
  /** {day: [{key,label}]} — Today-view entries hidden by the user (or re-hidden by the generator). */
  dismissed_json: string | null;
}

export interface AgentMemoryRow {
  id: number;
  user_id: number;
  key: string;
  content: string;
  updated_at: number;
}

export interface MessageRow {
  id: number;
  session_id: number;
  role: "user" | "assistant";
  text: string | null;
  /** Assistant only: the model's (summarized) thinking for this turn. */
  thinking: string | null;
  /** Assistant only: id of the user message this reply answers. */
  reply_to: number | null;
  /** Assistant only: ask_user questions (JSON), rendered as chips. */
  questions_json: string | null;
  /** Assistant only: interleaved timeline of text + feed items (JSON). */
  parts_json: string | null;
  created_at: number;
}

export interface AudioSegmentRow {
  id: number;
  message_id: number;
  seq: number;
  r2_key: string;
  duration_sec: number | null;
  transcript: string | null;
  words_json: string | null;
  created_at: number;
}

export interface EventRow {
  id: number;
  user_id: number;
  session_id: number | null;
  message_id: number | null;
  entity_type: EntityType;
  entity_id: number;
  kind: "created" | "updated" | "status_changed" | "linked" | "deleted" | "undone";
  log_id: number | null;
  payload_json: string | null;
  undone: number;
  created_at: number;
}

/** One line of the post-utterance change feed shown to the user.
 * event_id 0 = synthetic (no audit row, not undoable — e.g. briefing update). */
export interface ChangeFeedItem {
  event_id: number;
  entity_type: EntityType | "briefing" | "schedule";
  entity_id: number;
  kind: string;
  label: string;
}
