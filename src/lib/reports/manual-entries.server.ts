/**
 * Manual bookkeeping entries (income + expenses), extracted from the POST
 * handlers of /api/income and /api/expenses so the routes and the agent tool
 * layer share ONE implementation. Validation rules, insert shapes, and PostHog
 * events are identical to the original route code — a caller that needs
 * different behavior should not change this file's semantics.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { track } from "@/lib/analytics/posthog";
import { findDuplicateExpenses } from "@/lib/finance/expense-duplicates.server";
import { describeDuplicate, validOverrideReason, type DuplicateMatch } from "@/lib/finance/duplicate-payment";
import { isIsoDate, isPaymentMethod, isPaymentStatus, type PaymentStatus } from "@/lib/finance/payment-fields";
import { isCategoryDeductible, SYSTEM_CHART_ACCOUNTS } from "@/lib/reports/categories";
import { postGlManualIncomeEntry, rebuildExpenseRowGl, deleteExpenseRowGl, postExpenseRowGl, type ExpenseGlRow } from "@/lib/reports/gl-posting";
import type { WorkspaceRowScope } from "@/lib/workspaces/row-scope.server";

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
  | { ok: false; status: number; error: string; code?: "duplicate_payment"; duplicates?: DuplicateMatch[] };

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
  options?: { id: string },
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
  const entryId = options?.id ?? randomUUID();

  const { data, error } = await db
    .from("ledger_entries")
    .insert({
      id: entryId,
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
  // Write-through: the entry and its balanced General Ledger journal land together or not at all. The
  // journal is keyed by the entry id, so a retry (or the repair sweep) can never post it twice.
  try {
    const journalId = await postGlManualIncomeEntry(db, {
      managerUserId,
      sourceChargeId: entryId,
      categoryCode,
      amountCents,
      entryDate: input.postedDate.trim(),
      propertyId: input.propertyId?.trim() || null,
      description,
      linkLedgerEntryId: entryId,
    });
    if (!journalId) throw new Error("GL journal was not posted.");
  } catch (glError) {
    await db.from("ledger_entries").delete().eq("id", entryId).eq("manager_user_id", managerUserId);
    console.error("manual income GL post failed", glError instanceof Error ? glError.message : "unknown");
    return { ok: false, status: 500, error: "The entry could not be posted to the books. Nothing was saved; try again." };
  }
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
  /** Who the money went to. The CALLER must already have proven the payee belongs to this manager. */
  payeeId?: string | null;
  taxDeductible?: boolean | null;
  /** Paid (default) or Due. A Due entry needs `dueDate`; it posts as an accrual, never as cash out. */
  paymentStatus?: PaymentStatus | null;
  dueDate?: string | null;
  /** The day the money left; defaults to the entry date for a Paid entry. */
  paidDate?: string | null;
  paymentMethod?: string | null;
  /** Free-text payee ("Seattle Public Utilities") for someone who is not a saved payee or vendor. */
  payeeLabel?: string | null;
  billingPeriodStart?: string | null;
  billingPeriodEnd?: string | null;
  recurringPayableId?: string | null;
  /** Required to record a payment the duplicate check flagged; stored on the row and in the audit log. */
  duplicateOverrideReason?: string | null;
};

type ExpenseOptions = { id?: string; scope?: WorkspaceRowScope };

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

type PaymentFieldsResult =
  | {
      ok: true;
      fields: {
        payment_status: PaymentStatus;
        due_date: string | null;
        paid_date: string | null;
        payment_method: string | null;
        payee_label: string | null;
        billing_period_start: string | null;
        billing_period_end: string | null;
      };
    }
  | { ok: false; status: number; error: string };

