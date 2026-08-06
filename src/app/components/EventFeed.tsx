// Change-feed list reconstructed from audit events (events store no display
// label, so the line is rebuilt from kind + entity + payload). Used by the log
// permalink page and the chat replay page.
import { Link } from "react-router-dom";
import type { EventRecord, Todo, Project } from "../api";

export default function EventFeed(props: {
  events: EventRecord[];
  todos: Todo[];
  projects: Project[];
  className?: string;
}) {
  return (
    <ul className={`feed${props.className ? ` ${props.className}` : ""}`}>
      {props.events.map((e) => (
        <li key={e.id} className={e.undone ? "undone" : ""}>
          <span>
            {e.kind.replace("_", " ")} {e.entity_type}{" "}
            <Link to={entityRoute(e)} className="entity-link">
              {entityName(e, props.todos, props.projects)}
            </Link>
            {payloadDetail(e)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function entityRoute(e: EventRecord): string {
  switch (e.entity_type) {
    case "todo":
      return `/todos/${e.entity_id}`;
    case "project":
      return `/projects/${e.entity_id}`;
    case "action":
      return `/actions/${e.entity_id}`;
    case "log":
      return `/logs/${e.entity_id}`;
    default:
      return "/";
  }
}

function entityName(e: EventRecord, todos: Todo[], projects: Project[]): string {
  if (e.entity_type === "todo") {
    return todos.find((t) => t.id === e.entity_id)?.title ?? `#${e.entity_id}`;
  }
  if (e.entity_type === "project") {
    return projects.find((p) => p.id === e.entity_id)?.name ?? `#${e.entity_id}`;
  }
  return `#${e.entity_id}`;
}

function payloadDetail(e: EventRecord): string {
  try {
    const payload = e.payload_json
      ? (JSON.parse(e.payload_json) as { before?: Record<string, unknown>; after?: Record<string, unknown> })
      : null;
    if (payload?.before && payload?.after && "status" in payload.after) {
      return `: ${String(payload.before.status)} → ${String(payload.after.status)}`;
    }
    if (payload?.after) {
      return ` (${Object.keys(payload.after).join(", ")})`;
    }
  } catch {
    // no payload detail
  }
  return "";
}
