import { getPropertyById } from "@/lib/rental-application/data";
import { moduleRowVisibleToPortalUser } from "@/lib/manager-portfolio-access";
import type { ManagerTaskListTabId } from "@/lib/portal-detail-routes";
import type { ManagerTask } from "@/lib/manager-tasks";
import { inferManagerTaskType, inferManagerTaskUrgency } from "@/lib/manager-tasks";
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

/** In-list filter pills on the manager Tasks page. */
export const MANAGER_TASK_LIST_FILTERS = [
  "all",
  "service_orders",
  "tours",
  "general_tasks",
  "house_tasks",
] as const;
export type ManagerTaskListFilterId = (typeof MANAGER_TASK_LIST_FILTERS)[number];

export const MANAGER_TASK_LIST_FILTER_LABELS: Record<ManagerTaskListFilterId, string> = {
  all: "All",
  service_orders: "Service orders",
  tours: "Tours",
  general_tasks: "General tasks",
  house_tasks: "House tasks",
};

export function managerTaskIsScheduled(task: Pick<ManagerTask, "start" | "end">): boolean {
  return Boolean(task.start?.trim() && task.end?.trim());
}

/** Effective due instant for lateness — end of a slot, due date, or lone start. */
export function managerTaskDueInstant(
  task: Pick<ManagerTask, "start" | "end" | "dueDate" | "urgency">,
): number | null {
  const urgency = inferManagerTaskUrgency(task);
  if (urgency === "scheduled" && task.end?.trim()) {
    const endMs = Date.parse(task.end);
    return Number.isFinite(endMs) ? endMs : null;
  }
  if (task.dueDate?.trim()) {
    const dueMs = Date.parse(task.dueDate);
    return Number.isFinite(dueMs) ? dueMs : null;
  }
  if (task.start?.trim() && !managerTaskIsScheduled(task)) {
    const startMs = Date.parse(task.start);
    return Number.isFinite(startMs) ? startMs : null;
  }
  return null;
}

export function isManagerTaskLate(
  task: Pick<ManagerTask, "completed" | "start" | "end" | "dueDate" | "urgency">,
  referenceMs: number = Date.now(),
): boolean {
  if (task.completed) return false;
  const dueMs = managerTaskDueInstant(task);
  if (dueMs == null) return false;
  return dueMs < referenceMs;
}

function taskMatchesTypeFilter(task: ManagerTask, filter: Exclude<ManagerTaskListFilterId, "all" | "service_orders">): boolean {
  const type = inferManagerTaskType(task);
  if (filter === "tours") return type === "tour";
  if (filter === "house_tasks") return type === "house" || type === "check_in" || type === "check_out";
  if (filter === "general_tasks") return type === "general" || type === "work_order";
  return true;
}

export function openTasksForListTab(tasks: ManagerTask[], tabId: ManagerTaskListTabId): ManagerTask[] {
  if (tabId === "completed") return tasks.filter((task) => task.completed);
  const open = tasks.filter((task) => !task.completed);
  if (tabId === "overdue") return open.filter((task) => isManagerTaskLate(task));
  return open.filter((task) => !isManagerTaskLate(task));
}

export function countTaskListFilterBuckets(input: {
  tasks: ManagerTask[];
  services: ServiceRequest[];
  tabId: ManagerTaskListTabId;
  matchesProperty: (propertyId?: string) => boolean;
}): Record<ManagerTaskListFilterId, number> {
  const taskRows = openTasksForListTab(input.tasks, input.tabId).filter((task) =>
    input.matchesProperty(task.propertyId),
  );

  const serviceRows =
    input.tabId === "in-progress"
      ? input.services.filter((req) => input.matchesProperty(req.propertyId))
      : [];

  const tours = taskRows.filter((task) => inferManagerTaskType(task) === "tour").length;
  const houseTasks = taskRows.filter((task) => {
    const type = inferManagerTaskType(task);
    return type === "house" || type === "check_in" || type === "check_out";
  }).length;
  const generalTasks = taskRows.filter((task) => {
    const type = inferManagerTaskType(task);
    return type === "general" || type === "work_order";
  }).length;
  const services = serviceRows.length;

  return {
    all: taskRows.length + services,
    service_orders: services,
    tours,
    general_tasks: generalTasks,
    house_tasks: houseTasks,
  };
}

export function taskListRowMatchesFilter(
  row:
    | { kind: "task"; task: ManagerTask }
    | { kind: "service"; request: ServiceRequest },
  filter: ManagerTaskListFilterId,
): boolean {
  if (filter === "all") return true;
  if (row.kind === "service") return filter === "service_orders";
  if (filter === "service_orders") return false;
  return taskMatchesTypeFilter(row.task, filter);
}
