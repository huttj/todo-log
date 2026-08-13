// Complete destruction of a user's data — D1 rows in FK-safe order, R2 audio
// by prefix. The order is load-bearing: dependents before their targets
// (events/logs before messages, messages before sessions, sessions before
// notifications, schedules/actions before todos, todos before projects).
import type { Env, UserRow } from "./types";
import { deleteVectors } from "./embeddings";

const DELETE_ORDER = [
  `DELETE FROM google_tokens WHERE user_id = ?1`,
  `DELETE FROM learnings WHERE user_id = ?1`,
  `DELETE FROM events WHERE user_id = ?1`,
  `DELETE FROM corrections WHERE user_id = ?1`,
  `DELETE FROM audio_segments WHERE message_id IN
     (SELECT id FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE user_id = ?1))`,
  `DELETE FROM llm_usage WHERE user_id = ?1`,
  `DELETE FROM logs WHERE user_id = ?1`,
  `DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE user_id = ?1)`,
  `DELETE FROM support_messages WHERE user_id = ?1`,
  `DELETE FROM sessions WHERE user_id = ?1`,
  `DELETE FROM notifications WHERE user_id = ?1`,
  `DELETE FROM todo_schedules WHERE user_id = ?1`,
  `DELETE FROM actions WHERE user_id = ?1`,
  `DELETE FROM todos WHERE user_id = ?1`,
  `DELETE FROM projects WHERE user_id = ?1`,
  `DELETE FROM agent_memory WHERE user_id = ?1`,
  `DELETE FROM push_subscriptions WHERE user_id = ?1`,
  `DELETE FROM briefings WHERE user_id = ?1`,
];

async function purgeR2Prefix(env: Env, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await env.MEDIA.list({ prefix, cursor });
    for (const obj of listed.objects) {
      await env.MEDIA.delete(obj.key).catch(() => {});
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

/** Destroys everything. Caller is responsible for having checked
 * delete_after (or admin intent). */
export async function purgeUser(env: Env, user: UserRow): Promise<void> {
  // Vector ids must be gathered while the rows still exist.
  const vectorIds: string[] = [];
  for (const [type, table] of [["project", "projects"], ["todo", "todos"], ["log", "logs"]] as const) {
    const r = await env.DB.prepare(`SELECT id FROM ${table} WHERE user_id = ?`)
      .bind(user.id)
      .all<{ id: number }>();
    vectorIds.push(...r.results.map((x) => `${type}:${x.id}`));
  }
  await deleteVectors(env, vectorIds);
  for (const prefix of [`audio/${user.id}/`, `support/tmp/${user.id}/`, `support/${user.id}/`]) {
    await purgeR2Prefix(env, prefix);
  }
  await env.DB.batch(DELETE_ORDER.map((sql) => env.DB.prepare(sql).bind(user.id)));
  await env.DB.prepare(`DELETE FROM prospects WHERE lower(email) = lower(?)`)
    .bind(user.email)
    .run();
  await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(user.id).run();
  console.log(`purge: user ${user.id} (${user.email}) destroyed`);
}

/** Cron leg: destroy accounts whose grace period has elapsed. */
export async function purgeDueDeletions(env: Env, t: number): Promise<void> {
  const due = await env.DB.prepare(
    `SELECT * FROM users WHERE delete_after IS NOT NULL AND delete_after <= ?`,
  )
    .bind(t)
    .all<UserRow>();
  for (const user of due.results) {
    try {
      await purgeUser(env, user);
    } catch (err) {
      console.error(`purge: user ${user.id} failed:`, err);
    }
  }
}
