import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  managerKindAvailabilityStorageKey,
  type ManagerKindAvailabilityKind,
} from "@/lib/manager-availability-kinds";
import { managerTasksStorageKey } from "@/lib/manager-tasks";
import {
  suggestManagerTime,
  type ScheduleSuggestion,
  type SuggestBusyWindow,
} from "@/lib/manager-schedule-suggest";
import { googleBusyBlocks } from "@/lib/tour-availability.server";
import { isActivePlannedTourEvent, rowPayload, windowsFromPayload, type TourBlock } from "@/lib/tour-slot-math";

/** The two non-tour scheduling flows this suggestion engine serves. Tours have
 * their own availability grid and are never suggested here. */
export type ManagerSuggestKind = ManagerKindAvailabilityKind;

function toBusyWindow(block: TourBlock): SuggestBusyWindow {
  return { startIso: block.start, endIso: block.end };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function textField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value.trim() : "";
}

/** A manager's painted services/tasks availability slot keys — `[]` when nothing is painted yet. */
async function loadAvailabilitySlotKeys(
  db: SupabaseClient,
  managerUserId: string,
  kind: ManagerSuggestKind,
): Promise<string[]> {
  const { data } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("id", managerKindAvailabilityStorageKey(managerUserId, kind))
    .maybeSingle();
  const rowData = data?.row_data;
  const payload = asObject(rowData)?.payload;
  return Array.isArray(payload) ? payload.filter((item): item is string => typeof item === "string") : [];
}

/** This manager's scheduled tasks (both start and end set) as busy windows. */
async function loadTaskBusyWindows(db: SupabaseClient, managerUserId: string): Promise<SuggestBusyWindow[]> {
  const { data } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("id", managerTasksStorageKey(managerUserId))
    .maybeSingle();
  const rowData = data?.row_data as Record<string, unknown> | null | undefined;
  const tasks = Array.isArray(rowData?.tasks) ? rowData.tasks : [];
  const windows: SuggestBusyWindow[] = [];
  for (const raw of tasks) {
    const task = asObject(raw);
    if (!task) continue;
    const start = textField(task, "start");
    const end = textField(task, "end");
    if (!start || !end) continue;
    windows.push({ startIso: start, endIso: end });
  }
  return windows;
}

/** Pending tour inquiries and active planned tour events for this manager, the
 * same reads the public tour-availability route uses to keep the same half
 * hour from being offered twice. */
async function loadTourBusyWindows(db: SupabaseClient, managerUserId: string): Promise<SuggestBusyWindow[]> {
  const windows: SuggestBusyWindow[] = [];

  const { data: pendingRows } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("record_type", "partner_inquiry_request")
    .eq("manager_user_id", managerUserId);
  for (const pending of pendingRows ?? []) {
    const payload = rowPayload((pending as { row_data: unknown }).row_data);
    if (!payload) continue;
    if (textField(payload, "status").toLowerCase() !== "pending") continue;
    for (const block of windowsFromPayload(payload)) windows.push(toBusyWindow(block));
  }

  const { data: plannedRow } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("id", "axis_admin_planned_events_v1")
    .maybeSingle();
  const plannedPayload = asObject(plannedRow?.row_data)?.payload;
  const plannedEvents = Array.isArray(plannedPayload) ? plannedPayload.map(asObject).filter(Boolean) : [];
  for (const event of plannedEvents as Record<string, unknown>[]) {
    if (textField(event, "kind") !== "tour") continue;
    if (!isActivePlannedTourEvent(event)) continue;
    const managerUserIdOnEvent = textField(event, "managerUserId");
    if (managerUserIdOnEvent !== managerUserId) continue;
    const start = textField(event, "start");
    const end = textField(event, "end");
    if (!start || !end) continue;
    windows.push({ startIso: start, endIso: end });
  }

  return windows;
}

/** Every window this manager is already committed to: scheduled services,
 * tasks, pending/planned tours, and their linked Google Calendar. Union of all
 * four, so a suggestion in any flow never lands on top of another. */
export async function loadManagerBusyWindows(
  db: SupabaseClient,
  managerUserId: string,
  opts: { excludeWorkOrderId?: string; horizonDays?: number } = {},
): Promise<SuggestBusyWindow[]> {
  const { excludeWorkOrderId, horizonDays = 60 } = opts;

  let workOrderQuery = db
    .from("portal_work_order_records")
    .select("id, row_data")
    .eq("manager_user_id", managerUserId);
  if (excludeWorkOrderId) workOrderQuery = workOrderQuery.neq("id", excludeWorkOrderId);

  const now = new Date();
  const nowIso = now.toISOString();
  const horizonIso = new Date(now.getTime() + horizonDays * 24 * 60 * 60 * 1000).toISOString();

  const [{ data: workOrderRows }, taskWindows, tourWindows, googleBlocks] = await Promise.all([
    workOrderQuery,
    loadTaskBusyWindows(db, managerUserId),
    loadTourBusyWindows(db, managerUserId),
    googleBusyBlocks(db, managerUserId, nowIso, horizonIso),
  ]);

  const workOrderWindows: SuggestBusyWindow[] = (workOrderRows ?? [])
    .map((row) => row.row_data as { scheduledAtIso?: string; bucket?: string; durationMinutes?: unknown })
    .filter((row) => row?.scheduledAtIso && row.bucket !== "completed")
    .map((row) => {
      const start = new Date(row.scheduledAtIso as string);
      const durationMinutes = typeof row.durationMinutes === "number" && Number.isFinite(row.durationMinutes) ? row.durationMinutes : 60;
      return { startIso: start.toISOString(), endIso: new Date(start.getTime() + durationMinutes * 60_000).toISOString() };
    });

  return [...workOrderWindows, ...taskWindows, ...tourWindows, ...googleBlocks.map(toBusyWindow)];
}

/** The one time-suggestion entry point for the services and tasks scheduling
 * flows: loads this manager's painted availability and every busy window, then
 * hands off to {@link suggestManagerTime} for the actual pick. */
export async function suggestManagerTimeForKind(
  db: SupabaseClient,
  managerUserId: string,
  input: {
    kind: ManagerSuggestKind;
    durationMinutes?: number;
    seed: string;
    after?: string | null;
    excludeWorkOrderId?: string;
    now?: Date;
  },
): Promise<ScheduleSuggestion | null> {
  const { kind, durationMinutes, seed, after, excludeWorkOrderId, now } = input;

  const [availabilitySlotKeys, busy] = await Promise.all([
    loadAvailabilitySlotKeys(db, managerUserId, kind),
    loadManagerBusyWindows(db, managerUserId, { excludeWorkOrderId }),
  ]);

  return suggestManagerTime({
    availabilitySlotKeys,
    busy,
    durationMinutes,
    seed,
    after,
    now,
  });
}
