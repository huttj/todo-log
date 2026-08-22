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
  listRecentDone,
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
- Entity links are REQUIRED and use markdown-style syntax. (All names/items in the examples below are ILLUSTRATIVE — never echo an example's wording into output; build every line from the user's actual data.) The procedure: write the sentence first, exactly as you naturally would. THEN pick 2-5 consecutive words ALREADY IN that sentence and wrap them: "Next: [book the venue](todo:18) for the reunion." The link adds ZERO new words to the line. If you find yourself putting the entity's TITLE inside the brackets, you have failed — the bracketed words must be your sentence's own words, which keep reading grammatically when the brackets are removed.
  BAD: "Book the venue for the reunion [Book reunion venue by Friday](todo:22)." (title appended as a citation — the sentence says it twice)
  BAD: "venue booking [todo:22]" (bare token)
  GOOD: "[Book the venue](todo:22) for the reunion."
  GOOD: "Mail [Priya's birthday card](todo:21)."
  GOOD (project line): "[Deck Repair](project:3) — Moving. Next: [sand the railing](todo:22)."
  Self-check every line before output: delete the bracketed words and read it — if the sentence is STILL complete, you wrote the item twice; rewrite so the linked words are load-bearing. A line about a tracked item with no link is a defect; so is a line that names the item twice.
