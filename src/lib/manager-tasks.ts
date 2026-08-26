import { normalizeAssignee, type WorkAssignee } from "@/lib/work-assignment";
import {
  DEFAULT_EVENT_DURATION_MINUTES,
  replaceManagerTaskPlannedEvents,
  type PlannedEvent,
} from "@/lib/demo-admin-scheduling";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { emitAdminUi } from "@/lib/demo-admin-ui";

export const MANAGER_TASKS_RECORD_PREFIX = "axis_manager_tasks_v1_";
export const MANAGER_TASKS_EVENT = "manager-tasks-changed";

export type ManagerTask = {
  id: string;
  title: string;
  notes?: string;
  propertyId?: string;
  propertyTitle?: string;
  roomLabel?: string;
  /** ISO start; when omitted the task stays off the calendar. */
  start?: string;
  /** ISO end; calendar blocks require both start and end. */
  end?: string;
  durationMinutes?: number;
  completed: boolean;
  /**
   * Who is doing this, when a manager has said. Tasks are staff work, so this is a TEAM member —
   * `work-assignment.ts` is the one place that rule lives, and it does not offer vendors here.
   */
  assignee?: WorkAssignee;
  createdAt: string;
  updatedAt: string;
};

export type ManagerTaskInput = {
  title: string;
  notes?: string;
  propertyId?: string;
  propertyTitle?: string;
  roomLabel?: string;
  start?: string;
  end?: string;
  assignee?: WorkAssignee | null;
};

const localTasks = new Map<string, ManagerTask[]>();

function isBrowser() {
  return typeof window !== "undefined";
}

export function managerTasksStorageKey(managerUserId: string): string {
  return `${MANAGER_TASKS_RECORD_PREFIX}${managerUserId}`;
}

function plannedEventIdForTask(taskId: string): string {
  return `task_${taskId}`;
}

function durationBetween(start: string, end: string): number {
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_EVENT_DURATION_MINUTES;
  return Math.max(15, Math.round(ms / 60_000));
}

function normalizeTask(raw: unknown): ManagerTask | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const id = String(row.id ?? "").trim();
  const title = String(row.title ?? "").trim();
  if (!id || !title) return null;
  const start = String(row.start ?? "").trim() || undefined;
  const end = String(row.end ?? "").trim() || undefined;
  const durationMinutes =
    start && end
      ? durationBetween(start, end)
      : typeof row.durationMinutes === "number" && Number.isFinite(row.durationMinutes)
        ? Math.max(15, Math.round(row.durationMinutes))
        : undefined;
  return {
    id,
    title,
    notes: typeof row.notes === "string" ? row.notes.trim() || undefined : undefined,
    propertyId: typeof row.propertyId === "string" ? row.propertyId.trim() || undefined : undefined,
    propertyTitle: typeof row.propertyTitle === "string" ? row.propertyTitle.trim() || undefined : undefined,
    roomLabel: typeof row.roomLabel === "string" ? row.roomLabel.trim() || undefined : undefined,
    start,
    end,
    durationMinutes,
    completed: row.completed === true,
    // Unusable assignees normalize to undefined rather than a name nobody can act on.
    assignee: normalizeAssignee(row.assignee) ?? undefined,
    createdAt: String(row.createdAt ?? new Date().toISOString()),
    updatedAt: String(row.updatedAt ?? new Date().toISOString()),
  };
}

export function normalizeManagerTasks(raw: unknown): ManagerTask[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeTask).filter((task): task is ManagerTask => Boolean(task));
}

function readLocalTasks(managerUserId: string): ManagerTask[] {
  return [...(localTasks.get(managerUserId) ?? [])];
}

function writeLocalTasks(managerUserId: string, tasks: ManagerTask[]) {
  localTasks.set(managerUserId, tasks);
}

