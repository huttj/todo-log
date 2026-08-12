// The AIO agent: takes one user utterance in a session, applies changes to the
// user's data through tools (recording an audit event per change), and returns
// a terse reply plus the change feed. Corrections are conversational — the
// agent applies fixes immediately and files a corrections row for the
// out-of-band learnings distillation.
import Anthropic from "@anthropic-ai/sdk";
import type {
  Env,
  UserRow,
  SessionRow,
  ProjectRow,
  TodoRow,
  ScheduleRow,
  LogRow,
  ChangeFeedItem,
  EntityType,
} from "./types";
import { emptyUsage, addUsage, recordUsage, computeCost } from "./usage";
import { BRIEFING_STYLE, rehiddenEntries, stripInvalidRefs, type Briefing } from "./briefing";
import { resolveUseCase, modelParams, parseConfig } from "./config";
import {
  now,
  insertRow,
  updateRow,
  getEntity,
  getSession,
  listProjects,
  listTodos,
  listTodosForProject,
  listSchedule,
  createSlot,
  getSlot,
  listLogs,
  searchAll,
  insertEvent,
  fileCorrection,
  getLearnings,
  setNotification,
  clearNotification,
  listNotifications,
  getNotificationById,
  getBriefing,
  setBriefing,
  listDismissals,
  addDismissals,
  saveMemory,
  listMemories,
  recentSessionEvents,
  sessionMessages,
  conversationOrder,
  messageSegments,
} from "./db";

// Opt-in via Settings (chat_briefing_updates): chats may rewrite the overview.
const UPDATE_BRIEFING_TOOL: Anthropic.Tool = {
  name: "update_briefing",
  description:
    "Rewrite the Today-view briefing (replaces it whole — include every section, not just what changed). Fetch the current briefing first (fetch, entity_type \"briefing\") if you haven't seen it this conversation, so unchanged sections carry forward. Call when this conversation meaningfully changes what today or the week looks like: new plans, finished/dropped items, a shifted picture of a project, or an answered question in it. Don't call for minor bookkeeping. Main lists hold only what deserves attention; the rest goes in the _more lists (behind \"see more\").\n" +
    BRIEFING_STYLE,
  input_schema: {
    type: "object",
    properties: {
      headline: { type: "string", description: "One honest line about what today looks like" },
      today: { type: "array", items: { type: "string" }, description: "Actionable plans/commitments for today and tonight" },
      today_more: { type: "array", items: { type: "string" } },
      oneoffs: {
        type: "array",
        items: { type: "string" },
        description: "Loose threads: commitments living only in logs — phrase assumed states as questions",
      },
      oneoffs_more: { type: "array", items: { type: "string" } },
      coming: { type: "array", items: { type: "string" }, description: "Tomorrow and the days ahead; also pure timing/status info" },
      coming_more: { type: "array", items: { type: "string" } },
      projects: {
        type: "array",
        items: {
          type: "object",
          properties: {
            project_id: { type: ["integer", "null"] },
            name: { type: "string" },
            line: { type: "string", description: "Momentum + one suggested next step, ≤ 20 words" },
          },
          required: ["name", "line"],
        },
      },
      projects_more: {
        type: "array",
        items: {
          type: "object",
          properties: {
            project_id: { type: ["integer", "null"] },
            name: { type: "string" },
            line: { type: "string" },
          },
          required: ["name", "line"],
        },
      },
      rehidden: {
        type: "array",
        items: { type: "string" },
        description:
          "Exact copies of lines from THIS rewrite that are the same underlying item as one the user dismissed (fetch the briefing to see dismissed_today) — they stay hidden after the update.",
      },
    },
    required: ["headline"],
  },
};

// Model + thinking come from per-user settings (worker/config.ts).
const MAX_TOOL_ITERATIONS = 8;
const DAY = 86400;

// ---------------------------------------------------------------------------
// Time helpers (Cyborgy pattern): give the model an offset-aware "now" so it
// can resolve "yesterday" / "at 3pm" into concrete timestamps.
// ---------------------------------------------------------------------------

function nowInZone(tz: string): { iso: string; pretty: string } {
  const ref = new Date();
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      weekday: "long",
      timeZoneName: "longOffset",
    })
      .formatToParts(ref)
      .map((p) => [p.type, p.value]),
  );
  const offset = (parts.timeZoneName ?? "GMT+00:00").replace("GMT", "") || "+00:00";
  const iso = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
  const pretty = `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} (${tz})`;
  return { iso, pretty };
}

