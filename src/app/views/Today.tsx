// Today: the precomputed daily briefing (what today should look like) above
// the day's schedule (scheduled todos) and logs. Arrows / date picker browse
// other days; briefing, slipped, and in-flight sections only show on today.
// Every entry is dismissable (eye icon) — dismissed ones hide behind "see
// more" for the rest of the day (server-side per date, so the overview
// generator sees them and re-hides regenerated equivalents).
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowsRotate, faCheck, faEye, faEyeSlash, faMicrophone, faRotateLeft } from "@fortawesome/free-solid-svg-icons";
import {
  api,
  post,
  patch,
  type Todo,
  type ScheduleEntry,
  type Project,
  type Briefing,
  type BriefingProjectLine,
} from "../api";
import TodoRow from "../components/TodoRow";
import HoldTalk from "../components/HoldTalk";
import PushNudge from "../components/PushNudge";
import { renderEntityRefs } from "../refs";
import { requestTalk } from "../talk";
import { fmtCost } from "../fmt";
import type { CaptureContext } from "../Capture";

const SLOT_STATUSES = ["planned", "done", "skipped"] as const;
const DAY = 86400;

// Progressive parse of the streamed briefing JSON: cut back to a structural
// boundary, close open brackets, and try to parse. Cheap at briefing sizes.
function closeAndParse(fragment: string): Partial<Briefing> | null {
  let inStr = false;
  let esc = false;
  const stack: string[] = [];
  for (const ch of fragment) {
    if (esc) {
      esc = false;
      continue;
    }
    if (inStr) {
      if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (inStr) return null;
  const s = fragment.replace(/[,\s]+$/, "");
  if (s.endsWith(":")) return null;
  const closers = stack
    .reverse()
    .map((c) => (c === "{" ? "}" : "]"))
    .join("");
  try {
    return JSON.parse(s + closers) as Partial<Briefing>;
  } catch {
    return null;
  }
}

/** A partial parse can cut arrays/objects mid-item — keep only complete ones. */
function sanitizeBriefing(p: Partial<Briefing>): Briefing | null {
  if (typeof p.headline !== "string") return null;
  const strs = (v: unknown) =>
    Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const projs = (v: unknown) =>
    Array.isArray(v)
      ? (v as { project_id?: unknown; name?: unknown; line?: unknown }[]).filter(
          (x): x is BriefingProjectLine =>
            !!x && typeof x === "object" && typeof x.name === "string" && typeof x.line === "string",
        )
      : [];
  return {
    headline: p.headline,
    today: strs(p.today),
    today_more: strs(p.today_more),
    oneoffs: strs(p.oneoffs),
    oneoffs_more: strs(p.oneoffs_more),
    coming: strs(p.coming),
    coming_more: strs(p.coming_more),
    projects: projs(p.projects),
    projects_more: projs(p.projects_more),
  };
}

function parsePartialBriefing(text: string): Partial<Briefing> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  const s = text.slice(start);
  let attempts = 0;
  for (let i = s.length; i > 0 && attempts < 60; i--) {
    const ch = s[i - 1];
    if (ch === "]" || ch === "}" || ch === '"') {
      attempts++;
      const r = closeAndParse(s.slice(0, i));
      if (r) return r;
    }
  }
  return null;
}

/** An entry with a stable dismissal key. */
interface Entry {
  k: string;
  node: ReactNode;
  label?: string;
}

export default function Today(props: {
  refreshKey: number;
  onFocus: (ctx: CaptureContext | null) => void;
}) {
  const [dayOffset, setDayOffset] = useState(0);
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [generatedAt, setGeneratedAt] = useState<number | null>(null);
  const [briefCost, setBriefCost] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scheduled, setScheduled] = useState<ScheduleEntry[]>([]);
  const [overdue, setOverdue] = useState<ScheduleEntry[]>([]);
  const [daySpend, setDaySpend] = useState(0);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);

  const day = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + dayOffset);
    return d;
  }, [dayOffset]);
  const dayStart = Math.floor(day.getTime() / 1000);
  const isToday = dayOffset === 0;
  const isoDate = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;

  const load = () => {
    if (isToday) {
      api<{
        briefing: Briefing | null;
        generated_at: number | null;
        cost_usd?: number | null;
        has_prev?: boolean;
      }>("/briefing")
        .then((r) => {
          setBriefing(r.briefing);
          setGeneratedAt(r.generated_at);
          setBriefCost(r.cost_usd ?? null);
        })
        .catch(() => {});
      api<ScheduleEntry[]>(`/schedule?from=${dayStart - 7 * DAY}&to=${dayStart}`)
        .then((past) =>
          setOverdue(
            past.filter(
              (s) => s.slot_status === "planned" && s.status !== "done" && s.status !== "abandoned",
            ),
          ),
        )
        .catch(() => {});
    }
    api<ScheduleEntry[]>(`/schedule?from=${dayStart}&to=${dayStart + DAY}`)
      .then(setScheduled)
      .catch(() => {});
    api<{ cost: number }>(`/usage/day?from=${dayStart}&to=${dayStart + DAY}`)
      .then((r) => setDaySpend(r.cost))
      .catch(() => {});
    api<Todo[]>("/todos?all=1").then(setTodos).catch(() => {});
    api<Project[]>("/projects").then(setProjects).catch(() => {});
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [props.refreshKey, dayStart]);

  // Talk from this page is a plain session — the agent fetches the overview
  // itself when the conversation needs it.
  useEffect(() => {
    props.onFocus(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -- Dismissals (server-side, per date — the overview generator reads them
  // and re-hides regenerated equivalents) -----------------------------------
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [doneKeys, setDoneKeys] = useState<Set<string>>(new Set());
  const loadDismissed = () => {
    api<{ keys: string[]; items?: { key: string; why?: string }[] }>(`/dismissals?day=${isoDate}`)
      .then((r) => {
        setDismissed(new Set(r.keys));
        setDoneKeys(new Set((r.items ?? []).filter((x) => x.why === "done").map((x) => x.key)));
      })
      .catch(() => {});
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(loadDismissed, [isoDate, props.refreshKey]);
  const toggleDismiss = (k: string, label?: string, why: "done" | "hide" = "hide") => {
    const next = new Set(dismissed);
    const dismissing = !next.has(k);
    if (dismissing) next.add(k);
    else next.delete(k);
    setDismissed(next);
    setDoneKeys((prev) => {
      const d = new Set(prev);
      if (dismissing && why === "done") d.add(k);
      else d.delete(k);
      return d;
    });
    void post("/dismissals", { day: isoDate, key: k, label, dismissed: dismissing, why }).catch(
      () => {},
    );
  };

  const doneBtn = (k: string, label?: string) => (
    <button
      className="dismiss-btn done-btn"
      title="Done — clears it from today (undo under see more)"
      onClick={(e) => {
        e.stopPropagation();
        toggleDismiss(k, label, "done");
      }}
    >
      <FontAwesomeIcon icon={faCheck} />
    </button>
  );

  const dismissBtn = (k: string, restore = false, label?: string) => {
    const wasDone = doneKeys.has(k);
    return (
      <button
        className="dismiss-btn"
        title={restore ? (wasDone ? "Undo done" : "Bring it back") : "Hide for today"}
        onClick={(e) => {
          e.stopPropagation();
          toggleDismiss(k, label);
        }}
      >
        <FontAwesomeIcon icon={restore ? (wasDone ? faRotateLeft : faEyeSlash) : faEye} />
      </button>
    );
  };

  const [seeMore, setSeeMore] = useState<Set<string>>(new Set());
  const toggleMore = (key: string) =>
    setSeeMore((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetch("/api/briefing/refresh", { method: "POST" });
      if (!res.ok || !res.body) throw new Error(res.statusText || "refresh failed");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let acc = "";
      let lastParse = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const evt = JSON.parse(line.slice(6)) as
            | { type: "delta"; text: string }
            | { type: "done"; briefing: Briefing; generated_at: number; cost_usd?: number | null }
            | { type: "error"; error: string };
          if (evt.type === "delta") {
            acc += evt.text;
            // Throttled progressive render — sections appear as they complete.
            if (Date.now() - lastParse > 250) {
              lastParse = Date.now();
              const partial = parsePartialBriefing(acc);
              const clean = partial ? sanitizeBriefing(partial) : null;
              if (clean) setBriefing(clean);
            }
          } else if (evt.type === "done") {
            setBriefing(evt.briefing);
            setGeneratedAt(evt.generated_at);
            setBriefCost(evt.cost_usd ?? null);
            loadDismissed();
          } else {
            setError(evt.error);
          }
        }
      }
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setRefreshing(false);
    }
  }

  const todoTitle = useMemo(() => new Map(todos.map((t) => [t.id, t.title])), [todos]);
  const projectName = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);
  // A todo already visible as a schedule row (today's or slipped) doesn't
  // repeat under In flight.
  const inFlight = todos.filter(
    (t) =>
      t.status === "in_progress" &&
      !scheduled.some((s) => s.id === t.id) &&
      !overdue.some((s) => s.id === t.id),
  );

  const scheduledRow = (s: ScheduleEntry, showDay = false, restore = false) => (
    <div
      key={s.schedule_id}
      className={`action-row status-${s.slot_status === "planned" ? s.status : s.slot_status} ${restore ? "hidden-item" : ""}`}
    >
      <span className="time">
        {s.slot_all_day
          ? showDay
            ? new Date(s.slot_start * 1000).toLocaleDateString(undefined, { weekday: "short" })
            : "any time"
          : new Date(s.slot_start * 1000).toLocaleTimeString(undefined, {
              hour: "numeric",
              minute: "2-digit",
            })}
      </span>
      <span className="title">
        <Link to={`/todos/${s.id}`}>{s.title}</Link>
      </span>
      <select
        value={s.slot_status}
        onChange={async (e) => {
          await patch(`/schedule/${s.schedule_id}`, { status: e.target.value });
          props.onFocus({ type: "todo", id: s.id, label: s.title });
          load();
        }}
      >
        {SLOT_STATUSES.map((st) => (
          <option key={st} value={st}>
            {st}
          </option>
        ))}
      </select>
      {dismissBtn(`sched:${s.schedule_id}`, restore, s.title)}
    </div>
  );

  const sorted = [...scheduled].sort(
    (a, b) => (b.slot_all_day - a.slot_all_day) || (a.slot_start - b.slot_start),
  );

  // [the agent's own words](todo:12) become links; legacy bare tokens fall
  // back to entity titles. Shared renderer with the chat bubbles.
  const renderRefs = (text: string) =>
    renderEntityRefs(text, { todo: todoTitle, project: projectName });

  /** A section of dismissable rows: dismissed ones collapse behind "see more". */
  const rowSection = (secKey: string, heading: string, entries: Entry[]) => {
    if (entries.length === 0) return null;
    const shown = entries.filter((e) => !dismissed.has(e.k));
    const hidden = entries.filter((e) => dismissed.has(e.k));
    const open = seeMore.has(secKey);
    return (
      <section>
        <h2>{heading}</h2>
        {shown.length === 0 && !open && (
          <p className="empty section-empty">Nothing to show.</p>
        )}
        {shown.map((e) => e.node)}
        {open && hidden.map((e) => e.node)}
        {hidden.length > 0 && (
          <button className="link see-more" onClick={() => toggleMore(secKey)}>
            {open ? "hide dismissed" : `see ${hidden.length} more`}
          </button>
        )}
      </section>
    );
  };

  // Focus: the main list shows only the agent's priority picks (minus your
  // dismissals); "see more" holds the deprioritized _more items plus whatever
  // you dismissed.
  const briefCard = (key: string, heading: string, main: Entry[], more: Entry[], action?: ReactNode) => {
    if (main.length + more.length === 0) return null;
    const shown = main.filter((e) => !dismissed.has(e.k));
    // Fold order: agent-deprioritized, then user-hidden, then completed.
    const all = [...main, ...more];
    const hidden = [
      ...more.filter((e) => !dismissed.has(e.k)),
      ...all.filter((e) => dismissed.has(e.k) && !doneKeys.has(e.k)),
      ...all.filter((e) => dismissed.has(e.k) && doneKeys.has(e.k)),
    ];
    const expanded = seeMore.has(key);
    return (
      <div className="briefing brief-card">
        <section className="brief-section">
          <h2>
            {heading}
            {action}
          </h2>
          {shown.length === 0 && !expanded && (
            <p className="empty section-empty">Nothing to show.</p>
          )}
          <ul className={`brief-list ${key}`}>
            {shown.map((e) => (
              <li key={e.k} className="brief-line">
                <span className="line-body">{e.node}</span>
                <span className="line-acts">
                  {doneBtn(e.k, e.label)}
                  {dismissBtn(e.k, false, e.label)}
                </span>
              </li>
            ))}
            {expanded &&
              hidden.map((e) => (
                <li
                  key={e.k}
                  className={`brief-line ${dismissed.has(e.k) ? (doneKeys.has(e.k) ? "hidden-item done-item" : "hidden-item") : "more-item"}`}
                >
                  <span className="line-body">{e.node}</span>
                  <span className="line-acts">{dismissBtn(e.k, dismissed.has(e.k), e.label)}</span>
                </li>
              ))}
          </ul>
          {hidden.length > 0 && (
            <button className="link see-more" onClick={() => toggleMore(key)}>
              {expanded ? "show less" : `see ${hidden.length} more`}
            </button>
          )}
        </section>
      </div>
    );
  };

  // The style guide has lines start with the linked project name; only trust
  // a leading link when its text actually is the name (a "[Moving](project:3)"
  // opener still gets the name prefixed), and only skip the prefix then
  // (avoids "Back Taxes — Back Taxes — ...").
  const startsWithName = (p: BriefingProjectLine) => {
    const m = (p.line ?? "").trimStart().match(/^\[([^\]]+)\]/);
    if (!m) return false;
    const linked = m[1].toLowerCase();
    const name = p.name.toLowerCase();
    return linked === name || linked.includes(name) || name.includes(linked);
  };
  const projectLine = (p: BriefingProjectLine) =>
    startsWithName(p) ? (
      <>{renderRefs(p.line ?? "")}</>
    ) : (
      <>
        {p.project_id ? (
          <Link className="brief-ref" to={`/projects/${p.project_id}`}>
            {p.name}
          </Link>
        ) : (
          <strong>{p.name}</strong>
        )}
        {" — "}
        {renderRefs(p.line ?? "")}
      </>
    );

  const lineEntries = (section: string, lines: string[]): Entry[] =>
    lines.map((t) => ({ k: `b:${section}:${t.slice(0, 80)}`, label: t.slice(0, 300), node: renderRefs(t) }));

  const threads = briefing
    ? [...(briefing.oneoffs ?? []), ...(briefing.oneoffs_more ?? [])]
    : [];

  return (
    <div className="tasks today">
      <div className="day-nav">
        <button onClick={() => setDayOffset(dayOffset - 1)}>‹</button>
        <div className="day-center">
          <h2 onClick={() => setDayOffset(0)}>
            {day.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
            {isToday && " (today)"}
          </h2>
          <input
            type="date"
            className="date-pick"
            value={isoDate}
            onChange={(e) => {
              const picked = new Date(`${e.target.value}T00:00:00`);
              if (!Number.isNaN(picked.getTime())) {
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                setDayOffset(Math.round((picked.getTime() - today.getTime()) / (DAY * 1000)));
              }
            }}
          />
        </div>
        <button onClick={() => setDayOffset(dayOffset + 1)}>›</button>
      </div>
      {isToday && <PushNudge />}
      {daySpend > 0 && (
        <p className="day-cost" title="Total agent spend this day">
          agent spend {isToday ? "so far " : ""}
          {fmtCost(daySpend)}
        </p>
      )}

      {isToday && (
        <>
          {!briefing && !refreshing && (
            <p className="empty">No briefing yet — tap refresh below to compute one, or just start talking.</p>
          )}
          {briefing && (
            <>
              <div className="briefing brief-card">
                <section className="brief-section">
                  <h2>Overview</h2>
                  <p className="headline">{renderRefs(briefing.headline)}</p>
                </section>
              </div>
              {briefCard(
                "today",
                "Plans & commitments",
                lineEntries("today", briefing.today ?? []),
                lineEntries("today", briefing.today_more ?? []),
              )}
              {briefCard(
                "oneoffs",
                "Loose threads",
                lineEntries("oneoffs", briefing.oneoffs ?? []),
                lineEntries("oneoffs", briefing.oneoffs_more ?? []),
                <HoldTalk
                  className="thread-talk"
                  title="Talk through these threads · hold or drag up to record"
                  onOpen={(autoStart) =>
                    requestTalk(null, {
                      seed: ["**Loose threads:**", "", ...threads.map((x) => `- ${x}`)].join("\n"),
                      autoStart,
                    })
                  }
                >
                  <FontAwesomeIcon icon={faMicrophone} /> talk
                </HoldTalk>,
              )}
              {briefCard(
                "coming",
                "Coming up",
                lineEntries("coming", [
                  ...(briefing.coming ?? []),
                  ...(briefing.tomorrow ?? []),
                  ...(briefing.week ?? []),
                ]),
                lineEntries("coming", briefing.coming_more ?? []),
              )}
              {briefCard(
                "projects",
                "Projects",
                (briefing.projects ?? []).map((p) => ({
                  k: `b:proj:${p.name}:${p.line.slice(0, 60)}`,
                  label: p.line.slice(0, 300),
                  node: projectLine(p),
                })),
                (briefing.projects_more ?? []).map((p) => ({
                  k: `b:proj:${p.name}:${p.line.slice(0, 60)}`,
                  label: p.line.slice(0, 300),
                  node: projectLine(p),
                })),
              )}
            </>
          )}
          <div className="brief-refresh">
            <span className="brief-cost" title="Cost of the last generation">
              {briefCost != null && briefCost > 0 ? `generated for ${fmtCost(briefCost)}` : ""}
            </span>
            {error && <span className="error">Briefing refresh failed: {error}</span>}
            <button
              className={`h2-toggle refresh ${refreshing ? "spin" : ""}`}
              title={
                generatedAt
                  ? `Recompute briefing (last: ${new Date(generatedAt * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })})`
                  : "Compute briefing"
              }
              onClick={() => void refresh()}
              disabled={refreshing}
            >
              <FontAwesomeIcon icon={faArrowsRotate} />
            </button>
          </div>
        </>
      )}

      {rowSection(
        "schedule",
        "Schedule",
        sorted.map((s) => ({ k: `sched:${s.schedule_id}`, node: scheduledRow(s, false, dismissed.has(`sched:${s.schedule_id}`)) })),
      )}
      {!isToday && sorted.length === 0 && <p className="empty">Nothing scheduled this day.</p>}

      {isToday &&
        rowSection(
          "slipped",
          "Slipped",
          overdue.map((s) => ({ k: `sched:${s.schedule_id}`, node: scheduledRow(s, true, dismissed.has(`sched:${s.schedule_id}`)) })),
        )}

      {isToday &&
        rowSection(
          "inflight",
          "In flight",
          inFlight.map((t) => ({
            k: `todo:${t.id}`,
            node: (
              <div key={t.id} className={`dismiss-row ${dismissed.has(`todo:${t.id}`) ? "hidden-item" : ""}`}>
                <TodoRow todo={t} onChanged={load} />
                {dismissBtn(`todo:${t.id}`, dismissed.has(`todo:${t.id}`), t.title)}
              </div>
            ),
          })),
        )}

    </div>
  );
}
