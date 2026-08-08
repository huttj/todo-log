// Manual CRUD ("edit the actuals") for projects/todos/actions/logs, plus undo.
// Manual edits also write audit events (session-less) so the history is whole.
import { Hono } from "hono";
import type { AppContext } from "./auth";
import { requireEnabled } from "./auth";
import {
  now,
  insertRow,
  updateRow,
  getEntity,
  listProjects,
  listTodos,
  listActions,
  listLogs,
  searchAll,
  insertEvent,
  getEvent,
  listNotifications,
  ENTITY_TABLES,
} from "./db";
import type { EntityType, ProjectRow, TodoRow, ActionRow } from "./types";

export const crud = new Hono<AppContext>();
crud.use("*", requireEnabled);

function pick(
  body: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (f in body) out[f] = body[f];
  return out;
}

// -- Projects ---------------------------------------------------------------

crud.get("/projects", async (c) => c.json(await listProjects(c.env, c.get("user").id)));

crud.post("/projects", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  if (typeof body.name !== "string" || !body.name.trim()) {
    return c.json({ error: "name required" }, 400);
  }
  const t = now();
  const row = await insertRow<ProjectRow>(c.env, "projects", {
    user_id: c.get("user").id,
    name: body.name.trim(),
    description: typeof body.description === "string" ? body.description : null,
    kind: body.kind === "ongoing" ? "ongoing" : "bounded",
    status: "active",
    created_at: t,
    updated_at: t,
  });
  await insertEvent(c.env, {
    userId: c.get("user").id,
    entityType: "project",
    entityId: row.id,
    kind: "created",
    payload: { manual: true },
  });
  return c.json(row);
});

// -- Todos ------------------------------------------------------------------

crud.get("/todos", async (c) => {
  const includeClosed = c.req.query("all") === "1";
  return c.json(await listTodos(c.env, c.get("user").id, { includeClosed }));
});

crud.post("/todos", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  if (typeof body.title !== "string" || !body.title.trim()) {
    return c.json({ error: "title required" }, 400);
  }
  const t = now();
  const row = await insertRow<TodoRow>(c.env, "todos", {
    user_id: c.get("user").id,
    project_id: typeof body.project_id === "number" ? body.project_id : null,
    title: body.title.trim(),
    outcome: typeof body.outcome === "string" ? body.outcome : null,
    details: typeof body.details === "string" ? body.details : null,
    status: typeof body.status === "string" ? body.status : "idea",
    created_at: t,
    updated_at: t,
  });
  await insertEvent(c.env, {
    userId: c.get("user").id,
    entityType: "todo",
    entityId: row.id,
    kind: "created",
    payload: { manual: true },
  });
  return c.json(row);
});

// -- Actions ----------------------------------------------------------------

crud.get("/actions", async (c) => {
  const from = Number(c.req.query("from") ?? now() - 86400);
  const to = Number(c.req.query("to") ?? now() + 7 * 86400);
  return c.json(await listActions(c.env, c.get("user").id, { from, to }));
});

crud.get("/actions/:id", async (c) => {
  const action = await getEntity<ActionRow>(c.env, "action", c.get("user").id, Number(c.req.param("id")));
  if (!action) return c.json({ error: "not found" }, 404);
  return c.json(action);
});

crud.post("/actions", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const t = now();
  const row = await insertRow<ActionRow>(c.env, "actions", {
    user_id: c.get("user").id,
    todo_id: typeof body.todo_id === "number" ? body.todo_id : null,
    project_id: typeof body.project_id === "number" ? body.project_id : null,
    title: typeof body.title === "string" ? body.title : null,
    scheduled_start: typeof body.scheduled_start === "number" ? body.scheduled_start : null,
    scheduled_end: typeof body.scheduled_end === "number" ? body.scheduled_end : null,
    started_at: null,
    ended_at: null,
    status: typeof body.status === "string" ? body.status : "scheduled",
    gcal_event_id: null,
    created_at: t,
    updated_at: t,
  });
  await insertEvent(c.env, {
    userId: c.get("user").id,
    entityType: "action",
    entityId: row.id,
    kind: "created",
    payload: { manual: true },
  });
  return c.json(row);
});

// -- Logs -------------------------------------------------------------------

