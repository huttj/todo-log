// Cron sweep (Cyborgy pattern): heal untranscribed audio segments, then
// distill pending corrections into each user's learnings doc.
import Anthropic from "@anthropic-ai/sdk";
import type { Env, UserRow, TodoRow, ScheduleRow } from "./types";
import {
  now,
  stuckSegments,
  setSegmentTranscript,
  pendingCorrections,
  markCorrectionsProcessed,
  getLearnings,
  setLearnings,
  enabledUsers,
  listSchedule,
  listTodos,
  listMemories,
  setNotification,
  getBriefing,
} from "./db";
import { transcribe } from "./transcribe";
import { generateBriefing } from "./briefing";
import { emptyUsage, addUsage, recordUsage } from "./usage";
import { resolveUseCase, modelParams, parseConfig } from "./config";
import { pushToUser } from "./push";

const DAY = 86400;

export async function runSweep(env: Env): Promise<void> {
  await healSegments(env);
  await distillCorrections(env);
  await runCheckins(env);
  await refreshStaleBriefings(env);
}

/** The overview regenerates only here (per the user's schedule) or via the
 * manual refresh button — chats never touch it. */
async function refreshStaleBriefings(env: Env): Promise<void> {
  let users: UserRow[];
  try {
    users = await enabledUsers(env);
  } catch {
    return;
  }
  const t = now();
  for (const user of users) {
    try {
      const schedule = parseConfig(user.agent_config).briefing_refresh;
      if (schedule.interval_hours === 0) continue; // manual / chat-driven only
      const hour = hourInZone(user.timezone ?? env.TIMEZONE);
      if (hour < schedule.start_hour || hour >= schedule.end_hour) continue;
      const current = await getBriefing(env, user.id);
      if (current && t - current.generated_at < schedule.interval_hours * 3600) continue;
      await generateBriefing(env, user);
    } catch (err) {
      console.error(`sweep: briefing refresh for user ${user.id} failed:`, err);
    }
  }
}

async function healSegments(env: Env): Promise<void> {
  const stuck = await stuckSegments(env, now() - 60);
  for (const seg of stuck) {
    try {
      const object = await env.MEDIA.get(seg.r2_key);
      if (!object) continue;
      const { text, words } = await transcribe(env, await object.arrayBuffer());
      await setSegmentTranscript(env, seg.id, text, words);
    } catch (err) {
      console.error(`sweep: segment ${seg.id} still failing:`, err);
      await env.DB.prepare(
        `UPDATE audio_segments SET transcribe_failures = transcribe_failures + 1 WHERE id = ?`,
      )
        .bind(seg.id)
        .run()
        .catch(() => {});
    }
  }
}

