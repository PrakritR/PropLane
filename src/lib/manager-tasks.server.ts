import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_EVENT_DURATION_MINUTES } from "@/lib/demo-admin-scheduling";
import {
  managerTasksStorageKey,
  normalizeManagerTasks,
  type ManagerTask,
} from "@/lib/manager-tasks";
import { normalizeAssignee } from "@/lib/work-assignment";

function durationBetween(start: string, end: string): number {
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_EVENT_DURATION_MINUTES;
  return Math.max(15, Math.round(ms / 60_000));
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
  return normalized;
}

export async function createManagerTaskRow(
  db: SupabaseClient,
  managerUserId: string,
  input: unknown,
): Promise<ManagerTask> {
  const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const title = String(body.title ?? "").trim();
  if (!title) throw new Error("Title is required.");
  const start = String(body.start ?? "").trim() || undefined;
  const end = String(body.end ?? "").trim() || undefined;
  if (start && end && Date.parse(end) <= Date.parse(start)) {
    throw new Error("End time must be after start time.");
  }
  const now = new Date().toISOString();
  const task: ManagerTask = {
    id: String(body.id ?? crypto.randomUUID()),
    title,
    notes: typeof body.notes === "string" ? body.notes.trim() || undefined : undefined,
    propertyId: typeof body.propertyId === "string" ? body.propertyId.trim() || undefined : undefined,
    propertyTitle: typeof body.propertyTitle === "string" ? body.propertyTitle.trim() || undefined : undefined,
    roomLabel: typeof body.roomLabel === "string" ? body.roomLabel.trim() || undefined : undefined,
    start,
    end,
    durationMinutes: start && end ? durationBetween(start, end) : undefined,
    completed: false,
    assignee: normalizeAssignee(body.assignee) ?? undefined,
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
  const start = typeof patch.start === "string" ? patch.start.trim() || undefined : current.start;
  const end = typeof patch.end === "string" ? patch.end.trim() || undefined : current.end;
  const durationMinutes =
    typeof patch.durationMinutes === "number" && Number.isFinite(patch.durationMinutes)
      ? Math.max(15, Math.round(patch.durationMinutes))
      : start && end
        ? durationBetween(start, end)
        : current.durationMinutes;
  const next: ManagerTask = {
    ...current,
    title: typeof patch.title === "string" ? patch.title.trim() || current.title : current.title,
    notes: typeof patch.notes === "string" ? patch.notes.trim() || undefined : current.notes,
    propertyId:
      typeof patch.propertyId === "string" ? patch.propertyId.trim() || undefined : current.propertyId,
    propertyTitle:
      typeof patch.propertyTitle === "string"
        ? patch.propertyTitle.trim() || undefined
        : current.propertyTitle,
    roomLabel:
      typeof patch.roomLabel === "string" ? patch.roomLabel.trim() || undefined : current.roomLabel,
    start,
    end,
    durationMinutes,
    completed: patch.completed === true ? true : patch.completed === false ? false : current.completed,
    assignee:
      patch.assignee !== undefined
        ? normalizeAssignee(patch.assignee) ?? undefined
        : current.assignee,
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
