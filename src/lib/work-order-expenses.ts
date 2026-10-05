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
  const expenseDate = (input.completedAt || new Date().toISOString()).slice(0, 10);
  const laborCategory = WORK_ORDER_CATEGORY_TO_EXPENSE[input.category] ?? "maintenance";
  const memoBase = input.workDoneSummary?.trim() || `Work order ${input.workOrderId}`;

  const ensureComponent = async (component: "labor" | "materials", amountCents: number, categoryCode: string, memo: string) => {
    const { data, error } = await db.rpc("ensure_paid_work_order_expense", {
      p_manager: managerUserId,
      p_work_order: input.workOrderId,
      p_component: component,
      p_amount: amountCents,
      p_category: categoryCode,
      p_date: expenseDate,
      p_property: input.propertyId?.trim() || null,
      p_vendor: input.vendorId?.trim() || null,
      p_memo: memo,
      p_deductible: isCategoryDeductible(categoryCode),
    });
    if (error || typeof data !== "string") throw new Error(error?.message ?? "Paid expense create failed");
    ids.push(data);
    // GL posting is keyed by this stable expense id. If the first delivery
    // failed after inserting the expense, replay repairs the journal.
    await postGlExpenseEntry(db, {
      managerUserId,
      expenseId: data,
      categoryCode,
      amountCents,
      entryDate: expenseDate,
      propertyId: input.propertyId?.trim() || null,
      vendorId: input.vendorId?.trim() || null,
      memo,
    });
  };

  if (input.vendorCostCents && input.vendorCostCents > 0) {
    await ensureComponent("labor", input.vendorCostCents, laborCategory, memoBase);
  }

  if (input.materialsCostCents && input.materialsCostCents > 0) {
    await ensureComponent("materials", input.materialsCostCents, "materials", input.materialsMemo?.trim() || `${memoBase} — materials`);
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
    expenseEntryIds: [...new Set([...(row.expenseEntryIds ?? []), ...expenseEntryIds])],
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
