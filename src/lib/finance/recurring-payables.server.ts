import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { findOwnedPayee } from "@/lib/manager-payees.server";
import {
  advanceRecurrenceDate,
  isIsoDate,
  isPaymentMethod,
  isRecurrenceFrequency,
  type RecurrenceFrequency,
} from "@/lib/finance/payment-fields";
import { recordManualExpense } from "@/lib/reports/manual-entries.server";
import { rowAllowedInWorkspaceScope, type WorkspaceRowScope } from "@/lib/workspaces/row-scope.server";

/**
 * Recurring payables: a schedule (the monthly owner payment, a utility, an insurance premium) that generates
 * one DUE financial entry per occurrence. PropLane records and reminds; it moves no money and holds none. A
 * generated entry is an ordinary `manager_expense_entries` row (status Due, accrual in the books, a real
 * payee/vendor/method); marking it Paid goes through the same duplicate-payment gate as any other payment.
 *
 * One entry per (payable, due date): the partial unique index makes the cron, a retry and a manual
 * "generate now" idempotent.
 */

export type RecurringPayable = {
  id: string;
  label: string;
  payeeId: string | null;
  vendorId: string | null;
  payeeLabel: string | null;
  categoryCode: string;
  amountCents: number;
  propertyId: string | null;
  memo: string | null;
  paymentMethod: string | null;
  frequency: RecurrenceFrequency;
  nextDate: string;
  endDate: string | null;
  status: "active" | "paused" | "ended";
  lastGeneratedFor: string | null;
};

export type RecurringPayableInput = {
  label?: string | null;
  payeeId?: string | null;
  vendorId?: string | null;
  payeeLabel?: string | null;
  categoryCode?: string | null;
  amountCents?: number | null;
  propertyId?: string | null;
  memo?: string | null;
  paymentMethod?: string | null;
  frequency?: string | null;
  nextDate?: string | null;
  endDate?: string | null;
  status?: string | null;
};

export type RecurringResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

/** How many days ahead of its due date an entry is generated, so it shows as Due in time to pay it. */
export const RECURRING_LEAD_DAYS = 5;
/** Catch-up cap per payable per run: a paused-then-resumed schedule never floods the books in one tick. */
const MAX_PER_RUN = 12;