/** Validate and default the Paid/Due, method, payee and billing-period fields of one entry. */
function resolvePaymentFields(input: ManualExpenseInput, expenseDate: string): PaymentFieldsResult {
  const status: PaymentStatus = input.paymentStatus == null ? "paid" : isPaymentStatus(input.paymentStatus) ? input.paymentStatus : "paid";
  if (input.paymentStatus != null && !isPaymentStatus(input.paymentStatus)) {
    return { ok: false, status: 400, error: "paymentStatus must be paid or due." };
  }
  for (const [field, value] of [
    ["dueDate", input.dueDate],
    ["paidDate", input.paidDate],
    ["billingPeriodStart", input.billingPeriodStart],
    ["billingPeriodEnd", input.billingPeriodEnd],
  ] as const) {
    if (value != null && value !== "" && !isIsoDate(value)) {
      return { ok: false, status: 400, error: `${field} must be a valid YYYY-MM-DD date.` };
    }
  }
  const dueDate = textOrNull(input.dueDate);
  if (status === "due" && !dueDate) return { ok: false, status: 400, error: "A Due entry needs a due date." };
  const method = textOrNull(input.paymentMethod);
  if (method && !isPaymentMethod(method)) return { ok: false, status: 400, error: "Unknown payment method." };
  const start = textOrNull(input.billingPeriodStart);
  const end = textOrNull(input.billingPeriodEnd);
  if (start && end && end < start) return { ok: false, status: 400, error: "The billing period ends before it starts." };
  return {
    ok: true,
    fields: {
      payment_status: status,
      due_date: dueDate,
      paid_date: status === "paid" ? textOrNull(input.paidDate) ?? expenseDate : null,
      payment_method: method,
      payee_label: textOrNull(input.payeeLabel)?.slice(0, 160) ?? null,
      billing_period_start: start,
      billing_period_end: end,
    },
  };
}

type DuplicateGate =
  | { ok: true; overrideReason: string | null }
  | { ok: false; status: 409; error: string; code: "duplicate_payment"; duplicates: DuplicateMatch[] };

/**
 * The duplicate-payment gate for a Paid entry. No match: proceed. A match with no valid override reason: a
 * 409 naming what it matched. A match WITH a reason: proceed, and the override is written to `audit_log`
 * BEFORE the entry is saved, so an override can never exist without its record (the write fails closed).
 */
async function duplicateGate(
  db: SupabaseClient,
  managerUserId: string,
  entryId: string,
  candidate: {
    amountCents: number;
    propertyId: string | null;
    vendorId: string | null;
    payeeId: string | null;
    payeeLabel: string | null;
    memo: string | null;
    paidDate: string;
    billingPeriodStart: string | null;
    billingPeriodEnd: string | null;
  },
  overrideReason: unknown,
  scope?: WorkspaceRowScope,
): Promise<DuplicateGate | { ok: false; status: 500; error: string }> {
  let matches: DuplicateMatch[];
  try {
    matches = await findDuplicateExpenses(db, managerUserId, { id: entryId, ...candidate }, scope);
  } catch (e) {
    // Fail closed: a payment is not recorded when the history could not be read.
    return { ok: false, status: 500, error: e instanceof Error ? e.message : "Duplicate check failed." };
  }
  if (matches.length === 0) return { ok: true, overrideReason: null };
  if (!validOverrideReason(overrideReason)) {
    return {
      ok: false,
      status: 409,
      code: "duplicate_payment",
      duplicates: matches,
      error: `This looks like a duplicate payment: ${describeDuplicate(matches[0]!)}. Give a reason to record it anyway.`,
    };
  }
  const reason = overrideReason.trim().slice(0, 500);
  const { error } = await db.from("audit_log").insert({
    actor_user_id: managerUserId,
    landlord_id: managerUserId,
    action: "expense_duplicate_override",
    tool_name: "finance_entry",
    input_summary: { expenseId: entryId, amountCents: candidate.amountCents, paidDate: candidate.paidDate, reason },
    result_summary: { matchedExpenseIds: matches.map((m) => m.id), reasons: matches.map((m) => m.reason) },
    dedupe_key: `expense-duplicate-override:${entryId}`,
  });
  if (error && error.code !== "23505") return { ok: false, status: 500, error: "The override could not be recorded; nothing was saved." };
  return { ok: true, overrideReason: reason };
}

