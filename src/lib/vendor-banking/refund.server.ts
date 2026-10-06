import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { findPlatformHold, refundPlatformHold } from "@/lib/stripe-platform-hold.server";
import { directInvoiceHoldSourceId } from "@/lib/stripe-platform-hold";
import {
  applyVendorBankingPayoutRefund,
  getVendorBankingPayoutForVendor,
  refundableGrossCents,
  type VendorBankingPayoutRow,
} from "@/lib/vendor-banking/payouts.server";
import { recordVendorBankingLedgerEntry } from "@/lib/vendor-banking/ledger.server";
import { recordVendorBankingShortfall } from "@/lib/vendor-banking/shortfall.server";

export type VendorRefundPreview = {
  requestedGrossCents: number;
  feeShareCents: number;
  netDebitCents: number; // what the vendor's balance gives up (gross - fee share)
  managerReceivesCents: number; // == requestedGrossCents
};

/** Pure preview math the modal shows live — no Stripe call, no db write. */
export function previewVendorRefund(
  payout: Pick<VendorBankingPayoutRow, "amountCents" | "platformFeeCents" | "refundedGrossCents">,
  requestedGrossCents: number,
): VendorRefundPreview {
  const gross = Math.max(0, Math.min(Math.round(requestedGrossCents), refundableGrossCents(payout)));
  const feeShareCents =
    payout.amountCents > 0 ? Math.round((gross * payout.platformFeeCents) / payout.amountCents) : 0;
  return {
    requestedGrossCents: gross,
    feeShareCents,
    netDebitCents: Math.max(0, gross - feeShareCents),
    managerReceivesCents: gross,
  };
}

export type VendorRefundResult =
  | {
      ok: true;
      status: "refunded" | "partially_refunded";
      requestedGrossCents: number;
      feeShareCents: number;
      netDebitCents: number;
      shortfallCents: number;
    }
  | { ok: false; status: 400 | 403 | 404 | 409 | 422; error: string };

/**
 * Vendor-initiated refund of a payout they own. Two real Stripe shapes:
 *
 * - `destination_charge` (bank was ready at pay time): one
 *   `refunds.create({ charge, amount, reverse_transfer: true,
 *   refund_application_fee: true })` — Stripe claws back the destination
 *   transfer AND the retained application fee proportionally in one call.
 * - `hold`: the original charge sat on the platform with no
 *   `transfer_data`, so `reverse_transfer` doesn't apply. If the hold is
 *   still `held` (not yet transferred), a plain platform refund is enough —
 *   nothing left the platform. If it already `transferred` (the vendor
 *   added a bank after being paid, and the hold auto-moved), the refund of
 *   the platform charge returns the manager's money, and a SEPARATE
 *   `transfers.createReversal` on that hold's own transfer claws the net
 *   amount back from the vendor's connected account.
 *
 * If the claw-back leg fails (commonly: insufficient balance on the
 * vendor's connected account), the manager is refunded regardless and the
 * uncoverable amount is recorded as a shortfall to draw down from the
 * vendor's next settled payment (VD51) — a refund is never silently
 * refused just because the vendor already spent the money.
 */
