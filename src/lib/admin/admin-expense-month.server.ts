import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllPages } from "@/lib/auth/admin-portal-manager-ids.server";
import { isRevenueMonth, shiftMonth } from "@/lib/admin/admin-revenue-model";

/**
 * What PropLane spent in one month, for the Dashboard's Profit card.
 *
 * `platform_expenses` (created by the Finances work: amount_cents, spent_on, recurrence
 * none|monthly|yearly, ends_on) is read DEFENSIVELY: the table may not exist on a database the
 * migration has not reached, and a profit computed from an unreadable expenses table would be
 * revenue masquerading as profit. Any failure is `null`, which omits the card.
 */
export type ExpenseRow = {
  amount_cents: number | string | null;
  spent_on: string | null;
  recurrence: string | null;
  ends_on: string | null;
};

/** Does this expense occur in `month` (`YYYY-MM`)? One-time in its month; recurring from `spent_on` until `ends_on`. */
export function expenseOccursInMonth(row: ExpenseRow, month: string): boolean {
  if (!isRevenueMonth(month) || !row.spent_on) return false;
  const start = `${month}-01`;
  const next = `${shiftMonth(month, 1)}-01`;
  const spent = row.spent_on.slice(0, 10);
  const recurrence = String(row.recurrence ?? "none").toLowerCase();
  if (recurrence === "none") return spent >= start && spent < next;
  if (spent >= next) return false;
  if (row.ends_on && row.ends_on.slice(0, 10) < start) return false;
  if (recurrence === "monthly") return true;
  if (recurrence === "yearly") return spent.slice(5, 7) === month.slice(5, 7);
  return false;
}

/** Sum of the expenses that occur in `month`, in cents. */
export function sumExpensesForMonth(rows: readonly ExpenseRow[], month: string): number {
  let total = 0;
  for (const row of rows) {
    if (!expenseOccursInMonth(row, month)) continue;
    const cents = Number(row.amount_cents);
    if (Number.isFinite(cents) && cents > 0) total += Math.round(cents);
  }
  return total;
}

export async function loadMonthExpensesCents(db: SupabaseClient, month: string): Promise<number | null> {
  try {
    const rows = await readAllPages<ExpenseRow>((from, to) =>
      db
        .from("platform_expenses")
        .select("amount_cents, spent_on, recurrence, ends_on")
        .order("id")
        .range(from, to),
    );
    return sumExpensesForMonth(rows, month);
  } catch {
    return null;
  }
}