/**
 * Does this expense row own its General Ledger journals? A paid bill's expense row settles through its bill's
 * journals, and a work-order or Stripe-sourced row is posted by its own writer: re-posting any of them from
 * here would double-book.
 */
async function expenseRowOwnsItsGl(
  db: SupabaseClient,
  managerUserId: string,
  row: { id: string; source_work_order_id?: unknown; source_stripe_payment_id?: unknown },
): Promise<boolean> {
  if (row.source_work_order_id || row.source_stripe_payment_id) return false;
  const { data, error } = await db
    .from("manager_bills")
    .select("id")
    .eq("manager_user_id", managerUserId)
    .eq("paid_expense_entry_id", row.id)
    .limit(1);
  if (error) throw new Error(error.message);
  return (data ?? []).length === 0;
}

function glRow(managerUserId: string, e: Record<string, unknown>): ExpenseGlRow {
  return {
    id: String(e.id),
    manager_user_id: managerUserId,
    property_id: (e.property_id as string | null) ?? null,
    category_code: String(e.category_code),
    amount_cents: Number(e.amount_cents),
    expense_date: String(e.expense_date),
    memo: (e.memo as string | null) ?? null,
    vendor_id: (e.vendor_id as string | null) ?? null,
    payment_status: (e.payment_status as string | null) ?? "paid",
    due_date: (e.due_date as string | null) ?? null,
    paid_date: (e.paid_date as string | null) ?? null,
  };
}

/** Insert a manual expense entry into manager_expense_entries, scoped to the manager, and post it to the GL. */
export async function recordManualExpense(
  db: SupabaseClient,
  managerUserId: string,
  input: ManualExpenseInput,
  options?: ExpenseOptions,
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
  const expenseDate = input.expenseDate.trim();
  if (!isIsoDate(expenseDate)) return { ok: false, status: 400, error: "expenseDate must be a valid YYYY-MM-DD date." };

  const categoryCode = input.categoryCode.trim();
  // Auto-suggest the tax classification from the category; an explicit value
  // from the caller is a manager override and wins.
  const taxDeductible =
    typeof input.taxDeductible === "boolean" ? input.taxDeductible : isCategoryDeductible(categoryCode);

  const payment = resolvePaymentFields(input, expenseDate);
  if (!payment.ok) return payment;
  const entryId = options?.id ?? randomUUID();

  let overrideReason: string | null = null;
  if (payment.fields.payment_status === "paid") {
    const gate = await duplicateGate(
      db,
      managerUserId,
      entryId,
      {
        amountCents,
        propertyId: input.propertyId?.trim() || null,
        vendorId: input.vendorId?.trim() || null,
        payeeId: input.payeeId?.trim() || null,
        payeeLabel: payment.fields.payee_label,
        memo: input.memo?.trim() || null,
        paidDate: payment.fields.paid_date ?? expenseDate,
        billingPeriodStart: payment.fields.billing_period_start,
        billingPeriodEnd: payment.fields.billing_period_end,
      },
      input.duplicateOverrideReason,
      options?.scope,
    );
    if (!gate.ok) return gate;
    overrideReason = gate.overrideReason;
  }

  const now = new Date().toISOString();
  const { data, error } = await db
    .from("manager_expense_entries")
    .insert({
      id: entryId,
      manager_user_id: managerUserId,
      property_id: input.propertyId?.trim() || null,
      category_code: categoryCode,
      amount_cents: amountCents,
      expense_date: expenseDate,
      memo: input.memo?.trim() || null,
      vendor_id: input.vendorId?.trim() || null,
      ...(input.payeeId?.trim() ? { payee_id: input.payeeId.trim() } : {}),
      ...(input.recurringPayableId?.trim() ? { recurring_payable_id: input.recurringPayableId.trim() } : {}),
      ...payment.fields,
      duplicate_override_reason: overrideReason,
      tax_deductible: taxDeductible,
      updated_at: now,
    })
    .select("*")
    .single();

  if (error) return { ok: false, status: 500, error: error.message };
  // Write-through: the entry and its GL journal(s) land together or not at all (see `postExpenseRowGl`).
  try {
    await postExpenseRowGl(db, glRow(managerUserId, data as Record<string, unknown>));
  } catch (glError) {
    await db.from("manager_expense_entries").delete().eq("id", entryId).eq("manager_user_id", managerUserId);
    console.error("manual expense GL post failed", glError instanceof Error ? glError.message : "unknown");
    return { ok: false, status: 500, error: "The entry could not be posted to the books. Nothing was saved; try again." };
  }
  track("expense_created", managerUserId, {
    category_code: categoryCode,
    tax_deductible: taxDeductible,
    tax_overridden:
      typeof input.taxDeductible === "boolean" && input.taxDeductible !== isCategoryDeductible(categoryCode),
    payment_status: payment.fields.payment_status,
    duplicate_overridden: overrideReason !== null,
  });
  return { ok: true, entry: data as Record<string, unknown> };
}

