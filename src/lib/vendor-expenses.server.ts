import "server-only";

import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { isVendorExpenseCategory, type VendorExpense } from "@/lib/vendor-expenses";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

export const VENDOR_EXPENSE_SELECT =
  "id, expense_date, amount_cents, category, memo, work_order_id, receipt_path, created_at";

export type ServiceLabel = { title: string | null; propertyLabel: string | null };

function serviceLabel(rowData: unknown): ServiceLabel {
  const row = (rowData ?? {}) as { title?: unknown; propertyName?: unknown; unit?: unknown };
  const title = typeof row.title === "string" && row.title.trim() ? row.title.trim() : null;
  const property = typeof row.propertyName === "string" ? row.propertyName.trim() : "";
  const unit = typeof row.unit === "string" ? row.unit.trim() : "";
  const propertyLabel = property ? (unit && unit !== "—" ? `${property} · ${unit}` : property) : null;
  return { title, propertyLabel };
}

/**
 * A service the vendor may tie an expense to: the record must be assigned to THIS vendor
 * (`vendor_user_id`). A work-order id in a request body is a selector, never authorization.
 */
export async function findOwnService(db: Db, vendorUserId: string, workOrderId: string): Promise<ServiceLabel | null> {
  const { data, error } = await db
    .from("portal_work_order_records")
    .select("id, row_data")
    .eq("id", workOrderId)
    .eq("vendor_user_id", vendorUserId)
    .maybeSingle();
  if (error || !data) return null;
  return serviceLabel(data.row_data);
}

/** Labels for the services a batch of expenses link to — read only from this vendor's own records. */
export async function loadServiceLabels(
  db: Db,
  vendorUserId: string,
  workOrderIds: string[],
): Promise<Map<string, ServiceLabel>> {
  const labels = new Map<string, ServiceLabel>();
  const ids = [...new Set(workOrderIds.filter(Boolean))];
  if (ids.length === 0) return labels;
  const { data } = await db
    .from("portal_work_order_records")
    .select("id, row_data")
    .in("id", ids)
    .eq("vendor_user_id", vendorUserId);
  for (const row of data ?? []) labels.set(String(row.id), serviceLabel(row.row_data));
  return labels;
}

export function mapExpenseRow(row: Record<string, unknown>, labels: Map<string, ServiceLabel>): VendorExpense {
  const workOrderId = typeof row.work_order_id === "string" && row.work_order_id ? row.work_order_id : null;
  const label = workOrderId ? labels.get(workOrderId) : undefined;
  return {
    id: String(row.id),
    expenseDate: String(row.expense_date ?? "").slice(0, 10),
    amountCents: Number(row.amount_cents ?? 0),
    category: isVendorExpenseCategory(row.category) ? row.category : "other",
    memo: typeof row.memo === "string" && row.memo ? row.memo : null,
    workOrderId,
    workOrderTitle: label?.title ?? null,
    propertyLabel: label?.propertyLabel ?? null,
    hasReceipt: typeof row.receipt_path === "string" && row.receipt_path.length > 0,
    createdAt: String(row.created_at ?? ""),
  };
}

/** The vendor's expenses, newest first. Scoped on `vendor_user_id`, never on a client-supplied id. */
export async function listVendorExpenses(
  db: Db,
  vendorUserId: string,
): Promise<{ ok: true; expenses: VendorExpense[] } | { ok: false; error: string }> {
  const { data, error } = await db
    .from("vendor_expense_entries")
    .select(VENDOR_EXPENSE_SELECT)
    .eq("vendor_user_id", vendorUserId)
    .order("expense_date", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) return { ok: false, error: error.message };
  const rows = (data ?? []) as Record<string, unknown>[];
  const labels = await loadServiceLabels(
    db,
    vendorUserId,
    rows.map((row) => String(row.work_order_id ?? "")),
  );
  return { ok: true, expenses: rows.map((row) => mapExpenseRow(row, labels)) };
}