function taskToPlannedEvent(task: ManagerTask, managerUserId: string): PlannedEvent | null {
  if (!task.start || !task.end) return null;
  return {
    id: plannedEventIdForTask(task.id),
    title: `Task · ${task.title}`,
    start: task.start,
    end: task.end,
    kind: "task",
    managerUserId,
    sourceTaskId: task.id,
    propertyId: task.propertyId,
    propertyTitle: task.propertyTitle,
    roomLabel: task.roomLabel,
    notes: task.notes,
    adminUserId: managerUserId,
  };
}

function syncLocalTasksToPlannedEvents(managerUserId: string, tasks: ManagerTask[]) {
  if (!isBrowser()) return;
  const events = tasks
    .filter((task) => !task.completed)
    .map((task) => taskToPlannedEvent(task, managerUserId))
    .filter((event): event is PlannedEvent => Boolean(event));
  replaceManagerTaskPlannedEvents(managerUserId, events);
}

/** Re-merge this manager's task blocks after a server calendar sync overwrites planned events. */
export function reapplyManagerTasksToCalendar(managerUserId: string): void {
  syncLocalTasksToPlannedEvents(managerUserId, readLocalTasks(managerUserId));
}

/** Re-merge every cached manager task list after schedule sync. */
export function reapplyAllManagerTasksToCalendar(): void {
  if (!isBrowser()) return;
  for (const [managerUserId, tasks] of localTasks) {
    syncLocalTasksToPlannedEvents(managerUserId, tasks);
  }
}

export function notifyManagerTasksChanged() {
  if (!isBrowser()) return;
  window.dispatchEvent(new Event(MANAGER_TASKS_EVENT));
  emitAdminUi();
}

