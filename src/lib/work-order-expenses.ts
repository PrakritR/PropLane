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

/** The two lines a job's vendor cost is ever expensed as. */
type WorkOrderExpenseLine = "labor" | "materials";

/** What a job has already posted, by line: the one thing that decides whether a line posts again. */
export type PostedWorkOrderExpenseLines = Map<WorkOrderExpenseLine, string>;

type PostedExpenseRow = { id?: unknown; category_code?: unknown; source_vendor_invoice_id?: unknown };

/** Which line an existing `manager_expense_entries` row of this job is. */
function lineOfPostedRow(row: PostedExpenseRow): WorkOrderExpenseLine {
  // A row the vendor-invoice rail wrote (`settle_vendor_invoice_payment`) IS the job's vendor cost,
  // whatever category the bill carried, so it counts as labor and a completion never posts it twice.
  if (row.source_vendor_invoice_id != null) return "labor";
  return row.category_code === "materials" ? "materials" : "labor";
}

/**
 * The expense lines this work order already posted. A job's labor and materials are posted exactly
 * once however many times a completion runs: Mark done and Approve + pay both call this for the
 * same job, and without this read the second pass doubles the ledger, the cash-flow chart and the
 * tax-deductible total.
 *
 * THREE rails write `manager_expense_entries` against a work order: the two completion lines below
 * and `settle_vendor_invoice_payment`, which posts the paid vendor bill with the same
 * `source_work_order_id` (migration 20261003010000). All three are read here.
 *
 * Keyed on `source_work_order_id` plus the LINE, never the caller's category: both completion
 * callers take that category from the client, and a stale mirror sending a different one would walk
 * straight past a category-keyed guard. `WORK_ORDER_CATEGORY_TO_EXPENSE` never maps to `materials`,
 * so for a completion row that code identifies the materials line; an invoice row is read off its
 * `source_vendor_invoice_id` instead, since a bill's own category is not ours to interpret.
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
    .select("id, category_code, source_vendor_invoice_id")
    .eq("manager_user_id", managerUserId)
    .eq("source_work_order_id", workOrderId);
  if (error) return { ok: false, error: error.message };
  for (const row of (data ?? []) as PostedExpenseRow[]) {
    const id = row.id == null ? "" : String(row.id);
    if (!id) continue;
    const line = lineOfPostedRow(row);
    if (!posted.has(line)) posted.set(line, id);
  }
  return { ok: true, posted };
}

/**
 * What is posted RIGHT NOW, narrowed against what the caller already knew. Called immediately
 * before each insert so a row that landed while money was moving (or while the other rail ran) is
 * still seen. A failed refresh keeps the caller's earlier answer rather than blocking: the
 * fail-closed decision belongs to the read the caller took before it committed anything.
 *
 * This narrows the window; it cannot close it. Two completions inserting in the same instant can
 * still both see nothing posted. Closing it needs a unique partial index on
 * (manager_user_id, source_work_order_id, line), which existing rows may already violate.
 */
async function postedLinesNow(
  db: SupabaseClient,
  managerUserId: string,
  workOrderId: string,
  known: PostedWorkOrderExpenseLines,
): Promise<PostedWorkOrderExpenseLines> {
  const fresh = await readPostedWorkOrderExpenseLines(db, managerUserId, workOrderId);
  if (!fresh.ok) return known;
  const merged: PostedWorkOrderExpenseLines = new Map(known);
  for (const [line, id] of fresh.posted) if (!merged.has(line)) merged.set(line, id);
  return merged;
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
  let known = alreadyPostedLines;
  if (!known) {
    const read = await readPostedWorkOrderExpenseLines(db, managerUserId, input.workOrderId);
    if (!read.ok) throw new Error(`Could not read this job's posted expenses: ${read.error}`);
    known = read.posted;
  }

  const wantsLabor = Boolean(input.vendorCostCents && input.vendorCostCents > 0);
  const wantsMaterials = Boolean(input.materialsCostCents && input.materialsCostCents > 0);

  if (wantsLabor && !known.has("labor")) {
    known = await postedLinesNow(db, managerUserId, input.workOrderId, known);
  }
  const postedLabor = known.get("labor");
  if (postedLabor) ids.push(postedLabor);

  if (!postedLabor && wantsLabor && input.vendorCostCents && input.vendorCostCents > 0) {
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

  if (wantsMaterials && !known.has("materials")) {
    known = await postedLinesNow(db, managerUserId, input.workOrderId, known);
  }
  const postedMaterials = known.get("materials");
  if (postedMaterials) ids.push(postedMaterials);

  if (!postedMaterials && wantsMaterials && input.materialsCostCents && input.materialsCostCents > 0) {
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
