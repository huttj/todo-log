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
  listSchedule,
  getSlot,
  otherPlannedSlots,
  undoBriefing,
  listLogs,
  searchAll,
  insertEvent,
  getEvent,
  listNotifications,
  dismissNotification,
  getBriefing,
  ENTITY_TABLES,
} from "./db";
import { generateBriefing } from "./briefing";
import { parseConfig } from "./config";
import { listMemories, saveMemory, listDismissals, setDismissal, resolvePlannedSlots } from "./db";
import { saveSubscription, pushToUser } from "./push";
import { checkinForUser } from "./sweep";
import type { Env, EntityType, ProjectRow, TodoRow } from "./types";

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

// -- Schedule slots (the Today/schedule surface) ----------------------------

crud.get("/schedule", async (c) => {
  const from = Number(c.req.query("from") ?? now() - 86400);
  const to = Number(c.req.query("to") ?? now() + 7 * 86400);
  return c.json(await listSchedule(c.env, c.get("user").id, { from, to }));
});

// Slot status from the UI. Marking the last planned slot done also finishes
// the todo (one-shot tasks); recurring todos with future slots stay open.
crud.patch("/schedule/:id", async (c) => {
  const user = c.get("user");
  const slot = await getSlot(c.env, user.id, Number(c.req.param("id")));
  if (!slot) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{ status?: string }>();
  if (!body.status || !["planned", "done", "skipped"].includes(body.status)) {
    return c.json({ error: "status must be planned|done|skipped" }, 400);
  }
  await c.env.DB.prepare(`UPDATE todo_schedules SET status = ? WHERE id = ? AND user_id = ?`)
    .bind(body.status, slot.id, user.id)
    .run();
  let todoStatus: string | null = null;
  if (body.status === "done" && (await otherPlannedSlots(c.env, user.id, slot.todo_id, slot.id)) === 0) {
    todoStatus = "done";
    await updateRow(c.env, "todos", user.id, slot.todo_id, { status: "done", updated_at: now() });
    await insertEvent(c.env, {
      userId: user.id,
      entityType: "todo",
      entityId: slot.todo_id,
      kind: "status_changed",
      payload: { manual: true, via: "schedule_slot", after: { status: "done" } },
    });
  }
  return c.json({ ok: true, todo_status: todoStatus });
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
  await dismissNotification(c.env, c.get("user").id, Number(c.req.param("id")));
  return c.json({ ok: true });
});

// -- Daily briefing ---------------------------------------------------------

crud.get("/briefing", async (c) => {
  const row = await getBriefing(c.env, c.get("user").id);
  if (!row) return c.json({ briefing: null, generated_at: null, has_prev: false });
  try {
    return c.json({
      briefing: JSON.parse(row.content_json),
      generated_at: row.generated_at,
      cost_usd: row.cost_usd,
      has_prev: !!(row as { prev_content_json?: string | null }).prev_content_json,
    });
  } catch {
    return c.json({ briefing: null, generated_at: null, has_prev: false });
  }
});

crud.post("/briefing/undo", async (c) => {
  const row = await undoBriefing(c.env, c.get("user").id);
  if (!row) return c.json({ error: "nothing to undo" }, 400);
  try {
    return c.json({ briefing: JSON.parse(row.content_json), generated_at: row.generated_at });
  } catch {
    return c.json({ error: "stored briefing unreadable" }, 500);
  }
});

// Streams the generation: raw JSON deltas as they're written, then a done
// frame with the parsed briefing. Generation runs under waitUntil, so it
// completes and persists even if the tab disconnects mid-stream.
crud.post("/briefing/refresh", async (c) => {
  const user = c.get("user");
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const emit = (obj: unknown) =>
    writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)).catch(() => {});

  c.executionCtx.waitUntil(
    (async () => {
      try {
        const briefing = await generateBriefing(c.env, user, (text) => void emit({ type: "delta", text }));
        if (!briefing) {
          await emit({ type: "error", error: "generation returned no usable briefing — try again" });
        } else {
          const row = await getBriefing(c.env, user.id);
          await emit({ type: "done", briefing, generated_at: now(), cost_usd: row?.cost_usd ?? null });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("briefing refresh threw:", msg);
        await emit({ type: "error", error: `briefing generation error: ${msg.slice(0, 300)}` });
      }
      await writer.close().catch(() => {});
    })(),
  );

  return new Response(readable, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
});

