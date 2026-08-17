// The precomputed daily briefing: what today should look like, per-project
// momentum, loose threads, and what's coming. The Today view renders it; the
// agent sees it every turn and rewrites it via update_briefing when warranted;
// cron refreshes it when stale; ↻ recomputes on demand.
import type { Env, UserRow, ScheduleRow } from "./types";
import { emptyUsage, addUsage, recordUsage, computeCost } from "./usage";
import { modelParams } from "./config";
import { llmFor } from "./llm";
import {
  now,
  listProjects,
  listTodos,
  listSchedule,
  listLogs,
  listMemories,
  listNotifications,
  setBriefing,
  listDismissals,
  addDismissals,
} from "./db";

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
- No urgency intensifiers or prodding, ever: "actually", "finally", "sit down", "lock in", "make it real", "you keep", "still hanging", "no action yet", "stalled" — all banned.
- The headline is ONE orienting line about the day's shape — never an enumeration of the plans (the plans list right below does that; a headline that reads like the plans compressed is a defect). Mention the count, the theme, or the most notable timing instead.
  BAD headline: "Four things are on today's plate: discuss the statements, mail the card, brainstorm Fix Men, define criteria." (that's the plans list again)
  GOOD headline: "A four-item day, mostly tying off loose ends before the [contract job](todo:25) likely starts midweek."
  BAD: "should cut the resistance" → GOOD: "should make it much easier".
- Don't echo back facts the user just told you as if they were news ("it's filled out, just needs to go out" the day after they said exactly that). Freshly-shared context is known context — use it silently.
- Mirror the user's own words and commitment level. "Look into" stays "look into" — never escalate to "do"/"apply"/"finish".
- When a state is assumed rather than known (returned? delivered? finished?), phrase the line as a QUESTION — especially loose threads: "Did you return the spare key to Reggie?"
- Only actionable items go in plans; pure status or timing information belongs in coming.
- PAUSED projects are on hold — the user set that status deliberately. Their todos get NO lines in today/oneoffs/coming (main or _more), and the project gets no main-list line. At most one quiet line in projects_more — "[Name](project:N) — paused." — with no suggested next step. Resurface paused work ONLY when a slot for it is actually scheduled or the user explicitly says they're picking it back up. Completed/abandoned projects are omitted entirely.
- Order project lines by the user's stated priorities (shown per project when set) — high-priority or urgent-vibe projects go in the main list, back-burner ones in projects_more. Mirror the priority's wording when it shapes the next step.
- Project lines START with the linked project name — "[Back Taxes](project:3) — moving. Next: ..." — and never repeat the name afterward. The words inside that first link are the project's NAME, nothing else.
  BAD: "[Moving](project:3). Next: ..." (momentum word linked instead of the name — the reader can't tell which project this is)
  GOOD: "[Back Taxes](project:3) — moving. Next: [feed the statements](todo:22) to Claude." Momentum words stay neutral and factual (moving / quiet / waiting / new), and they must respect elapsed time: a project created in the last few days is "new" or "just started", NEVER "dormant" or "quiet" — those imply meaningful time has passed (use them only after a week or more without movement). A next step is a plain suggestion, never a command.
- The main lists hold only the few items that deserve attention today; everything else goes in the matching _more list (shown behind "see more"). Be strict: 3-5 main items per list is the ceiling. For coming, prioritize by imminence and prep-need — the long tail of someday-items always goes in coming_more.
- Link ids must come from the data above, exactly as shown. NEVER invent or guess an id, and never label a log id as todo:N (or vice versa) — a link to the wrong record is worse than no link.
- RELATIVE TIME IN LOGS IS FROZEN AT THAT LOG'S DATE. Every log line is stamped with the day it was recorded; words like "today", "tomorrow", "tonight", "this weekend" inside a log point at THAT day's neighbors, not the current date. A log from 2 days ago saying "flying out tomorrow" means the flight was yesterday — it already happened. Re-anchor every relative phrase against its log's stamp before using it, and NEVER copy "today"/"tomorrow" out of a log not stamped today — write the actual day instead ("returning Thursday, Aug 20"). Plans in an older log were plans for THAT day, not today's plans; re-list them only if something current says they're still open. Self-check: any "today"/"tomorrow"/"tonight" in your output must be true against the Current local time line, not against a log's wording.
- Ground every line in real data — never invent. Second person, plain, brief.`;

/** The model sometimes links an id that doesn't exist (or a log id as
 * todo:N). Validate every ref against real ids; invalid ones degrade to
 * their words. */
export async function stripInvalidRefs(env: Env, userId: number, briefing: Briefing): Promise<Briefing> {
  const ids: Record<string, Set<number>> = {};
  for (const [key, table] of [["todo", "todos"], ["project", "projects"], ["log", "logs"]] as const) {
    const r = await env.DB.prepare(`SELECT id FROM ${table} WHERE user_id = ?`)
      .bind(userId)
      .all<{ id: number }>();
    ids[key] = new Set(r.results.map((x) => x.id));
  }
  const clean = (text: string) =>
    text
      .replace(/\[([^\]]+)\]\((todo|project|log):(\d+)\)/g, (m, words: string, type: string, id: string) =>
        ids[type].has(Number(id)) ? m : words,
      )
      .replace(/\[(todo|project|log):(\d+)\]/g, (m, type: string, id: string) =>
        ids[type].has(Number(id)) ? m : "",
      );
  return {
    headline: clean(briefing.headline),
    today: briefing.today.map(clean),
    today_more: briefing.today_more.map(clean),
    oneoffs: briefing.oneoffs.map(clean),
    oneoffs_more: briefing.oneoffs_more.map(clean),
    coming: briefing.coming.map(clean),
    coming_more: briefing.coming_more.map(clean),
    projects: briefing.projects.map((pr) => ({ ...pr, line: clean(pr.line) })),
    projects_more: briefing.projects_more.map((pr) => ({ ...pr, line: clean(pr.line) })),
  };
}

/** Map re-hidden output lines back to the Today view's dismissal keys. */
export function rehiddenEntries(
  briefing: Briefing,
  lines: string[],
): { key: string; label: string | null }[] {
  const out: { key: string; label: string | null }[] = [];
  for (const line of lines) {
    let key: string | null = null;
    if ([...briefing.today, ...briefing.today_more].includes(line)) key = `b:today:${line.slice(0, 80)}`;
    else if ([...briefing.oneoffs, ...briefing.oneoffs_more].includes(line)) key = `b:oneoffs:${line.slice(0, 80)}`;
    else if ([...briefing.coming, ...briefing.coming_more].includes(line)) key = `b:coming:${line.slice(0, 80)}`;
    else {
      const proj = [...briefing.projects, ...briefing.projects_more].find((p) => p.line === line);
      if (proj) key = `b:proj:${proj.name}:${proj.line.slice(0, 60)}`;
    }
    if (key) out.push({ key, label: line.slice(0, 300) });
  }
  return out;
}

export async function generateBriefing(
  env: Env,
  user: UserRow,
  onDelta?: (text: string) => void,
): Promise<Briefing | null> {
  const t = now();
  const tz = user.timezone ?? env.TIMEZONE;
  // Today's date string in the user's timezone — dismissals are keyed by it.
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(t * 1000));
  const [projects, todos, scheduled, logs, memories, notifications, dismissed] = await Promise.all([
    listProjects(env, user.id),
    listTodos(env, user.id),
    listSchedule(env, user.id, { from: t - 2 * DAY, to: t + 7 * DAY }),
    listLogs(env, user.id, { from: t - 7 * DAY, limit: 40 }),
    listMemories(env, user.id),
    listNotifications(env, user.id),
    listDismissals(env, user.id, day),
  ]);

  // Log lines carry the full date plus distance from today — a bare weekday
  // forces the model into calendar arithmetic it reliably gets wrong when
  // re-anchoring relative phrases ("flying out tomorrow") in summaries.
  const logDay = (sec: number) => {
    const label = new Date(sec * 1000).toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" });
    const ago = Math.round(
      (Date.parse(day) - Date.parse(new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(sec * 1000)))) / 86400000,
    );
    return ago <= 0 ? `today, ${label}` : ago === 1 ? `yesterday, ${label}` : `${label}, ${ago} days ago`;
  };

  const when = (s: ScheduleRow) =>
    s.slot_all_day
      ? `${new Date(s.slot_start * 1000).toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" })} (any time)`
      : new Date(s.slot_start * 1000).toLocaleString("en-US", { timeZone: tz });

  // A todo on a non-active project must not read as normal open work.
  const inactive = new Map(projects.filter((p) => p.status !== "active").map((p) => [p.id, p.status]));
  const projFlag = (projectId: number | null) => {
    if (!projectId) return "";
    const st = inactive.get(projectId);
    return st ? ` [project ${st}]` : "";
  };

  const input = [
    `Current local time: ${new Date(t * 1000).toLocaleString("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })}`,
    `Active projects:\n${projects
      .filter((p) => p.status === "active")
      .map((p) => {
        const days = Math.floor((t - p.created_at) / DAY);
        const age = days === 0 ? "created today" : days === 1 ? "created yesterday" : `${days} days old`;
        return `#${p.id} ${p.name} (${age})${p.priority ? ` [priority: ${p.priority}]` : ""}${p.description ? ` — ${p.description}` : ""}`;
      })
      .join("\n") || "(none)"}`,
    projects.some((p) => p.status === "paused")
      ? `Paused projects (on hold — see the paused rule):\n${projects
          .filter((p) => p.status === "paused")
          .map((p) => `#${p.id} ${p.name}`)
          .join("\n")}`
      : "",
    `Open todos:\n${todos
      .map((td) => `#${td.id} ${td.title} [${td.status}]${td.project_id ? ` (project #${td.project_id})` : ""}${projFlag(td.project_id)}${td.details ? ` — ${td.details.slice(0, 120)}` : ""}`)
      .join("\n") || "(none)"}`,
    `Schedule (last 2 days → next 7; a todo can have several slots):\n${scheduled.map((s) => `todo #${s.id} ${s.title} [slot: ${s.slot_status}]${projFlag(s.project_id)} ${when(s)}`).join("\n") || "(none)"}`,
    `Recent logs (last 7 days, newest first — the user's own words about how it's going):\n${logs
      .map((l) => `#${l.id} [${logDay(l.occurred_at)}] (${l.kind}) ${l.summary}`)
      .join("\n") || "(none)"}`,
    memories.length ? `Agent memory notes:\n${memories.map((m) => `[${m.key}] ${m.content}`).join("\n")}` : "",
    notifications.length
      ? `Open notifications:\n${notifications.map((n) => `- ${n.title}${n.body ? ` — ${n.body}` : ""}`).join("\n")}`
      : "",
    dismissed.filter((d) => d.why === "done").length
      ? `Items the user marked DONE from today's view — treat as completed; never re-list them as open work:\n${dismissed
          .filter((d) => d.why === "done")
          .map((d) => `- ${d.label ?? d.key}`)
          .join("\n")}`
      : "",
    dismissed.filter((d) => d.why !== "done").length
      ? `Items the user HID from today's view ("don't bother me with this today" — still open, keep tracking, just don't resurface it prominently today):\n${dismissed
          .filter((d) => d.why !== "done")
          .map((d) => `- ${d.label ?? d.key}`)
          .join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const { client, resolved, provider, byok } = await llmFor(env, user, "briefing");
  // Structured output guarantees parseable JSON (adaptive thinking previously
  // ate into max_tokens and could truncate the raw-JSON reply mid-object).
  const strArray = { type: "array", items: { type: "string" } };
  const projArray = {
    type: "array",
    items: {
      type: "object",
      properties: {
        project_id: { anyOf: [{ type: "integer" }, { type: "null" }] },
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
      rehidden: strArray,
    },
    required: [
      "headline", "today", "today_more", "oneoffs", "oneoffs_more",
      "coming", "coming_more", "projects", "projects_more", "rehidden",
    ],
    additionalProperties: false,
  };
  const started = Date.now();
  const params = modelParams(resolved);
  const stream = client.messages.stream({
    model: resolved.modelId,
    max_tokens: 6000,
    ...params,
    // On non-json_schema providers the adapter drops the format and the
    // prompt's "ONLY JSON" + the brace-extraction fallback below carry it.
    output_config: {
      ...((params.output_config as Record<string, unknown>) ?? {}),
      format: { type: "json_schema", schema: BRIEFING_SCHEMA },
    },
    system:
      "You compute the daily briefing for Todo Log, a voice-first todo/journal app. From the data, " +
      "produce ONLY a JSON object (no fences, no prose) with keys:\n" +
      '- "headline": one honest line about what today looks like.\n' +
      '- "today" + "today_more": plans & commitments for today/tonight, actionable items only.\n' +
      '- "oneoffs" + "oneoffs_more": loose threads — commitments that appear ONLY in logs, not tracked as any todo.\n' +
      '- "coming" + "coming_more": tomorrow and the days ahead, plus pure timing/status info.\n' +
      '- "projects" + "projects_more": {"project_id": n, "name": "...", "line": "..."} per ACTIVE project, ' +
      "line = momentum + one suggested next step, ≤ 20 words.\n" +
      '- "rehidden": if any line in your output is the SAME underlying item as one the user dismissed ' +
      "(see the dismissed list in the data, when present), copy that line's exact text here (for project rows, " +
      "the line text) so it stays hidden after regeneration. [] when none.\n" +
      "All keys required; use [] when empty.\n\n" +
      BRIEFING_STYLE,
    messages: [{ role: "user", content: input }],
  });
  if (onDelta) stream.on("text", (t) => onDelta(t));
  const response = await stream.finalMessage();

  console.log(
    `briefing: generated for user ${user.id} in ${Date.now() - started}ms, ` +
      `stop=${response.stop_reason}, out=${response.usage.output_tokens}`,
  );
  const usage = emptyUsage();
  addUsage(usage, response.usage);
  await recordUsage(env, { userId: user.id, kind: "briefing", model: resolved.modelId, provider, byok, usage });

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
    const briefing: Briefing = await stripInvalidRefs(env, user.id, {
      headline: parsed.headline,
      today: parsed.today ?? [],
      today_more: parsed.today_more ?? [],
      oneoffs: parsed.oneoffs ?? [],
      oneoffs_more: parsed.oneoffs_more ?? [],
      coming: parsed.coming ?? [],
      coming_more: parsed.coming_more ?? [],
      projects: parsed.projects ?? [],
      projects_more: parsed.projects_more ?? [],
    });
    await setBriefing(env, user.id, JSON.stringify(briefing), computeCost(resolved.modelId, usage));
    // Regenerated equivalents of dismissed items start hidden.
    const rehiddenRaw = (parsed as { rehidden?: string[] }).rehidden ?? [];
    const rehidden = (await stripInvalidRefs(env, user.id, { ...briefing, today: rehiddenRaw })).today;
    await addDismissals(env, user.id, day, rehiddenEntries(briefing, rehidden)).catch(() => {});
    return briefing;
  } catch {
    console.error(`briefing: unparseable output for user ${user.id}: ${text.slice(0, 200)}`);
    return null;
  }
}
