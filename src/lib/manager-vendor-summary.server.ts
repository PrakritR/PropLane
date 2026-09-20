import "server-only";

import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { linkedOwnerScopeForModule } from "@/lib/auth/co-manager-module-scope";
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

export type ManagerVendorSummary = {
  jobs: ManagerVendorSummaryJob[];
  ratingCount: number;
  completedJobCount: number;
  completedInvoiceTotalCents: number | null;
  completedInvoiceAverageCents: number | null;
};

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
  const { data: vendorRecord, error: vendorError } = await db
    .from("manager_vendor_records")
    .select("id, manager_user_id, vendor_user_id, row_data")
    .eq("id", vendorId)
    .maybeSingle();
  if (vendorError) throw vendorError;
  if (!vendorRecord) return { ok: false, status: 404 };

  const ownerId = String(vendorRecord.manager_user_id ?? "").trim();
  const vendorUserId = String(vendorRecord.vendor_user_id ?? "").trim() || null;
  if (!ownerId) return { ok: false, status: 404 };
  let scopedPropertyIds: Set<string> | null = null;
  if (ownerId !== viewerId) {
    const linked = await linkedOwnerScopeForModule(db, viewerId, "services", "read", { throwOnError: true });
    const allowed = linked.propertyIdsByOwner.get(ownerId) ?? new Set<string>();
    if (allowed.size === 0) {
      return { ok: false, status: 403 };
    }
    scopedPropertyIds = allowed;
  }

  const workSelect = "id, property_id, assigned_property_id, vendor_user_id, row_data, updated_at";
  const propertyColumns = scopedPropertyIds ? (["property_id", "assigned_property_id"] as const) : [null] as const;
  const fetchWorkRows = async (legacyAssignment: "vendorId" | "assignee" | null) => {
    const responses = await Promise.all(propertyColumns.map((propertyColumn) => {
      let query = db.from("portal_work_order_records").select(workSelect).eq("manager_user_id", ownerId);
      if (vendorUserId) query = query.eq("vendor_user_id", vendorUserId);
      else if (legacyAssignment === "vendorId") query = query.contains("row_data", { vendorId });
      else query = query.contains("row_data", { assignee: { id: vendorId } });
      if (propertyColumn && scopedPropertyIds) query = query.in(propertyColumn, [...scopedPropertyIds]);
      return query.order("updated_at", { ascending: false }).limit(500);
    }));
    for (const response of responses) if (response.error) throw response.error;
    return responses.flatMap((response) => response.data ?? []);
  };
  const queriedRows = vendorUserId
    ? await fetchWorkRows(null)
    : [...await fetchWorkRows("vendorId"), ...await fetchWorkRows("assignee")];
  const workRecords = [...new Map(queriedRows.map((record) => [String(record.id), record])).values()]
    .sort((left, right) => String(right.updated_at ?? "").localeCompare(String(left.updated_at ?? "")) || String(left.id).localeCompare(String(right.id)))
    .slice(0, 500);
  const permitted = workRecords.filter((record) => {
    if (!scopedPropertyIds) return true;
    const propertyId = String(record.property_id ?? "").trim();
    const assignedPropertyId = String(record.assigned_property_id ?? "").trim();
    return scopedPropertyIds.has(propertyId) || scopedPropertyIds.has(assignedPropertyId);
  }).filter((record) => {
    const row = (record.row_data ?? {}) as DemoManagerWorkOrderRow;
    return vendorUserId
      ? String(record.vendor_user_id ?? "") === vendorUserId
      : row.vendorId === vendorId || (row.assignee?.type === "vendor" && row.assignee.id === vendorId);
  });
  const workOrderIds = permitted.map((record) => String(record.id));
  if (workOrderIds.length === 0) return { ok: true, summary: { jobs: [], ratingCount: 0, completedJobCount: 0, completedInvoiceTotalCents: null, completedInvoiceAverageCents: null } };

  const [bidResult, invoiceResult, payoutResult] = await Promise.all([
    vendorUserId
      ? db.from("work_order_bids").select("work_order_id, amount_cents").in("work_order_id", workOrderIds).eq("vendor_user_id", vendorUserId).eq("status", "accepted")
      : Promise.resolve({ data: [], error: null }),
    vendorUserId
      ? db.from("vendor_invoices").select("work_order_id, total_cents, status, paid_at, submitted_at, created_at").eq("manager_user_id", ownerId).eq("vendor_user_id", vendorUserId).in("work_order_id", workOrderIds).in("status", ["submitted", "approved", "scheduled", "paid"]).order("submitted_at", { ascending: false }).order("created_at", { ascending: false })
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
  for (const row of invoiceResult.data ?? []) {
    const workOrderId = String(row.work_order_id);
    if (!invoiceByWorkOrder.has(workOrderId)) invoiceByWorkOrder.set(workOrderId, centsOrNull(row.total_cents));
  }
  const paidByWorkOrder = new Map(
    (payoutResult.data ?? []).filter((row) => row.status === "paid").map((row) => [String(row.work_order_id), centsOrNull(row.amount_cents)]),
  );
  const jobs = permitted.map((record) => {
    const row = (record.row_data ?? {}) as DemoManagerWorkOrderRow;
    const completed = row.bucket === "completed";
    const rawRating = row.residentConfirmation?.rating;
    const rating = completed && typeof rawRating === "number" && Number.isInteger(rawRating) && rawRating >= 1 && rawRating <= 5 ? rawRating : null;
    return {
      id: String(record.id), title: row.title || "Service", propertyName: row.propertyName || "—", unit: row.unit || null,
      status: row.automationStatus || row.bucket || "—",
      acceptedQuoteCents: acceptedByWorkOrder.get(String(record.id)) ?? null,
      finalInvoiceCents: invoiceByWorkOrder.get(String(record.id)) ?? null,
      paidCents: paidByWorkOrder.get(String(record.id)) ?? null,
      residentRating: rating,
    };
  });
  const completedJobIds = new Set(
    permitted.filter((record) => (record.row_data as DemoManagerWorkOrderRow | null)?.bucket === "completed").map((record) => String(record.id)),
  );
  const completedJobs = jobs.filter((job) => completedJobIds.has(job.id));
  const completedInvoices = completedJobs.map((job) => job.finalInvoiceCents).filter((value): value is number => value !== null);
  const completedInvoiceTotalCents = completedInvoices.length ? completedInvoices.reduce((sum, value) => sum + value, 0) : null;
  return {
    ok: true,
    summary: {
      jobs,
      ratingCount: jobs.filter((job) => job.residentRating != null).length,
      completedJobCount: completedJobs.length,
      completedInvoiceTotalCents,
      completedInvoiceAverageCents: completedInvoiceTotalCents === null ? null : Math.round(completedInvoiceTotalCents / completedInvoices.length),
    },
  };
}
