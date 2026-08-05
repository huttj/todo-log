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
}

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

export type TodoStatus = "idea" | "scheduled" | "in_progress" | "done" | "abandoned";
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
  created_at: number;
}

export interface ProjectRow {
  id: number;
  user_id: number;
  name: string;
  description: string | null;
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
  started_at: number;
  ended_at: number | null;
}

export interface MessageRow {
  id: number;
  session_id: number;
  role: "user" | "assistant";
  text: string | null;
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

/** One line of the post-utterance change feed shown to the user. */
export interface ChangeFeedItem {
  event_id: number;
  entity_type: EntityType;
  entity_id: number;
  kind: string;
  label: string;
}
