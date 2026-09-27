import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

export type VendorBankingPayoutDestination = "destination_charge" | "hold";

export type VendorBankingPayoutRow = {
  id: string;
  managerUserId: string;
  vendorUserId: string;
  workOrderId: string | null;
  invoiceId: string | null;
  amountCents: number;
  platformFeeCents: number;
  refundedGrossCents: number;
  refundedFeeCents: number;
  status: string;
  destination: VendorBankingPayoutDestination | null;
  stripeChargeId: string | null;
  stripeTransferId: string | null;
  createdAt: string;
};

const SELECT =
  "id, manager_user_id, vendor_user_id, work_order_id, invoice_id, amount_cents, platform_fee_cents, refunded_gross_cents, refunded_fee_cents, status, destination, stripe_charge_id, stripe_transfer_id, created_at";

function fromRow(row: Record<string, unknown>): VendorBankingPayoutRow {
  return {
    id: String(row.id),
    managerUserId: String(row.manager_user_id),
    vendorUserId: String(row.vendor_user_id),
    workOrderId: (row.work_order_id as string | null) ?? null,
    invoiceId: (row.invoice_id as string | null) ?? null,
    amountCents: Number(row.amount_cents) || 0,
    platformFeeCents: Number(row.platform_fee_cents) || 0,
    refundedGrossCents: Number(row.refunded_gross_cents) || 0,
    refundedFeeCents: Number(row.refunded_fee_cents) || 0,
    status: String(row.status),
    destination: (row.destination as VendorBankingPayoutDestination | null) ?? null,
    stripeChargeId: (row.stripe_charge_id as string | null) ?? null,
    stripeTransferId: (row.stripe_transfer_id as string | null) ?? null,
    createdAt: String(row.created_at),
  };
}

/** The vendor's own payout row, scoped so vendor A can never read/refund vendor B's row. */
export async function getVendorBankingPayoutForVendor(
  db: SupabaseClient,
  opts: { payoutId: string; vendorUserId: string },
): Promise<VendorBankingPayoutRow | null> {
  const { data, error } = await db
    .from("vendor_payouts")
    .select(SELECT)
    .eq("id", opts.payoutId)
    .eq("vendor_user_id", opts.vendorUserId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? fromRow(data as Record<string, unknown>) : null;
}

/** Every settled payout for this vendor, newest first — the Payments list' underlying rows. */
export async function listVendorBankingPayoutsForVendor(
  db: SupabaseClient,
  vendorUserId: string,
  limit = 200,
): Promise<VendorBankingPayoutRow[]> {
  const { data, error } = await db
    .from("vendor_payouts")
    .select(SELECT)
    .eq("vendor_user_id", vendorUserId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => fromRow(row as Record<string, unknown>));
}

/** The gross amount still eligible for refund on this payout — never negative. */
export function refundableGrossCents(row: Pick<VendorBankingPayoutRow, "amountCents" | "refundedGrossCents">): number {
  return Math.max(0, row.amountCents - row.refundedGrossCents);
}

/**
 * Records a refund against a payout's running totals and flips status to
 * `refunded` (fully) or `partially_refunded`. Pure arithmetic — the caller
 * has already done the real Stripe refund/reversal before calling this.
 */
export async function applyVendorBankingPayoutRefund(
  db: SupabaseClient,
  opts: { payoutId: string; refundGrossCents: number; refundFeeCents: number },
): Promise<{ ok: true; status: "refunded" | "partially_refunded" } | { ok: false; error: string }> {
  const { data: current, error: readError } = await db
    .from("vendor_payouts")
    .select("amount_cents, refunded_gross_cents, refunded_fee_cents")
    .eq("id", opts.payoutId)
    .maybeSingle();
  if (readError) return { ok: false, error: readError.message };
  if (!current) return { ok: false, error: "Payout not found." };
  const row = current as { amount_cents: number; refunded_gross_cents: number; refunded_fee_cents: number };
  const newRefundedGross = Number(row.refunded_gross_cents) + opts.refundGrossCents;
  const newRefundedFee = Number(row.refunded_fee_cents) + opts.refundFeeCents;
  const status: "refunded" | "partially_refunded" =
    newRefundedGross >= Number(row.amount_cents) ? "refunded" : "partially_refunded";
  const { error: updateError } = await db
    .from("vendor_payouts")
    .update({
      refunded_gross_cents: newRefundedGross,
      refunded_fee_cents: newRefundedFee,
      status,
      updated_at: new Date().toISOString(),
    })
    .eq("id", opts.payoutId);
  if (updateError) return { ok: false, error: updateError.message };
  return { ok: true, status };
}
