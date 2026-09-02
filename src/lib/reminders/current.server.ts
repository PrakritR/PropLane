import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReminderQueueRow } from "@/lib/reminders/queue.server";

function iso(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function reminderAnchorMatches(expected: unknown, current: unknown): boolean {
  const left = iso(expected);
  const right = iso(current);
  return Boolean(left && right && left === right);
}

/** Re-read only at send time so cancelled/completed/rescheduled subjects never emit stale facts. */
export async function reminderIsCurrent(db: SupabaseClient, row: ReminderQueueRow): Promise<boolean> {
  const expectedAnchor = row.payload.anchorIso;
  // Backward compatibility for rows created before anchor snapshots shipped.
  if (!iso(expectedAnchor)) return true;

  if (row.kind === "tour") {
    const { data, error } = await db
      .from("portal_schedule_records")
      .select("row_data")
      .eq("id", "axis_admin_planned_events_v1")
      .maybeSingle();
    if (error) throw error;
    const payload = (data?.row_data as { payload?: unknown } | null)?.payload;
    const event = (Array.isArray(payload) ? payload : []).find(
      (candidate) =>
        candidate &&
        typeof candidate === "object" &&
        String((candidate as Record<string, unknown>).id ?? "") === row.subjectId,
    ) as Record<string, unknown> | undefined;
    return Boolean(
      event &&
        !String(event.canceledAt ?? "").trim() &&
        String(event.managerUserId ?? "").trim() === row.managerUserId &&
        reminderAnchorMatches(expectedAnchor, event.start),
    );
  }

  if (row.kind === "task") {
    const { data, error } = await db
      .from("portal_schedule_records")
      .select("row_data")
      .eq("manager_user_id", row.managerUserId)
      .eq("record_type", "manager_tasks")
      .maybeSingle();
    if (error) throw error;
    const tasks = (data?.row_data as { tasks?: unknown } | null)?.tasks;
    const task = (Array.isArray(tasks) ? tasks : []).find(
      (candidate) =>
        candidate &&
        typeof candidate === "object" &&
        String((candidate as Record<string, unknown>).id ?? "") === row.subjectId,
    ) as Record<string, unknown> | undefined;
    return Boolean(
      task &&
        task.completed !== true &&
        reminderAnchorMatches(expectedAnchor, task.start ?? task.dueDate),
    );
  }

  const table = row.kind === "work_order" ? "portal_work_order_records" : "portal_service_request_records";
  const { data, error } = await db
    .from(table)
    .select("manager_user_id, row_data")
    .eq("id", row.subjectId)
    .maybeSingle();
  if (error) throw error;
  if (!data || String(data.manager_user_id ?? "") !== row.managerUserId) return false;
  const subject = (data.row_data ?? {}) as Record<string, unknown>;
  if (row.kind === "work_order") {
    if (subject.bucket === "completed" || subject.status === "Completed") return false;
    return reminderAnchorMatches(expectedAnchor, subject.scheduledAtIso);
  }
  if (subject.status !== "approved") return false;
  return reminderAnchorMatches(expectedAnchor, subject.returnByDate);
}
