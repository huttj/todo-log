// The precomputed daily briefing: what today should look like, per-project
// momentum, one-off commitments, and what the user said about the coming days.
// Regenerated after every agent turn, on cron staleness, and on demand — the
// Today view renders it; plan-mode chats get it as context.
import Anthropic from "@anthropic-ai/sdk";
import type { Env, UserRow, ActionRow } from "./types";
import {
  now,
  listProjects,
  listTodos,
  listActions,
  listLogs,
  listMemories,
  listNotifications,
  setBriefing,
} from "./db";

const BRIEFING_MODEL = "claude-sonnet-5";
const DAY = 86400;

export interface Briefing {
  /** One-line read of the day. */
  headline: string;
  /** Plans/commitments for today (and tonight). */
  today: string[];
  /** For tomorrow, when anything is known. */
  tomorrow: string[];
  /** One line per active project: momentum + suggested next step. */
  projects: { project_id: number | null; name: string; line: string }[];
  /** Commitments that live only in the logs — not tracked as todos/actions. */
  oneoffs: string[];
  /** Anything said about the coming week. */
  week: string[];
}

export async function generateBriefing(env: Env, user: UserRow): Promise<Briefing | null> {
  const t = now();
  const tz = user.timezone ?? env.TIMEZONE;
  const [projects, todos, actions, logs, memories, notifications] = await Promise.all([
    listProjects(env, user.id),
    listTodos(env, user.id),
    listActions(env, user.id, { from: t - 2 * DAY, to: t + 7 * DAY }),
    listLogs(env, user.id, { from: t - 7 * DAY, limit: 40 }),
    listMemories(env, user.id),
    listNotifications(env, user.id),
  ]);

  const when = (a: ActionRow) =>
    a.scheduled_start
      ? a.all_day
        ? `${new Date(a.scheduled_start * 1000).toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" })} (all day)`
        : new Date(a.scheduled_start * 1000).toLocaleString("en-US", { timeZone: tz })
      : "unscheduled";

  const input = [
    `Current local time: ${new Date(t * 1000).toLocaleString("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })}`,
    `Active projects:\n${projects
      .filter((p) => p.status === "active")
      .map((p) => `#${p.id} ${p.name}${p.description ? ` — ${p.description}` : ""}`)
      .join("\n") || "(none)"}`,
    `Open todos:\n${todos
      .map((td) => `#${td.id} ${td.title} [${td.status}]${td.project_id ? ` (project #${td.project_id})` : ""}${td.details ? ` — ${td.details.slice(0, 120)}` : ""}`)
      .join("\n") || "(none)"}`,
    `Actions (last 2 days → next 7):\n${actions.map((a) => `- ${a.title ?? "untitled"} [${a.status}] ${when(a)}`).join("\n") || "(none)"}`,
    `Recent logs (last 7 days, newest first — the user's own words about how it's going):\n${logs
      .map((l) => `- [${new Date(l.occurred_at * 1000).toLocaleDateString("en-US", { timeZone: tz, weekday: "short" })}] (${l.kind}) ${l.summary}`)
      .join("\n") || "(none)"}`,
    memories.length ? `Agent memory notes:\n${memories.map((m) => `[${m.key}] ${m.content}`).join("\n")}` : "",
    notifications.length
      ? `Open notifications:\n${notifications.map((n) => `- ${n.title}${n.body ? ` — ${n.body}` : ""}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: BRIEFING_MODEL,
    max_tokens: 1200,
    system:
      "You compute the daily briefing for Todo Log, a voice-first todo/journal app. From the data, " +
      "produce ONLY a JSON object (no fences, no prose) with keys:\n" +
      '- "headline": one honest line about what today looks like.\n' +
      '- "today": 2-6 short bullets — plans and commitments for today/tonight, most important first. ' +
      "Include scheduled items AND things the user said they'd do today that never got scheduled.\n" +
      '- "tomorrow": bullets for tomorrow if anything is known, else [].\n' +
      '- "projects": one entry per ACTIVE project: {"project_id": n, "name": "...", "line": "..."} where ' +
      "line = current momentum (moving/stalled/waiting, from logs and statuses) + one concrete suggested next step. ≤ 20 words.\n" +
      '- "oneoffs": commitments that appear ONLY in logs — promised, mentioned, or agreed to but not tracked ' +
      "as any todo/action (e.g. \"said you'd send Sam the photos\"). [] if none.\n" +
      '- "week": bullets for anything the user said about the coming week. [] if none.\n' +
      "Ground every line in the data — never invent. Write in second person, plainly, no filler. " +
      "If the logs suggest something is being avoided, it's fine for the headline or a project line to say so gently.",
    messages: [{ role: "user", content: input }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("")
    .trim()
    .replace(/^```(json)?|```$/g, "")
    .trim();
  try {
    const parsed = JSON.parse(text) as Briefing;
    if (!parsed.headline) return null;
    await setBriefing(env, user.id, JSON.stringify(parsed));
    return parsed;
  } catch {
    console.error(`briefing: unparseable output for user ${user.id}: ${text.slice(0, 200)}`);
    return null;
  }
}