- NEVER narrate the user's inner world. No talk of resistance, avoidance, motivation, energy, being stuck or stalled, or what today "should" be the day for. Describe the state of the WORK, never the psychology of the person. Their feelings live in their own logs, in their own words — do not paraphrase feelings back at them, and do not restate uncertainty they expressed as a fact about them ("uncertain it's worth it" → frame the task: "Unclear if it's worth it — you might look into it if there's time").
- Never convert their uncertainty into a commitment: "you might X if there's time", not "will X if there's time".
- No urgency intensifiers or prodding, ever: "actually", "finally", "sit down", "lock in", "make it real", "you keep", "still hanging", "no action yet", "stalled" — all banned.
- The headline is ONE orienting line about the day's shape — never an enumeration of the plans (the plans list right below does that; a headline that reads like the plans compressed is a defect). Mention the count, the theme, or the most notable timing instead.
  BAD headline: "Four things are on today's plate: book the venue, mail the card, sand the railing, call the plumber." (that's the plans list again)
  GOOD headline: "A four-item day, mostly tying off loose ends before [the deck inspection](todo:25) midweek."
  BAD: "should cut the resistance" → GOOD: "should make it much easier".
- Don't echo back facts the user just told you as if they were news ("it's filled out, just needs to go out" the day after they said exactly that). Freshly-shared context is known context — use it silently.
- Mirror the user's own words and commitment level. "Look into" stays "look into" — never escalate to "do"/"apply"/"finish".
- When a state is assumed rather than known (returned? delivered? finished?), phrase the line as a QUESTION — especially loose threads: "Did you return the drill to Marcus?" But NEVER ask "Did you X?" about work whose planned slot or stated date is still in the FUTURE — a plan set for next Friday hasn't happened yet and isn't in question. Future-dated work belongs in coming, stated with its date ("the drill return is planned for Friday"), and usually only when it's imminent or needs prep.
- A TRACKED TODO IS NEVER A LOOSE THREAD. Oneoffs hold only commitments that live in logs with no todo — if you can link todo:N in the line, the item is tracked and belongs in today/coming/its project line instead.
- Only actionable items go in plans; pure status or timing information belongs in coming.
- PAUSED projects are on hold — the user set that status deliberately. Their todos get NO lines in today/oneoffs/coming (main or _more), and the project gets no main-list line. At most one quiet line in projects_more — "[Name](project:N) — paused." — with no suggested next step. Resurface paused work ONLY when a slot for it is actually scheduled or the user explicitly says they're picking it back up. Completed/abandoned projects are omitted entirely.
- Order project lines by the user's stated priorities (shown per project when set) — high-priority or urgent-vibe projects go in the main list, back-burner ones in projects_more. Mirror the priority's wording when it shapes the next step.
- Project lines START with the linked project name — "[Deck Repair](project:3) — moving. Next: ..." — and never repeat the name afterward. The words inside that first link are the project's NAME, nothing else.
  BAD: "[Moving](project:3). Next: ..." (momentum word linked instead of the name — the reader can't tell which project this is)
  GOOD: "[Deck Repair](project:3) — moving. Next: [sand the railing](todo:22)." Momentum words stay neutral and factual (moving / quiet / waiting / new), and they must respect elapsed time: a project created in the last few days is "new" or "just started", NEVER "dormant" or "quiet" — those imply meaningful time has passed (use them only after a week or more without movement). A next step is a plain suggestion, never a command.
- The main lists hold only the few items that deserve attention today; everything else goes in the matching _more list (shown behind "see more"). Be strict: 3-5 main items per list is the ceiling. For coming, prioritize by imminence and prep-need — the long tail of someday-items always goes in coming_more.
- Link ids must come from the data above, exactly as shown. NEVER invent or guess an id, and never label a log id as todo:N (or vice versa) — a link to the wrong record is worse than no link: the chat agent treats these links as ground truth and will EDIT the linked record when the user talks about the line. Before emitting any link, re-read the target's own title/name in the data and confirm your bracketed words describe THAT record. A loose thread by definition has no todo — link the log it lives in, or leave the words unlinked; never borrow a nearby todo's id.
- PASSING INTENTIONS EXPIRE; TODOS PERSIST. A "maybe I'll X" or "possibly Y" in a log is an idea for THAT day, not a standing plan. The user's todo list is the record of what actually needs doing — if a mentioned activity was never captured as a todo and hasn't come up since, DROP IT: silence means it happened, resolved, or stopped mattering, and resurfacing it days later is noise. Logs older than yesterday contribute status and context to the briefing, never fresh plans. And NEVER stitch separate passing mentions into a menu ("gym, the title search, or a walk — your call") — options the user never posed as alternatives are an invention, and a line mixing unrelated items reads as nonsense.
- EXPIRED DAY-BOUND INTENTS ARE STALE. A todo whose own title or details tie it to a specific day that has passed ("...today", "leaving tomorrow" written days ago) is not open work to surface. If recent logs show it happened, treat it as done and give it no line. Only if it plausibly still matters, ask ONE question about whether it happened — and trust the logs over the todo's status when they conflict (a log reporting the oil change beats an open "get the oil changed" todo).
- HONOR THE USER'S CURRENT SITUATION. When memory notes or recent logs establish a constraint on what's doable right now — traveling, away from home, sick, a visitor in town — today's plans may only hold work that's actually possible in that situation. Location-bound tasks (home chores, local errands, physical items elsewhere) move to coming, anchored to when the constraint lifts ("when you're back Thursday"), without nagging. State the situation once in the headline or coming when it shapes the day.
- RELATIVE TIME IN LOGS IS FROZEN AT THAT LOG'S DATE. Every log line is stamped with the day it was recorded; words like "today", "tomorrow", "tonight", "this weekend" inside a log point at THAT day's neighbors, not the current date. A log from 2 days ago saying "dentist tomorrow" means the appointment was yesterday — it already happened. Re-anchor every relative phrase against its log's stamp before using it, and NEVER copy "today"/"tomorrow" out of a log not stamped today — write the actual day instead ("back Thursday"). Plans in an older log were plans for THAT day, not today's plans; re-list them only if something current says they're still open. Self-check: any "today"/"tomorrow"/"tonight" in your output must be true against the Current local time line, not against a log's wording.
- Ground every line in real data — never invent. Second person, plain, brief.`;

/** The model sometimes links an id that doesn't exist, a log id as todo:N,
 * or — worst — a wrong-but-existing id (a "spare key" line linked to an
 * unemployment todo), which downstream consumers then trust as ground truth.
 * Validate every ref against real ids AND require the bracketed words to
 * share at least one content word with the target's own title; failures
 * degrade to their words. */
export async function stripInvalidRefs(env: Env, userId: number, briefing: Briefing): Promise<Briefing> {
  const targets: Record<string, Map<number, string>> = {};
  for (const [key, table, expr] of [
    ["todo", "todos", "title"],
    ["project", "projects", "name"],
    ["log", "logs", "COALESCE(title, '') || ' ' || COALESCE(summary, '')"],
  ] as const) {
    const r = await env.DB.prepare(`SELECT id, ${expr} AS words FROM ${table} WHERE user_id = ?`)
      .bind(userId)
      .all<{ id: number; words: string }>();
    targets[key] = new Map(r.results.map((x) => [x.id, x.words]));
  }
  const STOP = new Set([
    "the", "and", "for", "with", "that", "this", "from", "into", "about", "your", "you",
    "them", "they", "she", "her", "him", "his", "its", "will", "when", "what", "did",
    "have", "has", "are", "was", "were", "get", "got", "out", "not", "now", "one", "more",
  ]);
  const contentWords = (s: string) =>
    new Set(
      s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP.has(w)),
    );
  const related = (linkWords: string, target: string) => {
    const lw = contentWords(linkWords);
    if (lw.size === 0) return true; // nothing to judge by ("do it") — keep
    const tw = contentWords(target);
    for (const a of lw)
      for (const b of tw)
        if (a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))))
          return true;
    return false;
  };
  const clean = (text: string) =>
    text
      .replace(/\[([^\]]+)\]\((todo|project|log):(\d+)\)/g, (m, words: string, type: string, id: string) => {
        const target = targets[type].get(Number(id));
        return target !== undefined && related(words, target) ? m : words;
      })
      .replace(/\[(todo|project|log):(\d+)\]/g, (m, type: string, id: string) =>
        targets[type].has(Number(id)) ? m : "",
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
  const [projects, todos, scheduled, logs, memories, notifications, dismissed, recentDone] = await Promise.all([
    listProjects(env, user.id),
    listTodos(env, user.id),
    listSchedule(env, user.id, { from: t - 2 * DAY, to: t + 7 * DAY }),
    listLogs(env, user.id, { from: t - 7 * DAY, limit: 40 }),
    listMemories(env, user.id),
    listNotifications(env, user.id),
    listDismissals(env, user.id, day),
    listRecentDone(env, user.id),
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
      .map((td) => {
        // Future slots (even past the 7-day schedule window) mark planned
        // work — without this the model mistakes scheduled todos for
        // unresolved threads and asks "did you?" about next week's plan.
        const slot = td.next_planned && td.next_planned > t
          ? ` [planned: ${new Date(td.next_planned * 1000).toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" })}]`
          : "";
        return `#${td.id} ${td.title} [${td.status}]${slot}${td.project_id ? ` (project #${td.project_id})` : ""}${projFlag(td.project_id)}${td.details ? ` — ${td.details.slice(0, 120)}` : ""}`;
      })
      .join("\n") || "(none)"}`,
    `Schedule (last 2 days → next 7; a todo can have several slots):\n${scheduled.map((s) => `todo #${s.id} ${s.title} [slot: ${s.slot_status}]${projFlag(s.project_id)} ${when(s)}`).join("\n") || "(none)"}`,
    `Recent logs (last 7 days, newest first — the user's own words about how it's going):\n${logs
      .map((l) => `#${l.id} [${logDay(l.occurred_at)}] (${l.kind}) ${l.summary}`)
      .join("\n") || "(none)"}`,
    memories.length ? `Agent memory notes:\n${memories.map((m) => `[${m.key}] ${m.content}`).join("\n")}` : "",
    notifications.length
      ? `Open notifications:\n${notifications.map((n) => `- ${n.title}${n.body ? ` — ${n.body}` : ""}`).join("\n")}`
      : "",
    recentDone.length
      ? `Items the user CHECKED OFF as done in the last week — completed facts, not per-day preferences. NEVER re-list any of these (or a rephrasing of the same underlying item) as open work in any list:\n${recentDone
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
