// One FontAwesome icon per change-feed action. Entity-first (matching the
// nav: log=book, project=stack, todo=pencil), with a few verb overrides.
import {
  faPencil,
  faLayerGroup,
  faBookOpen,
  faCalendarDays,
  faSun,
  faBell,
  faBellSlash,
  faRotateLeft,
  faBrain,
  faGraduationCap,
  faCircleDot,
  faTrashCan,
} from "@fortawesome/free-solid-svg-icons";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";

const ENTITY_ICONS: Record<string, IconDefinition> = {
  todo: faPencil,
  project: faLayerGroup,
  log: faBookOpen,
  schedule: faCalendarDays,
  briefing: faSun,
  notification: faBell,
  memory: faBrain,
  correction: faGraduationCap,
};

export function feedIcon(entityType: string, kind: string): IconDefinition {
  if (kind === "undone") return faRotateLeft;
  if (kind === "deleted") return faTrashCan;
  if (kind === "scheduled" || kind === "rescheduled") return faCalendarDays;
  if (kind === "briefing_updated") return faSun;
  if (kind.includes("notification")) return kind.includes("clear") ? faBellSlash : faBell;
  return ENTITY_ICONS[entityType] ?? faCircleDot;
}
