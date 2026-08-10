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

const DISTILL_MODEL = "claude-opus-5";
const CHECKIN_MODEL = "claude-sonnet-5";
const CHECKIN_INTERVAL = 3 * 3600;
const DAY = 86400;

export async function runSweep(env: Env): Promise<void> {
  await healSegments(env);
  await distillCorrections(env);
  await runCheckins(env);
  await refreshStaleBriefings(env);
}

/** Chats regenerate the briefing; cron covers the mornings and quiet days —
 * refresh whenever it's stale (> 4h) during waking hours. */
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
      const hour = hourInZone(user.timezone ?? env.TIMEZONE);
      if (hour < 6 || hour >= 23) continue;
      const current = await getBriefing(env, user.id);
      if (current && t - current.generated_at < 4 * 3600) continue;
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
  for (const [userId, corrections] of byUser) {
    try {
      const current = await getLearnings(env, userId);
      const response = await client.messages.create({
        model: DISTILL_MODEL,
        max_tokens: 4096,
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
      if (user.last_checkin_at && t - user.last_checkin_at < CHECKIN_INTERVAL) continue;
      const hour = hourInZone(user.timezone ?? env.TIMEZONE);
      if (hour < 8 || hour >= 22) continue;
      // Recently in a conversation → they're engaged; don't nag.
      const recent = await env.DB.prepare(
        `SELECT 1 FROM sessions WHERE user_id = ? AND started_at > ? LIMIT 1`,
      )
        .bind(user.id, t - 3600)
        .first();
      if (recent) continue;
      // Mark the attempt regardless of outcome so a SKIP still waits 3h.
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
  const response = await client.messages.create({
    model: CHECKIN_MODEL,
    max_tokens: 500,
    system:
      "You are the agent inside Todo Log, writing the single in-app check-in notification for your user. " +
      "You are warm, brief, and specific — a good coworker glancing at the board, never a nag. " +
      "Given what's open, either write a short check-in (title ≤ 8 words; body 1-3 sentences naming " +
      "SPECIFIC items and asking 1-2 concrete questions — a progress update, or what's making something " +
      "hard) or decide none is warranted right now. Mirror the user's own words and commitment level " +
      "(never escalate \"look into\" to \"do\"); when a state is assumed rather than known, ask rather than " +
      "assert; banned register: \"finally\", \"you keep postponing\", \"still hanging\", \"no action yet\". " +
      'Reply with ONLY JSON: {"title": "...", "body": "..."} or {"skip": true}.',
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
    };
    if (parsed.skip || !parsed.title) return;
    await setNotification(env, user.id, "checkin", parsed.title, parsed.body ?? null);
  } catch {
    console.error(`sweep: unparseable check-in for user ${user.id}: ${text.slice(0, 200)}`);
  }
}
