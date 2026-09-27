import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * When a refund's vendor-side debit exceeds what can actually be clawed back
 * right now, the uncoverable remainder is recorded here rather than left
 * unrecorded or silently refused — "Deduct the difference from your next
 * payments" (VD51). Atomic (a Postgres function, same style as
 * proplane_balance_move) so a concurrent refund/settle pair can't race the
 * running total.
 */
export async function recordVendorBankingShortfall(
  db: SupabaseClient,
  vendorUserId: string,
  cents: number,
): Promise<number> {
  if (!Number.isFinite(cents) || cents <= 0) return 0;
  const { data, error } = await db.rpc("vendor_banking_add_shortfall", {
    p_vendor_user_id: vendorUserId,
    p_cents: Math.round(cents),
  });
  if (error) throw new Error(`Could not record the refund shortfall: ${error.message}`);
  return Number(data) || 0;
}

/**
 * Draws down up to `availableCents` from the vendor's outstanding shortfall
 * (if any) and returns how much was actually applied. Call this BEFORE
 * crediting a new settled payment so the shortfall is repaid out of the
 * vendor's own future earnings, never out of thin air.
 */
export async function drawDownVendorBankingShortfall(
  db: SupabaseClient,
  vendorUserId: string,
  availableCents: number,
): Promise<number> {
  if (!Number.isFinite(availableCents) || availableCents <= 0) return 0;
  const { data, error } = await db.rpc("vendor_banking_drawdown_shortfall", {
    p_vendor_user_id: vendorUserId,
    p_available_cents: Math.round(availableCents),
  });
  if (error) throw new Error(`Could not draw down the refund shortfall: ${error.message}`);
  return Number(data) || 0;
}

export async function readVendorBankingOutstandingShortfall(
  db: SupabaseClient,
  vendorUserId: string,
): Promise<number> {
  const { data, error } = await db
    .from("vendor_banking_shortfalls")
    .select("outstanding_cents")
    .eq("vendor_user_id", vendorUserId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the refund shortfall: ${error.message}`);
  return Number((data as { outstanding_cents?: number } | null)?.outstanding_cents ?? 0);
}
