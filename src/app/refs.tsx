// Entity links in agent-authored text: [the agent's own words](todo:12).
// The wrapped words render as the link — the agent decides what's tappable.
// Legacy bare [todo:12] tokens fall back to a title lookup (or #id).
//
// Defensive de-dupe: models sometimes append the entity TITLE as the link
// label right after saying the same thing in their own words ("…finalize the
// tax plan [Discuss bank statements…](todo:22)"). When the label's words
// mostly already appear at the tail of the preceding text, we wrap those
// trailing words as the link instead of rendering the label again.
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

const BASES: Record<string, string> = {
  todo: "todos",
  project: "projects",
  log: "logs",
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(Boolean);

/** If the label duplicates the tail of `prev` — or is verbatim the entity's
 * title pasted as a citation — return [keptPrefix, wrapWords] where wrapWords
 * are the trailing words of prev to use as the link text instead. */
function dedupe(prev: string, label: string, entityTitle?: string): [string, string] | null {
  const labelTokens = norm(label);
  if (labelTokens.length < 2) return null;
  const window = norm(prev).slice(-(labelTokens.length + 3));
  if (window.length === 0) return null;
  const hits = labelTokens.filter((t) => window.includes(t)).length;
  const isTitleCitation =
    entityTitle != null && labelTokens.length >= 3 && norm(entityTitle).join(" ") === labelTokens.join(" ");
  if (hits / labelTokens.length < 0.6 && !isTitleCitation) return null;
  // Wrap trailing words of the raw prev text (the natural phrase the model
  // already wrote); title citations wrap a short tail, echoes wrap up to the
  // label's own length.
  const wrapCount = isTitleCitation && hits / labelTokens.length < 0.6 ? 4 : labelTokens.length;
  const m = prev.match(new RegExp(`(\\S+(?:\\s+\\S+){0,${wrapCount - 1}})\\s*$`));
  if (!m) return null;
  return [prev.slice(0, prev.length - m[0].length), m[1]];
}

export function renderEntityRefs(
  text: string,
  titles?: { todo?: Map<number, string>; project?: Map<number, string> },
): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\[([^\]]+)\]\((todo|project|log):(\d+)\)|\[(todo|project|log):(\d+)\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    let pending = text.slice(last, m.index);
    const labeled = m[2] !== undefined;
    const type = labeled ? m[2] : m[4];
    const id = Number(labeled ? m[3] : m[5]);
    let label = labeled
      ? m[1]
      : type === "todo"
        ? (titles?.todo?.get(id) ?? `#${id}`)
        : type === "project"
          ? (titles?.project?.get(id) ?? `#${id}`)
          : `#${id}`;
    if (labeled) {
      const entityTitle =
        type === "todo" ? titles?.todo?.get(id) : type === "project" ? titles?.project?.get(id) : undefined;
      const fixed = dedupe(pending, label, entityTitle);
      if (fixed) {
        pending = fixed[0];
        label = fixed[1];
      }
    }
    if (pending) out.push(pending);
    out.push(
      <Link key={k++} className="brief-ref" to={`/${BASES[type]}/${id}`}>
        {label.length > 60 ? `${label.slice(0, 60)}…` : label}
      </Link>,
    );
    last = re.lastIndex;
  }
  out.push(text.slice(last));
  return out;
}
