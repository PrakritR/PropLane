import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReminderQueueRow } from "@/lib/reminders/queue.server";
import type { ReminderSubjectKind } from "@/lib/reminders/rules";
import { hasSmsTestProvenance } from "@/lib/sms/sms-test-provenance";

/** Kinds whose currency lives in `subjects/leasing-current.server.ts`. */
const LEASING_KINDS: ReadonlySet<ReminderSubjectKind> = new Set<ReminderSubjectKind>([
  "tour_request_unanswered",
  "tour_request_reoffer",
  "tour_no_show_manager",
  "application_decision_manager",
  "application_no_lease_manager",
  "message_unanswered",
]);

/** Kinds whose currency lives in `subjects/tenancy-current.server.ts`. */
const TENANCY_KINDS: ReadonlySet<ReminderSubjectKind> = new Set<ReminderSubjectKind>([
  "move_in",
  "move_in_payment_method",
  "lease_ending",
  "lease_ending_manager",
  "move_out",
  "move_out_inspection_manager",
  "deposit_accounting",
  "countersign_overdue",
  "renewal_offer_expiry",
]);

/** Kinds whose currency lives in `subjects/services-current.server.ts`. */
const SERVICE_KINDS: ReadonlySet<ReminderSubjectKind> = new Set<ReminderSubjectKind>([
  "work_order_unassigned",
  "work_order_unassigned_emergency",
  "work_order_no_on_my_way",
  "vendor_offer_expiry",
  "vendor_invoice_nudge",
  "invoice_approval",
  "service_request_decision",
  "service_request_unpaid",
  "vendor_document_expiry",
]);

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
  if (row.kind === "tour_interest") {
    const { tourInterestIsCurrent } = await import("./subjects/tour-interest.server");
    return tourInterestIsCurrent(db, row);
  }
  if (row.kind === "inspection" || row.kind === "inspection_manager") {
    const { inspectionReminderIsCurrent } = await import("./subjects/inspections.server");
    return inspectionReminderIsCurrent(db, row);
  }
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
        !hasSmsTestProvenance(event) &&
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
        !hasSmsTestProvenance(task) &&
        task.completed !== true &&
        reminderAnchorMatches(expectedAnchor, task.start ?? task.dueDate),
    );
  }

  if (row.kind === "application" || row.kind === "application_manager") {
    return applicationIsCurrent(db, row, expectedAnchor);
  }

  if (row.kind === "application_post_tour") {
    return postTourReminderIsCurrent(db, row, expectedAnchor);
  }

  if (row.kind === "lease" || row.kind === "lease_manager") {
    return leaseIsCurrent(db, row, expectedAnchor);
  }

  if (row.kind === "payment_manager" || row.kind === "delinquency_manager") {
    return paymentManagerReminderIsCurrent(db, row, expectedAnchor);
  }

  if (row.kind === "outgoing_payment") {
    return outgoingPaymentIsCurrent(db, row, expectedAnchor);
  }

  if (row.kind === "task_overdue") {
    const { data, error } = await db.from("portal_schedule_records").select("row_data").eq("manager_user_id", row.managerUserId).eq("record_type", "manager_tasks").maybeSingle();
    if (error) throw error;
    const tasks = (data?.row_data as { tasks?: unknown } | null)?.tasks;
    const task = (Array.isArray(tasks) ? tasks : []).find((candidate) => candidate && typeof candidate === "object" && String((candidate as Record<string, unknown>).id ?? "") === row.subjectId) as Record<string, unknown> | undefined;
    return Boolean(task && !hasSmsTestProvenance(task) && task.completed !== true && reminderAnchorMatches(expectedAnchor, task.start ?? task.dueDate));
  }
  if (row.kind === "document_signature") {
    const { data, error } = await db.from("manager_documents").select("manager_user_id, signature_status, signature_requested_at, deleted_at").eq("id", row.subjectId).maybeSingle();
    if (error) throw error;
    return Boolean(data && String(data.manager_user_id ?? "") === row.managerUserId && data.signature_status === "pending" && !data.deleted_at && reminderAnchorMatches(expectedAnchor, data.signature_requested_at));
  }
  if (row.kind === "resident_welcome") return true;

  if (LEASING_KINDS.has(row.kind)) {
    const { leasingReminderIsCurrent } = await import("./subjects/leasing-current.server");
    return leasingReminderIsCurrent(db, row, expectedAnchor);
  }

  if (TENANCY_KINDS.has(row.kind)) {
    const { tenancyReminderIsCurrent } = await import("./subjects/tenancy-current.server");
    return tenancyReminderIsCurrent(db, row, expectedAnchor);
  }

  if (SERVICE_KINDS.has(row.kind)) {
    const { serviceReminderIsCurrent } = await import("./subjects/services-current.server");
    return serviceReminderIsCurrent(db, row, expectedAnchor);
  }

  if (row.kind !== "work_order" && row.kind !== "service_order") return true;

  const table = row.kind === "work_order" ? "portal_work_order_records" : "portal_service_request_records";
  const { data, error } = await db
    .from(table)
    .select("manager_user_id, row_data")
    .eq("id", row.subjectId)
    .maybeSingle();
  if (error) throw error;
  if (!data || String(data.manager_user_id ?? "") !== row.managerUserId) return false;
  const subject = (data.row_data ?? {}) as Record<string, unknown>;
  if (hasSmsTestProvenance(subject)) return false;
  if (row.kind === "work_order") {
    if (subject.bucket === "completed" || subject.status === "Completed") return false;
    return reminderAnchorMatches(expectedAnchor, subject.scheduledAtIso);
  }
  if (subject.status !== "approved") return false;
  return reminderAnchorMatches(expectedAnchor, subject.returnByDate);
}

