/**
 * Manual bookkeeping entries (income + expenses), extracted from the POST
 * handlers of /api/income and /api/expenses so the routes and the agent tool
 * layer share ONE implementation. Validation rules, insert shapes, and PostHog
 * events are identical to the original route code — a caller that needs
 * different behavior should not change this file's semantics.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { track } from "@/lib/analytics/posthog";
import { isCategoryDeductible, SYSTEM_CHART_ACCOUNTS } from "@/lib/reports/categories";

/** Income category codes accepted by manual income entries. */
export const MANUAL_INCOME_CODES = new Set(
  SYSTEM_CHART_ACCOUNTS.filter((a) => a.accountType === "income").map((a) => a.code),
);

/**
 * Expense category codes from the system chart of accounts. NOTE: the
 * /api/expenses route historically accepts any non-empty code (custom codes
 * default to Sch. E Line 19), so recordManualExpense does NOT enforce this set
 * — it exists for callers (e.g. the agent's record_expense tool) that want to
 * restrict input to known categories up front.
 */
export const MANUAL_EXPENSE_CODES = new Set(
  SYSTEM_CHART_ACCOUNTS.filter((a) => a.accountType === "expense").map((a) => a.code),
);

export type ManualEntryResult =
  | { ok: true; entry: Record<string, unknown> }
  | { ok: false; status: number; error: string };

export type ManualIncomeInput = {
  propertyId?: string | null;
  categoryCode?: string | null;
  amountCents?: number | null;
  postedDate?: string | null;
  description?: string | null;
  residentEmail?: string | null;
};

/** Insert a manual income entry into ledger_entries, scoped to the manager. */
export async function recordManualIncome(
  db: SupabaseClient,
  managerUserId: string,
  input: ManualIncomeInput,
): Promise<ManualEntryResult> {
  const amountCents = Number(input.amountCents);
  if (!(amountCents > 0)) {
    return { ok: false, status: 400, error: "amountCents must be positive." };
  }
  if (!input.postedDate?.trim()) {
    return { ok: false, status: 400, error: "postedDate required." };
  }

  const categoryCode = input.categoryCode?.trim() || "other_income";
  if (!MANUAL_INCOME_CODES.has(categoryCode)) {
    return { ok: false, status: 400, error: "Invalid income category." };
  }

  const description = input.description?.trim() || "Manual income entry";
  const residentEmail = input.residentEmail?.trim().toLowerCase() || null;
  const now = new Date().toISOString();

  const { data, error } = await db
    .from("ledger_entries")
    .insert({
      manager_user_id: managerUserId,
      resident_user_id: null,
      resident_email: residentEmail,
      property_id: input.propertyId?.trim() || null,
      unit_label: "",
      lease_id: null,
      entry_type: "payment",
      category_code: categoryCode,
      amount_cents: amountCents,
      due_date: null,
      posted_date: input.postedDate.trim(),
      source_charge_id: null,
      description,
      updated_at: now,
    })
    .select("*")
    .single();

  if (error) return { ok: false, status: 500, error: error.message };
  track("income_created", managerUserId, { category_code: categoryCode });
  return { ok: true, entry: data as Record<string, unknown> };
}

export type ManualExpenseInput = {
  propertyId?: string | null;
  categoryCode?: string | null;
  amountCents?: number | null;
  expenseDate?: string | null;
  memo?: string | null;
  vendorId?: string | null;
  taxDeductible?: boolean | null;
};