export async function refundVendorPayout(
  stripe: Stripe,
  db: SupabaseClient,
  opts: { payoutId: string; vendorUserId: string; requestedGrossCents?: number; reason?: string; idempotencyKey: string },
): Promise<VendorRefundResult> {
  const payout = await getVendorBankingPayoutForVendor(db, { payoutId: opts.payoutId, vendorUserId: opts.vendorUserId });
  if (!payout) return { ok: false, status: 404, error: "Payment not found." };
  if (payout.status !== "paid" && payout.status !== "partially_refunded") {
    return { ok: false, status: 409, error: `This payment is ${payout.status} and cannot be refunded.` };
  }
  const maxRefundable = refundableGrossCents(payout);
  if (maxRefundable <= 0) return { ok: false, status: 409, error: "This payment has already been fully refunded." };

  const requested = Math.round(opts.requestedGrossCents ?? maxRefundable);
  if (!Number.isFinite(requested) || requested <= 0) {
    return { ok: false, status: 400, error: "Enter an amount greater than $0." };
  }
  if (requested > maxRefundable) {
    return { ok: false, status: 422, error: `At most $${(maxRefundable / 100).toFixed(2)} can still be refunded.` };
  }
  if (!payout.stripeChargeId) {
    return { ok: false, status: 422, error: "No Stripe charge is on file for this payment." };
  }

  const preview = previewVendorRefund(payout, requested);
  const idk = opts.idempotencyKey.trim() || `refund:${opts.payoutId}:${requested}`;

  let clawedBackCents = 0;
  if (payout.destination === "destination_charge") {
    await stripe.refunds.create(
      {
        charge: payout.stripeChargeId,
        amount: preview.requestedGrossCents,
        reverse_transfer: true,
        refund_application_fee: true,
        reason: mapRefundReason(opts.reason),
      },
      { idempotencyKey: `${idk}:refund` },
    );
    clawedBackCents = preview.netDebitCents;
  } else {
    // hold path — refund the platform charge (never a partial guess: exactly the requested amount).
    await stripe.refunds.create(
      { charge: payout.stripeChargeId, amount: preview.requestedGrossCents, reason: mapRefundReason(opts.reason) },
      { idempotencyKey: `${idk}:refund` },
    );
    const sourceId = payout.invoiceId ? directInvoiceHoldSourceId(payout.invoiceId) : (payout.workOrderId ?? "");
    const hold = sourceId ? await findPlatformHold(db, "vendor_invoice", sourceId).catch(() => null) : null;
    if (hold?.status === "transferred" && hold.stripeTransferId) {
      try {
        await stripe.transfers.createReversal(
          hold.stripeTransferId,
          { amount: preview.netDebitCents },
          { idempotencyKey: `${idk}:reversal` },
        );
        clawedBackCents = preview.netDebitCents;
      } catch (e) {
        console.error(`[vendor-banking] transfer reversal failed for payout ${payout.id}:`, e instanceof Error ? e.message : e);
        clawedBackCents = 0;
      }
    } else if (hold?.status === "held") {
      // Nothing ever left the platform for this specific hold — the whole
      // requested amount was already clawed back by the platform refund
      // above, so there is nothing further to claim from the vendor.
      clawedBackCents = preview.netDebitCents;
      if (requested >= maxRefundable) {
        await refundPlatformHold(db, "vendor_invoice", sourceId).catch(() => undefined);
      }
    }
  }

  const shortfallCents = Math.max(0, preview.netDebitCents - clawedBackCents);
  if (shortfallCents > 0) {
    await recordVendorBankingShortfall(db, opts.vendorUserId, shortfallCents);
  }

  const applied = await applyVendorBankingPayoutRefund(db, {
    payoutId: payout.id,
    refundGrossCents: preview.requestedGrossCents,
    refundFeeCents: preview.feeShareCents,
  });
  if (!applied.ok) return { ok: false, status: 422, error: applied.error };

  await recordVendorBankingLedgerEntry(db, {
    vendorUserId: opts.vendorUserId,
    managerUserId: payout.managerUserId,
    kind: "refund",
    amountCents: -preview.netDebitCents,
    source: "refund",
    sourceId: payout.id,
    description: opts.reason?.trim() ? `Refund — ${opts.reason.trim()}` : "Refund",
    stripeObjectId: payout.stripeChargeId,
    idempotencyKey: `${idk}:ledger_refund`,
  });
  if (preview.feeShareCents > 0) {
    await recordVendorBankingLedgerEntry(db, {
      vendorUserId: opts.vendorUserId,
      managerUserId: payout.managerUserId,
      kind: "adjustment",
      amountCents: preview.feeShareCents,
      source: "refund",
      sourceId: payout.id,
      description: "PropLane fee refunded proportionally",
      stripeObjectId: payout.stripeChargeId,
      idempotencyKey: `${idk}:ledger_fee_reversal`,
    });
  }
  if (shortfallCents > 0) {
    await recordVendorBankingLedgerEntry(db, {
      vendorUserId: opts.vendorUserId,
      managerUserId: payout.managerUserId,
      kind: "adjustment",
      amountCents: -shortfallCents,
      source: "refund",
      sourceId: payout.id,
      description: "Refund shortfall — deducted from your next payments",
      idempotencyKey: `${idk}:ledger_shortfall`,
    });
  }

  return {
    ok: true,
    status: applied.status,
    requestedGrossCents: preview.requestedGrossCents,
    feeShareCents: preview.feeShareCents,
    netDebitCents: preview.netDebitCents,
    shortfallCents,
  };
}

function mapRefundReason(reason: string | undefined): Stripe.RefundCreateParams.Reason | undefined {
  const r = reason?.trim().toLowerCase();
  if (r === "duplicate" || r === "fraudulent" || r === "requested_by_customer") return r;
  return undefined;
}
