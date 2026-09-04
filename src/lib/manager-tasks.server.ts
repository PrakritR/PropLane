import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_EVENT_DURATION_MINUTES } from "@/lib/demo-admin-scheduling";
import {
  managerTasksStorageKey,
  normalizeManagerTasks,
  normalizeTaskType,
  type ManagerTask,
} from "@/lib/manager-tasks";
import { normalizeAssignee } from "@/lib/work-assignment";
import { viewerAndLinkedOwnerIdsForModule } from "@/lib/auth/co-manager-module-scope";

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

/** A team assignment names a co-manager's user id; a vendor id is a vendor row id. */
function taskAssignedTo(task: ManagerTask, userId: string): boolean {
  const assignee = task.assignee;
  if (!assignee || assignee.type !== "team") return false;
  return assignee.id.trim() !== "" && assignee.id.trim() === userId.trim();
}

/**
 * Every task record this viewer may read: their own, plus the linked owners'.
 *
 * Tasks are stored one row per manager, so a task the OWNER created and assigned
 * to a co-manager lives in the owner's row. Reading only the caller's own row is
 * why an assigned tour never reached the assignee's list (AXI-159).
 */
async function readTaskRecordsForViewer(
  db: SupabaseClient,
  viewerUserId: string,
): Promise<{ ownerUserId: string; tasks: ManagerTask[] }[]> {
  let ownerIds: string[] = [viewerUserId];
  try {
    ownerIds = await viewerAndLinkedOwnerIdsForModule(db, viewerUserId, "calendar");
  } catch {
    // A failed scope read must not blank the viewer's OWN tasks — degrade to them.
    ownerIds = [viewerUserId];
  }
  const records = await Promise.all(
    ownerIds.map(async (ownerUserId) => {
      try {
        return { ownerUserId, tasks: await readTasksRecord(db, ownerUserId) };
      } catch {
        return { ownerUserId, tasks: [] as ManagerTask[] };
      }
    }),
  );
  return records;
}

/**
 * The viewer's own tasks, plus tasks a linked owner ASSIGNED to them.
 *
 * Only assigned rows cross the boundary — a co-manager sees the one job they
 * were given, never the owner's whole task list.
 */
export async function loadManagerTasks(db: SupabaseClient, managerUserId: string): Promise<ManagerTask[]> {
  const records = await readTaskRecordsForViewer(db, managerUserId);
  const own = records.find((r) => r.ownerUserId === managerUserId)?.tasks ?? [];
  const seen = new Set(own.map((t) => t.id));
  const assigned = records
    .filter((r) => r.ownerUserId !== managerUserId)
    .flatMap((r) => r.tasks.filter((task) => taskAssignedTo(task, managerUserId)))
    .filter((task) => (seen.has(task.id) ? false : (seen.add(task.id), true)));
  return [...own, ...assigned];
}

/**
 * The owner whose record holds a task this viewer may WRITE — their own record
 * first, then a linked owner's record but ONLY for a task assigned to them.
 *
 * Without this an assignee could see a task and not tick it off, which is worse
 * than not seeing it: the card is there and does nothing.
 */
