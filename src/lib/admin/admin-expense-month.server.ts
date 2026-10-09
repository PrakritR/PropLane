import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllPages } from "@/lib/auth/admin-portal-manager-ids.server";
import { isRevenueMonth } from "@/lib/admin/admin-revenue-model";
import { EXPENSE_RECURRENCES, expenseDateInMonth, type ExpenseRecurrence } from "@/lib/admin/platform-expense-rules";

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

function recurrenceOf(raw: unknown): ExpenseRecurrence {
  const value = String(raw ?? "none").toLowerCase();
  return (EXPENSE_RECURRENCES as readonly string[]).includes(value) ? (value as ExpenseRecurrence) : "none";
}

/**
 * Does this expense occur in `month` (`YYYY-MM`)?
 *
 * The rule is `expenseDateInMonth` in `platform-expense-rules` — the one the Finances page expands
 * its months with — so the Dashboard's Profit card and Finances can never disagree. Deciding it a
 * second time here is how a monthly expense charged on the 20th with `ends_on` the 10th became a
 * phantom charge on one surface and not the other.
 */
export function expenseOccursInMonth(row: ExpenseRow, month: string): boolean {
  if (!isRevenueMonth(month) || !row.spent_on) return false;
  return (
    expenseDateInMonth(
      {
        spentOn: row.spent_on.slice(0, 10),
        recurrence: recurrenceOf(row.recurrence),
        endsOn: row.ends_on ? row.ends_on.slice(0, 10) : null,
      },
      month,
    ) !== null
  );
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
