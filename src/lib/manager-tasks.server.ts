import type { SupabaseClient } from "@supabase/supabase-js";
import { PLANNED_RECORD_ID, rowsFromRecord } from "@/lib/tour-inquiry-confirm.server";
import {
  endIsoForDuration,
  DEFAULT_EVENT_DURATION_MINUTES,
  type PlannedEvent,
} from "@/lib/demo-admin-scheduling";
import {
  managerTasksStorageKey,
  normalizeManagerTasks,
  type ManagerTask,
} from "@/lib/manager-tasks";

function plannedEventIdForTask(taskId: string): string {
  return `task_${taskId}`;
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

async function readTasksRecord(db: SupabaseClient, managerUserId: string): Promise<ManagerTask[]> {
  const { data, error } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("id", managerTasksStorageKey(managerUserId))
    .maybeSingle();
  if (error) throw error;
  const rowData = data?.row_data as Record<string, unknown> | null | undefined;
  return normalizeManagerTasks(rowData?.tasks);
}

async function writeTasksRecord(db: SupabaseClient, managerUserId: string, tasks: ManagerTask[]): Promise<void> {
  const id = managerTasksStorageKey(managerUserId);
  const { error } = await db.from("portal_schedule_records").upsert(
    {
      id,
      manager_user_id: managerUserId,
      property_id: null,
      record_type: "manager_tasks",
      row_data: {
        id,
        recordType: "manager_tasks",
        managerUserId,
        tasks,
      },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (error) throw error;
}

async function syncTasksToPlannedEvents(db: SupabaseClient, managerUserId: string, tasks: ManagerTask[]): Promise<void> {
  const { data: plannedRecord, error: plannedReadError } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("id", PLANNED_RECORD_ID)
    .maybeSingle();
  if (plannedReadError) throw plannedReadError;

  const plannedRows = rowsFromRecord(plannedRecord?.row_data);
  const withoutManagerTasks = plannedRows.filter((event) => {
    const kind = String(event.kind ?? "");
    const owner = String(event.managerUserId ?? "");
    return !(kind === "task" && owner === managerUserId);
  });

  const taskEvents = tasks
    .filter((task) => !task.completed)
    .map((task) => taskToPlannedEvent(task, managerUserId) as unknown as Record<string, unknown>);

  const { error: writeError } = await db.from("portal_schedule_records").upsert(
    {
      id: PLANNED_RECORD_ID,
      manager_user_id: null,
      property_id: null,
      record_type: PLANNED_RECORD_ID,
      row_data: {
        id: PLANNED_RECORD_ID,
        recordType: PLANNED_RECORD_ID,
        managerUserId: null,
        propertyId: null,
        payload: [...withoutManagerTasks, ...taskEvents],
      },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (writeError) throw writeError;
}

export async function loadManagerTasks(db: SupabaseClient, managerUserId: string): Promise<ManagerTask[]> {
  return readTasksRecord(db, managerUserId);
}

export async function saveManagerTasks(
  db: SupabaseClient,
  managerUserId: string,
  tasks: ManagerTask[],
): Promise<ManagerTask[]> {
  const normalized = normalizeManagerTasks(tasks);
  await writeTasksRecord(db, managerUserId, normalized);
  await syncTasksToPlannedEvents(db, managerUserId, normalized);
  return normalized;
}

export async function createManagerTaskRow(
  db: SupabaseClient,
  managerUserId: string,
  input: unknown,
): Promise<ManagerTask> {
  const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const title = String(body.title ?? "").trim();
  const start = String(body.start ?? "").trim();
  if (!title || !start) throw new Error("Title and schedule time are required.");
  const durationMinutes =
    typeof body.durationMinutes === "number" && Number.isFinite(body.durationMinutes)
      ? Math.max(15, Math.round(body.durationMinutes))
      : DEFAULT_EVENT_DURATION_MINUTES;
  const now = new Date().toISOString();
  const task: ManagerTask = {
    id: String(body.id ?? crypto.randomUUID()),
    title,
    notes: typeof body.notes === "string" ? body.notes.trim() || undefined : undefined,
    propertyId: typeof body.propertyId === "string" ? body.propertyId.trim() || undefined : undefined,
    propertyTitle: typeof body.propertyTitle === "string" ? body.propertyTitle.trim() || undefined : undefined,
    start,
    end: String(body.end ?? endIsoForDuration(start, durationMinutes)),
    durationMinutes,
    completed: false,
    createdAt: now,
    updatedAt: now,
  };
  const tasks = [...(await readTasksRecord(db, managerUserId)), task];
  await saveManagerTasks(db, managerUserId, tasks);
  return task;
}

export async function patchManagerTaskRow(
  db: SupabaseClient,
  managerUserId: string,
  taskId: string,
  patch: Record<string, unknown>,
): Promise<ManagerTask> {
  const tasks = await readTasksRecord(db, managerUserId);
  const current = tasks.find((row) => row.id === taskId);
  if (!current) throw new Error("Task not found.");
  const durationMinutes =
    typeof patch.durationMinutes === "number" && Number.isFinite(patch.durationMinutes)
      ? Math.max(15, Math.round(patch.durationMinutes))
      : current.durationMinutes;
  const start = typeof patch.start === "string" ? patch.start : current.start;
  const next: ManagerTask = {
    ...current,
    title: typeof patch.title === "string" ? patch.title.trim() || current.title : current.title,
    notes: typeof patch.notes === "string" ? patch.notes.trim() || undefined : current.notes,
    start,
    durationMinutes,
    end: typeof patch.end === "string" ? patch.end : endIsoForDuration(start, durationMinutes),
    completed: patch.completed === true ? true : patch.completed === false ? false : current.completed,
    updatedAt: new Date().toISOString(),
  };
  const updated = tasks.map((row) => (row.id === taskId ? next : row));
  await saveManagerTasks(db, managerUserId, updated);
  return next;
}

export async function deleteManagerTaskRow(
  db: SupabaseClient,
  managerUserId: string,
  taskId: string,
): Promise<void> {
  const tasks = (await readTasksRecord(db, managerUserId)).filter((row) => row.id !== taskId);
  await saveManagerTasks(db, managerUserId, tasks);
}