function rowToPayable(row: Record<string, unknown>): RecurringPayable {
  return {
    id: String(row.id),
    label: String(row.label ?? ""),
    payeeId: (row.payee_id as string | null) ?? null,
    vendorId: (row.vendor_id as string | null) ?? null,
    payeeLabel: (row.payee_label as string | null) ?? null,
    categoryCode: String(row.category_code ?? ""),
    amountCents: Number(row.amount_cents ?? 0),
    propertyId: (row.property_id as string | null) ?? null,
    memo: (row.memo as string | null) ?? null,
    paymentMethod: (row.payment_method as string | null) ?? null,
    frequency: row.frequency as RecurrenceFrequency,
    nextDate: String(row.next_date),
    endDate: (row.end_date as string | null) ?? null,
    status: (row.status as RecurringPayable["status"]) ?? "active",
    lastGeneratedFor: (row.last_generated_for as string | null) ?? null,
  };
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

async function validate(
  db: SupabaseClient,
  managerUserId: string,
  input: RecurringPayableInput,
  scope: WorkspaceRowScope,
  partial: boolean,
): Promise<RecurringResult<Record<string, unknown>>> {
  const out: Record<string, unknown> = {};
  if (!partial || input.label !== undefined) {
    const label = str(input.label);
    if (!label) return { ok: false, status: 400, error: "label required." };
    out.label = label.slice(0, 160);
  }
  if (!partial || input.amountCents !== undefined) {
    const cents = Number(input.amountCents);
    if (!Number.isSafeInteger(cents) || cents <= 0) return { ok: false, status: 400, error: "amountCents must be a positive integer." };
    out.amount_cents = cents;
  }
  if (!partial || input.categoryCode !== undefined) {
    const code = str(input.categoryCode);
    if (!code) return { ok: false, status: 400, error: "categoryCode required." };
    out.category_code = code;
  }
  if (!partial || input.frequency !== undefined) {
    if (!isRecurrenceFrequency(input.frequency)) return { ok: false, status: 400, error: "frequency must be weekly, monthly, quarterly or annual." };
    out.frequency = input.frequency;
  }
  if (!partial || input.nextDate !== undefined) {
    if (!isIsoDate(input.nextDate)) return { ok: false, status: 400, error: "nextDate must be a valid YYYY-MM-DD date." };
    out.next_date = input.nextDate;
    out.anchor_day = Number(String(input.nextDate).slice(8, 10));
  }
  if (input.endDate !== undefined) {
    if (input.endDate !== null && input.endDate !== "" && !isIsoDate(input.endDate)) return { ok: false, status: 400, error: "endDate must be a valid YYYY-MM-DD date." };
    out.end_date = input.endDate ? input.endDate : null;
  }
  const next = (out.next_date as string | undefined) ?? undefined;
  if (next && out.end_date && String(out.end_date) < next) return { ok: false, status: 400, error: "The end date is before the next date." };
  if (input.paymentMethod !== undefined) {
    const method = str(input.paymentMethod);
    if (method && !isPaymentMethod(method)) return { ok: false, status: 400, error: "Unknown payment method." };
    out.payment_method = method;
  }
  if (input.status !== undefined) {
    if (input.status !== "active" && input.status !== "paused" && input.status !== "ended") return { ok: false, status: 400, error: "status must be active, paused or ended." };
    out.status = input.status;
  }
  if (input.memo !== undefined) out.memo = str(input.memo)?.slice(0, 500) ?? null;
  if (input.payeeLabel !== undefined) out.payee_label = str(input.payeeLabel)?.slice(0, 160) ?? null;
  if (input.payeeId !== undefined) {
    const payeeId = str(input.payeeId);
    // A payee id is a claim: it must be a live payee of THIS manager (a foreign id is the same 404).
    if (payeeId && !(await findOwnedPayee(db, managerUserId, payeeId))) return { ok: false, status: 404, error: "Payee not found." };
    out.payee_id = payeeId;
  }
  if (input.vendorId !== undefined) {
    const vendorId = str(input.vendorId);
    if (vendorId) {
      const { data } = await db.from("manager_vendor_records").select("id").eq("id", vendorId).eq("manager_user_id", managerUserId).maybeSingle();
      if (!data) return { ok: false, status: 400, error: "vendorId is not owned by this manager." };
    }
    out.vendor_id = vendorId;
  }
  if (input.propertyId !== undefined) {
    const propertyId = str(input.propertyId);
    if (propertyId && !rowAllowedInWorkspaceScope(scope, propertyId)) {
      return { ok: false, status: 400, error: "This property is outside your active workspace." };
    }
    out.property_id = propertyId;
  }
  return { ok: true, value: out };
}

export async function createRecurringPayable(
  db: SupabaseClient,
  managerUserId: string,
  input: RecurringPayableInput,
  scope: WorkspaceRowScope,
): Promise<RecurringResult<RecurringPayable>> {
  const checked = await validate(db, managerUserId, input, scope, false);
  if (!checked.ok) return checked;
  const { data, error } = await db
    .from("manager_recurring_payables")
    .insert({ ...checked.value, status: checked.value.status ?? "active", manager_user_id: managerUserId, updated_at: new Date().toISOString() })
    .select("*")
    .single();
  if (error || !data) return { ok: false, status: 500, error: error?.message ?? "Failed to create the recurring payable." };
  return { ok: true, value: rowToPayable(data as Record<string, unknown>) };
}

export async function updateRecurringPayable(
  db: SupabaseClient,
  managerUserId: string,
  id: string,
  input: RecurringPayableInput,
  scope: WorkspaceRowScope,
): Promise<RecurringResult<RecurringPayable>> {
  const { data: existing, error: readError } = await db
    .from("manager_recurring_payables").select("*").eq("id", id).eq("manager_user_id", managerUserId).maybeSingle();
  if (readError) return { ok: false, status: 500, error: readError.message };
  if (!existing || !rowAllowedInWorkspaceScope(scope, (existing as { property_id: string | null }).property_id)) {
    return { ok: false, status: 404, error: "Recurring payable not found." };
  }
  const checked = await validate(db, managerUserId, input, scope, true);
  if (!checked.ok) return checked;
  if (Object.keys(checked.value).length === 0) return { ok: false, status: 400, error: "Nothing to update." };
  const endDate = (checked.value.end_date !== undefined ? checked.value.end_date : (existing as { end_date: string | null }).end_date) as string | null;
  const nextDate = String(checked.value.next_date ?? (existing as { next_date: string }).next_date);
  if (endDate && endDate < nextDate) return { ok: false, status: 400, error: "The end date is before the next date." };
  const { data, error } = await db
    .from("manager_recurring_payables")
    .update({ ...checked.value, updated_at: new Date().toISOString() })
    .eq("id", id).eq("manager_user_id", managerUserId).select("*").maybeSingle();
  if (error || !data) return { ok: false, status: error ? 500 : 404, error: error?.message ?? "Recurring payable not found." };
  return { ok: true, value: rowToPayable(data as Record<string, unknown>) };
}

export async function listRecurringPayables(db: SupabaseClient, managerUserId: string, scope: WorkspaceRowScope): Promise<RecurringPayable[]> {
  const { data, error } = await db
    .from("manager_recurring_payables").select("*").eq("manager_user_id", managerUserId).order("next_date", { ascending: true }).limit(200);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[])
    .filter((row) => rowAllowedInWorkspaceScope(scope, row.property_id as string | null))
    .map(rowToPayable);
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export type GenerateSummary = { payables: number; generated: number; skipped: number; ended: number; errors: string[] };

/**
 * Generate every Due entry the active payables owe through `today + leadDays`, then step each schedule forward.
 * Idempotent: an occurrence that already has its entry is skipped, and the schedule still advances.
 */
export async function generateDueRecurringEntries(
  db: SupabaseClient,
  today: string,
  options: { managerUserId?: string; leadDays?: number } = {},
): Promise<GenerateSummary> {
  const horizon = addDays(today, options.leadDays ?? RECURRING_LEAD_DAYS);
  const summary: GenerateSummary = { payables: 0, generated: 0, skipped: 0, ended: 0, errors: [] };
  let query = db.from("manager_recurring_payables").select("*").eq("status", "active").lte("next_date", horizon).order("next_date", { ascending: true }).limit(500);
  if (options.managerUserId) query = query.eq("manager_user_id", options.managerUserId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);

  for (const raw of (data ?? []) as Record<string, unknown>[]) {
    const payable = rowToPayable(raw);
    const owner = String(raw.manager_user_id);
    const anchorDay = Number(raw.anchor_day ?? payable.nextDate.slice(8, 10));
    summary.payables += 1;
    let cursor = payable.nextDate;
    let last = payable.lastGeneratedFor;
    let ended = false;
    let made = 0;
    while (cursor <= horizon && made < MAX_PER_RUN) {
      if (payable.endDate && cursor > payable.endDate) { ended = true; break; }
      const { data: existing } = await db
        .from("manager_expense_entries").select("id").eq("recurring_payable_id", payable.id).eq("due_date", cursor).maybeSingle();
      if (existing) {
        summary.skipped += 1;
      } else {
        const result = await recordManualExpense(db, owner, {
          propertyId: payable.propertyId,
          categoryCode: payable.categoryCode,
          amountCents: payable.amountCents,
          expenseDate: cursor,
          memo: payable.memo || payable.label,
          vendorId: payable.vendorId,
          payeeId: payable.payeeId,
          payeeLabel: payable.payeeLabel,
          paymentStatus: "due",
          dueDate: cursor,
          paymentMethod: payable.paymentMethod,
          recurringPayableId: payable.id,
        });
        if (!result.ok) {
          // A concurrent run won the unique index: that occurrence exists, so it counts as skipped, not as an error.
          if (/duplicate|unique/i.test(result.error)) summary.skipped += 1;
          else { summary.errors.push(`${payable.id} ${cursor}: ${result.error}`); break; }
        } else {
          summary.generated += 1;
          made += 1;
        }
      }
      last = cursor;
      cursor = advanceRecurrenceDate(cursor, payable.frequency, anchorDay);
    }
    if (payable.endDate && cursor > payable.endDate) ended = true;
    if (cursor !== payable.nextDate || ended) {
      if (ended) summary.ended += 1;
      await db
        .from("manager_recurring_payables")
        .update({ next_date: cursor, last_generated_for: last, status: ended ? "ended" : "active", updated_at: new Date().toISOString() })
        .eq("id", payable.id).eq("manager_user_id", owner);
    }
  }
  return summary;
}