crud.get("/logs", async (c) => {
  const q = c.req.query();
  return c.json(
    await listLogs(c.env, c.get("user").id, {
      todoId: q.todo_id ? Number(q.todo_id) : undefined,
      actionId: q.action_id ? Number(q.action_id) : undefined,
      projectId: q.project_id ? Number(q.project_id) : undefined,
      from: q.from ? Number(q.from) : undefined,
      to: q.to ? Number(q.to) : undefined,
      limit: q.limit ? Math.min(Number(q.limit), 200) : undefined,
    }),
  );
});

// -- Notifications (written by the agent; the app reads/acknowledges) -------

crud.get("/notifications", async (c) => c.json(await listNotifications(c.env, c.get("user").id)));

crud.post("/notifications/:id/read", async (c) => {
  await c.env.DB.prepare(`UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?`)
    .bind(Number(c.req.param("id")), c.get("user").id)
    .run();
  return c.json({ ok: true });
});

crud.delete("/notifications/:id", async (c) => {
  await c.env.DB.prepare(`DELETE FROM notifications WHERE id = ? AND user_id = ?`)
    .bind(Number(c.req.param("id")), c.get("user").id)
    .run();
  return c.json({ ok: true });
});

// Omni search across projects, todos, and logs.
crud.get("/search", async (c) => {
  const q = c.req.query("q")?.trim();
  if (!q) return c.json({ projects: [], todos: [], logs: [] });
  return c.json(await searchAll(c.env, c.get("user").id, q));
});

// -- Generic PATCH / undo ---------------------------------------------------

const PATCHABLE: Record<EntityType, string[]> = {
  project: ["name", "description", "kind", "status"],
  todo: ["title", "outcome", "details", "project_id", "status"],
  action: [
    "todo_id",
    "project_id",
    "title",
    "scheduled_start",
    "scheduled_end",
    "started_at",
    "ended_at",
    "status",
  ],
  log: ["summary", "kind", "todo_id", "action_id", "project_id"],
};

const TYPE_BY_PATH: Record<string, EntityType> = {
  projects: "project",
  todos: "todo",
  actions: "action",
  logs: "log",
};

crud.patch("/:table/:id", async (c) => {
  const type = TYPE_BY_PATH[c.req.param("table")];
  if (!type) return c.json({ error: "unknown entity" }, 404);
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  const current = await getEntity<Record<string, unknown>>(c.env, type, user.id, id);
  if (!current) return c.json({ error: "not found" }, 404);

  const body = await c.req.json<Record<string, unknown>>();
  const cols = pick(body, PATCHABLE[type]);
  if (Object.keys(cols).length === 0) return c.json({ error: "no patchable fields" }, 400);

  const before: Record<string, unknown> = {};
  for (const k of Object.keys(cols)) before[k] = current[k];
  if (type !== "log") cols.updated_at = now();

  const row = await updateRow<Record<string, unknown>>(c.env, ENTITY_TABLES[type], user.id, id, cols);
  await insertEvent(c.env, {
    userId: user.id,
    entityType: type,
    entityId: id,
    kind: "status" in cols && cols.status !== before.status ? "status_changed" : "updated",
    payload: { manual: true, before, after: cols },
  });
  return c.json(row);
});

crud.post("/events/:id/undo", async (c) => {
  const user = c.get("user");
  const event = await getEvent(c.env, user.id, Number(c.req.param("id")));
  if (!event) return c.json({ error: "not found" }, 404);
  if (event.undone) return c.json({ error: "already undone" }, 400);

  const table = ENTITY_TABLES[event.entity_type];
  if (event.kind === "created") {
    await c.env.DB.prepare(`DELETE FROM ${table} WHERE id = ? AND user_id = ?`)
      .bind(event.entity_id, user.id)
      .run();
  } else if (event.kind === "updated" || event.kind === "status_changed") {
    const payload = event.payload_json ? (JSON.parse(event.payload_json) as { before?: Record<string, unknown> }) : {};
    if (!payload.before || Object.keys(payload.before).length === 0) {
      return c.json({ error: "nothing to restore" }, 400);
    }
    await updateRow(c.env, table, user.id, event.entity_id, payload.before);
  } else {
    return c.json({ error: `cannot undo ${event.kind}` }, 400);
  }

  await c.env.DB.prepare(`UPDATE events SET undone = 1 WHERE id = ?`).bind(event.id).run();
  await insertEvent(c.env, {
    userId: user.id,
    entityType: event.entity_type,
    entityId: event.entity_id,
    kind: "undone",
    payload: { undid_event: event.id },
  });
  return c.json({ ok: true });
});
