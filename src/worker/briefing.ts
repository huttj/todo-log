// The precomputed daily briefing: what today should look like, per-project
// momentum, loose threads, and what's coming. The Today view renders it; the
// agent sees it every turn and rewrites it via update_briefing when warranted;
// cron refreshes it when stale; ↻ recomputes on demand.
import Anthropic from "@anthropic-ai/sdk";
import type { Env, UserRow, ScheduleRow } from "./types";
import { emptyUsage, addUsage, recordUsage } from "./usage";
import {
  now,
  listProjects,
  listTodos,
  listSchedule,
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
- Entity links are REQUIRED and use markdown-style syntax. The procedure: write the sentence first, exactly as you naturally would. THEN pick 2-5 consecutive words ALREADY IN that sentence and wrap them: "Next: [discuss the statements](todo:18) with Claude." The link adds ZERO new words to the line. If you find yourself putting the entity's TITLE inside the brackets, you have failed — the bracketed words must be your sentence's own words, which keep reading grammatically when the brackets are removed.
  BAD: "Discuss the statements with Claude to finalize the tax plan [Discuss bank statements with Claude to finalize tax plan](todo:22)." (title appended as a citation — the sentence says it twice)
  BAD: "tax discussion with Claude [todo:22]" (bare token)
  GOOD: "[Discuss the statements](todo:22) with Claude to finalize the tax plan."
  GOOD: "Mail [Taylor's birthday card](todo:21)."
  GOOD (project line): "[Back Taxes](project:3) — Moving. Next: [feed the statements](todo:22) to Claude."
  Self-check every line before output: delete the bracketed words and read it — if the sentence is STILL complete, you wrote the item twice; rewrite so the linked words are load-bearing. A line about a tracked item with no link is a defect; so is a line that names the item twice.
- NEVER narrate the user's inner world. No talk of resistance, avoidance, motivation, energy, being stuck or stalled, or what today "should" be the day for. Describe the state of the WORK, never the psychology of the person. Their feelings live in their own logs, in their own words — do not paraphrase feelings back at them, and do not restate uncertainty they expressed as a fact about them ("uncertain it's worth it" → frame the task: "Unclear if it's worth it — you might look into it if there's time").
- Never convert their uncertainty into a commitment: "you might X if there's time", not "will X if there's time".
- No urgency intensifiers or prodding, ever: "actually", "finally", "sit down", "lock in", "make it real", "you keep", "still hanging", "no action yet", "stalled" — all banned. The headline states what's on deck, plainly; it is never a diagnosis or a call to action.
  BAD headline: "Today's the day to actually sit down with three stalled things."
  GOOD headline: "Three candidates for today: [taxes-with-Claude](todo:18), [file criteria](todo:21), and [Fix Men next steps](todo:15) — plus [mailing Taylor's card](todo:19)."
  BAD: "should cut the resistance" → GOOD: "should make it much easier".
- Don't echo back facts the user just told you as if they were news ("it's filled out, just needs to go out" the day after they said exactly that). Freshly-shared context is known context — use it silently.
- Mirror the user's own words and commitment level. "Look into" stays "look into" — never escalate to "do"/"apply"/"finish".
- When a state is assumed rather than known (returned? delivered? finished?), phrase the line as a QUESTION — especially loose threads: "Did you return the spare key to Reggie?"
- Only actionable items go in plans; pure status or timing information belongs in coming.
- Project momentum words stay neutral and factual: moving / quiet / dormant / waiting. A next step is a plain suggestion ("Next: brainstorm keep/toss criteria"), never a command.
- The main lists hold only the few items that deserve attention today; everything else goes in the matching _more list (shown behind "see more").
- Ground every line in real data — never invent. Second person, plain, brief.`;

export async function generateBriefing(env: Env, user: UserRow): Promise<Briefing | null> {
  const t = now();
  const tz = user.timezone ?? env.TIMEZONE;
  const [projects, todos, scheduled, logs, memories, notifications] = await Promise.all([
    listProjects(env, user.id),
    listTodos(env, user.id),
    listSchedule(env, user.id, { from: t - 2 * DAY, to: t + 7 * DAY }),
    listLogs(env, user.id, { from: t - 7 * DAY, limit: 40 }),
    listMemories(env, user.id),
    listNotifications(env, user.id),
  ]);

  const when = (s: ScheduleRow) =>
    s.slot_all_day
      ? `${new Date(s.slot_start * 1000).toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" })} (any time)`
      : new Date(s.slot_start * 1000).toLocaleString("en-US", { timeZone: tz });

  const input = [
    `Current local time: ${new Date(t * 1000).toLocaleString("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })}`,
    `Active projects:\n${projects
      .filter((p) => p.status === "active")
      .map((p) => `#${p.id} ${p.name}${p.description ? ` — ${p.description}` : ""}`)
      .join("\n") || "(none)"}`,
    `Open todos:\n${todos
      .map((td) => `#${td.id} ${td.title} [${td.status}]${td.project_id ? ` (project #${td.project_id})` : ""}${td.details ? ` — ${td.details.slice(0, 120)}` : ""}`)
      .join("\n") || "(none)"}`,
    `Schedule (last 2 days → next 7; a todo can have several slots):\n${scheduled.map((s) => `todo #${s.id} ${s.title} [slot: ${s.slot_status}] ${when(s)}`).join("\n") || "(none)"}`,
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
  // Structured output guarantees parseable JSON (adaptive thinking previously
  // ate into max_tokens and could truncate the raw-JSON reply mid-object).
  const strArray = { type: "array", items: { type: "string" } };
  const projArray = {
    type: "array",
    items: {
      type: "object",
      properties: {
        project_id: { type: ["integer", "null"] },
        name: { type: "string" },
        line: { type: "string" },
      },
      required: ["project_id", "name", "line"],
      additionalProperties: false,
    },
  };
  const BRIEFING_SCHEMA = {
    type: "object",
    properties: {
      headline: { type: "string" },
      today: strArray,
      today_more: strArray,
      oneoffs: strArray,
      oneoffs_more: strArray,
      coming: strArray,
      coming_more: strArray,
      projects: projArray,
      projects_more: projArray,
    },
    required: [
      "headline", "today", "today_more", "oneoffs", "oneoffs_more",
      "coming", "coming_more", "projects", "projects_more",
    ],
    additionalProperties: false,
  };
  const response = await client.messages.create({
    model: BRIEFING_MODEL,
    max_tokens: 6000,
    output_config: { format: { type: "json_schema", schema: BRIEFING_SCHEMA } },
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

  const usage = emptyUsage();
  addUsage(usage, response.usage);
  await recordUsage(env, { userId: user.id, kind: "briefing", model: BRIEFING_MODEL, usage });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("")
    .trim();
  // Structured output should be pure JSON; keep the outermost-object fallback.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    console.error(
      `briefing: no JSON for user ${user.id} — stop_reason=${response.stop_reason}, ` +
        `blocks=[${response.content.map((b) => b.type).join(",")}], ` +
        `output_tokens=${response.usage.output_tokens}, text="${text.slice(0, 200)}"`,
    );
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
