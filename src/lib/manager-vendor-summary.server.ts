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
  /** Bounded newest-first list for the profile UI; totals below cover the full authorized history. */
  jobs: ManagerVendorSummaryJob[];
  totalJobCount: number;
  ratingCount: number;
  ratingAverage: number | null;
  completedJobCount: number;
  completedInvoiceTotalCents: number | null;
  completedInvoiceAverageCents: number | null;
};

const WORK_PAGE_SIZE = 500;
const RELATION_PAGE_SIZE = 500;
const WORK_ORDER_ID_BATCH_SIZE = 200;
const RECENT_JOB_LIMIT = 100;

const centsOrNull = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
};

function recordTime(row: { submitted_at?: unknown; created_at?: unknown; id?: unknown }): string {
  return String(row.submitted_at ?? row.created_at ?? "");
}

async function fetchAllPages<T>(
  loadPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  pageSize: number,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const result = await loadPage(from, from + pageSize - 1);
    if (result.error) throw result.error;
    const page = result.data ?? [];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size) result.push(items.slice(start, start + size));
  return result;
}

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
  let servicePropertyIds: Set<string> | null = null;
  let financialPropertyIds: Set<string> | null = null;
  if (ownerId !== viewerId) {
    const [serviceScope, financialScope] = await Promise.all([
      linkedOwnerScopeForModule(db, viewerId, "services", "read", { throwOnError: true }),
      linkedOwnerScopeForModule(db, viewerId, "financials", "read", { throwOnError: true }),
    ]);
    const allowedServices = serviceScope.propertyIdsByOwner.get(ownerId) ?? new Set<string>();
    if (allowedServices.size === 0) {
      return { ok: false, status: 403 };
    }
    servicePropertyIds = allowedServices;
    financialPropertyIds = financialScope.propertyIdsByOwner.get(ownerId) ?? new Set<string>();
  }

  const workSelect = "id, property_id, assigned_property_id, vendor_user_id, row_data, updated_at";
  const propertyColumns = servicePropertyIds ? (["property_id", "assigned_property_id"] as const) : [null] as const;
  const fetchWorkRows = async (legacyAssignment: "vendorId" | "assignee" | null) => {
    const responses = await Promise.all(propertyColumns.map((propertyColumn) =>
      fetchAllPages((from, to) => {
        let query = db.from("portal_work_order_records").select(workSelect).eq("manager_user_id", ownerId);
        if (vendorUserId) query = query.eq("vendor_user_id", vendorUserId);
        else if (legacyAssignment === "vendorId") query = query.contains("row_data", { vendorId });
        else query = query.contains("row_data", { assignee: { id: vendorId } });
        if (propertyColumn && servicePropertyIds) query = query.in(propertyColumn, [...servicePropertyIds]);
        return query.order("updated_at", { ascending: false }).order("id", { ascending: false }).range(from, to);
      }, WORK_PAGE_SIZE),
    ));
    return responses.flat();
  };
  const queriedRows = vendorUserId
    ? await fetchWorkRows(null)
    : [...await fetchWorkRows("vendorId"), ...await fetchWorkRows("assignee")];
  const workRecords = [...new Map(queriedRows.map((record) => [String(record.id), record])).values()]
    .sort((left, right) => String(right.updated_at ?? "").localeCompare(String(left.updated_at ?? "")) || String(right.id).localeCompare(String(left.id)));
  const permitted = workRecords.filter((record) => {
    if (!servicePropertyIds) return true;
    const propertyId = String(record.property_id ?? "").trim();
    const assignedPropertyId = String(record.assigned_property_id ?? "").trim();
    return servicePropertyIds.has(propertyId) || servicePropertyIds.has(assignedPropertyId);
  }).filter((record) => {
    const row = (record.row_data ?? {}) as DemoManagerWorkOrderRow;
    return vendorUserId
      ? String(record.vendor_user_id ?? "") === vendorUserId
      : row.vendorId === vendorId || (row.assignee?.type === "vendor" && row.assignee.id === vendorId);
  });
  const workOrderIds = permitted.map((record) => String(record.id));
  if (workOrderIds.length === 0) return { ok: true, summary: { jobs: [], totalJobCount: 0, ratingCount: 0, ratingAverage: null, completedJobCount: 0, completedInvoiceTotalCents: null, completedInvoiceAverageCents: null } };

  const financialWorkOrderIds = permitted
    .filter((record) => {
      if (!financialPropertyIds) return true;
      const propertyId = String(record.property_id ?? "").trim();
      const assignedPropertyId = String(record.assigned_property_id ?? "").trim();
      return financialPropertyIds.has(propertyId) || financialPropertyIds.has(assignedPropertyId);
    })
    .map((record) => String(record.id));

  const fetchRelations = async <T>(
    ids: readonly string[],
    load: (batch: string[], from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  ) => (await Promise.all(chunks(ids, WORK_ORDER_ID_BATCH_SIZE).map((batch) => fetchAllPages(
    (from, to) => load(batch, from, to),
    RELATION_PAGE_SIZE,
  )))).flat();

  const [bids, invoices, payouts] = await Promise.all([
    vendorUserId
      ? fetchRelations(workOrderIds, (batch, from, to) => db.from("work_order_bids").select("id, work_order_id, amount_cents").in("work_order_id", batch).eq("vendor_user_id", vendorUserId).eq("status", "accepted").order("id", { ascending: true }).range(from, to))
      : Promise.resolve([]),
    vendorUserId
      ? fetchRelations(financialWorkOrderIds, (batch, from, to) => db.from("vendor_invoices").select("id, work_order_id, total_cents, status, paid_at, submitted_at, created_at").eq("manager_user_id", ownerId).eq("vendor_user_id", vendorUserId).in("work_order_id", batch).in("status", ["submitted", "approved", "scheduled", "paid"]).order("submitted_at", { ascending: false }).order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, to))
      : Promise.resolve([]),
    vendorUserId
      ? fetchRelations(financialWorkOrderIds, (batch, from, to) => db.from("vendor_payouts").select("id, work_order_id, amount_cents, status").eq("manager_user_id", ownerId).eq("vendor_user_id", vendorUserId).in("work_order_id", batch).order("id", { ascending: true }).range(from, to))
      : Promise.resolve([]),
  ]);
  const acceptedByWorkOrder = new Map<string, number | null>();
  for (const bid of bids) {
    const workOrderId = String(bid.work_order_id);
    if (!acceptedByWorkOrder.has(workOrderId)) acceptedByWorkOrder.set(workOrderId, centsOrNull(bid.amount_cents));
  }
  const invoiceByWorkOrder = new Map<string, number | null>();
  for (const row of invoices.sort((left, right) => recordTime(right).localeCompare(recordTime(left)) || String(right.id ?? "").localeCompare(String(left.id ?? "")))) {
    const workOrderId = String(row.work_order_id);
    if (!invoiceByWorkOrder.has(workOrderId)) invoiceByWorkOrder.set(workOrderId, centsOrNull(row.total_cents));
  }
  const paidByWorkOrder = new Map<string, number | null>();
  for (const payout of payouts) {
    if (payout.status !== "paid") continue;
    const workOrderId = String(payout.work_order_id);
    if (!paidByWorkOrder.has(workOrderId)) paidByWorkOrder.set(workOrderId, centsOrNull(payout.amount_cents));
  }
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
  const ratings = jobs.map((job) => job.residentRating).filter((rating): rating is number => rating !== null);
  const completedInvoices = completedJobs.map((job) => job.finalInvoiceCents).filter((value): value is number => value !== null);
  const completedInvoiceTotalCents = completedInvoices.length ? completedInvoices.reduce((sum, value) => sum + value, 0) : null;
  return {
    ok: true,
    summary: {
      jobs: jobs.slice(0, RECENT_JOB_LIMIT),
      totalJobCount: jobs.length,
      ratingCount: ratings.length,
      ratingAverage: ratings.length ? Math.round((ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length) * 10) / 10 : null,
      completedJobCount: completedJobs.length,
      completedInvoiceTotalCents,
      completedInvoiceAverageCents: completedInvoiceTotalCents === null ? null : Math.round(completedInvoiceTotalCents / completedInvoices.length),
    },
  };
}
