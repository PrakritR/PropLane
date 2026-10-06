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

/** The lines an existing `manager_expense_entries` row of this job accounts for. */
function linesClosedByPostedRow(row: PostedExpenseRow, jobBillInvoiceIds: ReadonlySet<string>): WorkOrderExpenseLine[] {
  // A row the vendor-invoice rail wrote (`settle_vendor_invoice_payment`) for the JOB's own bill is
  // the vendor's WHOLE cost for it: `vendor_invoices` carries one `total_cents` with no
  // labor/materials split, so that single expense accounts for both lines and a completion adds
  // nothing on top of it.
  //
  // The estimate-visit fee rides the same rail as a SECOND invoice on the same service
  // (`work-order-visit-fee-invoice.server.ts`), so it carries the job's `source_work_order_id`
  // too. A $50 visit fee is not the job's labor: treating it as the whole bill suppressed the
  // accepted bid's expense entirely, so it closes neither line.
  const invoiceId = row.source_vendor_invoice_id == null ? "" : String(row.source_vendor_invoice_id);
  if (invoiceId) return jobBillInvoiceIds.has(invoiceId) ? ["labor", "materials"] : [];
  return [row.category_code === "materials" ? "materials" : "labor"];
}

/**
 * Of these `vendor_invoices` ids, the ones that are the job's own bill rather than an
 * estimate-visit fee. A read failure returns `null`, which the caller turns into a refusal: not
 * knowing which invoice an expense came from means not knowing what is posted.
 *
 * A visit fee is recognised ONLY by the server-written `estimate_visit_bid_id`, never by a
 * `VISIT-` invoice number, which arrives verbatim in the vendor's own submission body — reading it
 * there let the assigned vendor number their own job bill that way and have the completion post
 * labor and materials on top of the paid bill.
 *
 * Everything else counts as the job's bill, including an id that did not come back. Both unknowns
 * fail in the same direction as the read failure above: a row that may already account for the
 * job's whole cost closes both lines rather than letting a second one post.
 */
async function jobBillInvoiceIds(
  db: SupabaseClient,
  invoiceIds: readonly string[],
): Promise<ReadonlySet<string> | null> {
  if (invoiceIds.length === 0) return new Set<string>();
  const { data, error } = await db
    .from("vendor_invoices")
    .select("id, estimate_visit_bid_id")
    .in("id", [...invoiceIds]);
  if (error) return null;
  const visitFees = new Set<string>();
  for (const row of (data ?? []) as Array<{ id?: unknown; estimate_visit_bid_id?: unknown }>) {
    const id = row.id == null ? "" : String(row.id);
    if (id && row.estimate_visit_bid_id != null) visitFees.add(id);
  }
  return new Set(invoiceIds.filter((id) => !visitFees.has(id)));
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
 * `source_vendor_invoice_id` instead and closes both lines when it is the job's own bill (the whole
 * cost) and neither when it is the estimate-visit fee, which is a separate invoice on the service.
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
  const rows = (data ?? []) as PostedExpenseRow[];
  const invoiceIds = [
    ...new Set(
      rows
        .map((row) => (row.source_vendor_invoice_id == null ? "" : String(row.source_vendor_invoice_id)))
        .filter(Boolean),
    ),
  ];
  const jobBills = await jobBillInvoiceIds(db, invoiceIds);
  if (!jobBills) return { ok: false, error: "Could not tell this job's vendor bill from its estimate-visit fee." };
  for (const row of rows) {
    const id = row.id == null ? "" : String(row.id);
    if (!id) continue;
    for (const line of linesClosedByPostedRow(row, jobBills)) if (!posted.has(line)) posted.set(line, id);
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

  const wantsLabor = Boolean(input.vendorCostCents && input.vendorCostCents > 0);
  const wantsMaterials = Boolean(input.materialsCostCents && input.materialsCostCents > 0);

  // A completion carrying no cost posts nothing, so it has nothing to guard: reading the ledger
  // here would only decide what NOT to post, while making a Mark done with no vendor or materials
  // cost fail outright whenever that read fails. Marking a job done is not a money move.
  if (!wantsLabor && !wantsMaterials) return ids;

  // The posted-lines read also sees an expense the invoice rail already booked for this job
  // (`source_vendor_invoice_id`), which the per-component RPC key below cannot: one job is never
  // expensed twice across rails. The RPC then makes each remaining line atomic and replay-safe.
  let known = alreadyPostedLines;
  if (!known) {
    const read = await readPostedWorkOrderExpenseLines(db, managerUserId, input.workOrderId);
    if (!read.ok) throw new Error(`Could not read this job's posted expenses: ${read.error}`);
    known = read.posted;
  }

  if (wantsLabor && !known.has("labor")) {
    known = await postedLinesNow(db, managerUserId, input.workOrderId, known);
  }
  const postedLabor = known.get("labor");
  if (postedLabor) ids.push(postedLabor);
  if (!postedLabor && wantsLabor && input.vendorCostCents) {
    await ensureComponent("labor", input.vendorCostCents, laborCategory, memoBase);
  }

  if (wantsMaterials && !known.has("materials")) {
    known = await postedLinesNow(db, managerUserId, input.workOrderId, known);
  }
  const postedMaterials = known.get("materials");
  if (postedMaterials && postedMaterials !== postedLabor) ids.push(postedMaterials);
  if (!postedMaterials && wantsMaterials && input.materialsCostCents) {
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
