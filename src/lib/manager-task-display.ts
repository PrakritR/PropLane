import { getPropertyById } from "@/lib/rental-application/data";
import { moduleRowVisibleToPortalUser } from "@/lib/manager-portfolio-access";
import type { ManagerTask } from "@/lib/manager-tasks";
import {
  readAllServiceRequests,
  type ServiceRequest,
} from "@/lib/service-requests-storage";
import { normalizeAssignee } from "@/lib/work-assignment";

/** Street-only property label for task rows — avoids repeating room count and rent in the subtitle. */
export function compactTaskPropertyLabel(
  propertyId: string | undefined,
  propertyTitle?: string,
): string | undefined {
  const pid = propertyId?.trim();
  if (pid) {
    const property = getPropertyById(pid);
    if (property) {
      const street = property.address.split(",")[0]?.trim();
      return street || property.buildingName?.trim() || property.title?.trim() || propertyTitle?.trim();
    }
  }
  const stored = propertyTitle?.trim();
  if (!stored) return undefined;
  return stored.split(" · ")[0]?.trim() || stored;
}

/** Room line on tasks should be the room name, not the full picker label with floor and rent. */
export function compactTaskRoomLabel(roomLabel?: string): string | undefined {
  const raw = roomLabel?.trim();
  if (!raw) return undefined;
  return raw.split(" · ")[0]?.trim() || raw;
}

export function compactTaskLocationLabel(task: Pick<ManagerTask, "propertyId" | "propertyTitle" | "roomLabel">): string | null {
  const parts = [
    compactTaskPropertyLabel(task.propertyId, task.propertyTitle),
    compactTaskRoomLabel(task.roomLabel),
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

const NOTE_PREVIEW_MAX_LINES = 3;

/** First few lines of notes for list cards; full text stays in the editor / detail modal. */
export function taskNotesPreview(notes: string | undefined): { preview: string; truncated: boolean } {
  const text = notes?.trim() ?? "";
  if (!text) return { preview: "", truncated: false };
  const lines = text.split(/\r?\n/);
  if (lines.length <= NOTE_PREVIEW_MAX_LINES && text.length <= 220) {
    return { preview: text, truncated: false };
  }
  const preview = lines.slice(0, NOTE_PREVIEW_MAX_LINES).join("\n");
  return { preview, truncated: true };
}

/** Add-on service rows assigned to this team member (not unassigned, not vendors). */
export function serviceRequestsAssignedToViewer(viewerUserId: string): ServiceRequest[] {
  const viewer = viewerUserId.trim();
  if (!viewer) return [];
  return readAllServiceRequests()
    .filter((req) => moduleRowVisibleToPortalUser(req, viewer, "services"))
    .filter((req) => req.status !== "denied")
    .filter((req) => {
      const assignee = normalizeAssignee(req.assignee);
      return assignee?.type === "team" && assignee.id === viewer;
    })
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

export function serviceRequestLocationLabel(req: ServiceRequest): string | null {
  const property = compactTaskPropertyLabel(req.propertyId);
  const resident = req.residentName?.trim();
  const parts = [property, resident].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** In-list filter pills on the manager Tasks page (same shape as Services Open / Scheduled / …). */
export const MANAGER_TASK_LIST_FILTERS = ["all", "open", "scheduled", "services"] as const;
export type ManagerTaskListFilterId = (typeof MANAGER_TASK_LIST_FILTERS)[number];

export const MANAGER_TASK_LIST_FILTER_LABELS: Record<ManagerTaskListFilterId, string> = {
  all: "All",
  open: "Open",
  scheduled: "Scheduled",
  services: "Service orders",
};

export function managerTaskIsScheduled(task: Pick<ManagerTask, "start" | "end">): boolean {
  return Boolean(task.start?.trim() && task.end?.trim());
}

export function countTaskListFilterBuckets(input: {
  tasks: ManagerTask[];
  services: ServiceRequest[];
  tabId: "in-progress" | "completed";
  matchesProperty: (propertyId?: string) => boolean;
}): Record<ManagerTaskListFilterId, number> {
  const taskRows = (input.tabId === "completed"
    ? input.tasks.filter((task) => task.completed)
    : input.tasks.filter((task) => !task.completed)
  ).filter((task) => input.matchesProperty(task.propertyId));

  const serviceRows =
    input.tabId === "completed"
      ? []
      : input.services.filter((req) => input.matchesProperty(req.propertyId));

  const openTasks = taskRows.filter((task) => !managerTaskIsScheduled(task)).length;
  const scheduledTasks = taskRows.filter((task) => managerTaskIsScheduled(task)).length;
  const services = serviceRows.length;

  return {
    all: taskRows.length + services,
    open: openTasks,
    scheduled: scheduledTasks,
    services,
  };
}

export function taskListRowMatchesFilter(
  row:
    | { kind: "task"; task: ManagerTask }
    | { kind: "service"; request: ServiceRequest },
  filter: ManagerTaskListFilterId,
): boolean {
  if (filter === "all") return true;
  if (row.kind === "service") return filter === "services";
  if (filter === "services") return false;
  if (filter === "scheduled") return managerTaskIsScheduled(row.task);
  return !managerTaskIsScheduled(row.task);
}