export type ManualExpensePatch = ManualExpenseInput & { id: string };

/** Update a manager-owned expense. Only supplied fields are written; money-bearing edits re-derive its journals. */
export async function updateManualExpense(
  db: SupabaseClient,
  managerUserId: string,
  input: ManualExpensePatch,
  options?: { scope?: WorkspaceRowScope },
): Promise<ManualEntryResult> {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!id) return { ok: false, status: 400, error: "id required." };

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  let moneyChanged = false;
  if (typeof input.taxDeductible === "boolean") patch.tax_deductible = input.taxDeductible;
  if (input.categoryCode !== undefined) {
    if (typeof input.categoryCode !== "string" || !input.categoryCode.trim()) {
      return { ok: false, status: 400, error: "categoryCode required." };
    }
    // Custom non-empty categories are supported by the create endpoint too.
    patch.category_code = input.categoryCode.trim();
    moneyChanged = true;
  }
  if (input.amountCents != null) {
    const amountCents = Number(input.amountCents);
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return { ok: false, status: 400, error: "amountCents must be a positive integer." };
    patch.amount_cents = amountCents;
    moneyChanged = true;
  }
  if (input.expenseDate !== undefined) {
    const date = typeof input.expenseDate === "string" ? input.expenseDate.trim() : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
      return { ok: false, status: 400, error: "expenseDate must be a valid YYYY-MM-DD date." };
    }
    patch.expense_date = date;
    moneyChanged = true;
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
  if (input.propertyId !== undefined) { patch.property_id = input.propertyId?.trim() || null; moneyChanged = true; }
  if (input.vendorId !== undefined) { patch.vendor_id = input.vendorId?.trim() || null; moneyChanged = true; }

  // Payment fields: validated by the same resolver as a create, against the row's own entry date.
  const touchesPayment =
    input.paymentStatus !== undefined || input.dueDate !== undefined || input.paidDate !== undefined ||
    input.paymentMethod !== undefined || input.payeeLabel !== undefined ||
    input.billingPeriodStart !== undefined || input.billingPeriodEnd !== undefined;

  const { data: existing, error: existingError } = await db
    .from("manager_expense_entries")
    .select("*")
    .eq("id", id)
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  if (existingError) return { ok: false, status: 500, error: existingError.message };
  if (!existing) return { ok: false, status: 404, error: "Expense not found." };

  let overrideReason: string | null = null;
  const merged = {
    amount: Number(patch.amount_cents ?? existing.amount_cents),
    property: (patch.property_id !== undefined ? patch.property_id : existing.property_id) as string | null,
    vendor: (patch.vendor_id !== undefined ? patch.vendor_id : existing.vendor_id) as string | null,
    expenseDate: String(patch.expense_date ?? existing.expense_date),
  };
  if (touchesPayment) {
    const resolved = resolvePaymentFields(
      {
        paymentStatus: input.paymentStatus ?? (existing.payment_status as PaymentStatus | null),
        dueDate: input.dueDate !== undefined ? input.dueDate : (existing.due_date as string | null),
        paidDate: input.paidDate !== undefined ? input.paidDate : (existing.paid_date as string | null),
        paymentMethod: input.paymentMethod !== undefined ? input.paymentMethod : (existing.payment_method as string | null),
        payeeLabel: input.payeeLabel !== undefined ? input.payeeLabel : (existing.payee_label as string | null),
        billingPeriodStart: input.billingPeriodStart !== undefined ? input.billingPeriodStart : (existing.billing_period_start as string | null),
        billingPeriodEnd: input.billingPeriodEnd !== undefined ? input.billingPeriodEnd : (existing.billing_period_end as string | null),
      },
      merged.expenseDate,
    );
    if (!resolved.ok) return resolved;
    Object.assign(patch, resolved.fields);
    moneyChanged = true;
  }
  const nextStatus = (patch.payment_status ?? existing.payment_status ?? "paid") as PaymentStatus;
  const becomesPaid = nextStatus === "paid" && (existing.payment_status ?? "paid") !== "paid";
  const paidFactsChanged =
    nextStatus === "paid" &&
    (patch.amount_cents !== undefined || patch.paid_date !== undefined || patch.billing_period_start !== undefined ||
      patch.payee_label !== undefined || patch.property_id !== undefined || patch.vendor_id !== undefined);
  if (becomesPaid || paidFactsChanged) {
    const gate = await duplicateGate(
      db,
      managerUserId,
      id,
      {
        amountCents: merged.amount,
        propertyId: merged.property,
        vendorId: merged.vendor,
        payeeId: (existing.payee_id as string | null) ?? null,
        payeeLabel: (patch.payee_label !== undefined ? patch.payee_label : existing.payee_label) as string | null,
        memo: (patch.memo !== undefined ? patch.memo : existing.memo) as string | null,
        paidDate: String(patch.paid_date ?? existing.paid_date ?? merged.expenseDate),
        billingPeriodStart: (patch.billing_period_start !== undefined ? patch.billing_period_start : existing.billing_period_start) as string | null,
        billingPeriodEnd: (patch.billing_period_end !== undefined ? patch.billing_period_end : existing.billing_period_end) as string | null,
      },
      input.duplicateOverrideReason,
      options?.scope,
    );
    if (!gate.ok) return gate;
    if (gate.overrideReason) patch.duplicate_override_reason = gate.overrideReason;
    overrideReason = gate.overrideReason;
  }

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
  if (moneyChanged && (await expenseRowOwnsItsGl(db, managerUserId, data))) {
    try {
      await rebuildExpenseRowGl(db, glRow(managerUserId, data as Record<string, unknown>));
    } catch (glError) {
      // Put the row back so the books and the entry never disagree.
      await db.from("manager_expense_entries").update(existing).eq("id", id).eq("manager_user_id", managerUserId);
      try { await rebuildExpenseRowGl(db, glRow(managerUserId, existing as Record<string, unknown>)); } catch { /* repaired by the next sweep */ }
      console.error("manual expense GL rebuild failed", glError instanceof Error ? glError.message : "unknown");
      return { ok: false, status: 500, error: "The change could not be posted to the books. Nothing was saved; try again." };
    }
  }
  const taxOnly = typeof input.taxDeductible === "boolean" && Object.keys(patch).length === 2;
  track(taxOnly ? "expense_tax_status_changed" : becomesPaid ? "expense_marked_paid" : "expense_updated", managerUserId, {
    category_code: String(data.category_code ?? ""),
    tax_deductible: typeof data.tax_deductible === "boolean" ? data.tax_deductible : undefined,
    duplicate_overridden: overrideReason !== null,
  });
  return { ok: true, entry: data as Record<string, unknown> };
}

/** Delete a manager-owned expense and the journals it owns (its books follow it). */
export async function deleteManualExpenseGl(db: SupabaseClient, managerUserId: string, row: { id: string; source_work_order_id?: unknown; source_stripe_payment_id?: unknown }): Promise<void> {
  if (await expenseRowOwnsItsGl(db, managerUserId, row)) await deleteExpenseRowGl(db, managerUserId, row.id);
}
