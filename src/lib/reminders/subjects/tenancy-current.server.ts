/**
 * Send-time currency for the tenancy kinds (PLAN-0915 phase 2): the
 * application row is re-read and the date the reminder was queued against
 * must still be the date on the row.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReminderQueueRow } from "@/lib/reminders/queue.server";
import { reminderAnchorMatches } from "@/lib/reminders/current.server";
import { tenancyAnchorIso, tenancyRowFromRecord } from "@/lib/reminders/subjects/tenancy.server";
import { normalizeLeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { hasSmsTestProvenance } from "@/lib/sms/sms-test-provenance";

export async function tenancyReminderIsCurrent(db: SupabaseClient, row: ReminderQueueRow, expectedAnchor: unknown): Promise<boolean> {
  if (row.kind === "countersign_overdue" || row.kind === "renewal_offer_expiry") {
    const { data, error } = await db.from("portal_lease_pipeline_records").select("id, manager_user_id, resident_email, row_data").eq("id", row.subjectId).maybeSingle();
    if (error) throw error;
    if (!data || String(data.manager_user_id ?? "") !== row.managerUserId) return false;
    if (hasSmsTestProvenance(data.row_data)) return false;
    const lease = normalizeLeasePipelineRow(data.row_data);
    if (lease.fullySignedAt || lease.voidedAt) return false;
    if (row.kind === "countersign_overdue") {
      const managerSigned = Boolean(lease.managerSignedAt?.trim() || lease.managerSignature?.signedAtIso?.trim());
      const residentSignedAt = lease.residentSignedAt?.trim() || lease.residentSignature?.signedAtIso?.trim() || "";
      return !managerSigned && reminderAnchorMatches(expectedAnchor, residentSignedAt);
    }
    const raw = data.row_data as { pendingRenewal?: unknown };
    const currentEnd = String(lease.application?.leaseEnd ?? "").trim();
    return Boolean(raw.pendingRenewal) && reminderAnchorMatches(expectedAnchor, currentEnd.includes("T") ? currentEnd : `${currentEnd}T17:00:00`);
  }

  if (row.kind === "move_in_payment_method") {
    const { data, error } = await db.from("portal_household_charge_records").select("manager_user_id, row_data").eq("id", row.subjectId).maybeSingle();
    if (error) throw error;
    if (!data || String(data.manager_user_id ?? "") !== row.managerUserId) return false;
    const charge = (data.row_data ?? {}) as Record<string, unknown>;
    if (hasSmsTestProvenance(charge)) return false;
    const status = String(charge.status ?? "").toLowerCase();
    if (status === "paid" || status === "void" || status === "canceled") return false;
    const userId = typeof row.payload.recipientUserId === "string" ? row.payload.recipientUserId : "";
    if (userId) {
      const { data: profile } = await db.from("profiles").select("stripe_customer_id").eq("id", userId).maybeSingle();
      if (String(profile?.stripe_customer_id ?? "").trim()) return false;
    }
    return true;
  }

  const { data, error } = await db.from("manager_application_records").select("id, manager_user_id, resident_email, row_data").eq("id", row.subjectId).maybeSingle();
  if (error) throw error;
  if (!data || String(data.manager_user_id ?? "") !== row.managerUserId) return false;
  if (hasSmsTestProvenance(data.row_data)) return false;
  const tenancy = tenancyRowFromRecord({ id: String(data.id), manager_user_id: data.manager_user_id, resident_email: data.resident_email, row_data: (data.row_data ?? {}) as Record<string, unknown> });
  if (!tenancy) return false;
  const date =
    row.kind === "move_in" ? tenancy.moveIn
    : row.kind === "lease_ending" || row.kind === "lease_ending_manager" ? tenancy.leaseEnd
    : row.kind === "move_out" || row.kind === "move_out_inspection_manager" ? tenancy.moveOut
    : null;
  if (row.kind === "deposit_accounting") {
    // The deadline moves with the move-out date; a changed date re-queues under a new anchor.
    if (!tenancy.moveOut) return false;
    const expectedMs = Date.parse(String(expectedAnchor ?? ""));
    const moveOutMs = Date.parse(tenancyAnchorIso(tenancy.moveOut));
    return Number.isFinite(expectedMs) && Number.isFinite(moveOutMs) && expectedMs > moveOutMs;
  }
  return Boolean(date && reminderAnchorMatches(expectedAnchor, tenancyAnchorIso(date)));
}
