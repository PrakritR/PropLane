import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  findDuplicatePayments,
  type DuplicateMatch,
  type PaymentFingerprint,
} from "@/lib/finance/duplicate-payment";
import { rowAllowedInWorkspaceScope, type WorkspaceRowScope } from "@/lib/workspaces/row-scope.server";

type HistoryRow = {
  id: string;
  property_id: string | null;
  vendor_id: string | null;
  payee_id: string | null;
  payee_label: string | null;
  memo: string | null;
  amount_cents: number | string;
  expense_date: string;
  paid_date: string | null;
  billing_period_start: string | null;
  billing_period_end: string | null;
};

/**
 * The owner's paid expenses of the SAME amount, as fingerprints. The amount is the index: a candidate can
 * only duplicate a payment of exactly its own amount, so the read is bounded and never scans the ledger.
 * When the active workspace narrows to a set of houses, history outside it is out of scope (the books of
 * another workspace are not this workspace's duplicates).
 */
export async function findDuplicateExpenses(
  db: SupabaseClient,
  managerUserId: string,
  candidate: PaymentFingerprint,
  scope?: WorkspaceRowScope,
): Promise<DuplicateMatch[]> {
  const { data, error } = await db
    .from("manager_expense_entries")
    .select(
      "id, property_id, vendor_id, payee_id, payee_label, memo, amount_cents, expense_date, paid_date, billing_period_start, billing_period_end",
    )
    .eq("manager_user_id", managerUserId)
    .eq("payment_status", "paid")
    .eq("amount_cents", candidate.amountCents)
    .order("expense_date", { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  const history: PaymentFingerprint[] = ((data ?? []) as HistoryRow[])
    .filter((row) => !scope || rowAllowedInWorkspaceScope(scope, row.property_id))
    .map((row) => ({
      id: row.id,
      amountCents: Number(row.amount_cents),
      propertyId: row.property_id,
      vendorId: row.vendor_id,
      payeeId: row.payee_id,
      payeeLabel: row.payee_label,
      memo: row.memo,
      paidDate: row.paid_date || row.expense_date,
      billingPeriodStart: row.billing_period_start,
      billingPeriodEnd: row.billing_period_end,
    }));
  return findDuplicatePayments(candidate, history);
}