/** Insert a manual expense entry into manager_expense_entries, scoped to the manager. */
export async function recordManualExpense(
  db: SupabaseClient,
  managerUserId: string,
  input: ManualExpenseInput,
): Promise<ManualEntryResult> {
  const amountCents = Number(input.amountCents);
  if (!(amountCents > 0)) {
    return { ok: false, status: 400, error: "amountCents must be positive." };
  }
  if (!input.expenseDate?.trim()) {
    return { ok: false, status: 400, error: "expenseDate required." };
  }
  if (!input.categoryCode?.trim()) {
    return { ok: false, status: 400, error: "categoryCode required." };
  }

  const categoryCode = input.categoryCode.trim();
  // Auto-suggest the tax classification from the category; an explicit value
  // from the caller is a manager override and wins.
  const taxDeductible =
    typeof input.taxDeductible === "boolean" ? input.taxDeductible : isCategoryDeductible(categoryCode);

  const now = new Date().toISOString();
  const { data, error } = await db
    .from("manager_expense_entries")
    .insert({
      manager_user_id: managerUserId,
      property_id: input.propertyId?.trim() || null,
      category_code: categoryCode,
      amount_cents: amountCents,
      expense_date: input.expenseDate.trim(),
      memo: input.memo?.trim() || null,
      vendor_id: input.vendorId?.trim() || null,
      tax_deductible: taxDeductible,
      updated_at: now,
    })
    .select("*")
    .single();

  if (error) return { ok: false, status: 500, error: error.message };
  track("expense_created", managerUserId, {
    category_code: categoryCode,
    tax_deductible: taxDeductible,
    tax_overridden:
      typeof input.taxDeductible === "boolean" && input.taxDeductible !== isCategoryDeductible(categoryCode),
  });
  return { ok: true, entry: data as Record<string, unknown> };
}

export type ManualExpensePatch = ManualExpenseInput & { id: string };

/** Update a manager-owned expense. Only supplied fields are written. */
export async function updateManualExpense(
  db: SupabaseClient,
  managerUserId: string,
  input: ManualExpensePatch,
): Promise<ManualEntryResult> {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!id) return { ok: false, status: 400, error: "id required." };

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof input.taxDeductible === "boolean") patch.tax_deductible = input.taxDeductible;
  if (input.categoryCode !== undefined) {
    if (typeof input.categoryCode !== "string" || !input.categoryCode.trim()) {
      return { ok: false, status: 400, error: "categoryCode required." };
    }
    // Custom non-empty categories are supported by the create endpoint too.
    patch.category_code = input.categoryCode.trim();
  }
  if (input.amountCents != null) {
    const amountCents = Number(input.amountCents);
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return { ok: false, status: 400, error: "amountCents must be a positive integer." };
    patch.amount_cents = amountCents;
  }
  if (input.expenseDate !== undefined) {
    const date = typeof input.expenseDate === "string" ? input.expenseDate.trim() : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
      return { ok: false, status: 400, error: "expenseDate must be a valid YYYY-MM-DD date." };
    }
    patch.expense_date = date;
  }
  for (const field of ["memo", "propertyId", "vendorId"] as const) {
    if (input[field] != null && typeof input[field] !== "string") {
      return { ok: false, status: 400, error: `${field} must be a string or null.` };
    }
  }
  if (input.taxDeductible !== undefined && typeof input.taxDeductible !== "boolean") {
    return { ok: false, status: 400, error: "taxDeductible must be a boolean." };
  }
  for (const [field, table] of [["propertyId", "manager_property_records"], ["vendorId", "manager_vendor_records"]] as const) {
    const targetId = input[field]?.trim();
    if (!targetId) continue;
    const { data: target, error: targetError } = await db.from(table).select("id")
      .eq("manager_user_id", managerUserId).eq("id", targetId).maybeSingle();
    if (targetError) return { ok: false, status: 500, error: targetError.message };
    if (!target) return { ok: false, status: 400, error: `${field} is not owned by this manager.` };
  }
  if (input.memo !== undefined) patch.memo = input.memo?.trim() || null;
  if (input.propertyId !== undefined) patch.property_id = input.propertyId?.trim() || null;
  if (input.vendorId !== undefined) patch.vendor_id = input.vendorId?.trim() || null;

  if (Object.keys(patch).length === 1) {
    return { ok: false, status: 400, error: "Nothing to update." };
  }

  const { data, error } = await db
    .from("manager_expense_entries")
    .update(patch)
    .eq("id", id)
    .eq("manager_user_id", managerUserId)
    .select("*")
    .maybeSingle();

  if (error) return { ok: false, status: 500, error: error.message };
  if (!data) return { ok: false, status: 404, error: "Expense not found." };
  const taxOnly = typeof input.taxDeductible === "boolean" && Object.keys(patch).length === 2;
  track(taxOnly ? "expense_tax_status_changed" : "expense_updated", managerUserId, {
    category_code: String(data.category_code ?? ""),
    tax_deductible: typeof data.tax_deductible === "boolean" ? data.tax_deductible : undefined,
  });
  return { ok: true, entry: data as Record<string, unknown> };
}
