import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { isCategoryDeductible, WORK_ORDER_CATEGORY_TO_EXPENSE, type WorkOrderCategory } from "@/lib/reports/categories";
import { postGlExpenseEntry } from "@/lib/reports/gl-posting";

export type WorkOrderCompleteInput = {
  workOrderId: string;
  category: WorkOrderCategory;
  vendorCostCents?: number;
  materialsCostCents?: number;
  materialsMemo?: string;
  workDoneSummary?: string;
  completedAt?: string;
  propertyId?: string;
  vendorId?: string;
};

export async function createExpensesFromWorkOrder(
  db: SupabaseClient,
  managerUserId: string,
  input: WorkOrderCompleteInput,
): Promise<string[]> {
  const ids: string[] = [];
  const now = new Date().toISOString();
  const expenseDate = (input.completedAt || now).slice(0, 10);
  const laborCategory = WORK_ORDER_CATEGORY_TO_EXPENSE[input.category] ?? "maintenance";
  const memoBase = input.workDoneSummary?.trim() || `Work order ${input.workOrderId}`;

  if (input.vendorCostCents && input.vendorCostCents > 0) {
    const { data, error } = await db
      .from("manager_expense_entries")
      .insert({
        manager_user_id: managerUserId,
        property_id: input.propertyId?.trim() || null,
        category_code: laborCategory,
        amount_cents: input.vendorCostCents,
        expense_date: expenseDate,
        memo: memoBase,
        vendor_id: input.vendorId?.trim() || null,
        tax_deductible: isCategoryDeductible(laborCategory),
        source_work_order_id: input.workOrderId,
        updated_at: now,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    if (data?.id) {
      ids.push(String(data.id));
      await postGlExpenseEntry(db, {
        managerUserId,
        expenseId: String(data.id),
        categoryCode: laborCategory,
        amountCents: input.vendorCostCents,
        entryDate: expenseDate,
        propertyId: input.propertyId?.trim() || null,
        vendorId: input.vendorId?.trim() || null,
        memo: memoBase,
      });
    }
  }

  if (input.materialsCostCents && input.materialsCostCents > 0) {
    const { data, error } = await db
      .from("manager_expense_entries")
      .insert({
        manager_user_id: managerUserId,
        property_id: input.propertyId?.trim() || null,
        category_code: "materials",
        amount_cents: input.materialsCostCents,
        expense_date: expenseDate,
        memo: input.materialsMemo?.trim() || `${memoBase} — materials`,
        vendor_id: input.vendorId?.trim() || null,
        tax_deductible: isCategoryDeductible("materials"),
        source_work_order_id: input.workOrderId,
        updated_at: now,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    if (data?.id) {
      ids.push(String(data.id));
      await postGlExpenseEntry(db, {
        managerUserId,
        expenseId: String(data.id),
        categoryCode: "materials",
        amountCents: input.materialsCostCents,
        entryDate: expenseDate,
        propertyId: input.propertyId?.trim() || null,
        vendorId: input.vendorId?.trim() || null,
        memo: input.materialsMemo?.trim() || `${memoBase} — materials`,
      });
    }
  }

  return ids;
}

export function mergeWorkOrderCompletion(
  row: DemoManagerWorkOrderRow,
  input: WorkOrderCompleteInput,
  expenseEntryIds: string[],
): DemoManagerWorkOrderRow {
  return {
    ...row,
    bucket: "completed",
    status: "Completed",
    category: input.category,
    vendorCostCents: input.vendorCostCents,
    materialsCostCents: input.materialsCostCents,
    materialsMemo: input.materialsMemo,
    workDoneSummary: input.workDoneSummary,
    completedAt: input.completedAt || new Date().toISOString(),
    expenseEntryIds: [...(row.expenseEntryIds ?? []), ...expenseEntryIds],
  };
}

/** Bookkeeping-only "paid" flag — Stripe vendor payout runs separately for ACH. */
export function markWorkOrderPaid(
  row: DemoManagerWorkOrderRow,
  paidAt: string = new Date().toISOString(),
  payment?: { channel?: DemoManagerWorkOrderRow["vendorPaymentChannel"] },
): DemoManagerWorkOrderRow {
  return {
    ...row,
    automationStatus: "paid",
    paidAt,
    vendorPaymentChannel: payment?.channel ?? row.vendorPaymentChannel,
  };
}
