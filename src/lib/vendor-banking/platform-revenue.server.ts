import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { vendorServiceFeeDescription } from "@/lib/platform-fees";

/**
 * PropLane's own revenue from the vendor service fee, written through next to
 * the vendor statement fee line (see ledger.server.ts). The statement debit is
 * the vendor's view of the fee; `platform_revenue_entries` is PropLane's. It is
 * a record of what already happened, never a source of new money.
 *
 * Deliberately NOT gated on VENDOR_BANKING_ENABLED here: the flag decides
 * whether a fee is ever TAKEN (`vendorPayFeeBps` -> 0 when off, so a flag-off
 * checkout freezes fee 0 and nothing is booked). Once a fee has been frozen
 * into a Checkout and charged, the revenue is real even if the flag is flipped
 * before settlement, exactly like the vendor statement fee line, which is also
 * written whenever the settled fee is positive.
 *
 * Both writers are idempotent on a deterministic key and MUST NOT throw into
 * the payment path: a missing table (migration unapplied) or any other failure
 * returns `{ ok: false }` and logs, and the payment still settles.
 */

export type PlatformRevenueResult = { ok: true; recorded: boolean } | { ok: false };

type FeeSource = "work_order" | "invoice";
type ReversalSource = "refund" | "hold_expiry";

function isUniqueViolation(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "23505") return true;
  return /duplicate key|unique constraint/i.test(error.message ?? "");
}

async function insertRevenue(
  db: SupabaseClient,
  row: {
    kind: "vendor_service_fee" | "vendor_service_fee_reversal";
    amountCents: number;
    vendorUserId: string | null;
    managerUserId: string | null;
    source: FeeSource | ReversalSource;
    sourceId: string;
    idempotencyKey: string;
    description: string;
  },
): Promise<PlatformRevenueResult> {
  try {
    const { error } = await db.from("platform_revenue_entries").insert({
      kind: row.kind,
      amount_cents: row.amountCents,
      vendor_user_id: row.vendorUserId,
      manager_user_id: row.managerUserId,
      source: row.source,
      source_id: row.sourceId,
      idempotency_key: row.idempotencyKey,
      description: row.description,
    });
    if (error) {
      if (isUniqueViolation(error)) return { ok: true, recorded: false };
      console.error(`[vendor-banking] platform revenue entry ${row.idempotencyKey} failed:`, error.message);
      return { ok: false };
    }
    return { ok: true, recorded: true };
  } catch (e) {
    console.error(`[vendor-banking] platform revenue entry ${row.idempotencyKey} failed:`, e instanceof Error ? e.message : e);
    return { ok: false };
  }
}

/** Books the fee taken on one settled Stripe-rail vendor payment as platform revenue. */
export async function recordVendorServiceFeeRevenue(
  db: SupabaseClient,
  opts: {
    vendorUserId: string | null;
    managerUserId: string | null;
    feeCents: number;
    source: FeeSource;
    sourceId: string;
  },
): Promise<PlatformRevenueResult> {
  const feeCents = Math.round(opts.feeCents);
  if (!Number.isFinite(feeCents) || feeCents <= 0) {
    return { ok: true, recorded: false };
  }
  return insertRevenue(db, {
    kind: "vendor_service_fee",
    amountCents: feeCents,
    vendorUserId: opts.vendorUserId,
    managerUserId: opts.managerUserId,
    source: opts.source,
    sourceId: opts.sourceId,
    idempotencyKey: `vendor_service_fee:${opts.source}:${opts.sourceId}`,
    description: vendorServiceFeeDescription(),
  });
}

/**
 * Books the give-back of that fee (refund share, or an expired hold returned
 * to the manager) as a negative revenue entry. `reversalId` is the refund
 * request key or the hold id: one reversal per refund, never per payment, so a
 * second partial refund is its own entry.
 */
export async function recordVendorServiceFeeRevenueReversal(
  db: SupabaseClient,
  opts: {
    vendorUserId: string | null;
    managerUserId: string | null;
    feeCents: number;
    source: ReversalSource;
    sourceId: string;
    reversalId: string;
  },
): Promise<PlatformRevenueResult> {
  const feeCents = Math.round(opts.feeCents);
  if (!Number.isFinite(feeCents) || feeCents <= 0) {
    return { ok: true, recorded: false };
  }
  return insertRevenue(db, {
    kind: "vendor_service_fee_reversal",
    amountCents: -feeCents,
    vendorUserId: opts.vendorUserId,
    managerUserId: opts.managerUserId,
    source: opts.source,
    sourceId: opts.sourceId,
    idempotencyKey: `vendor_service_fee_reversal:${opts.source}:${opts.reversalId}`,
    description: `${vendorServiceFeeDescription()} reversed`,
  });
}
