// Semantic search: bge-base embeddings in Vectorize, synced incrementally by
// the cron sweep (single integration point — no per-tool indexing churn).
// Vector ids are "<type>:<rowid>", metadata carries {user_id, type} for
// filtered queries. Hydration always re-checks D1 with the requester's
// user_id, so stale or foreign vectors can never leak content.
import type { Env, ProjectRow, TodoRow, LogRow } from "./types";
import { now, searchAll } from "./db";

const MODEL = "@cf/baai/bge-base-en-v1.5";
const SYNC_KEY = "embed_sync_at";

async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 25) {
    const batch = texts.slice(i, i + 25).map((t) => t.slice(0, 2000) || " ");
    const res = (await env.AI.run(MODEL as never, { text: batch } as never)) as unknown as {
      data: number[][];
    };
    out.push(...res.data);
  }
  return out;
}

const projectText = (p: ProjectRow) =>
  [p.name, p.description ?? "", p.priority ?? ""].join("\n").trim();
const todoText = (t: TodoRow) => [t.title, t.outcome ?? "", t.details ?? ""].join("\n").trim();
const logText = (l: LogRow) => [l.title ?? "", l.summary].join("\n").trim();

/** Incremental sync: everything created/updated since the watermark. First
 * run (no watermark) backfills the whole corpus. */
export async function syncEmbeddings(env: Env): Promise<void> {
  if (!env.VECTORS) return;
  const marker = await env.DB.prepare(`SELECT value FROM meta WHERE key = ?`)
    .bind(SYNC_KEY)
    .first<{ value: string }>();
  const since = marker ? Number(marker.value) : 0;
  const t = now();

  const [projects, todos, logs] = await Promise.all([
    env.DB.prepare(`SELECT * FROM projects WHERE updated_at > ?`).bind(since).all<ProjectRow>(),
    env.DB.prepare(`SELECT * FROM todos WHERE updated_at > ?`).bind(since).all<TodoRow>(),
    env.DB.prepare(`SELECT * FROM logs WHERE created_at > ?`).bind(since).all<LogRow>(),
  ]);

  const items: { id: string; user_id: number; type: string; text: string }[] = [
    ...projects.results.map((p) => ({ id: `project:${p.id}`, user_id: p.user_id, type: "project", text: projectText(p) })),
    ...todos.results.map((td) => ({ id: `todo:${td.id}`, user_id: td.user_id, type: "todo", text: todoText(td) })),
    ...logs.results.map((l) => ({ id: `log:${l.id}`, user_id: l.user_id, type: "log", text: logText(l) })),
  ].filter((x) => x.text.length > 0);

  if (items.length > 0) {
    const vectors = await embed(env, items.map((x) => x.text));
    for (let i = 0; i < items.length; i += 500) {
      await env.VECTORS.upsert(
        items.slice(i, i + 500).map((x, j) => ({
          id: x.id,
          values: vectors[i + j],
          metadata: { user_id: x.user_id, type: x.type },
        })),
      );
    }
    console.log(`embeddings: synced ${items.length} items`);
  }

  await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(SYNC_KEY, String(t))
    .run();
}

export interface SemanticHit {
  type: "project" | "todo" | "log";
  id: number;
  score: number;
}

export async function semanticSearch(
  env: Env,
  userId: number,
  query: string,
  opts: { types?: string[]; topK?: number } = {},
): Promise<SemanticHit[]> {
  if (!env.VECTORS) return [];
  try {
    const [vector] = await embed(env, [query]);
    const res = await env.VECTORS.query(vector, {
      topK: opts.topK ?? 12,
      filter: { user_id: { $eq: userId } },
      returnMetadata: true,
    });
    return res.matches
      .map((m) => {
        const [type, idStr] = m.id.split(":");
        return { type: type as SemanticHit["type"], id: Number(idStr), score: m.score };
      })
      .filter(
        (h) =>
          ["project", "todo", "log"].includes(h.type) &&
          Number.isFinite(h.id) &&
          (!opts.types || opts.types.length === 0 || opts.types.includes(h.type)),
      );
  } catch (err) {
    console.error("semantic search failed:", err);
    return [];
  }
}

/** Purge support: remove a user's vectors (ids gathered before row deletion). */
export async function deleteVectors(env: Env, ids: string[]): Promise<void> {
  if (!env.VECTORS || ids.length === 0) return;
  for (let i = 0; i < ids.length; i += 500) {
    await env.VECTORS.deleteByIds(ids.slice(i, i + 500)).catch(() => {});
  }
}

/** Keyword + semantic, merged: keyword hits lead (exact words beat vibes),
 * semantic-only extras append, deduped, hydrated fresh from D1 under the
 * requester's user_id. */
export type SearchSort = "blend" | "recent" | "match";

/** Blend: match strength decays with age (30-day half-life, floored at 0.5)
 * so a perfect old hit still beats a mediocre fresh one, and ties break
 * toward now. Keyword hits score 1.0 — exact words beat vibes. */
function blendScore(match: number, ageDays: number): number {
  return match * (0.5 + 0.5 * Math.pow(2, -ageDays / 30));
}

export async function hybridSearch(
  env: Env,
  userId: number,
  query: string,
  opts: { types?: string[]; projectId?: number; sort?: SearchSort } = {},
): Promise<{ projects: ProjectRow[]; todos: TodoRow[]; logs: LogRow[] }> {
  const [keyword, semantic] = await Promise.all([
    searchAll(env, userId, query, opts),
    // Semantic can't scope to a project cheaply — skip it for scoped queries.
    opts.projectId == null ? semanticSearch(env, userId, query, { types: opts.types }) : Promise.resolve([]),
  ]);
  const have = new Set([
    ...keyword.projects.map((p) => `project:${p.id}`),
    ...keyword.todos.map((t) => `todo:${t.id}`),
    ...keyword.logs.map((l) => `log:${l.id}`),
  ]);
  const matchOf = new Map<string, number>();
  for (const k of have) matchOf.set(k, 1);
  const extras = semantic.filter((h) => !have.has(`${h.type}:${h.id}`)).slice(0, 10);
  for (const hit of extras) {
    const table = { project: "projects", todo: "todos", log: "logs" }[hit.type];
    const row = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ? AND user_id = ?`)
      .bind(hit.id, userId)
      .first<ProjectRow & TodoRow & LogRow>();
    if (!row) continue; // stale vector (deleted row) — ignore
    matchOf.set(`${hit.type}:${hit.id}`, hit.score);
    if (hit.type === "project") keyword.projects.push(row);
    else if (hit.type === "todo") keyword.todos.push(row);
    else keyword.logs.push(row);
  }

  const t = now();
  const sort = opts.sort ?? "blend";
  const order = <T extends { id: number }>(rows: T[], type: string, when: (r: T) => number): T[] => {
    const key = (r: T) => {
      const match = matchOf.get(`${type}:${r.id}`) ?? 0.5;
      if (sort === "recent") return when(r);
      if (sort === "match") return match;
      return blendScore(match, Math.max(0, (t - when(r)) / 86400));
    };
    return [...rows].sort((a, b) => key(b) - key(a));
  };
  return {
    projects: order(keyword.projects, "project", (r) => (r as ProjectRow).updated_at),
    todos: order(keyword.todos, "todo", (r) => (r as TodoRow).updated_at),
    logs: order(keyword.logs, "log", (r) => (r as LogRow).occurred_at),
  };
}