async function distillCorrections(env: Env): Promise<void> {
  const pending = await pendingCorrections(env);
  if (pending.length === 0) return;

  const byUser = new Map<number, { id: number; description: string }[]>();
  for (const p of pending) {
    const list = byUser.get(p.user_id) ?? [];
    list.push(p);
    byUser.set(p.user_id, list);
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  let users: UserRow[] = [];
  try {
    users = await enabledUsers(env);
  } catch {
    return;
  }
  const userById = new Map(users.map((u) => [u.id, u]));
  for (const [userId, corrections] of byUser) {
    try {
      const user = userById.get(userId);
      if (!user) continue;
      const resolved = resolveUseCase(user, "distill");
      const current = await getLearnings(env, userId);
      const response = await client.messages.create({
        model: resolved.modelId,
        max_tokens: 6000,
        ...(modelParams(resolved) as object),
        system:
          "You maintain a concise 'learnings' document for a personal todo/journal agent: durable guidance " +
          "distilled from times the user corrected the agent. Merge the new corrections into the current " +
          "document. Rules: generalize each correction into a reusable instruction; merge duplicates; keep " +
          "it under ~30 short bullet points, most broadly-useful first; drop anything one-off or ephemeral. " +
          "Output ONLY the updated document as markdown bullets, no preamble.",
        messages: [
          {
            role: "user",
            content: `Current document:\n${current || "(empty)"}\n\nNew corrections:\n${corrections
              .map((x) => `- ${x.description}`)
              .join("\n")}`,
          },
        ],
      });
      const usage = emptyUsage();
      addUsage(usage, response.usage);
      await recordUsage(env, { userId, kind: "distill", model: resolved.modelId, usage });
      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("\n")
        .trim();
      if (text) {
        await setLearnings(env, userId, text);
        await markCorrectionsProcessed(
          env,
          corrections.map((x) => x.id),
        );
      }
    } catch (err) {
      console.error(`sweep: distilling corrections for user ${userId} failed:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Periodic check-in: every ~3h during waking hours, wake a lightweight agent
// pass that decides whether to (re)write the 'checkin' notification with a
// specific progress question about what's open or scheduled today.
// ---------------------------------------------------------------------------

function hourInZone(tz: string): number {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(
      new Date(),
    ),
  );
}

async function runCheckins(env: Env): Promise<void> {
  const t = now();
  let users: UserRow[];
  try {
    users = await enabledUsers(env);
  } catch (err) {
    console.error("sweep: listing users for check-ins failed:", err);
    return;
  }
  for (const user of users) {
    try {
      const schedule = parseConfig(user.agent_config).checkin_schedule;
      if (schedule.interval_hours === 0) continue; // check-ins turned off
      if (user.last_checkin_at && t - user.last_checkin_at < schedule.interval_hours * 3600) continue;
      const hour = hourInZone(user.timezone ?? env.TIMEZONE);
      if (hour < schedule.start_hour || hour >= schedule.end_hour) continue;
      // Recently in a conversation → they're engaged; don't nag.
      const recent = await env.DB.prepare(
        `SELECT 1 FROM sessions WHERE user_id = ? AND started_at > ? LIMIT 1`,
      )
        .bind(user.id, t - 3600)
        .first();
      if (recent) continue;
      // Mark the attempt regardless of outcome so a SKIP still waits a full interval.
      await env.DB.prepare(`UPDATE users SET last_checkin_at = ? WHERE id = ?`)
        .bind(t, user.id)
        .run();
      await checkinForUser(env, user, t);
    } catch (err) {
      console.error(`sweep: check-in for user ${user.id} failed:`, err);
    }
  }
}

async function checkinForUser(env: Env, user: UserRow, t: number): Promise<void> {
  const [schedule, todos, memories] = await Promise.all([
    listSchedule(env, user.id, { from: t - 2 * DAY, to: t + DAY }),
    listTodos(env, user.id),
    listMemories(env, user.id),
  ]);
  const open = schedule.filter((s) => s.slot_status === "planned");
  const inFlight = todos.filter(
    (td) => (td.status === "in_progress" || td.status === "scheduled") && !open.some((o) => o.id === td.id),
  );
  if (open.length === 0 && inFlight.length === 0) return;

  const tz = user.timezone ?? env.TIMEZONE;
  const line = (s: ScheduleRow) => {
    const when = s.slot_all_day
      ? `${new Date(s.slot_start * 1000).toLocaleDateString("en-US", { timeZone: tz, weekday: "short" })} (any time)`
      : new Date(s.slot_start * 1000).toLocaleString("en-US", { timeZone: tz });
    return `- todo “${s.title}” [${s.status}] ${when}`;
  };
  const todoLine = (td: TodoRow) => `- todo “${td.title}” [${td.status}]`;

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const resolved = resolveUseCase(user, "checkin");
  const response = await client.messages.create({
    model: resolved.modelId,
    max_tokens: 2000,
    ...(modelParams(resolved) as object),
    system:
      "You are the agent inside Todo Log, writing the single in-app check-in notification for your user. " +
      "You are warm, brief, and specific — a good coworker glancing at the board, never a nag. " +
      "Given what's open, either write a short check-in (title ≤ 8 words; body 1-3 sentences naming " +
      "SPECIFIC items and asking 1-2 concrete questions — a progress update, or what's making something " +
      "hard) or decide none is warranted right now. Mirror the user's own words and commitment level " +
      "(never escalate \"look into\" to \"do\"); when a state is assumed rather than known, ask rather than " +
      "assert; banned register: \"finally\", \"you keep postponing\", \"still hanging\", \"no action yet\". " +
      "If the day's picture has clearly shifted since the briefing would have been computed, you may also " +
      'set "refresh_briefing": true to recompute the Today overview. ' +
      'Reply with ONLY JSON: {"title": "...", "body": "...", "refresh_briefing": false} or {"skip": true}.',
    messages: [
      {
        role: "user",
        content: [
          `Local time: ${new Date(t * 1000).toLocaleString("en-US", { timeZone: tz })}`,
          `Scheduled todos (last 2 days → tomorrow):\n${open.map(line).join("\n") || "(none)"}`,
          `Todos in flight:\n${inFlight.slice(0, 15).map(todoLine).join("\n") || "(none)"}`,
          memories.length
            ? `Your memory notes:\n${memories.map((m) => `[${m.key}] ${m.content}`).join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
  });
  const usage = emptyUsage();
  addUsage(usage, response.usage);
  await recordUsage(env, { userId: user.id, kind: "checkin", model: resolved.modelId, usage });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("")
    .trim();
  try {
    const parsed = JSON.parse(text.replace(/^```(json)?|```$/g, "").trim()) as {
      title?: string;
      body?: string;
      skip?: boolean;
      refresh_briefing?: boolean;
    };
    if (parsed.skip || !parsed.title) return;
    await setNotification(env, user.id, "checkin", parsed.title, parsed.body ?? null);
    await pushToUser(env, user.id, { title: parsed.title, body: parsed.body ?? null }).catch((err) =>
      console.error(`push: check-in push failed for user ${user.id}:`, err),
    );
    // Respect a manual-only overview setting: check-ins don't regenerate it either.
    if (parsed.refresh_briefing && parseConfig(user.agent_config).briefing_refresh.interval_hours > 0) {
      await generateBriefing(env, user).catch((err) =>
        console.error(`sweep: check-in-triggered briefing refresh failed for user ${user.id}:`, err),
      );
    }
  } catch {
    console.error(`sweep: unparseable check-in for user ${user.id}: ${text.slice(0, 200)}`);
  }
}
