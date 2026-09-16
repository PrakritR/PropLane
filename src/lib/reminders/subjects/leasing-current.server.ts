/** Send-time currency for the tour and application kinds (PLAN-0915 phase 3). */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReminderQueueRow } from "@/lib/reminders/queue.server";
import { reminderAnchorMatches } from "@/lib/reminders/current.server";
import { INQUIRIES_RECORD_ID, rowsFromRecord } from "@/lib/tour-inquiry.server";
import { isActivePlannedEvent, type PlannedEvent } from "@/lib/demo-admin-scheduling";

export async function leasingReminderIsCurrent(db: SupabaseClient, row: ReminderQueueRow, expectedAnchor: unknown): Promise<boolean> {
  if (row.kind === "tour_request_unanswered" || row.kind === "tour_request_reoffer") {
    const { data, error } = await db.from("portal_schedule_records").select("row_data").eq("id", INQUIRIES_RECORD_ID).maybeSingle();
    if (error) throw error;
    const inquiry = rowsFromRecord(data?.row_data).find((candidate) => String(candidate.id ?? "") === row.subjectId);
    return Boolean(
      inquiry &&
        String(inquiry.status ?? "") === "pending" &&
        String(inquiry.managerUserId ?? "") === row.managerUserId &&
        reminderAnchorMatches(expectedAnchor, inquiry.createdAt),
    );
  }
  if (row.kind === "tour_no_show_manager") {
    const { data, error } = await db.from("portal_schedule_records").select("row_data").eq("id", "axis_admin_planned_events_v1").maybeSingle();
    if (error) throw error;
    const payload = (data?.row_data as { payload?: unknown } | null)?.payload;
    const event = (Array.isArray(payload) ? (payload as PlannedEvent[]) : []).find((candidate) => candidate.id === row.subjectId);
    return Boolean(event && isActivePlannedEvent(event) && event.managerUserId === row.managerUserId && reminderAnchorMatches(expectedAnchor, event.end ?? event.start));
  }
  if (row.kind === "application_decision_manager" || row.kind === "application_no_lease_manager") {
    const { data, error } = await db.from("manager_application_records").select("manager_user_id, created_at, updated_at, row_data").eq("id", row.subjectId).maybeSingle();
    if (error) throw error;
    if (!data || String(data.manager_user_id ?? "") !== row.managerUserId) return false;
    const app = (data.row_data ?? {}) as Record<string, unknown>;
    if (app.withdrawnAt) return false;
    if (row.kind === "application_decision_manager") {
      return String(app.bucket ?? "") === "pending" && reminderAnchorMatches(expectedAnchor, data.created_at);
    }
    if (String(app.bucket ?? "") !== "approved") return false;
    const { count } = await db.from("portal_lease_pipeline_records").select("id", { count: "exact", head: true }).eq("row_data->>axisId", row.subjectId);
    return (count ?? 0) === 0 && reminderAnchorMatches(expectedAnchor, app.approvedAt ?? data.updated_at);
  }
  if (row.kind === "message_unanswered") {
    const { unansweredMessageIsCurrent } = await import("./communication.server");
    return unansweredMessageIsCurrent(db, row.subjectId, row.managerUserId, expectedAnchor);
  }
  return true;
}
