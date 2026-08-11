// One FontAwesome icon per change-feed action, chosen from (entity, kind).
// Shared by the live dock feed and the replay/log-page EventFeed.
import {
  faSquarePlus,
  faFolderPlus,
  faFeather,
  faPen,
  faArrowsRotate,
  faCalendarDays,
  faSun,
  faBell,
  faBellSlash,
  faRotateLeft,
  faBrain,
  faGraduationCap,
  faSquareCheck,
  faLayerGroup,
  faBookOpen,
  faCircleDot,
  faTrashCan,
} from "@fortawesome/free-solid-svg-icons";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";

const ENTITY_ICONS: Record<string, IconDefinition> = {
  todo: faSquareCheck,
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
  if (kind === "created") {
    if (entityType === "todo") return faSquarePlus;
    if (entityType === "project") return faFolderPlus;
    if (entityType === "log") return faFeather;
  }
  if (kind === "updated" || kind === "refiled") return entityType === "log" ? faFeather : faPen;
  if (kind === "status_changed") return faArrowsRotate;
  if (kind === "scheduled" || kind === "rescheduled") return faCalendarDays;
  if (kind === "briefing_updated") return faSun;
  if (kind.includes("notification")) return kind.includes("clear") ? faBellSlash : faBell;
  return ENTITY_ICONS[entityType] ?? faCircleDot;
}