async function applicationIsCurrent(
  db: SupabaseClient,
  row: ReminderQueueRow,
  expectedAnchor: unknown,
): Promise<boolean> {
  const { data, error } = await db
    .from("manager_application_records")
    .select("id, manager_user_id, resident_email, row_data, created_at, updated_at")
    .eq("id", row.subjectId)
    .maybeSingle();
  if (error) throw error;
  if (!data || String(data.manager_user_id ?? "") !== row.managerUserId) return false;
  if (hasSmsTestProvenance(data.row_data)) return false;
  const appRow = {
    ...(data.row_data as Record<string, unknown>),
    id: data.id,
    managerUserId: data.manager_user_id,
    email: (data.row_data as { email?: string }).email ?? data.resident_email,
  } as import("@/data/demo-portal").DemoApplicantRow;
  const { shouldOfferApplicationCompletionReminder } = await import(
    "@/lib/rental-application/in-progress-application"
  );
  if (!shouldOfferApplicationCompletionReminder(appRow)) return false;
  const anchor = data.created_at ?? data.updated_at;
  return reminderAnchorMatches(expectedAnchor, anchor);
}

async function postTourReminderIsCurrent(
  db: SupabaseClient,
  row: ReminderQueueRow,
  expectedAnchor: unknown,
): Promise<boolean> {
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
  if (!event || hasSmsTestProvenance(event) || String(event.canceledAt ?? "").trim()) return false;
  if (String(event.managerUserId ?? "").trim() !== row.managerUserId) return false;
  const endIso = String(event.end ?? event.start ?? "");
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(endMs) || endMs > Date.now()) return false;
  return reminderAnchorMatches(expectedAnchor, endIso);
}

async function leaseIsCurrent(
  db: SupabaseClient,
  row: ReminderQueueRow,
  expectedAnchor: unknown,
): Promise<boolean> {
  const { data, error } = await db
    .from("portal_lease_pipeline_records")
    .select("id, manager_user_id, row_data")
    .eq("id", row.subjectId)
    .maybeSingle();
  if (error) throw error;
  if (!data || String(data.manager_user_id ?? "") !== row.managerUserId) return false;
  if (hasSmsTestProvenance(data.row_data)) return false;
  const { normalizeLeasePipelineRow } = await import("@/lib/lease-pipeline-storage");
  const lease = normalizeLeasePipelineRow(data.row_data);
  if (lease.status === "Fully Signed" || lease.status === "Voided") return false;

  if (row.kind === "lease_manager") {
    if (lease.status === "Resident Signature Pending" || lease.bucket === "resident") {
      return reminderAnchorMatches(expectedAnchor, lease.sentToResidentAt ?? lease.updatedAtIso);
    }
    if (lease.status === "Manager Review" || lease.status === "Draft") {
      return reminderAnchorMatches(expectedAnchor, lease.updatedAtIso ?? lease.sentToResidentAt);
    }
    return false;
  }

  if (row.recipientRole === "counterparty") {
    if (lease.status !== "Resident Signature Pending" && lease.bucket !== "resident") return false;
    return reminderAnchorMatches(expectedAnchor, lease.sentToResidentAt ?? lease.updatedAtIso);
  }
  if (lease.status !== "Manager Review" && lease.status !== "Draft") return false;
  return reminderAnchorMatches(expectedAnchor, lease.updatedAtIso);
}

async function outgoingPaymentIsCurrent(
  db: SupabaseClient,
  row: ReminderQueueRow,
  expectedAnchor: unknown,
): Promise<boolean> {
  const { data, error } = await db
    .from("manager_bills")
    .select("manager_user_id, due_date, status, sms_test_session_id")
    .eq("id", row.subjectId)
    .maybeSingle();
  if (error) throw error;
  if (!data || String(data.manager_user_id ?? "") !== row.managerUserId) return false;
  if (data.sms_test_session_id) return false;
  const status = String(data.status ?? "");
  if (status === "paid" || status === "void") return false;
  const dueDate = data.due_date ? String(data.due_date).slice(0, 10) : "";
  if (!dueDate) return false;
  const anchorIso = new Date(`${dueDate}T12:00:00`).toISOString();
  return reminderAnchorMatches(expectedAnchor, anchorIso);
}

async function paymentManagerReminderIsCurrent(
  db: SupabaseClient,
  row: ReminderQueueRow,
  expectedAnchor: unknown,
): Promise<boolean> {
  const { data, error } = await db
    .from("portal_household_charge_records")
    .select("manager_user_id, row_data")
    .eq("id", row.subjectId)
    .maybeSingle();
  if (error) throw error;
  if (!data || String(data.manager_user_id ?? "") !== row.managerUserId) return false;
  const charge = (data.row_data ?? {}) as Record<string, unknown>;
  if (hasSmsTestProvenance(charge)) return false;
  const status = String(charge.status ?? "").toLowerCase();
  if (status === "paid" || status === "void" || status === "canceled") return false;
  const dueIso = String(charge.dueDateIso ?? charge.dueDate ?? "");
  if (!dueIso.trim()) return false;
  const anchorIso = dueIso.includes("T") ? dueIso : new Date(`${dueIso.slice(0, 10)}T12:00:00`).toISOString();
  return reminderAnchorMatches(expectedAnchor, anchorIso);
}
