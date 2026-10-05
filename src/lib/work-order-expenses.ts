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

/** The two lines one completion can post. Nothing else is ever written against a work order. */
type WorkOrderExpenseLine = "labor" | "materials";

/** What a job has already posted, by line: the one thing that decides whether a line posts again. */
export type PostedWorkOrderExpenseLines = Map<WorkOrderExpenseLine, string>;

/**
 * The expense lines this work order already posted. One job's labor and materials are posted
 * exactly once however many times a completion runs: Mark done and Approve + pay both call this
 * for the same job, and without this read the second pass doubles the ledger, the cash-flow chart
 * and the tax-deductible total.
 *
 * Keyed on `source_work_order_id` plus the LINE, never the caller's category: both callers take
 * that category from the client, and a stale mirror sending a different one would walk straight
 * past a category-keyed guard. `WORK_ORDER_CATEGORY_TO_EXPENSE` never maps to `materials`, so the
 * materials row is the only one that can carry that code.
 *
 * Returns a failure rather than throwing, so a caller that is about to move money can read FIRST
 * and refuse before it does: not knowing what is already posted means refusing to post.
 */
export async function readPostedWorkOrderExpenseLines(
  db: SupabaseClient,
  managerUserId: string,
  workOrderId: string,
): Promise<{ ok: true; posted: PostedWorkOrderExpenseLines } | { ok: false; error: string }> {
  const posted: PostedWorkOrderExpenseLines = new Map();
  const { data, error } = await db
    .from("manager_expense_entries")
    .select("id, category_code")
    .eq("manager_user_id", managerUserId)
    .eq("source_work_order_id", workOrderId);
  if (error) return { ok: false, error: error.message };
  for (const row of (data ?? []) as Array<{ id?: unknown; category_code?: unknown }>) {
    const id = row.id == null ? "" : String(row.id);
    if (!id) continue;
    const line: WorkOrderExpenseLine = row.category_code === "materials" ? "materials" : "labor";
    if (!posted.has(line)) posted.set(line, id);
  }
  return { ok: true, posted };
}

/**
 * `alreadyPosted` is the read a caller already did (approve + pay reads before it touches money).
 * Without it this reads for itself and throws on failure - fail closed, the same direction the two
 * inserts below fail in - which is safe only where nothing has been committed yet.
 */
export async function createExpensesFromWorkOrder(
  db: SupabaseClient,
  managerUserId: string,
  input: WorkOrderCompleteInput,
  alreadyPostedLines?: PostedWorkOrderExpenseLines,
): Promise<string[]> {
  const ids: string[] = [];
  const now = new Date().toISOString();
  const expenseDate = (input.completedAt || now).slice(0, 10);
  const laborCategory = WORK_ORDER_CATEGORY_TO_EXPENSE[input.category] ?? "maintenance";
  const memoBase = input.workDoneSummary?.trim() || `Work order ${input.workOrderId}`;
  let alreadyPosted = alreadyPostedLines;
  if (!alreadyPosted) {
    const read = await readPostedWorkOrderExpenseLines(db, managerUserId, input.workOrderId);
    if (!read.ok) throw new Error(`Could not read this job's posted expenses: ${read.error}`);
    alreadyPosted = read.posted;
  }

  const postedLabor = alreadyPosted.get("labor");
  if (postedLabor) ids.push(postedLabor);
  const postedMaterials = alreadyPosted.get("materials");
  if (postedMaterials) ids.push(postedMaterials);

  if (!postedLabor && input.vendorCostCents && input.vendorCostCents > 0) {
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

  if (!postedMaterials && input.materialsCostCents && input.materialsCostCents > 0) {
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
