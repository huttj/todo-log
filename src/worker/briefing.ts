// The precomputed daily briefing: what today should look like, per-project
// momentum, loose threads, and what's coming. The Today view renders it; the
// agent sees it every turn and rewrites it via update_briefing when warranted;
// cron refreshes it when stale; ↻ recomputes on demand.
import Anthropic from "@anthropic-ai/sdk";
import type { Env, UserRow, TodoRow } from "./types";
import {
  now,
  listProjects,
  listTodos,
  listScheduledTodos,
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
  /** Plans & commitments for today/tonight — actionable items only. */
  today: string[];
  today_more: string[];
  /** Loose threads: commitments living only in logs, not tracked anywhere. */
  oneoffs: string[];
  oneoffs_more: string[];
  /** Tomorrow and the days ahead (also pure timing/status info). */
  coming: string[];
  coming_more: string[];
  /** One line per project: momentum + suggested next step. */
  projects: { project_id: number | null; name: string; line: string }[];
  projects_more: { project_id: number | null; name: string; line: string }[];
}

/** Style contract shared by the generator and the agent's update_briefing
 * tool — this is what makes the briefing feel like a colleague, not a nag. */
export const BRIEFING_STYLE = `STYLE RULES (follow exactly):
- Entity references: when a line concerns a specific tracked item, embed a token inline where it reads naturally — [todo:ID], [project:ID], [log:ID]. The app renders these as links. Example: "Feed the statements to Claude [todo:12]".
- Mirror the user's own words and commitment level. If they said they'd "look into" something, write "look into" — never escalate ("mentioned you'd look into" ≠ "said you'd do").
- You have a lot of information but not the full picture. When a state is assumed rather than known (returned? delivered? finished?), phrase the line as a QUESTION rather than an assertion — especially loose threads: "Did you return the spare key to Reggie?"
- Only actionable items go in plans; pure status or timing information ("nothing due until Tuesday") belongs in coming.
- Describe momentum neutrally: moving / quiet / dormant / waiting. Never nudge, guilt, or editorialize urgency. Banned register: "finally", "you keep postponing", "still hanging", "no action yet", "sit down and", "make it real", "the actual plan", prescriptive sequencing like "before touching X". A next step is a plain suggestion ("Next: brainstorm keep/toss criteria"), never a command or a judgment.
- The main lists hold only the few items that deserve attention today; everything else goes in the matching _more list (shown behind "see more").
- Ground every line in real data — never invent. Second person, plain, brief.`;

export async function generateBriefing(env: Env, user: UserRow): Promise<Briefing | null> {
  const t = now();
  const tz = user.timezone ?? env.TIMEZONE;
  const [projects, todos, scheduled, logs, memories, notifications] = await Promise.all([
    listProjects(env, user.id),
    listTodos(env, user.id),
    listScheduledTodos(env, user.id, { from: t - 2 * DAY, to: t + 7 * DAY }),
    listLogs(env, user.id, { from: t - 7 * DAY, limit: 40 }),
    listMemories(env, user.id),
    listNotifications(env, user.id),
  ]);

  const when = (td: TodoRow) =>
    td.scheduled_start
      ? td.all_day
        ? `${new Date(td.scheduled_start * 1000).toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" })} (any time)`
        : new Date(td.scheduled_start * 1000).toLocaleString("en-US", { timeZone: tz })
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
    `Scheduled todos (last 2 days → next 7):\n${scheduled.map((td) => `#${td.id} ${td.title} [${td.status}] ${when(td)}`).join("\n") || "(none)"}`,
    `Recent logs (last 7 days, newest first — the user's own words about how it's going):\n${logs
      .map((l) => `#${l.id} [${new Date(l.occurred_at * 1000).toLocaleDateString("en-US", { timeZone: tz, weekday: "short" })}] (${l.kind}) ${l.summary}`)
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
    max_tokens: 2400,
    system:
      "You compute the daily briefing for Todo Log, a voice-first todo/journal app. From the data, " +
      "produce ONLY a JSON object (no fences, no prose) with keys:\n" +
      '- "headline": one honest line about what today looks like.\n' +
      '- "today" + "today_more": plans & commitments for today/tonight, actionable items only.\n' +
      '- "oneoffs" + "oneoffs_more": loose threads — commitments that appear ONLY in logs, not tracked as any todo.\n' +
      '- "coming" + "coming_more": tomorrow and the days ahead, plus pure timing/status info.\n' +
      '- "projects" + "projects_more": {"project_id": n, "name": "...", "line": "..."} per ACTIVE project, ' +
      "line = momentum + one suggested next step, ≤ 20 words.\n" +
      "All keys required; use [] when empty.\n\n" +
      BRIEFING_STYLE,
    messages: [{ role: "user", content: input }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("")
    .trim();
  // Take the outermost JSON object regardless of any wrapping the model added.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    console.error(`briefing: no JSON in output for user ${user.id}: ${text.slice(0, 200)}`);
    return null;
  }
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<Briefing>;
    if (!parsed.headline) return null;
    const briefing: Briefing = {
      headline: parsed.headline,
      today: parsed.today ?? [],
      today_more: parsed.today_more ?? [],
      oneoffs: parsed.oneoffs ?? [],
      oneoffs_more: parsed.oneoffs_more ?? [],
      coming: parsed.coming ?? [],
      coming_more: parsed.coming_more ?? [],
      projects: parsed.projects ?? [],
      projects_more: parsed.projects_more ?? [],
    };
    await setBriefing(env, user.id, JSON.stringify(briefing));
    return briefing;
  } catch {
    console.error(`briefing: unparseable output for user ${user.id}: ${text.slice(0, 200)}`);
    return null;
  }
}