// -- LLM usage / cost instrumentation ---------------------------------------

crud.get("/usage/summary", async (c) => {
  const userId = c.get("user").id;
  const weekAgo = now() - 7 * 86400;
  const byKind = await c.env.DB.prepare(
    `SELECT kind, model, COUNT(*) AS n, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
            SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write,
            SUM(cost_usd) AS cost
     FROM llm_usage WHERE user_id = ? AND created_at > ? GROUP BY kind, model ORDER BY cost DESC`,
  )
    .bind(userId, weekAgo)
    .all();
  const totals = await c.env.DB.prepare(
    `SELECT SUM(cost_usd) AS all_time,
            SUM(CASE WHEN created_at > ? THEN cost_usd ELSE 0 END) AS week
     FROM llm_usage WHERE user_id = ?`,
  )
    .bind(weekAgo, userId)
    .first<{ all_time: number | null; week: number | null }>();
  return c.json({
    week: totals?.week ?? 0,
    all_time: totals?.all_time ?? 0,
    by_kind: byKind.results,
  });
});

// Total LLM spend inside a time range (the Today view's per-day line).
crud.get("/usage/day", async (c) => {
  const from = Number(c.req.query("from") ?? 0);
  const to = Number(c.req.query("to") ?? now());
  const row = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM llm_usage
     WHERE user_id = ? AND created_at >= ? AND created_at < ?`,
  )
    .bind(c.get("user").id, from, to)
    .first<{ cost: number }>();
  return c.json({ cost: row?.cost ?? 0 });
});

// Fine-grained usage for the Settings spend table: per local-day / kind /
// model aggregates over all time (tzoff = client's getTimezoneOffset()).
crud.get("/usage/table", async (c) => {
  const tzoff = Number(c.req.query("tzoff") ?? 0);
  const r = await c.env.DB.prepare(
    `SELECT date(created_at - ?2 * 60, 'unixepoch') AS day, kind, model,
       COUNT(*) AS n, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
       SUM(cache_read_tokens) AS cache_read, SUM(cost_usd) AS cost
     FROM llm_usage WHERE user_id = ?1
     GROUP BY day, kind, model ORDER BY day DESC`,
  )
    .bind(c.get("user").id, Number.isFinite(tzoff) ? tzoff : 0)
    .all();
  return c.json({ rows: r.results });
});

// Total spend attributable to one entity: every turn whose events touched it
// (for projects, also turns touching its todos or logs).
async function entityCost(
  c: { env: Env },
  userId: number,
  type: "todo" | "project",
  id: number,
): Promise<number> {
  const touching =
    type === "todo"
      ? `SELECT DISTINCT message_id FROM events
         WHERE user_id = ?1 AND message_id IS NOT NULL
           AND entity_type = 'todo' AND entity_id = ?2`
      : `SELECT DISTINCT message_id FROM events
         WHERE user_id = ?1 AND message_id IS NOT NULL
           AND ((entity_type = 'project' AND entity_id = ?2)
             OR (entity_type = 'todo' AND entity_id IN (SELECT id FROM todos WHERE user_id = ?1 AND project_id = ?2))
             OR (entity_type = 'log' AND entity_id IN (SELECT id FROM logs WHERE user_id = ?1 AND project_id = ?2)))`;
  const row = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM llm_usage
     WHERE user_id = ?1 AND message_id IN (${touching})`,
  )
    .bind(userId, id)
    .first<{ cost: number }>();
  return row?.cost ?? 0;
}

crud.get("/usage/entity", async (c) => {
  const type = c.req.query("type");
  const id = Number(c.req.query("id"));
  if (!id || (type !== "todo" && type !== "project")) return c.json({ error: "bad params" }, 400);
  return c.json({ cost: await entityCost(c, c.get("user").id, type, id) });
});