export function readManagerTasksLocal(managerUserId: string): ManagerTask[] {
  return readLocalTasks(managerUserId).sort((a, b) => {
    const aStart = a.start ?? "";
    const bStart = b.start ?? "";
    if (aStart && bStart) return aStart.localeCompare(bStart);
    if (aStart) return -1;
    if (bStart) return 1;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

export async function fetchManagerTasks(managerUserId: string): Promise<ManagerTask[]> {
  if (!isBrowser()) return readManagerTasksLocal(managerUserId);
  if (isDemoModeActive()) return readManagerTasksLocal(managerUserId);
  let res: Response;
  try {
    res = await fetch("/api/portal/manager-tasks", { credentials: "include", cache: "no-store" });
  } catch {
    throw new Error("Could not load tasks. Check your connection and try again.");
  }
  const data = (await res.json().catch(() => ({}))) as { tasks?: unknown; error?: string };
  if (!res.ok) throw new Error(data.error ?? "Could not load tasks.");
  const tasks = normalizeManagerTasks(data.tasks);
  writeLocalTasks(managerUserId, tasks);
  syncLocalTasksToPlannedEvents(managerUserId, tasks);
  notifyManagerTasksChanged();
  return tasks;
}

export async function createManagerTask(
  managerUserId: string,
  input: ManagerTaskInput,
): Promise<ManagerTask> {
  const title = input.title.trim();
  if (!title) throw new Error("Title is required.");
  const start = input.start?.trim() || undefined;
  const end = input.end?.trim() || undefined;
  if (start && end && Date.parse(end) <= Date.parse(start)) {
    throw new Error("End time must be after start time.");
  }
  const now = new Date().toISOString();
  const task: ManagerTask = {
    id: crypto.randomUUID(),
    title,
    notes: input.notes?.trim() || undefined,
    propertyId: input.propertyId?.trim() || undefined,
    propertyTitle: input.propertyTitle?.trim() || undefined,
    roomLabel: input.roomLabel?.trim() || undefined,
    start,
    end,
    durationMinutes: start && end ? durationBetween(start, end) : undefined,
    completed: false,
    createdAt: now,
    updatedAt: now,
  };

  if (isDemoModeActive()) {
    const tasks = [...readLocalTasks(managerUserId), task];
    writeLocalTasks(managerUserId, tasks);
    syncLocalTasksToPlannedEvents(managerUserId, tasks);
    notifyManagerTasksChanged();
    return task;
  }

  const res = await fetch("/api/portal/manager-tasks", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(task),
  });
  const data = (await res.json().catch(() => ({}))) as { task?: unknown; error?: string };
  if (!res.ok) throw new Error(data.error ?? "Could not create task.");
  const saved = normalizeTask(data.task);
  if (!saved) throw new Error("Could not create task.");
  const tasks = [...readLocalTasks(managerUserId).filter((row) => row.id !== saved.id), saved];
  writeLocalTasks(managerUserId, tasks);
  syncLocalTasksToPlannedEvents(managerUserId, tasks);
  notifyManagerTasksChanged();
  return saved;
}

export async function updateManagerTask(
  managerUserId: string,
  taskId: string,
  patch: Partial<
    Pick<
      ManagerTask,
      "title" | "notes" | "propertyId" | "propertyTitle" | "roomLabel" | "start" | "end" | "durationMinutes" | "completed"
    >
  >,
): Promise<ManagerTask> {
  if (!readLocalTasks(managerUserId).some((row) => row.id === taskId) && !isDemoModeActive()) {
    await fetchManagerTasks(managerUserId);
  }
  const current = readLocalTasks(managerUserId).find((row) => row.id === taskId);
  if (!current) throw new Error("Task not found.");

  const start = patch.start !== undefined ? patch.start?.trim() || undefined : current.start;
  const end = patch.end !== undefined ? patch.end?.trim() || undefined : current.end;
  const durationMinutes =
    patch.durationMinutes ?? (start && end ? durationBetween(start, end) : current.durationMinutes);
  const next: ManagerTask = {
    ...current,
    ...patch,
    title: patch.title?.trim() || current.title,
    notes: patch.notes !== undefined ? patch.notes.trim() || undefined : current.notes,
    propertyId: patch.propertyId !== undefined ? patch.propertyId?.trim() || undefined : current.propertyId,
    propertyTitle:
      patch.propertyTitle !== undefined ? patch.propertyTitle?.trim() || undefined : current.propertyTitle,
    roomLabel: patch.roomLabel !== undefined ? patch.roomLabel?.trim() || undefined : current.roomLabel,
    start,
    end,
    durationMinutes,
    updatedAt: new Date().toISOString(),
  };

  if (isDemoModeActive()) {
    const tasks = readLocalTasks(managerUserId).map((row) => (row.id === taskId ? next : row));
    writeLocalTasks(managerUserId, tasks);
    syncLocalTasksToPlannedEvents(managerUserId, tasks);
    notifyManagerTasksChanged();
    return next;
  }

  const res = await fetch("/api/portal/manager-tasks", {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: taskId, ...patch }),
  });
  const data = (await res.json().catch(() => ({}))) as { task?: unknown; error?: string };
  if (!res.ok) throw new Error(data.error ?? "Could not update task.");
  const saved = normalizeTask(data.task);
  if (!saved) throw new Error("Could not update task.");
  const tasks = readLocalTasks(managerUserId).map((row) => (row.id === taskId ? saved : row));
  writeLocalTasks(managerUserId, tasks);
  syncLocalTasksToPlannedEvents(managerUserId, tasks);
  notifyManagerTasksChanged();
  return saved;
}

export async function deleteManagerTask(managerUserId: string, taskId: string): Promise<void> {
  if (isDemoModeActive()) {
    const tasks = readLocalTasks(managerUserId).filter((row) => row.id !== taskId);
    writeLocalTasks(managerUserId, tasks);
    syncLocalTasksToPlannedEvents(managerUserId, tasks);
    notifyManagerTasksChanged();
    return;
  }

  const res = await fetch("/api/portal/manager-tasks", {
    method: "DELETE",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: taskId }),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Could not delete task.");
  const tasks = readLocalTasks(managerUserId).filter((row) => row.id !== taskId);
  writeLocalTasks(managerUserId, tasks);
  syncLocalTasksToPlannedEvents(managerUserId, tasks);
  notifyManagerTasksChanged();
}
