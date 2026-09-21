/**
 * Send-time currency for the PLAN-0915 service kinds: the row is re-read once,
 * and a reminder whose reason has gone away (someone was assigned, the vendor
 * invoiced, the invoice was decided) fails cleanly instead of sending a stale
 * fact.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReminderQueueRow } from "@/lib/reminders/queue.server";
import { reminderAnchorMatches } from "@/lib/reminders/current.server";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { VendorDocumentRecord } from "@/lib/vendor-documents";
import { hasSmsTestProvenance } from "@/lib/sms/sms-test-provenance";

async function loadWorkOrder(db: SupabaseClient, id: string, managerUserId: string) {
  const { data, error } = await db
    .from("portal_work_order_records")
    .select("manager_user_id, created_at, row_data")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data || String(data.manager_user_id ?? "") !== managerUserId) return null;
  if (hasSmsTestProvenance(data.row_data)) return null;
  return { createdAt: String(data.created_at ?? ""), row: (data.row_data ?? {}) as DemoManagerWorkOrderRow };
}

export async function serviceReminderIsCurrent(
  db: SupabaseClient,
  row: ReminderQueueRow,
  expectedAnchor: unknown,
): Promise<boolean> {
  switch (row.kind) {
    case "work_order_unassigned":
    case "work_order_unassigned_emergency": {
      const wo = await loadWorkOrder(db, row.subjectId, row.managerUserId);
      if (!wo) return false;
      const unassigned = wo.row.bucket === "open" && !wo.row.vendorId && !wo.row.vendorUserId && !wo.row.assignee && !wo.row.selfAssigned;
      return unassigned && reminderAnchorMatches(expectedAnchor, wo.createdAt);
    }
    case "work_order_no_on_my_way": {
      const wo = await loadWorkOrder(db, row.subjectId, row.managerUserId);
      if (!wo) return false;
      return wo.row.bucket === "scheduled" && !wo.row.enRouteAt && reminderAnchorMatches(expectedAnchor, wo.row.scheduledAtIso);
    }
    case "vendor_offer_expiry": {
      const { data, error } = await db
        .from("work_order_vendor_offers")
        .select("status, expires_at, manager_user_id")
        .eq("id", row.subjectId)
        .maybeSingle();
      if (error) throw error;
      if (!data || String(data.manager_user_id ?? "") !== row.managerUserId) return false;
      return data.status === "sent" && reminderAnchorMatches(expectedAnchor, data.expires_at);
    }
    case "vendor_invoice_nudge": {
      const wo = await loadWorkOrder(db, row.subjectId, row.managerUserId);
      if (!wo || wo.row.automationStatus !== "vendor_marked_done") return false;
      if (!reminderAnchorMatches(expectedAnchor, wo.row.vendorMarkedDoneAt)) return false;
      const { count } = await db
        .from("vendor_invoices")
        .select("id", { count: "exact", head: true })
        .eq("work_order_id", row.subjectId);
      return (count ?? 0) === 0;
    }
    case "invoice_approval": {
      const { data, error } = await db
        .from("vendor_invoices")
        .select("status, submitted_at, manager_user_id")
        .eq("id", row.subjectId)
        .maybeSingle();
      if (error) throw error;
      if (!data || String(data.manager_user_id ?? "") !== row.managerUserId) return false;
      return data.status === "submitted" && reminderAnchorMatches(expectedAnchor, data.submitted_at);
    }
    case "service_request_decision":
    case "service_request_unpaid": {
      const { data, error } = await db
        .from("portal_service_request_records")
        .select("manager_user_id, created_at, row_data")
        .eq("id", row.subjectId)
        .maybeSingle();
      if (error) throw error;
      if (!data || String(data.manager_user_id ?? "") !== row.managerUserId) return false;
      const request = (data.row_data ?? {}) as Record<string, unknown>;
      if (hasSmsTestProvenance(request)) return false;
      if (row.kind === "service_request_decision") {
        return request.status === "pending" && reminderAnchorMatches(expectedAnchor, request.requestedAt ?? data.created_at);
      }
      return request.status === "approved" && request.servicePaid !== true && reminderAnchorMatches(expectedAnchor, request.approvedAt);
    }
    case "vendor_document_expiry": {
      const [vendorId, kind] = row.subjectId.split(":");
      const { data, error } = await db.from("manager_vendor_records").select("manager_user_id, row_data").eq("id", vendorId).maybeSingle();
      if (error) throw error;
      if (!data || String(data.manager_user_id ?? "") !== row.managerUserId) return false;
      const documents = Array.isArray((data.row_data as { documents?: unknown })?.documents)
        ? ((data.row_data as { documents: VendorDocumentRecord[] }).documents)
        : [];
      const document = documents.find((candidate) => candidate.kind === kind);
      return Boolean(document && reminderAnchorMatches(expectedAnchor, document.expiresAt));
    }
    default:
      return true;
  }
}
