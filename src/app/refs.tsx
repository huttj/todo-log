// Entity links in agent-authored text: [the agent's own words](todo:12).
// The wrapped words render as the link — the agent decides what's tappable.
// Legacy bare [todo:12] tokens fall back to a title lookup (or #id).
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

const BASES: Record<string, string> = {
  todo: "todos",
  project: "projects",
  log: "logs",
};

export function renderEntityRefs(
  text: string,
  titles?: { todo?: Map<number, string>; project?: Map<number, string> },
): ReactNode[] {
  // A malformed ref ("[return the key](todo:unclear)") reads as its words,
  // never as raw markdown.
  text = text.replace(/\[([^\]]+)\]\((?:todo|project|log):(?!\d+\))[^)]*\)/g, "$1");
  const out: ReactNode[] = [];
  const re = /\[([^\]]+)\]\((todo|project|log):(\d+)\)|\[(todo|project|log):(\d+)\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const labeled = m[2] !== undefined;
    const type = labeled ? m[2] : m[4];
    const id = Number(labeled ? m[3] : m[5]);
    const label = labeled
      ? m[1]
      : type === "todo"
        ? (titles?.todo?.get(id) ?? `#${id}`)
        : type === "project"
          ? (titles?.project?.get(id) ?? `#${id}`)
          : `#${id}`;
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
