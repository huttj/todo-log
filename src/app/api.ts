export interface Me {
  id: number;
  email: string;
  name: string | null;
  enabled: boolean;
}

export interface Project {
  id: number;
  name: string;
  description: string | null;
  kind: "bounded" | "ongoing";
  status: "active" | "paused" | "completed" | "abandoned";
}

export interface Todo {
  id: number;
  project_id: number | null;
  title: string;
  outcome: string | null;
  details: string | null;
  status: "idea" | "scheduled" | "in_progress" | "done" | "abandoned";
  updated_at: number;
}

export interface Action {
  id: number;
  todo_id: number | null;
  project_id: number | null;
  title: string | null;
  scheduled_start: number | null;
  scheduled_end: number | null;
  started_at: number | null;
  ended_at: number | null;
  status: "scheduled" | "in_progress" | "done" | "skipped" | "canceled";
  all_day: number;
  created_at: number;
}

export interface AppNotification {
  id: number;
  slot: string;
  title: string;
  body: string | null;
  read: number;
  updated_at: number;
}

export interface Briefing {
  headline: string;
  today: string[];
  tomorrow: string[];
  projects: { project_id: number | null; name: string; line: string }[];
  oneoffs: string[];
  week: string[];
}

export interface Log {
  id: number;
  message_id: number | null;
  todo_id: number | null;
  action_id: number | null;
  project_id: number | null;
  kind: "log" | "reflection";
  summary: string;
  quotes_json: string | null;
  delivery_json: string | null;
  occurred_at: number;
}

export interface Quote {
  text: string;
  segment_id: number | null;
  start?: number | null;
  end?: number | null;
}

export interface EventRecord {
  id: number;
  message_id?: number | null;
  entity_type: string;
  entity_id: number;
  kind: string;
  payload_json: string | null;
  undone: number;
  created_at: number;
}

export interface LogTranscript {
  segments: { id: number; seq: number; transcript: string | null }[];
}

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

export interface SegmentDetail {
  id: number;
  transcript: string | null;
  duration_sec: number | null;
  words: TranscriptWord[] | null;
}

export interface CaptureSession {
  id: number;
  context_type: string | null;
  context_id: number | null;
  about_session_id?: number | null;
  ended_at: number | null;
}

export interface SessionSummary extends CaptureSession {
  started_at: number;
  message_count: number;
  first_text: string | null;
}

export interface Message {
  id: number;
  session_id: number;
  role: "user" | "assistant";
  text: string | null;
  thinking?: string | null;
  reply_to?: number | null;
}

export interface Segment {
  id: number;
  seq: number;
  transcript: string | null;
  duration_sec: number | null;
}

export interface FeedItem {
  event_id: number;
  entity_type: string;
  entity_id: number;
  kind: string;
  label: string;
}

export interface SendResult {
  text: string;
  reply: string;
  feed: FeedItem[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, init);
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return api<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body != null ? JSON.stringify(body) : "{}",
  });
}

export function del<T>(path: string): Promise<T> {
  return api<T>(path, { method: "DELETE" });
}

export function patch<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function uploadSegment(
  messageId: number,
  seq: number,
  durationSec: number,
  blob: Blob,
): Promise<Segment> {
  const res = await fetch(
    `/api/messages/${messageId}/segments?seq=${seq}&duration=${durationSec.toFixed(1)}`,
    { method: "POST", headers: { "content-type": blob.type || "audio/webm" }, body: blob },
  );
  if (!res.ok) throw new ApiError(res.status, "segment upload failed");
  return res.json() as Promise<Segment>;
}