function parseWhen(v: unknown): number | null {
  if (v == null) return null;
  const ms = Date.parse(String(v));
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/** Epoch of local midnight for a YYYY-MM-DD in the given timezone. Uses the
 * zone's current UTC offset — DST edges within a day of the boundary are an
 * acceptable error for day-level scheduling. */
function dayStartInZone(tz: string, date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const { iso } = nowInZone(tz);
  const offset = iso.slice(19); // "+HH:MM" tail of the ISO timestamp
  const ms = Date.parse(`${date}T00:00:00${offset}`);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const WHEN = { type: ["string", "null"], description: "ISO 8601 with timezone offset" };
const ID = { type: ["integer", "null"] };

const TOOLS: Anthropic.Tool[] = [
  {
    name: "create_project",
    description:
      "Create a new project (area of focus). Only when the user names something clearly new — check the existing project list first.",
    input_schema: {
      type: "object",
      properties: {
        priority: {
          type: ["string", "null"],
          description: "Where this sits for the user, their own words ('urgent but I hate it', 'matters, but later this year'). Set when they say it.",
        },
        name: { type: "string" },
        description: { type: ["string", "null"] },
        kind: { type: "string", enum: ["bounded", "ongoing"] },
      },
      required: ["name", "kind"],
    },
  },
  {
    name: "update_project",
    description: "Update a project's fields. Only include fields that change.",
    input_schema: {
      type: "object",
      properties: {
        priority: { type: ["string", "null"] },
        project_id: { type: "integer" },
        name: { type: ["string", "null"] },
        description: { type: ["string", "null"] },
        kind: { type: ["string", "null"], enum: ["bounded", "ongoing", null] },
        status: { type: ["string", "null"], enum: ["active", "paused", "completed", "abandoned", null] },
      },
      required: ["project_id"],
    },
  },
  {
    name: "create_todo",
    description:
      "Create a todo. `title` is an imperative verb phrase ('Walk the dog' — never 'Walked' or 'Walking'). `outcome` is what done looks like; `details` holds constraints, fears, dependencies. `project_id` is optional — standalone todos are normal; never skip creating a stated task just because no project fits. Scheduling: `scheduled_date` (YYYY-MM-DD) for a day-level plan when the user names a day but no time — never invent an hour; `scheduled_start` (ISO with offset) only when they give an actual time. This creates a schedule slot; use schedule_todo to add more slots later (the same todo can be scheduled many times).",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        outcome: { type: ["string", "null"] },
        details: { type: ["string", "null"] },
        project_id: ID,
        scheduled_date: { type: ["string", "null"], description: "YYYY-MM-DD, day-level (\"any time\" that day)" },
        scheduled_start: WHEN,
        status: {
          type: ["string", "null"],
          enum: ["idea", "in_progress", "done", "abandoned", null],
        },
      },
      required: ["title"],
    },
  },
  {
    name: "update_todo",
    description:
      "Update a todo. Only include fields that change. Status transitions should reflect reality (user started → in_progress, finished → done). For scheduling use schedule_todo / update_schedule.",
    input_schema: {
      type: "object",
      properties: {
        todo_id: { type: "integer" },
        title: { type: ["string", "null"] },
        outcome: { type: ["string", "null"] },
        details: { type: ["string", "null"] },
        project_id: ID,
        status: {
          type: ["string", "null"],
          enum: ["idea", "in_progress", "done", "abandoned", null],
        },
      },
      required: ["todo_id"],
    },
  },
  {
    name: "schedule_todo",
    description:
      "Add a schedule slot to a todo — the same todo can be scheduled multiple times (e.g. practice Tue AND Thu). `scheduled_date` (YYYY-MM-DD) for day-level (\"any time\" — never invent an hour), `scheduled_start` (ISO with offset) when the user gives a time. Scheduling never changes the todo's status — work state and time commitments are separate.",
    input_schema: {
      type: "object",
      properties: {
        todo_id: { type: "integer" },
        scheduled_date: { type: ["string", "null"], description: "YYYY-MM-DD, day-level" },
        scheduled_start: WHEN,
      },
      required: ["todo_id"],
    },
  },
  {
    name: "update_schedule",
    description:
      "Reschedule a slot or set its outcome. `status`: planned | done | skipped. Slot ids appear in the schedule context (slot#N). Marking a slot done does NOT finish the todo — update the todo separately if the whole task is done.",
    input_schema: {
      type: "object",
      properties: {
        schedule_id: { type: "integer" },
        scheduled_date: { type: ["string", "null"], description: "YYYY-MM-DD, day-level" },
        scheduled_start: WHEN,
        status: { type: ["string", "null"], enum: ["planned", "done", "skipped", null] },
      },
      required: ["schedule_id"],
    },
  },
  {
    name: "create_log",
    description:
      "File THE journal log for this utterance — one log per recording, covering everything said. `summary` is a compact paraphrase of all of it, subjectless or first-person (journal voice, never 'he/the user'); `quotes` are 0-3 verbatim sentences worth preserving exactly. Attach to the single most central todo/project (entity pages also surface logs from turns that touched them, so one attachment is enough).",
    input_schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short label, 2-6 words — the log's gist ('Van talk with mom'). Always provide one.",
        },
        summary: { type: "string" },
        kind: { type: ["string", "null"], enum: ["log", "reflection", null] },
        todo_id: ID,
        project_id: ID,
        quotes: { type: ["array", "null"], items: { type: "string" } },
        delivery_tags: {
          type: ["array", "null"],
          items: { type: "string" },
          description:
            "Observable speech features only (e.g. 'hedging', 'flowing', 'fragmented'), never diagnostic. Omit if nothing stands out.",
        },
        occurred_at: WHEN,
      },
      required: ["summary"],
    },
  },
  {
    name: "update_log",
    description:
      "Update or re-file an existing log: fix the summary/kind, or attach it to the right todo/project (e.g. after the user answers a clarifying question). Only include fields that change.",
    input_schema: {
      type: "object",
      properties: {
        log_id: { type: "integer" },
        title: { type: ["string", "null"] },
        summary: { type: ["string", "null"] },
        kind: { type: ["string", "null"], enum: ["log", "reflection", null] },
        todo_id: ID,
        project_id: ID,
      },
      required: ["log_id"],
    },
  },
  {
    name: "fetch",
    description:
      "Fetch full detail for one entity: the record plus its related todos and recent logs. Use when the context snapshot isn't enough. entity_type \"briefing\" returns the current Today-view overview (no id needed).",
    input_schema: {
      type: "object",
      properties: {
        entity_type: { type: "string", enum: ["project", "todo", "log", "briefing"] },
        id: { type: "integer" },
      },
      required: ["entity_type"],
    },
  },
  {
    name: "search",
    description:
      "Text-search the user's projects, todos, and logs. Use to find the right entity when it isn't in the context snapshot (e.g. older or closed items).",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "save_memory",
    description:
      "Persist a note to your long-term memory (shown to you at the start of every conversation). Keyed: writing an existing key overwrites it; empty content deletes it. Use for durable context — ongoing situations, people, preferences, how the user works — NOT for things already recorded as todos/logs.",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Short kebab-case topic, e.g. 'job-search', 'planning-habits'" },
        content: { type: ["string", "null"], description: "The note (a few sentences). Empty/null deletes the key." },
      },
      required: ["key"],
    },
  },
  {
    name: "set_notification",
    description:
      "Write or replace the in-app notification under `slot` (one living notification per slot — this overwrites, it never stacks). Use to leave the user a note they'll see when they next look at the app: a check-in question, a reminder about something left open. Keep it short and specific.",
    input_schema: {
      type: "object",
      properties: {
        slot: { type: "string", description: "Stable purpose key, e.g. 'checkin'" },
        title: { type: "string" },
        body: { type: ["string", "null"] },
      },
      required: ["slot", "title"],
    },
  },
  {
    name: "clear_notification",
    description: "Remove the notification in `slot` (e.g. its question has been answered).",
    input_schema: {
      type: "object",
      properties: { slot: { type: "string" } },
      required: ["slot"],
    },
  },
  {
    name: "ask_user",
    description:
      "Interrupt with one or more questions, each with optional short suggested answers rendered as tappable chips. Use whenever an answer would change what you do — attachment ambiguity, whether to schedule, how something went. After calling this, END your reply (a short lead-in sentence is fine); never repeat the questions in prose.",
    input_schema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              question: { type: "string" },
              suggestions: {
                type: ["array", "null"],
                items: { type: "string" },
                description: "2-4 short tappable answers, when natural options exist",
              },
            },
            required: ["question"],
          },
        },
      },
      required: ["questions"],
    },
  },
  {
    name: "file_correction",
    description:
      "Record that the user corrected your behavior or interpretation (what you got wrong, what they wanted). File it AND apply the fix with other tools.",
    input_schema: {
      type: "object",
      properties: { description: { type: "string" } },
      required: ["description"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

export interface AskedQuestion {
  question: string;
  suggestions: string[];
}

interface TurnState {
  env: Env;
  user: UserRow;
  session: SessionRow;
  messageId: number;
  feed: ChangeFeedItem[];
  createdLogIds: number[];
  questions: AskedQuestion[];
  onEvent?: (e: TurnEvent) => void;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

async function feedEvent(
  s: TurnState,
  entityType: EntityType,
  entityId: number,
  kind: string,
  label: string,
  payload?: unknown,
): Promise<void> {
  const e = await insertEvent(s.env, {
    userId: s.user.id,
    sessionId: s.session.id,
    messageId: s.messageId,
    entityType,
    entityId,
    kind,
    payload,
    logId: kind === "status_changed" ? (s.createdLogIds.at(-1) ?? null) : null,
  });
  const item: ChangeFeedItem = { event_id: e.id, entity_type: entityType, entity_id: entityId, kind, label };
  s.feed.push(item);
  s.onEvent?.({ type: "feed", item });
}

/** Build {before, after} diff and column map from allowed fields present in input. */
function collectUpdates(
  input: Record<string, unknown>,
  current: Record<string, unknown>,
  fields: { name: string; parse?: (v: unknown) => unknown }[],
): { cols: Record<string, unknown>; before: Record<string, unknown>; after: Record<string, unknown> } {
  const cols: Record<string, unknown> = {};
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const f of fields) {
    if (!(f.name in input) || input[f.name] == null) continue;
    const value = f.parse ? f.parse(input[f.name]) : input[f.name];
    if (value === current[f.name]) continue;
    cols[f.name] = value;
    before[f.name] = current[f.name];
    after[f.name] = value;
  }
  return { cols, before, after };
}

async function executeTool(s: TurnState, name: string, rawInput: unknown): Promise<string> {
  const input = (rawInput ?? {}) as Record<string, unknown>;
  const t = now();
  switch (name) {
    case "create_project": {
      const row = await insertRow<ProjectRow>(s.env, "projects", {
        priority: str(input.priority),
        user_id: s.user.id,
        name: str(input.name) ?? "Untitled project",
        description: str(input.description),
        kind: input.kind === "ongoing" ? "ongoing" : "bounded",
        status: "active",
        created_at: t,
        updated_at: t,
      });
      await feedEvent(s, "project", row.id, "created", `Created “${row.name}”`);
      return JSON.stringify({ project_id: row.id });
    }
    case "update_project": {
      const id = num(input.project_id);
      const current = id && (await getEntity<ProjectRow>(s.env, "project", s.user.id, id));
      if (!current) return "error: project not found";
      const { cols, before, after } = collectUpdates(input, current as never, [
        { name: "name" },
        { name: "description" },
        { name: "kind" },
        { name: "status" },
        { name: "priority" },
      ]);
      if (Object.keys(cols).length === 0) return "no changes";
      cols.updated_at = t;
      await updateRow(s.env, "projects", s.user.id, current.id, cols);
      const kind = "status" in cols ? "status_changed" : "updated";
      const label =
        "status" in cols
          ? `“${current.name}”: ${current.status} → ${cols.status}`
          : `Updated “${current.name}” (${Object.keys(after).join(", ")})`;
      await feedEvent(s, "project", current.id, kind, label, { before, after });
      return "ok";
    }
    case "create_todo": {
      const tz = s.user.timezone ?? s.env.TIMEZONE;
      const dayStart = str(input.scheduled_date) ? dayStartInZone(tz, str(input.scheduled_date)!) : null;
      const scheduledStart = dayStart ?? parseWhen(input.scheduled_start);
      const row = await insertRow<TodoRow>(s.env, "todos", {
        user_id: s.user.id,
        project_id: num(input.project_id),
        title: str(input.title) ?? "Untitled",
        outcome: str(input.outcome),
        details: str(input.details),
        status: (() => {
          const st = str(input.status);
          return st && st !== "scheduled" ? st : "idea";
        })(),
        created_at: t,
        updated_at: t,
      });
      let when = "";
      if (scheduledStart) {
        await createSlot(s.env, s.user.id, row.id, scheduledStart, !!dayStart);
        when = ` @ ${new Date(scheduledStart * 1000).toLocaleString("en-US", {
          timeZone: tz,
          ...(dayStart ? { weekday: "short", month: "short", day: "numeric" } : {}),
        })}${dayStart ? " (any time)" : ""}`;
      }
      await feedEvent(s, "todo", row.id, "created", `Created “${row.title}” (${String(row.status).replace(/_/g, " ")})${when}`);
      return JSON.stringify({ todo_id: row.id });
    }
    case "update_todo": {
      // "scheduled" retired as a status — scheduling lives in slots.
      if ((input as Record<string, unknown>).status === "scheduled") {
        delete (input as Record<string, unknown>).status;
      }
      const id = num(input.todo_id);
      const current = id && (await getEntity<TodoRow>(s.env, "todo", s.user.id, id));
      if (!current) return "error: todo not found";
      const { cols, before, after } = collectUpdates(input, current as never, [
        { name: "title" },
        { name: "outcome" },
        { name: "details" },
        { name: "project_id" },
        { name: "status" },
      ]);
      if (Object.keys(cols).length === 0) return "no changes";
      cols.updated_at = t;
      await updateRow(s.env, "todos", s.user.id, current.id, cols);
      const kind = "status" in cols ? "status_changed" : "updated";
      const label =
        "status" in cols
          ? `“${current.title}”: ${String(current.status).replace(/_/g, " ")} → ${String(cols.status).replace(/_/g, " ")}`
          : `Updated “${current.title}” (${Object.keys(after).join(", ")})`;
      await feedEvent(s, "todo", current.id, kind, label, { before, after });
      return "ok";
    }
    case "schedule_todo": {
      const todoId = num(input.todo_id);
      const todo = todoId && (await getEntity<TodoRow>(s.env, "todo", s.user.id, todoId));
      if (!todo) return "error: todo not found";
      const tz = s.user.timezone ?? s.env.TIMEZONE;
      const dayStart = str(input.scheduled_date) ? dayStartInZone(tz, str(input.scheduled_date)!) : null;
      const startAt = dayStart ?? parseWhen(input.scheduled_start);
      if (startAt == null) return "error: scheduled_date or scheduled_start required";
      const slot = await createSlot(s.env, s.user.id, todo.id, startAt, !!dayStart);
      const when = `${new Date(startAt * 1000).toLocaleString("en-US", {
        timeZone: tz,
        ...(dayStart ? { weekday: "short", month: "short", day: "numeric" } : {}),
      })}${dayStart ? " (any time)" : ""}`;
      const item: ChangeFeedItem = {
        event_id: 0,
        entity_type: "schedule",
        entity_id: slot.id,
        kind: "scheduled",
        label: `Scheduled “${todo.title}” — ${when}`,
      };
      s.feed.push(item);
      s.onEvent?.({ type: "feed", item });
      return JSON.stringify({ schedule_id: slot.id });
    }
    case "update_schedule": {
      const slotId = num(input.schedule_id);
      const slot = slotId && (await getSlot(s.env, s.user.id, slotId));
      if (!slot) return "error: schedule slot not found";
      const tz = s.user.timezone ?? s.env.TIMEZONE;
      const dayStart = str(input.scheduled_date) ? dayStartInZone(tz, str(input.scheduled_date)!) : null;
      const startAt = dayStart ?? parseWhen(input.scheduled_start);
      const cols: Record<string, unknown> = {};
      if (startAt != null) {
        cols.scheduled_start = startAt;
        cols.all_day = dayStart ? 1 : 0;
      }
      const status = str(input.status);
      if (status && ["planned", "done", "skipped"].includes(status)) cols.status = status;
      if (Object.keys(cols).length === 0) return "no changes";
      await s.env.DB.prepare(
        `UPDATE todo_schedules SET ${Object.keys(cols)
          .map((k) => `${k} = ?`)
          .join(", ")} WHERE id = ? AND user_id = ?`,
      )
        .bind(...Object.values(cols), slot.id, s.user.id)
        .run();
      const todo = await getEntity<TodoRow>(s.env, "todo", s.user.id, slot.todo_id);
      const label =
        status && status !== "planned"
          ? `Slot for “${todo?.title ?? slot.todo_id}”: ${status}`
          : `Rescheduled “${todo?.title ?? slot.todo_id}”`;
      const item: ChangeFeedItem = {
        event_id: 0,
        entity_type: "schedule",
        entity_id: slot.id,
        kind: "scheduled",
        label,
      };
      s.feed.push(item);
      s.onEvent?.({ type: "feed", item });
      return "ok";
    }
    case "create_log": {
      const quotes = Array.isArray(input.quotes)
        ? (input.quotes as unknown[]).filter((q): q is string => typeof q === "string")
        : [];
      const quotesJson = quotes.length
        ? JSON.stringify(await resolveQuotes(s, quotes))
        : null;
      const tags = Array.isArray(input.delivery_tags)
        ? (input.delivery_tags as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      const row = await insertRow<LogRow>(s.env, "logs", {
        user_id: s.user.id,
        message_id: s.messageId,
        todo_id: num(input.todo_id),
        action_id: null,
        project_id: num(input.project_id),
        kind: input.kind === "reflection" ? "reflection" : "log",
        title: str(input.title),
        summary: str(input.summary) ?? "(empty)",
        quotes_json: quotesJson,
        delivery_json: tags.length ? JSON.stringify({ tags }) : null,
        occurred_at: parseWhen(input.occurred_at) ?? t,
        created_at: t,
      });
      s.createdLogIds.push(row.id);
      await feedEvent(s, "log", row.id, "created", `${row.kind === "reflection" ? "Reflection" : "Logged"}: ${row.title ?? row.summary}`);
      return JSON.stringify({ log_id: row.id });
    }
    case "update_log": {
      const id = num(input.log_id);
      const current = id && (await getEntity<LogRow>(s.env, "log", s.user.id, id));
      if (!current) return "error: log not found";
      const { cols, before, after } = collectUpdates(input, current as never, [
        { name: "title" },
        { name: "summary" },
        { name: "kind" },
        { name: "todo_id" },
        { name: "project_id" },
      ]);
      if (Object.keys(cols).length === 0) return "no changes";
      await updateRow(s.env, "logs", s.user.id, current.id, cols);
      const attachChanged = "todo_id" in cols || "project_id" in cols;
      const label = attachChanged
        ? `Re-filed: ${(cols.title as string) ?? current.title ?? (cols.summary as string) ?? current.summary}`
        : `Updated (${Object.keys(after).join(", ")})`;
      await feedEvent(s, "log", current.id, "updated", label, { before, after });
      return "ok";
    }
    case "fetch": {
      if (str(input.entity_type) === "briefing") {
        const b = await getBriefing(s.env, s.user.id);
        if (!b) return "no briefing computed yet";
        const day = new Intl.DateTimeFormat("en-CA", {
          timeZone: s.user.timezone ?? s.env.TIMEZONE,
        }).format(new Date(now() * 1000));
        const hidden = await listDismissals(s.env, s.user.id, day);
        return JSON.stringify({
          briefing: JSON.parse(b.content_json),
          dismissed_today: hidden.map(
            (h) => `${h.why === "done" ? "[marked done] " : "[hidden for today] "}${h.label ?? h.key}`,
          ),
        });
      }
      const type = str(input.entity_type) as EntityType | null;
      const id = num(input.id);
      if (!type || !id || !["project", "todo", "log"].includes(type)) {
        return "error: entity_type and id required";
      }
      const entity = await getEntity<Record<string, unknown>>(s.env, type, s.user.id, id);
      if (!entity) return `error: ${type} #${id} not found`;
      const related: Record<string, unknown> = { [type]: entity };
      if (type === "project") {
        related.todos = (await listTodosForProject(s.env, s.user.id, id)).slice(0, 30);
        related.recent_logs = await listLogs(s.env, s.user.id, { projectId: id, limit: 10 });
      } else if (type === "todo") {
        related.recent_logs = await listLogs(s.env, s.user.id, { todoId: id, limit: 10 });
      }
      return JSON.stringify(related);
    }
    case "search": {
      const q = str(input.query);
      if (!q) return "error: query required";
      return JSON.stringify(await searchAll(s.env, s.user.id, q));
    }
    case "update_briefing": {
      const headline = str(input.headline);
      if (!headline) return "error: headline required";
      const arr = (v: unknown) =>
        Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === "string") : [];
      const projArr = (v: unknown) =>
        Array.isArray(v)
          ? (v as Record<string, unknown>[])
              .filter((p) => typeof p.name === "string" && typeof p.line === "string")
              .map((p) => ({
                project_id: typeof p.project_id === "number" ? p.project_id : null,
                name: p.name as string,
                line: p.line as string,
              }))
          : [];
      const next: Briefing = await stripInvalidRefs(s.env, s.user.id, {
        headline,
        today: arr(input.today),
        today_more: arr(input.today_more),
        oneoffs: arr(input.oneoffs),
        oneoffs_more: arr(input.oneoffs_more),
        coming: arr(input.coming),
        coming_more: arr(input.coming_more),
        projects: projArr(input.projects),
        projects_more: projArr(input.projects_more),
      });
      await setBriefing(s.env, s.user.id, JSON.stringify(next));
      const day = new Intl.DateTimeFormat("en-CA", {
        timeZone: s.user.timezone ?? s.env.TIMEZONE,
      }).format(new Date(now() * 1000));
      await addDismissals(s.env, s.user.id, day, rehiddenEntries(next, arr(input.rehidden))).catch(
        () => {},
      );
      const item: ChangeFeedItem = {
        event_id: 0,
        entity_type: "briefing",
        entity_id: 0,
        kind: "briefing_updated",
        label: "Updated today's briefing",
      };
      s.feed.push(item);
      s.onEvent?.({ type: "feed", item });
      return "briefing updated";
    }
    case "save_memory": {
      const key = str(input.key);
      if (!key) return "error: key required";
      await saveMemory(s.env, s.user.id, key, str(input.content) ?? "");
      return str(input.content) ? "saved" : "deleted";
    }
    case "set_notification": {
      const slot = str(input.slot);
      const title = str(input.title);
      if (!slot || !title) return "error: slot and title required";
      await setNotification(s.env, s.user.id, slot, title, str(input.body));
      return "set";
    }
    case "clear_notification": {
      const slot = str(input.slot);
      if (!slot) return "error: slot required";
      await clearNotification(s.env, s.user.id, slot);
      return "cleared";
    }
    case "ask_user": {
      const qs: AskedQuestion[] = Array.isArray(input.questions)
        ? (input.questions as Record<string, unknown>[])
            .map((q) => ({
              question: str(q.question) ?? "",
              suggestions: Array.isArray(q.suggestions)
                ? (q.suggestions as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 5)
                : [],
            }))
            .filter((q) => q.question)
            .slice(0, 3)
        : [];
      if (qs.length === 0) return "error: questions required";
      s.questions.push(...qs);
      s.onEvent?.({ type: "questions", questions: qs });
      return "asked — end your reply now; the user's next message answers these";
    }
    case "file_correction": {
      const description = str(input.description);
      if (description) await fileCorrection(s.env, s.user.id, s.session.id, description);
      return "filed";
    }
    default:
      return `error: unknown tool ${name}`;
  }
}

const normText = (x: string) =>
  x.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

/** Find the quote's word-level time span inside a segment's word timestamps. */
function findWordSpan(
  words: { word: string; start: number; end: number }[],
  quote: string,
): { start: number; end: number } | null {
  const quoteWords = normText(quote).split(" ").filter(Boolean);
  if (quoteWords.length === 0) return null;
  const segWords = words.map((w) => normText(w.word));
  for (let i = 0; i + quoteWords.length <= segWords.length; i++) {
    let match = true;
    for (let j = 0; j < quoteWords.length; j++) {
      if (segWords[i + j] !== quoteWords[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      return { start: words[i].start, end: words[i + quoteWords.length - 1].end };
    }
  }
  return null;
}

/** Map verbatim quotes back to the audio segment (and word-level time span)
 * that contains them, so the UI can play and show exactly that slice. */
async function resolveQuotes(
  s: TurnState,
  quotes: string[],
): Promise<{ text: string; segment_id: number | null; start: number | null; end: number | null }[]> {
  const segments = await messageSegments(s.env, s.messageId);
  return quotes.map((q) => {
    for (const seg of segments) {
      if (!seg.transcript || !normText(seg.transcript).includes(normText(q))) continue;
      let start: number | null = null;
      let end: number | null = null;
      if (seg.words_json) {
        try {
          const span = findWordSpan(JSON.parse(seg.words_json), q);
          if (span) ({ start, end } = span);
        } catch {
          // no usable word timestamps — segment-level linking still works
        }
      }
      return { text: q, segment_id: seg.id, start, end };
    }
    return { text: q, segment_id: null, start: null, end: null };
  });
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the agent inside Todo Log, a todo list that doubles as a journal. The user talks to you — often rambling voice notes recorded mid-task, the way they'd rant to a coworker — and you keep their system up to date.

Ontology: PROJECTS are areas of focus (bounded = has an end state; ongoing = never completes). TODOS are tasks with a describable outcome, optionally under a project — a todo can carry a schedule (a day, or a specific time). LOGS are the journal and the record of what actually happened, attached to the todo/project they concern. A "reflection" is a log about how it's going (feelings, worth, direction), not just what happened.

How you behave:
- APPLY CHANGES IMMEDIATELY via tools. There is no confirmation step — the user corrects you by talking more. When corrected: apply the fix AND call file_correction.
- Thinking adds latency and cost. Most utterances are routine filing — one log, a status change, an obvious attachment — handle those directly with minimal deliberation. Reserve longer thinking for genuinely ambiguous restructuring or planning.
- ONE LOG PER UTTERANCE: every recording produces exactly ONE log capturing everything said, with a short title (its gist in 2-6 words) — never split one utterance into multiple topical logs. Attach it to the single most central todo/project (entity pages also surface logs from any turn that touched them, so one attachment covers the rest). Also update statuses to match reality: starting → in_progress, finished → done.
- Be silent-by-default in spirit: NO advice, opinions, or coaching unless the user directly asks. When asked, answer concisely using the context below.
- Your reply is a terse confirmation, 1-2 short sentences. The UI already shows a change feed of your tool calls — don't enumerate them again. If nothing needed doing, say so briefly.
- LINKS IN REPLIES: when your reply mentions a todo/project/log, wrap the words of YOUR sentence markdown-style — "filed it under [the kitchen project](project:3)" — and the app renders them as links. Never bare tokens like [todo:22], never pasted entity titles as citations.
- NEVER claim an action you didn't take. The reply may only reference changes actually made through tool calls this turn — if you logged something but created no todo, don't say you created a todo.
- Quotes: preserve 0-3 verbatim sentences worth keeping exactly (feelings, decisions, doubts). Summary is a compact paraphrase written subjectless or first-person, as if the user wrote it in their own journal — NEVER third person. GOOD: "Filled out the card; haven't seen her, so mailing it instead." BAD: "He filled out the card but hasn't given it to her." Never "he/she/they/the user".
- Use existing IDs from the context. Create a project only when clearly new. BIAS HARD TOWARD LINKING: read the project list — names AND descriptions — and attach logs/todos to an existing project whenever one plausibly covers the topic. A thin-but-real connection beats no link; unlinked items get lost. Only leave something unlinked when NO project plausibly relates. If you're torn (two candidate projects, or link-vs-not), attach your best guess AND ask via ask_user with the candidates — silently doing nothing is the worst outcome. REPAIR AS YOU GO: whenever you touch a todo that has no project (attaching a log to it, changing its status) and an existing project plausibly covers it, also set its project_id via update_todo — attaching a log to an orphaned todo strands the log one hop from the project.
- A todo does NOT need a project — but the linking bias above applies: if an existing project's name or description plausibly covers the task, set project_id. Only when nothing fits, create the todo with no project_id — never skip the todo for lack of a project, and never invent a project just to hold it. A log alone is not enough for a stated task.
- The session context is a HINT, not ground truth — the user may be talking about something else entirely. Never force an attachment that doesn't fit.
- Uncertainty policy: you will often be less than certain, and that never blocks capture. Minor ambiguity (exact wording, which status fits) — pick the sensible reading and act. Real ambiguity (task vs. passing thought, which of two entities, whether to schedule) — act on your best interpretation AND ask via the ask_user tool (with suggested answers when natural options exist); their answer lets you fix the record with the update tools. Only when interpretations diverge so much that acting would create junk records: do the safe minimum (usually an unattached log) and just ask. Asking is always allowed — one brief question beats a wrong guess or a silently dropped task.
- Concrete case: if the utterance clearly concerns some project/todo but you can't tell which (check the snapshot, try search), file the log UNATTACHED and ask via ask_user with the candidates as suggestions. When the user answers, re-file it with update_log.
- When the user states an intention WITH a time cue — "I want to look into that today", "I'll call them tomorrow", "this weekend" — schedule the todo: scheduled_date for a day without a time (day-level, "any time" — never invent an hour), scheduled_start only when they give an actual time. Scheduling does NOT change status — a scheduled idea stays an idea with a slot; something in progress stays in progress. Intentions with no time cue stay unscheduled todos.
- When the user reports having DONE something concrete, the log IS the record (occurred_at resolved from time cues). If it corresponds to a todo, mark that todo done; one-off done things need no todo — the log alone is the right artifact, and it shows on the day it happened.
- LINKAGE: when the turn creates a todo from what the user said, prefer attaching the utterance's log to that todo (create it first so the id exists), unless a different entity is clearly more central.
- Todo titles are imperative verb phrases ("Walk the dog", "Call the dentist") — never past tense ("Walked the dog") and never gerunds ("Walking the dog"). Whether it happened or is finished lives in status, not in the title's wording.
- Reflective questions are RARE. Only when something got done that clearly took real effort, courage, or carried emotional weight — and the user hasn't said how it went — ask ONE brief reflective question via ask_user. Routine errands, purchases, and chores NEVER get one ("bought a pen", "got groceries" — just file and confirm); a pointless question costs the user money and patience. Never more than one per turn, and drop it if they clearly don't want to reflect.
- When a LOG is the session context (the user hit reprocess), restructure freely as their correction implies: create or reschedule todos, re-file the log, fix the summary — don't limit yourself to re-attaching.
- occurred_at / scheduled times: resolve time cues against the current time given below. Only backdate on an explicit cue ("this morning", "yesterday"); otherwise omit occurred_at (defaults to now).
- delivery_tags: observable speech patterns only ("hedging", "flowing", "fragmented"), never diagnostic. Usually omit.
- PRIORITIES: each project can carry a priority in the user's OWN words (shown in the project list). Only the agent writes it (update_project.priority) — there's no manual editing. When a project has none and the conversation touches it, or when what the user says suggests its priority shifted, ask ONE short ask_user question about where it sits and store their answer near-verbatim. Never invent a priority they didn't express.
- MEMORY: your keyed notes appear in the context below. When you learn something durable — an ongoing situation, a person who keeps coming up, how the user likes to work — save_memory it (update the existing key when the situation evolves; delete keys that resolved). Don't duplicate what todos/logs already record.
- NOTIFICATIONS: set_notification leaves the user a short note in the app (one living notification per slot — it replaces, never stacks). If the user answers something a notification asked, clear_notification its slot.
- BRIEFING: the Today view shows a precomputed overview. It is NOT in your context by default — fetch it (fetch, entity_type "briefing") when the conversation concerns the day's plan.`;

const BRIEFING_READONLY = `
- The overview is read-only from chats: it regenerates on its own schedule — never claim you updated it.`;

const BRIEFING_WRITABLE = `
- When this conversation meaningfully changes the shape of today or the week — plans made or finished, a project's picture shifting — rewrite the overview with update_briefing (fetch it first). Skip it for minor bookkeeping.`;

/** Extra system prompt for 'plan' sessions ("what should I do today?"). */
const PLAN_ADDENDUM = `

THIS IS A PLANNING SESSION. The user wants help deciding what to do today. Different rules apply:
- Be conversational and proactive — the silent-by-default rule is suspended. You're a thinking partner, not a stenographer.
- Start from the evidence in the context: today's scheduled todos, slipped/stalled items, what recent logs say they've been working on or avoiding. Weigh energy and mood if their words hint at it.
- Propose a SHORT candidate plan (3-5 items max, less is fine) with one line of reasoning each, then ask what resonates. One question at a time; iterate.
- As items are agreed, schedule the todos: scheduled_date for "today"-level commitments (any time that day), scheduled_start only if the user names a time.
- If something on the list has been repeatedly deferred, gently name it and ask what's making it hard — that answer is worth a log.
- Still file logs for anything notable the user says along the way.`;

function contextBlock(data: {
  clock: { iso: string; pretty: string };
  learnings: string;
  memories: { key: string; content: string }[];
  notifications: { slot: string; title: string; body: string | null }[];
  projects: ProjectRow[];
  todos: TodoRow[];
  scheduled: ScheduleRow[];
  recentLogs: LogRow[];
  contextEntity: string;
  changeFeedSoFar: string;
}): string {
  const projects = data.projects
    .map(
      (p) =>
        `#${p.id} ${p.name} [${p.kind}, ${p.status}]${p.priority ? ` [priority: ${p.priority}]` : ""}${p.description ? ` — ${p.description.slice(0, 160)}` : ""}`,
    )
    .join("\n");
  const todos = data.todos
    .map((td) => `#${td.id} ${td.title} [${td.status}]${td.project_id ? ` (project #${td.project_id})` : ""}`)
    .join("\n");
  const scheduled = data.scheduled
    .map((sl) => {
      const when = sl.slot_all_day
        ? `${new Date(sl.slot_start * 1000).toISOString().slice(0, 10)} (any time)`
        : new Date(sl.slot_start * 1000).toISOString();
      return `slot#${sl.schedule_id} todo#${sl.id} ${sl.title} [slot: ${sl.slot_status}] @ ${when}`;
    })
    .join("\n");
  const memories = data.memories.map((m) => `[${m.key}] ${m.content}`).join("\n");
  const notifications = data.notifications
    .map((n) => `[${n.slot}] ${n.title}${n.body ? ` — ${n.body}` : ""}`)
    .join("\n");
  const logs = data.recentLogs
    .map((l) => `- [${new Date(l.occurred_at * 1000).toISOString().slice(0, 10)}] (${l.kind}) ${l.summary}`)
    .join("\n");
  return [
    `Current time: ${data.clock.pretty}. ISO: ${data.clock.iso}.`,
    data.learnings.trim() ? `What you've learned about this user (apply it):\n${data.learnings.trim()}` : "",
    memories ? `Your memory notes:\n${memories}` : "",
    notifications ? `Notifications currently shown to the user (clear a slot once its question is answered):\n${notifications}` : "",
    data.contextEntity ? `The user is currently looking at:\n${data.contextEntity}` : "",
    `Projects:\n${projects || "(none)"}`,
    `Open todos:\n${todos || "(none)"}`,
    `Schedule (yesterday → next 7 days; a todo can have several slots):\n${scheduled || "(none)"}`,
    logs ? `Recent logs (newest first):\n${logs}` : "",
    data.changeFeedSoFar ? `Changes already made earlier in this conversation:\n${data.changeFeedSoFar}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function describeContextEntity(env: Env, session: SessionRow, userId: number): Promise<string> {
  // Opened via "talk about this" on a briefing line — that line is the topic.
  if (session.seed_text) {
    return `The user opened this conversation to talk about this item from their briefing (they see it quoted at the top of the chat):\n"${session.seed_text}"\nStart from it — answer, update the record, or ask what they want to do with it.`;
  }
  // Replying to a notification you left: the notification IS the context.
  if (session.re_notification_id) {
    const n = await getNotificationById(env, userId, session.re_notification_id);
    if (n) {
      return `The user tapped "reply" on this notification you left them — their messages answer it:\n[${n.slot}] ${n.title}${n.body ? ` — ${n.body}` : ""}\n(When answered, clear_notification("${n.slot}").)`;
    }
  }
  // A past chat as context: the user opened Talk from that chat's replay page,
  // so this conversation is ABOUT that one — include its transcript and feed.
  if (session.about_session_id) {
    const prior = await getSession(env, userId, session.about_session_id);
    if (!prior) return "";
    const msgs = conversationOrder(await sessionMessages(env, prior.id));
    let transcript = msgs
      .filter((m) => m.text)
      .map((m) => `${m.role === "user" ? "User" : "You"}: ${m.text}`)
      .join("\n");
    if (transcript.length > 6000) transcript = `…${transcript.slice(-6000)}`;
    const feed = (await recentSessionEvents(env, prior.id))
      .map((e) => `- ${e.kind} ${e.entity_type} #${e.entity_id}`)
      .join("\n");
    const when = new Date(prior.started_at * 1000).toISOString();
    return `A past chat between you and the user (${when}). The user wants to talk ABOUT this conversation — discuss it, correct what came out of it, or build on it:\n${transcript || "(empty)"}${feed ? `\nChanges made during that chat:\n${feed}` : ""}`;
  }
  if (!session.context_type || !session.context_id) return "";
  const type = session.context_type;
  const entity = await getEntity<Record<string, unknown>>(env, type, userId, session.context_id);
  if (!entity) return "";
  const logs =
    type === "todo"
      ? await listLogs(env, userId, { todoId: session.context_id, limit: 5 })
      : type === "action"
        ? await listLogs(env, userId, { actionId: session.context_id, limit: 5 })
        : type === "project"
          ? await listLogs(env, userId, { projectId: session.context_id, limit: 5 })
          : [];
  const logLines = logs
    .map((l) => `- [${new Date(l.occurred_at * 1000).toISOString().slice(0, 10)}] (${l.kind}) ${l.summary}`)
    .join("\n");
  // A log in context (reprocess flow): include the original utterance so the
  // agent can re-evaluate what was actually said.
  let transcript = "";
  if (type === "log" && typeof entity.message_id === "number") {
    const segments = await messageSegments(env, entity.message_id);
    const text = segments.map((s) => s.transcript).filter(Boolean).join(" ");
    if (text) transcript = `\nOriginal utterance transcript:\n"${text}"`;
  }
  return `${type} #${session.context_id}: ${JSON.stringify(entity)}${logLines ? `\nIts recent logs:\n${logLines}` : ""}${transcript}`;
}

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

export interface TurnResult {
  reply: string;
  feed: ChangeFeedItem[];
  /** Accumulated (summarized) thinking across all iterations, for replay. */
  thinking: string;
  questions: AskedQuestion[];
  costUsd: number;
}

/** Live progress events emitted while the turn runs, for SSE streaming. */
export type TurnEvent =
  | { type: "iteration" }
  | { type: "thinking"; text: string }
  | { type: "delta"; text: string }
  | { type: "feed"; item: ChangeFeedItem }
  | { type: "questions"; questions: AskedQuestion[] };

export async function runTurn(
  env: Env,
  user: UserRow,
  session: SessionRow,
  messageId: number,
  userText: string,
  onEvent?: (e: TurnEvent) => void,
): Promise<TurnResult> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const tz = user.timezone ?? env.TIMEZONE;
  const t = now();

  const planMode = session.mode === "plan";
  // Seeded chats (loose threads etc.) get the same rich today-context as
  // planning: recent logs join the always-present briefing and schedule.
  const wantsStory = planMode || !!session.seed_text;
  const [learnings, memories, notifications, projects, todos, scheduled, recentLogs, contextEntity, priorMessages, priorEvents] =
    await Promise.all([
      getLearnings(env, user.id),
      listMemories(env, user.id),
      listNotifications(env, user.id),
      listProjects(env, user.id),
      listTodos(env, user.id),
      listSchedule(env, user.id, { from: t - DAY, to: t + 7 * DAY }),
      // Planning and seeded chats want the recent story; regular turns stay lean.
      wantsStory ? listLogs(env, user.id, { from: t - 3 * DAY, limit: 25 }) : Promise.resolve([]),
      describeContextEntity(env, session, user.id),
      sessionMessages(env, session.id),
      recentSessionEvents(env, session.id),
    ]);

  // Prompt caching: tools + the static prompt form a stable prefix (cache
  // breakpoints on the last tool and the static system block). The volatile
  // context (current time, todos, briefing) sits after the breakpoints so a
  // change there never invalidates the expensive prefix. Within one turn's
  // tool iterations everything repeats and reads from cache.
  const chatBriefingUpdates = parseConfig(user.agent_config).chat_briefing_updates;
  const staticSystem =
    SYSTEM_PROMPT +
    (chatBriefingUpdates ? BRIEFING_WRITABLE : BRIEFING_READONLY) +
    (planMode ? PLAN_ADDENDUM : "");
  const volatileSystem = contextBlock({
      clock: nowInZone(tz),
      learnings,
      memories,
      notifications,
      projects,
      todos,
      scheduled,
      recentLogs,
      contextEntity,
      changeFeedSoFar: priorEvents
        .map((e) => `- ${e.kind} ${e.entity_type} #${e.entity_id}`)
        .join("\n"),
    });
  // Static prefix (tools + prompt) caches for 1h — it must survive BETWEEN
  // turns (5-min TTL expired between real-world turns, so every turn paid a
  // full ~11K-token rewrite at 1.25x; that was most of per-turn cost). The
  // volatile block is deliberately uncached: it changes every turn, so a
  // breakpoint there is a pure write premium with no reads. Within-turn reuse
  // comes from the top-level auto-cache on the message tail.
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: staticSystem, cache_control: { type: "ephemeral", ttl: "1h" } },
    { type: "text", text: volatileSystem },
  ];
  const toolList = chatBriefingUpdates ? [...TOOLS, UPDATE_BRIEFING_TOOL] : TOOLS;
  const tools: Anthropic.Tool[] = toolList.map((t, i) =>
    i === toolList.length - 1 ? { ...t, cache_control: { type: "ephemeral", ttl: "1h" } } : t,
  );

  // Per-user tuning (Settings page): model + thinking level for chat turns.
  // Planning sessions get at least "high" thinking when thinking is on.
  const resolved = resolveUseCase(user, "chat");
  if (planMode && resolved.thinking !== "off" && resolved.model !== "haiku") {
    resolved.thinking = "high";
  }
  const model = resolved.modelId;

  const messages: Anthropic.MessageParam[] = [
    ...conversationOrder(priorMessages)
      .filter((m) => m.id !== messageId && m.text)
      .map((m) => ({ role: m.role, content: m.text as string })),
    { role: "user" as const, content: userText },
  ];

  const state: TurnState = {
    env,
    user,
    session,
    messageId,
    feed: [],
    createdLogIds: [],
    questions: [],
    onEvent,
  };

  let reply = "";
  let thinking = "";
  const usage = emptyUsage();
  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    onEvent?.({ type: "iteration" });
    if (thinking && !thinking.endsWith("\n\n")) thinking += "\n\n";
    const stream = client.messages.stream({
      model,
      max_tokens: 8192,
      ...modelParams(resolved),
      cache_control: { type: "ephemeral" },
      system,
      tools,
      messages,
    } as Parameters<typeof client.messages.stream>[0]);
    for await (const event of stream) {
      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          onEvent?.({ type: "delta", text: event.delta.text });
        } else if (event.delta.type === "thinking_delta" && event.delta.thinking) {
          thinking += event.delta.thinking;
          onEvent?.({ type: "thinking", text: event.delta.thinking });
        }
      }
    }
    const response = await stream.finalMessage();
    addUsage(usage, response.usage);

    if (response.stop_reason === "refusal") {
      reply = "I couldn't process that one — try rephrasing.";
      break;
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) reply = text;

    if (response.stop_reason !== "tool_use" || toolUses.length === 0) break;

    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      let result: string;
      try {
        result = await executeTool(state, tu.name, tu.input);
      } catch (err) {
        result = `error: ${err instanceof Error ? err.message : String(err)}`;
      }
      results.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: result,
        is_error: result.startsWith("error:"),
      });
    }
    messages.push({ role: "user", content: results });
  }

  // Backfill: status changes made before the log was filed get linked to the
  // turn's log ("every status change has a log behind it").
  if (state.createdLogIds.length > 0) {
    await env.DB.prepare(
      `UPDATE events SET log_id = ? WHERE message_id = ? AND kind = 'status_changed' AND log_id IS NULL`,
    )
      .bind(state.createdLogIds[0], messageId)
      .run();
  }

  await recordUsage(env, {
    userId: user.id,
    kind: "turn",
    model,
    sessionId: session.id,
    messageId,
    usage,
  });

  return {
    reply: reply || "Noted.",
    feed: state.feed,
    thinking: thinking.trim(),
    questions: state.questions,
    costUsd: computeCost(model, usage),
  };
}
