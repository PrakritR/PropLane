import {
  DEFAULT_EVENT_DURATION_MINUTES,
  endIsoForDuration,
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
  /** ISO start; required to place the task on the schedule. */
  start: string;
  /** ISO end; derived from duration when omitted on create. */
  end: string;
  durationMinutes: number;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ManagerTaskInput = {
  title: string;
  notes?: string;
  propertyId?: string;
  propertyTitle?: string;
  start: string;
  durationMinutes?: number;
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

function normalizeTask(raw: unknown): ManagerTask | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const id = String(row.id ?? "").trim();
  const title = String(row.title ?? "").trim();
  const start = String(row.start ?? "").trim();
  if (!id || !title || !start) return null;
  const durationMinutes =
    typeof row.durationMinutes === "number" && Number.isFinite(row.durationMinutes)
      ? Math.max(15, Math.round(row.durationMinutes))
      : DEFAULT_EVENT_DURATION_MINUTES;
  const end = String(row.end ?? "").trim() || endIsoForDuration(start, durationMinutes);
  return {
    id,
    title,
    notes: typeof row.notes === "string" ? row.notes.trim() || undefined : undefined,
    propertyId: typeof row.propertyId === "string" ? row.propertyId.trim() || undefined : undefined,
    propertyTitle: typeof row.propertyTitle === "string" ? row.propertyTitle.trim() || undefined : undefined,
    start,
    end,
    durationMinutes,
    completed: row.completed === true,
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

function taskToPlannedEvent(task: ManagerTask, managerUserId: string): PlannedEvent {
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
    notes: task.notes,
    adminUserId: managerUserId,
  };
}

function syncLocalTasksToPlannedEvents(managerUserId: string, tasks: ManagerTask[]) {
  if (!isBrowser()) return;
  const events = tasks.filter((task) => !task.completed).map((task) => taskToPlannedEvent(task, managerUserId));
  replaceManagerTaskPlannedEvents(managerUserId, events);
}

export function notifyManagerTasksChanged() {
  if (!isBrowser()) return;
  window.dispatchEvent(new Event(MANAGER_TASKS_EVENT));
  emitAdminUi();
}

export function readManagerTasksLocal(managerUserId: string): ManagerTask[] {
  return readLocalTasks(managerUserId).sort((a, b) => a.start.localeCompare(b.start));
}

export async function fetchManagerTasks(managerUserId: string): Promise<ManagerTask[]> {
  if (isDemoModeActive()) return readManagerTasksLocal(managerUserId);
  const res = await fetch("/api/portal/manager-tasks", { credentials: "include", cache: "no-store" });
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
  const start = input.start.trim();
  if (!title || !start) throw new Error("Title and schedule time are required.");
  const durationMinutes = input.durationMinutes ?? DEFAULT_EVENT_DURATION_MINUTES;
  const now = new Date().toISOString();
  const task: ManagerTask = {
    id: crypto.randomUUID(),
    title,
    notes: input.notes?.trim() || undefined,
    propertyId: input.propertyId?.trim() || undefined,
    propertyTitle: input.propertyTitle?.trim() || undefined,
    start,
    end: endIsoForDuration(start, durationMinutes),
    durationMinutes,
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
  patch: Partial<Pick<ManagerTask, "title" | "notes" | "start" | "end" | "durationMinutes" | "completed">>,
): Promise<ManagerTask> {
  if (!readLocalTasks(managerUserId).some((row) => row.id === taskId) && !isDemoModeActive()) {
    await fetchManagerTasks(managerUserId);
  }
  const current = readLocalTasks(managerUserId).find((row) => row.id === taskId);
  if (!current) throw new Error("Task not found.");

  const durationMinutes = patch.durationMinutes ?? current.durationMinutes;
  const start = patch.start ?? current.start;
  const next: ManagerTask = {
    ...current,
    ...patch,
    title: patch.title?.trim() || current.title,
    notes: patch.notes !== undefined ? patch.notes.trim() || undefined : current.notes,
    start,
    durationMinutes,
    end: patch.end ?? endIsoForDuration(start, durationMinutes),
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