async function ownerRecordForWritableTask(
  db: SupabaseClient,
  viewerUserId: string,
  taskId: string,
): Promise<{ ownerUserId: string; tasks: ManagerTask[] } | null> {
  const records = await readTaskRecordsForViewer(db, viewerUserId);
  const own = records.find((r) => r.ownerUserId === viewerUserId);
  if (own?.tasks.some((task) => task.id === taskId)) return own;
  for (const record of records) {
    if (record.ownerUserId === viewerUserId) continue;
    const task = record.tasks.find((t) => t.id === taskId);
    if (task && taskAssignedTo(task, viewerUserId)) return record;
  }
  return null;
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
  const dueDate = String(body.dueDate ?? "").trim() || undefined;
  if (start && end && Date.parse(end) <= Date.parse(start)) {
    throw new Error("End time must be after start time.");
  }
  const assignee = normalizeAssignee(body.assignee) ?? undefined;
  if (!assignee) throw new Error("Assignee is required.");
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
    dueDate: start && end ? undefined : dueDate,
    durationMinutes: start && end ? durationBetween(start, end) : undefined,
    completed: false,
    assignee,
    taskType: normalizeTaskType(body.taskType) ?? "general",
    linkedTourId: typeof body.linkedTourId === "string" ? body.linkedTourId.trim() || undefined : undefined,
    linkedWorkOrderId:
      typeof body.linkedWorkOrderId === "string" ? body.linkedWorkOrderId.trim() || undefined : undefined,
    templateKey: typeof body.templateKey === "string" ? body.templateKey.trim() || undefined : undefined,
    sourceId: typeof body.sourceId === "string" ? body.sourceId.trim() || undefined : undefined,
    dedupKey: typeof body.dedupKey === "string" ? body.dedupKey.trim() || undefined : undefined,
    reminderSentAt:
      typeof body.reminderSentAt === "string" ? body.reminderSentAt.trim() || undefined : undefined,
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
  // The record may be a linked owner's, when the task was assigned to this
  // viewer — see ownerRecordForWritableTask. Everything below then edits and
  // saves THAT record, never the viewer's own.
  const record = await ownerRecordForWritableTask(db, managerUserId, taskId);
  if (!record) throw new Error("Task not found.");
  const { ownerUserId, tasks } = record;
  const current = tasks.find((row) => row.id === taskId);
  if (!current) throw new Error("Task not found.");
  // An assignee may work their own task, not reassign it away or move it to
  // another house — that stays the owner's call.
  if (ownerUserId !== managerUserId && (patch.assignee !== undefined || patch.propertyId !== undefined)) {
    throw new Error("Task not found.");
  }
  const start =
    patch.start !== undefined
      ? typeof patch.start === "string"
        ? patch.start.trim() || undefined
        : undefined
      : current.start;
  const end =
    patch.end !== undefined
      ? typeof patch.end === "string"
        ? patch.end.trim() || undefined
        : undefined
      : current.end;
  const dueDate =
    patch.dueDate !== undefined
      ? typeof patch.dueDate === "string"
        ? patch.dueDate.trim() || undefined
        : undefined
      : start && end
        ? undefined
        : current.dueDate;
  const durationMinutes =
    typeof patch.durationMinutes === "number" && Number.isFinite(patch.durationMinutes)
      ? Math.max(15, Math.round(patch.durationMinutes))
      : start && end
        ? durationBetween(start, end)
        : start
          ? current.durationMinutes
          : undefined;
  const assignee =
    patch.assignee !== undefined
      ? normalizeAssignee(patch.assignee) ?? undefined
      : current.assignee;
  if (patch.assignee !== undefined && !assignee) throw new Error("Assignee is required.");
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
    dueDate: start && end ? undefined : dueDate,
    durationMinutes,
    completed: patch.completed === true ? true : patch.completed === false ? false : current.completed,
    assignee,
    taskType:
      patch.taskType !== undefined
        ? (normalizeTaskType(patch.taskType) ?? current.taskType)
        : current.taskType,
    linkedTourId:
      typeof patch.linkedTourId === "string"
        ? patch.linkedTourId.trim() || undefined
        : current.linkedTourId,
    linkedWorkOrderId:
      typeof patch.linkedWorkOrderId === "string"
        ? patch.linkedWorkOrderId.trim() || undefined
        : current.linkedWorkOrderId,
    reminderSentAt:
      typeof patch.reminderSentAt === "string"
        ? patch.reminderSentAt.trim() || undefined
        : current.reminderSentAt,
    updatedAt: new Date().toISOString(),
  };
  const updated = tasks.map((row) => (row.id === taskId ? next : row));
  await saveManagerTasks(db, ownerUserId, updated);
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
