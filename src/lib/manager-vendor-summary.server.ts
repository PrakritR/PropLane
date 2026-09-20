import "server-only";

import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { linkedOwnerScopeForModule } from "@/lib/auth/co-manager-module-scope";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

export type ManagerVendorSummaryJob = {
  id: string;
  title: string;
  propertyName: string;
  unit: string | null;
  status: string;
  acceptedQuoteCents: number | null;
  finalInvoiceCents: number | null;
  paidCents: number | null;
  residentRating: number | null;
};

export type ManagerVendorSummary = { jobs: ManagerVendorSummaryJob[]; ratingCount: number };

const centsOrNull = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
};

/** Manager-only vendor history. Every relation uses the directory row or signed-in vendor id, never contact text. */
export async function loadManagerVendorSummary(
  db: Db,
  viewerId: string,
  vendorId: string,
): Promise<{ ok: true; summary: ManagerVendorSummary } | { ok: false; status: 403 | 404 }> {
  const { data: vendorRecord } = await db
    .from("manager_vendor_records")
    .select("id, manager_user_id, vendor_user_id, row_data")
    .eq("id", vendorId)
    .maybeSingle();
  if (!vendorRecord) return { ok: false, status: 404 };

  const ownerId = String(vendorRecord.manager_user_id ?? "").trim();
  const vendorUserId = String(vendorRecord.vendor_user_id ?? "").trim() || null;
  const vendorRow = (vendorRecord.row_data ?? {}) as ManagerVendorRow;
  let scopedPropertyIds: Set<string> | null = null;
  if (ownerId !== viewerId) {
    const linked = await linkedOwnerScopeForModule(db, viewerId, "services", "read", { throwOnError: true });
    const allowed = linked.propertyIdsByOwner.get(ownerId) ?? new Set<string>();
    const vendorProperties = new Set((vendorRow.propertyIds ?? []).map(String).filter(Boolean));
    if (allowed.size === 0 || vendorProperties.size === 0 || ![...vendorProperties].some((id) => allowed.has(id))) {
      return { ok: false, status: 403 };
    }
    scopedPropertyIds = allowed;
  }

  const workQuery = db
    .from("portal_work_order_records")
    .select("id, property_id, assigned_property_id, vendor_user_id, row_data")
    .eq("manager_user_id", ownerId)
    .limit(500);
  const { data: workRecords, error: workError } = await workQuery;
  if (workError) throw workError;
  const permitted = (workRecords ?? []).filter((record) => {
    if (!scopedPropertyIds) return true;
    const propertyId = String(record.property_id ?? record.assigned_property_id ?? "").trim();
    return scopedPropertyIds.has(propertyId);
  }).filter((record) => {
    const row = (record.row_data ?? {}) as DemoManagerWorkOrderRow;
    return vendorUserId
      ? String(record.vendor_user_id ?? "") === vendorUserId
      : row.vendorId === vendorId || (row.assignee?.type === "vendor" && row.assignee.id === vendorId);
  });
  const workOrderIds = permitted.map((record) => String(record.id));
  if (workOrderIds.length === 0) return { ok: true, summary: { jobs: [], ratingCount: 0 } };

  const [bidResult, invoiceResult, payoutResult] = await Promise.all([
    vendorUserId
      ? db.from("work_order_bids").select("work_order_id, amount_cents").in("work_order_id", workOrderIds).eq("vendor_user_id", vendorUserId).eq("status", "accepted")
      : Promise.resolve({ data: [], error: null }),
    vendorUserId
      ? db.from("vendor_invoices").select("work_order_id, total_cents, status, paid_at, submitted_at, created_at").eq("manager_user_id", ownerId).eq("vendor_user_id", vendorUserId).in("work_order_id", workOrderIds).neq("status", "rejected").order("submitted_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    vendorUserId
      ? db.from("vendor_payouts").select("work_order_id, amount_cents, status").eq("manager_user_id", ownerId).eq("vendor_user_id", vendorUserId).in("work_order_id", workOrderIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (bidResult.error) throw bidResult.error;
  if (invoiceResult.error) throw invoiceResult.error;
  if (payoutResult.error) throw payoutResult.error;
  const acceptedByWorkOrder = new Map((bidResult.data ?? []).map((row) => [String(row.work_order_id), centsOrNull(row.amount_cents)]));
  const invoiceByWorkOrder = new Map<string, number | null>();
  for (const row of invoiceResult.data ?? []) invoiceByWorkOrder.set(String(row.work_order_id), centsOrNull(row.total_cents));
  const paidByWorkOrder = new Map(
    (payoutResult.data ?? []).filter((row) => row.status === "paid").map((row) => [String(row.work_order_id), centsOrNull(row.amount_cents)]),
  );
  const jobs = permitted.map((record) => {
    const row = (record.row_data ?? {}) as DemoManagerWorkOrderRow;
    const completed = row.bucket === "completed";
    const rating = completed && typeof row.residentConfirmation?.rating === "number" ? row.residentConfirmation.rating : null;
    return {
      id: String(record.id), title: row.title || "Service", propertyName: row.propertyName || "—", unit: row.unit || null,
      status: row.automationStatus || row.bucket || "—",
      acceptedQuoteCents: acceptedByWorkOrder.get(String(record.id)) ?? null,
      finalInvoiceCents: invoiceByWorkOrder.get(String(record.id)) ?? null,
      paidCents: paidByWorkOrder.get(String(record.id)) ?? null,
      residentRating: rating,
    };
  });
  return { ok: true, summary: { jobs, ratingCount: jobs.filter((job) => job.residentRating != null).length } };
}
