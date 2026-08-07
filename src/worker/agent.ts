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
  ActionRow,
  LogRow,
  ChangeFeedItem,
  EntityType,
} from "./types";
import {
  now,
  insertRow,
  updateRow,
  getEntity,
  getSession,
  listProjects,
  listTodos,
  listTodosForProject,
  actionsForTodo,
  listActions,
  listLogs,
  searchAll,
  insertEvent,
  fileCorrection,
  getLearnings,
  recentSessionEvents,
  sessionMessages,
  conversationOrder,
  messageSegments,
} from "./db";

// Sonnet 5 handles this structured extract-and-update work at ~half Opus cost;
// bump back to claude-opus-5 if turn quality dips.
const AGENT_MODEL = "claude-sonnet-5";
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
      "Create a todo. `outcome` is what done looks like; `details` holds constraints, fears, dependencies. `project_id` is optional — standalone todos are normal; never skip creating a stated task just because no project fits.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        outcome: { type: ["string", "null"] },
        details: { type: ["string", "null"] },
        project_id: ID,
        status: {
          type: ["string", "null"],
          enum: ["idea", "scheduled", "in_progress", "done", "abandoned", null],
        },
      },
      required: ["title"],
    },
  },
  {
    name: "update_todo",
    description:
      "Update a todo. Only include fields that change. Status transitions should reflect reality (user started → in_progress, finished → done).",
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
          enum: ["idea", "scheduled", "in_progress", "done", "abandoned", null],
        },
      },
      required: ["todo_id"],
    },
  },
  {
    name: "create_action",
    description:
      "Create an action: an attempt at a todo, scheduled (future) or impromptu (happening now / already happened). Impromptu actions may have no todo. `title` is an imperative verb phrase ('Walk the dog' — not 'Walked' or 'Walking') — completion is expressed via status/ended_at, never the title.",
    input_schema: {
      type: "object",
      properties: {
        todo_id: ID,
        project_id: ID,
        title: { type: ["string", "null"], description: "Defaults to the todo's title" },
        scheduled_start: WHEN,
        scheduled_end: WHEN,
        started_at: WHEN,
        ended_at: WHEN,
        status: {
          type: ["string", "null"],
          enum: ["scheduled", "in_progress", "done", "skipped", "canceled", null],
        },
      },
      required: [],
    },
  },
  {
    name: "update_action",
    description: "Update an action. Only include fields that change.",
    input_schema: {
      type: "object",
      properties: {
        action_id: { type: "integer" },
        todo_id: ID,
        project_id: ID,
        title: { type: ["string", "null"] },
        scheduled_start: WHEN,
        scheduled_end: WHEN,
        started_at: WHEN,
        ended_at: WHEN,
        status: {
          type: ["string", "null"],
          enum: ["scheduled", "in_progress", "done", "skipped", "canceled", null],
        },
      },
      required: ["action_id"],
    },
  },
  {
    name: "create_log",
    description:
      "File a journal log from what the user said. The default action for almost every utterance. `summary` is a short paraphrase; `quotes` are 0-3 verbatim sentences from the user worth preserving exactly. Attach to the todo/action/project it concerns when clear.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        kind: { type: ["string", "null"], enum: ["log", "reflection", null] },
        todo_id: ID,
        action_id: ID,
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
      "Update or re-file an existing log: fix the summary/kind, or attach it to the right todo/action/project (e.g. after the user answers a clarifying question). Only include fields that change.",
    input_schema: {
      type: "object",
      properties: {
        log_id: { type: "integer" },
        summary: { type: ["string", "null"] },
        kind: { type: ["string", "null"], enum: ["log", "reflection", null] },
        todo_id: ID,
        action_id: ID,
        project_id: ID,
      },
      required: ["log_id"],
    },
  },
  {
    name: "fetch",
    description:
      "Fetch full detail for one entity: the record plus its related todos/actions and recent logs. Use when the context snapshot isn't enough.",
    input_schema: {
      type: "object",
      properties: {
        entity_type: { type: "string", enum: ["project", "todo", "action", "log"] },
        id: { type: "integer" },
      },
      required: ["entity_type", "id"],
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

interface TurnState {
  env: Env;
  user: UserRow;
  session: SessionRow;
  messageId: number;
  feed: ChangeFeedItem[];
  createdLogIds: number[];
  onEvent?: (e: { type: "feed"; item: ChangeFeedItem }) => void;
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
        user_id: s.user.id,
        name: str(input.name) ?? "Untitled project",
        description: str(input.description),
        kind: input.kind === "ongoing" ? "ongoing" : "bounded",
        status: "active",
        created_at: t,
        updated_at: t,
      });
      await feedEvent(s, "project", row.id, "created", `Created project “${row.name}”`);
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
      ]);
      if (Object.keys(cols).length === 0) return "no changes";
      cols.updated_at = t;
      await updateRow(s.env, "projects", s.user.id, current.id, cols);
      const kind = "status" in cols ? "status_changed" : "updated";
      const label =
        "status" in cols
          ? `Project “${current.name}”: ${current.status} → ${cols.status}`
          : `Updated project “${current.name}” (${Object.keys(after).join(", ")})`;
      await feedEvent(s, "project", current.id, kind, label, { before, after });
      return "ok";
    }
    case "create_todo": {
      const row = await insertRow<TodoRow>(s.env, "todos", {
        user_id: s.user.id,
        project_id: num(input.project_id),
        title: str(input.title) ?? "Untitled",
        outcome: str(input.outcome),
        details: str(input.details),
        status: str(input.status) ?? "idea",
        created_at: t,
        updated_at: t,
      });
      await feedEvent(s, "todo", row.id, "created", `Created todo “${row.title}” (${row.status})`);
      return JSON.stringify({ todo_id: row.id });
    }
    case "update_todo": {
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
          ? `Todo “${current.title}”: ${current.status} → ${cols.status}`
          : `Updated todo “${current.title}” (${Object.keys(after).join(", ")})`;
      await feedEvent(s, "todo", current.id, kind, label, { before, after });
      return "ok";
    }
    case "create_action": {
      let title = str(input.title);
      const todoId = num(input.todo_id);
      if (!title && todoId) {
        const todo = await getEntity<TodoRow>(s.env, "todo", s.user.id, todoId);
        title = todo?.title ?? null;
      }
      const startedAt = parseWhen(input.started_at);
      const row = await insertRow<ActionRow>(s.env, "actions", {
        user_id: s.user.id,
        todo_id: todoId,
        project_id: num(input.project_id),
        title,
        scheduled_start: parseWhen(input.scheduled_start),
        scheduled_end: parseWhen(input.scheduled_end),
        started_at: startedAt,
        ended_at: parseWhen(input.ended_at),
        status: str(input.status) ?? (startedAt ? "in_progress" : "scheduled"),
        gcal_event_id: null,
        created_at: t,
        updated_at: t,
      });
      const when = row.scheduled_start
        ? ` @ ${new Date(row.scheduled_start * 1000).toLocaleString("en-US", { timeZone: s.user.timezone ?? s.env.TIMEZONE })}`
        : "";
      await feedEvent(s, "action", row.id, "created", `Created action “${row.title ?? "untitled"}” (${row.status})${when}`);
      return JSON.stringify({ action_id: row.id });
    }
    case "update_action": {
      const id = num(input.action_id);
      const current = id && (await getEntity<ActionRow>(s.env, "action", s.user.id, id));
      if (!current) return "error: action not found";
      const { cols, before, after } = collectUpdates(input, current as never, [
        { name: "todo_id" },
        { name: "project_id" },
        { name: "title" },
        { name: "scheduled_start", parse: parseWhen },
        { name: "scheduled_end", parse: parseWhen },
        { name: "started_at", parse: parseWhen },
        { name: "ended_at", parse: parseWhen },
        { name: "status" },
      ]);
      if (Object.keys(cols).length === 0) return "no changes";
      cols.updated_at = t;
      await updateRow(s.env, "actions", s.user.id, current.id, cols);
      const kind = "status" in cols ? "status_changed" : "updated";
      const label =
        "status" in cols
          ? `Action “${current.title ?? current.id}”: ${current.status} → ${cols.status}`
          : `Updated action “${current.title ?? current.id}” (${Object.keys(after).join(", ")})`;
      await feedEvent(s, "action", current.id, kind, label, { before, after });
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
        action_id: num(input.action_id),
        project_id: num(input.project_id),
        kind: input.kind === "reflection" ? "reflection" : "log",
        summary: str(input.summary) ?? "(empty)",
        quotes_json: quotesJson,
        delivery_json: tags.length ? JSON.stringify({ tags }) : null,
        occurred_at: parseWhen(input.occurred_at) ?? t,
        created_at: t,
      });
      s.createdLogIds.push(row.id);
      await feedEvent(s, "log", row.id, "created", `Logged ${row.kind}: ${row.summary}`);
      return JSON.stringify({ log_id: row.id });
    }
    case "update_log": {
      const id = num(input.log_id);
      const current = id && (await getEntity<LogRow>(s.env, "log", s.user.id, id));
      if (!current) return "error: log not found";
      const { cols, before, after } = collectUpdates(input, current as never, [
        { name: "summary" },
        { name: "kind" },
        { name: "todo_id" },
        { name: "action_id" },
        { name: "project_id" },
      ]);
      if (Object.keys(cols).length === 0) return "no changes";
      await updateRow(s.env, "logs", s.user.id, current.id, cols);
      const attachChanged = "todo_id" in cols || "action_id" in cols || "project_id" in cols;
      const label = attachChanged
        ? `Re-filed log: ${(cols.summary as string) ?? current.summary}`
        : `Updated log (${Object.keys(after).join(", ")})`;
      await feedEvent(s, "log", current.id, "updated", label, { before, after });
      return "ok";
    }
    case "fetch": {
      const type = str(input.entity_type) as EntityType | null;
      const id = num(input.id);
      if (!type || !id || !["project", "todo", "action", "log"].includes(type)) {
        return "error: entity_type and id required";
      }
      const entity = await getEntity<Record<string, unknown>>(s.env, type, s.user.id, id);
      if (!entity) return `error: ${type} #${id} not found`;
      const related: Record<string, unknown> = { [type]: entity };
      if (type === "project") {
        related.todos = (await listTodosForProject(s.env, s.user.id, id)).slice(0, 30);
        related.recent_logs = await listLogs(s.env, s.user.id, { projectId: id, limit: 10 });
      } else if (type === "todo") {
        related.actions = await actionsForTodo(s.env, s.user.id, id);
        related.recent_logs = await listLogs(s.env, s.user.id, { todoId: id, limit: 10 });
      } else if (type === "action") {
        related.recent_logs = await listLogs(s.env, s.user.id, { actionId: id, limit: 10 });
      }
      return JSON.stringify(related);
    }
    case "search": {
      const q = str(input.query);
      if (!q) return "error: query required";
      return JSON.stringify(await searchAll(s.env, s.user.id, q));
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

Ontology: PROJECTS are areas of focus (bounded = has an end state; ongoing = never completes). TODOS are tasks with a describable outcome, optionally under a project. ACTIONS are attempts at todos — scheduled or impromptu. LOGS are the journal: anything the user said, attached to the todo/action/project it concerns. A "reflection" is a log about how it's going (feelings, worth, direction), not just what happened.

How you behave:
- APPLY CHANGES IMMEDIATELY via tools. There is no confirmation step — the user corrects you by talking more. When corrected: apply the fix AND call file_correction.
- The default for nearly every utterance is create_log. Rants while working become logs on the current context entity. Also update statuses to match reality: user says they're starting → action in_progress, todo in_progress; finished → done and set ended_at.
- Be silent-by-default in spirit: NO advice, opinions, or coaching unless the user directly asks. When asked, answer concisely using the context below.
- Your reply is a terse confirmation, 1-2 short sentences. The UI already shows a change feed of your tool calls — don't enumerate them again. If nothing needed doing, say so briefly.
- NEVER claim an action you didn't take. The reply may only reference changes actually made through tool calls this turn — if you logged something but created no todo, don't say you created a todo.
- Quotes: preserve 0-3 verbatim sentences worth keeping exactly (feelings, decisions, doubts). Summary is a compact paraphrase in the user's voice, third person omitted.
- Use existing IDs from the context. Create a project only when clearly new. Link impromptu things to todos/projects when the connection is obvious; otherwise leave unlinked.
- A todo does NOT need a project. When the user states something they intend or need to do and no existing project fits, create the todo with no project_id — never skip the todo for lack of a project, and never invent a project just to hold it. A log alone is not enough for a stated task.
- The session context is a HINT, not ground truth — the user may be talking about something else entirely. Never force an attachment that doesn't fit.
- Uncertainty policy: you will often be less than certain, and that never blocks capture. Minor ambiguity (exact wording, which status fits) — pick the sensible reading and act. Real ambiguity (task vs. passing thought, which of two entities, whether to schedule) — act on your best interpretation AND end your reply with ONE short clarifying question; their answer lets you fix the record with the update tools. Only when interpretations diverge so much that acting would create junk records: do the safe minimum (usually an unattached log) and just ask. Asking is always allowed — one brief question beats a wrong guess or a silently dropped task.
- Concrete case: if the utterance clearly concerns some project/todo but you can't tell which (check the snapshot, try search), file the log UNATTACHED and ask ("Which project is this for — X or Y?"). When the user answers, re-file it with update_log.
- When the user reports having DONE something concrete (worked on it, made the call, finished it), record it as an action: impromptu, status done, started_at/ended_at resolved from time cues (or roughly now, with a plausible duration). Link it to its todo/project when one fits, but an action does NOT need a todo — one-off things still become (todo-less) actions; don't invent a retroactive todo just to hold one. Actions are what show up on the calendar.
- When one utterance reports several distinct done things, create a separate action for EACH — then a separate log per action, attached via action_id (create the action first so you have the id). A log about an action must never be left dangling without its action_id. One extra general log is fine only for leftover narrative that belongs to none of them.
- Action titles are imperative verb phrases ("Walk the dog", "Call the dentist") — never past tense ("Walked the dog") and never gerunds ("Walking the dog"). Whether it happened or is finished lives in status/started_at/ended_at, not in the title's wording.
- After recording a done action, if the user hasn't said how it went, end your reply with ONE brief reflective question (what happened / how did it feel / was it worthwhile?). Their answer becomes a reflection log attached to that action. Never more than one question per turn, and drop it if they clearly don't want to reflect.
- When a LOG is the session context (the user hit reprocess), restructure freely as their correction implies: create todos or actions, re-file or split the log, fix the summary — don't limit yourself to re-attaching.
- occurred_at / scheduled times: resolve time cues against the current time given below. Only backdate on an explicit cue ("this morning", "yesterday"); otherwise omit occurred_at (defaults to now).
- delivery_tags: observable speech patterns only ("hedging", "flowing", "fragmented"), never diagnostic. Usually omit.`;

function contextBlock(data: {
  clock: { iso: string; pretty: string };
  learnings: string;
  projects: ProjectRow[];
  todos: TodoRow[];
  actions: ActionRow[];
  contextEntity: string;
  changeFeedSoFar: string;
}): string {
  const projects = data.projects
    .map((p) => `#${p.id} ${p.name} [${p.kind}, ${p.status}]`)
    .join("\n");
  const todos = data.todos
    .map((td) => `#${td.id} ${td.title} [${td.status}]${td.project_id ? ` (project #${td.project_id})` : ""}`)
    .join("\n");
  const actions = data.actions
    .map((a) => {
      const when = a.scheduled_start ?? a.started_at;
      return `#${a.id} ${a.title ?? "untitled"} [${a.status}]${when ? ` @ ${new Date(when * 1000).toISOString()}` : ""}${a.todo_id ? ` (todo #${a.todo_id})` : ""}`;
    })
    .join("\n");
  return [
    `Current time: ${data.clock.pretty}. ISO: ${data.clock.iso}.`,
    data.learnings.trim() ? `What you've learned about this user (apply it):\n${data.learnings.trim()}` : "",
    data.contextEntity ? `The user is currently looking at:\n${data.contextEntity}` : "",
    `Projects:\n${projects || "(none)"}`,
    `Open todos:\n${todos || "(none)"}`,
    `Actions (yesterday → next 7 days):\n${actions || "(none)"}`,
    data.changeFeedSoFar ? `Changes already made earlier in this conversation:\n${data.changeFeedSoFar}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function describeContextEntity(env: Env, session: SessionRow, userId: number): Promise<string> {
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
}

/** Live progress events emitted while the turn runs, for SSE streaming. */
export type TurnEvent =
  | { type: "iteration" }
  | { type: "thinking"; text: string }
  | { type: "delta"; text: string }
  | { type: "feed"; item: ChangeFeedItem };

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

  const [learnings, projects, todos, actions, contextEntity, priorMessages, priorEvents] =
    await Promise.all([
      getLearnings(env, user.id),
      listProjects(env, user.id),
      listTodos(env, user.id),
      listActions(env, user.id, { from: t - DAY, to: t + 7 * DAY }),
      describeContextEntity(env, session, user.id),
      sessionMessages(env, session.id),
      recentSessionEvents(env, session.id),
    ]);

  const system =
    SYSTEM_PROMPT +
    "\n\n" +
    contextBlock({
      clock: nowInZone(tz),
      learnings,
      projects,
      todos,
      actions,
      contextEntity,
      changeFeedSoFar: priorEvents
        .map((e) => `- ${e.kind} ${e.entity_type} #${e.entity_id}`)
        .join("\n"),
    });

  const messages: Anthropic.MessageParam[] = [
    ...conversationOrder(priorMessages)
      .filter((m) => m.id !== messageId && m.text)
      .map((m) => ({ role: m.role, content: m.text as string })),
    { role: "user" as const, content: userText },
  ];

  const state: TurnState = { env, user, session, messageId, feed: [], createdLogIds: [], onEvent };

  let reply = "";
  let thinking = "";
  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    onEvent?.({ type: "iteration" });
    if (thinking && !thinking.endsWith("\n\n")) thinking += "\n\n";
    const stream = client.messages.stream({
      model: AGENT_MODEL,
      max_tokens: 8192,
      thinking: { type: "adaptive", display: "summarized" },
      system,
      tools: TOOLS,
      messages,
    });
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

  return { reply: reply || "Noted.", feed: state.feed, thinking: thinking.trim() };
}
