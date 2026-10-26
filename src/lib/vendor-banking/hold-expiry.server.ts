import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { refundPlatformHold } from "@/lib/stripe-platform-hold.server";
import type { PlatformHoldRow } from "@/lib/stripe-platform-hold";
import { directInvoiceIdFromHoldSourceId } from "@/lib/stripe-platform-hold";
import { recordVendorBankingLedgerEntry } from "@/lib/vendor-banking/ledger.server";
import { recordVendorServiceFeeRevenueReversal } from "@/lib/vendor-banking/platform-revenue.server";
import { PROPLANE_SERVICE_FEE_LABEL } from "@/lib/platform-fees";
import { submitVendorRefund } from "@/lib/vendor-banking/central-refund.server";
import {
  HOLD_EXPIRY_DAYS,
  notifyHoldReturned,
  resolvePayerForHold,
} from "@/lib/vendor-banking/hold-expiry-notice.server";

export { HOLD_EXPIRY_DAYS };

/**
 * Every unclaimed vendor_invoice-sourced hold older than the cutoff — VD58's 90-day cap.
 * Central vendor-invoice holds are born `classified_held`; legacy ones are `held`. A hold
 * that already carries a transfer id has left the platform and is never listed.
 */
export async function listExpiredVendorHolds(db: SupabaseClient, now: Date = new Date()): Promise<PlatformHoldRow[]> {
  const cutoffIso = new Date(now.getTime() - HOLD_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db
    .from("platform_payment_holds")
    .select("id, owner_user_id, owner_role, source, source_id, amount_cents, status, stripe_charge_id, stripe_transfer_id, created_at")
    .eq("source", "vendor_invoice")
    .in("status", ["held", "classified_held"])
    .is("stripe_transfer_id", null)
    .lt("created_at", cutoffIso);
  if (error) throw new Error(`Could not list expired vendor holds: ${error.message}`);
  return (data ?? []).map((row) => ({
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    ownerRole: row.owner_role,
    source: row.source,
    sourceId: String(row.source_id),
    amountCents: Number(row.amount_cents) || 0,
    status: row.status,
    stripeChargeId: row.stripe_charge_id,
    stripeTransferId: row.stripe_transfer_id,
    createdAt: row.created_at,
  })) as PlatformHoldRow[];
}

/** Reads back the EXACT gross charge + fee amounts this vendor's ledger already recorded for this source id — never re-derived, so the reversal matches what actually happened to the cent. */
async function readOriginalChargeAndFee(
  db: SupabaseClient,
  vendorUserId: string,
  sourceId: string,
): Promise<{ grossCents: number; feeCents: number }> {
  const { data, error } = await db
    .from("vendor_banking_ledger_entries")
    .select("kind, amount_cents")
    .eq("vendor_user_id", vendorUserId)
    .eq("source_id", directInvoiceIdFromHoldSourceId(sourceId) ?? sourceId)
    .in("kind", ["charge", "platform_fee"]);
  if (error) return { grossCents: 0, feeCents: 0 };
  let grossCents = 0;
  let feeCents = 0;
  for (const row of (data ?? []) as Array<{ kind: string; amount_cents: number }>) {
    if (row.kind === "charge") grossCents += Number(row.amount_cents) || 0;
    if (row.kind === "platform_fee") feeCents += Math.abs(Number(row.amount_cents) || 0);
  }
  return { grossCents, feeCents };
}

export type HoldExpiryResult = {
  checked: number;
  /** Holds whose money is back with the manager (the provider refund reached `succeeded`). */
  returned: number;
  /** Refunds Stripe has not settled yet: nobody is told until they do, and the next pass replays the same attempt key. */
  pending: number;
  failed: number;
  /** Holds the rail can never return on its own (no payout row): they need a human, not another pass. */
  stuck: number;
  errors: string[];
};

/**
 * The scheduled 90-day hold-expiry job (VD58, captain's recommended option):
 * a vendor_invoice-sourced hold still unclaimed after 90 days is returned to
 * the manager who paid it — a full refund of the original Stripe charge
 * (never a partial guess) — and the hold is marked `refunded`. Reverses the
 * earlier charge/fee ledger lines so the vendor's statement nets back to
 * zero for a payment they never actually received. Best-effort per hold: one
 * failure never blocks the rest.
 */
export async function expireVendorHolds(stripe: Stripe, db: SupabaseClient, now: Date = new Date()): Promise<HoldExpiryResult> {
  const holds = await listExpiredVendorHolds(db, now);
  const result: HoldExpiryResult = { checked: holds.length, returned: 0, pending: 0, failed: 0, stuck: 0, errors: [] };

  for (const hold of holds) {
    try {
      if (hold.status === "classified_held") {
        // A central hold carries reserved balance + source-consumption rows: only the
        // central refund rail may return it (a raw Stripe refund would strand them).
        const { data: payoutRow, error: payoutError } = await db
          .from("vendor_payouts")
          .select("id")
          .eq("platform_hold_id", hold.id)
          .eq("vendor_user_id", hold.ownerUserId)
          .limit(1)
          .maybeSingle();
        const payoutId = (payoutRow as { id?: string } | null)?.id;
        if (payoutError || !payoutId) {
          // No payout row means the central rail has nothing to refund through, and no later pass
          // will change that: counted apart from a transient failure so a stuck hold is visible
          // instead of one more repeating error line.
          result.stuck += 1;
          result.errors.push(`hold ${hold.id}: no payout row to refund through the central rail`);
          console.error(`[vendor-banking] hold ${hold.id} is stuck: no vendor_payouts row to refund through; it needs review.`);
          continue;
        }
        const refund = await submitVendorRefund(stripe, db, {
          payoutId,
          vendorUserId: hold.ownerUserId,
          reason: `Unclaimed after ${HOLD_EXPIRY_DAYS} days`,
          clientKey: hold.id,
          initiatedBy: "hold_expiry",
        });
        if (refund.ok && refund.status === "pending") {
          // Stripe has not settled it: nothing has reached the manager yet, so neither party is
          // told it was "refunded back to you". The hold keeps its status, so the next pass replays
          // the same attempt key, and whichever half sees it succeed sends the notice.
          result.pending += 1;
        } else if (refund.ok) {
          result.returned += 1;
          // Money has moved: a notice problem never turns this into a failure. The manager is
          // refunded the full gross (incl. PropLane's fee), not the vendor's net hold.
          try {
            const { managerUserId, label } = await resolvePayerForHold(db, hold);
            await notifyHoldReturned(db, hold, managerUserId, label, refund.grossCents);
          } catch (e) {
            console.error(`[vendor-banking] hold expiry notice failed for ${hold.id}:`, e instanceof Error ? e.message : e);
          }
        } else {
          result.failed += 1;
          result.errors.push(`hold ${hold.id}: ${refund.error}`);
        }
        continue;
      }
      if (!hold.stripeChargeId) {
        result.failed += 1;
        result.errors.push(`hold ${hold.id}: no stripe_charge_id on file, cannot refund`);
        continue;
      }
      await stripe.refunds.create(
        { charge: hold.stripeChargeId, reason: "requested_by_customer" },
        { idempotencyKey: `hold-expiry:${hold.id}` },
      );
      await refundPlatformHold(db, hold.source, hold.sourceId);

      const { managerUserId, label } = await resolvePayerForHold(db, hold);

      // Reverse the earlier charge (gross credit) and platform_fee (debit)
      // by their EXACT original amounts (read back, never re-derived) so the
      // statement nets to zero for a payment the vendor never actually
      // received — the whole point of "return to the manager", including
      // PropLane's own fee.
      const { grossCents, feeCents } = await readOriginalChargeAndFee(db, hold.ownerUserId, hold.sourceId);
      await recordVendorBankingLedgerEntry(db, {
        vendorUserId: hold.ownerUserId,
        managerUserId,
        kind: "refund",
        amountCents: -(grossCents || hold.amountCents),
        source: "hold_expiry",
        sourceId: hold.sourceId,
        description: `Returned to the manager — unclaimed after ${HOLD_EXPIRY_DAYS} days`,
        stripeObjectId: hold.stripeChargeId,
        idempotencyKey: `hold_expiry:${hold.id}:refund`,
      });
      if (feeCents > 0) {
        await recordVendorBankingLedgerEntry(db, {
          vendorUserId: hold.ownerUserId,
          managerUserId,
          kind: "adjustment",
          amountCents: feeCents, // gives back PropLane's own fee on a payment that was never actually delivered
          source: "hold_expiry",
          sourceId: hold.sourceId,
          description: `${PROPLANE_SERVICE_FEE_LABEL} reversed — payment returned unclaimed`,
          stripeObjectId: hold.stripeChargeId,
          idempotencyKey: `hold_expiry:${hold.id}:fee_reversal`,
        });
        await recordVendorServiceFeeRevenueReversal(db, {
          vendorUserId: hold.ownerUserId,
          managerUserId,
          feeCents,
          source: "hold_expiry",
          sourceId: hold.sourceId,
          reversalId: hold.id,
        });
      }

      result.returned += 1;

      await notifyHoldReturned(db, hold, managerUserId, label, hold.amountCents);
    } catch (e) {
      result.failed += 1;
      const message = e instanceof Error ? e.message : String(e);
      result.errors.push(`hold ${hold.id}: ${message}`);
      console.error(`[vendor-banking] hold expiry failed for ${hold.id}:`, message);
    }
  }
  return result;
}