// Per-project totals for the project cards (one map, no N client calls).
crud.get("/usage/projects", async (c) => {
  const userId = c.get("user").id;
  const projects = await listProjects(c.env, userId);
  const out: Record<number, number> = {};
  for (const p of projects) {
    out[p.id] = await entityCost(c, userId, "project", p.id);
  }
  return c.json(out);
});

// -- Today-view dismissals --------------------------------------------------

crud.get("/dismissals", async (c) => {
  const day = c.req.query("day");
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return c.json({ error: "day=YYYY-MM-DD required" }, 400);
  const rows = await listDismissals(c.env, c.get("user").id, day);
  return c.json({
    keys: rows.map((r) => r.key),
    items: rows.map((r) => ({ key: r.key, why: r.why ?? "hide" })),
  });
});

crud.post("/dismissals", async (c) => {
  const body = await c.req.json<{
    day?: string;
    key?: string;
    label?: string;
    dismissed?: boolean;
    why?: string;
  }>();
  if (!body.day || !/^\d{4}-\d{2}-\d{2}$/.test(body.day) || !body.key) {
    return c.json({ error: "day and key required" }, 400);
  }
  await setDismissal(
    c.env,
    c.get("user").id,
    body.day,
    body.key.slice(0, 300),
    body.label ? body.label.slice(0, 300) : null,
    body.dismissed !== false,
    body.why === "done" ? "done" : "hide",
  );
  return c.json({ ok: true });
});

// -- Web push subscriptions -------------------------------------------------

crud.get("/push/key", (c) => c.json({ key: c.env.VAPID_PUBLIC_KEY ?? null }));

crud.post("/push/subscribe", async (c) => {
  const body = await c.req.json<{ endpoint?: string; keys?: { p256dh?: string; auth?: string } }>();
  if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
    return c.json({ error: "endpoint and keys required" }, 400);
  }
  await saveSubscription(c.env, c.get("user").id, {
    endpoint: body.endpoint,
    keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
  });
  return c.json({ ok: true });
});

crud.post("/push/unsubscribe", async (c) => {
  const body = await c.req.json<{ endpoint?: string }>();
  if (!body.endpoint) return c.json({ error: "endpoint required" }, 400);
  await c.env.DB.prepare(`DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?`)
    .bind(c.get("user").id, body.endpoint)
    .run();
  return c.json({ ok: true });
});

// Test push to every device this user subscribed.
crud.post("/push/test", async (c) => {
  await pushToUser(c.env, c.get("user").id, {
    title: "Todo Log push works",
    body: "This is a test — check-ins will look like this.",
  });
  return c.json({ ok: true });
});

// Manual check-in (the same pass the cron runs, minus the schedule gates).
crud.post("/checkin/run", async (c) => {
  const result = await checkinForUser(c.env, c.get("user"), now());
  return c.json({ result });
});

// -- Agent memory (the save_memory notes, user-editable) --------------------

crud.get("/memory", async (c) => c.json(await listMemories(c.env, c.get("user").id)));

crud.post("/memory", async (c) => {
  const body = await c.req.json<{ key?: string; content?: string }>();
  const key = (body.key ?? "").trim();
  if (!key) return c.json({ error: "key required" }, 400);
  // Empty content deletes the key (same contract as the agent's tool).
  await saveMemory(c.env, c.get("user").id, key, body.content ?? "");
  return c.json({ ok: true });
});

// -- Agent settings (model / thinking) --------------------------------------

crud.get("/settings/agent", async (c) => {
  return c.json(parseConfig(c.get("user").agent_config));
});

crud.post("/settings/agent", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  // parseConfig sanitizes: unknown fields drop, invalid values fall back.
  const cfg = parseConfig(JSON.stringify(body));
  await c.env.DB.prepare(`UPDATE users SET agent_config = ? WHERE id = ?`)
    .bind(JSON.stringify(cfg), c.get("user").id)
    .run();
  return c.json(cfg);
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
  todo: ["title", "outcome", "details", "project_id", "status", "scheduled_start", "all_day"],
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
  if (type === "todo" && cols.status === "done") {
    await resolvePlannedSlots(c.env, user.id, id, "done");
  } else if (type === "todo" && cols.status === "abandoned") {
    await resolvePlannedSlots(c.env, user.id, id, "skipped");
  }
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
