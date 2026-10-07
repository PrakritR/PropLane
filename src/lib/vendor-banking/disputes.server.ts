import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { recordVendorBankingLedgerEntry } from "@/lib/vendor-banking/ledger.server";
import { recordVendorBankingShortfall } from "@/lib/vendor-banking/shortfall.server";
import { emitVendorBankingEvent } from "@/lib/vendor-banking/events.server";
import {
  disputeOutcomeForStatus,
  frozenCentsForDispute,
  isOpenDisputeStatus,
  lostDisputeVendorDebitCents,
} from "@/lib/vendor-banking/disputes";

type PayoutForDispute = {
  id: string;
  vendor_user_id: string;
  manager_user_id: string;
  amount_cents: number;
  platform_fee_cents: number;
  refunded_gross_cents: number;
};

type DisputeRow = {
  id: string;
  frozen_cents: number;
  outcome: string | null;
  opened_notified_at: string | null;
  closed_notified_at: string | null;
};

/** Cents frozen by every open dispute on this vendor's charges: neither withdrawable nor refundable. */
export async function readVendorFrozenDisputeCents(db: SupabaseClient, vendorUserId: string): Promise<number> {
  const { data, error } = await db
    .from("vendor_banking_disputes")
    .select("frozen_cents")
    .eq("vendor_user_id", vendorUserId)
    .gt("frozen_cents", 0);
  if (error) throw new Error(`Could not read frozen dispute amounts: ${error.message}`);
  return (data ?? []).reduce((sum, row) => sum + (Number((row as { frozen_cents: number }).frozen_cents) || 0), 0);
}

/**
 * `charge.dispute.created|updated|closed` for a charge a vendor payout settled on.
 * Returns true when the charge is a vendor payout's (the caller then skips the manager
 * rent-dispute and communication-credit paths). Idempotent: a redelivery or an
 * out-of-order `updated` after `closed` changes nothing.
 *
 * Open: the disputed amount (capped at the payment) is frozen on the dispute row. It is
 * deliberately NOT a ledger line: the statement tracks Stripe's real balance, and a freeze
 * moves none. Closed won: the freeze clears. Closed lost: one debit line on the vendor
 * statement and the same amount recorded as a shortfall drawn from their next payments,
 * the same way a refund the vendor cannot cover is.
 */
export async function handleVendorBankingDispute(db: SupabaseClient, dispute: Stripe.Dispute): Promise<boolean> {
  const stripeChargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id;
  if (!stripeChargeId || !dispute.id) return false;

  const { data: payouts, error: payoutError } = await db
    .from("vendor_payouts")
    .select("id, vendor_user_id, manager_user_id, amount_cents, platform_fee_cents, refunded_gross_cents")
    .eq("stripe_charge_id", stripeChargeId)
    .limit(2);
  if (payoutError) throw new Error(`Could not resolve the disputed vendor payment: ${payoutError.message}`);
  if (!payouts || payouts.length === 0) return false;
  if (payouts.length > 1) throw new Error("A disputed charge matches more than one vendor payment; it needs review.");
  const payout = payouts[0] as PayoutForDispute;

  const open = isOpenDisputeStatus(dispute.status);
  const outcome = disputeOutcomeForStatus(dispute.status);

  const { data: existingData, error: existingError } = await db
    .from("vendor_banking_disputes")
    .select("id, frozen_cents, outcome, opened_notified_at, closed_notified_at")
    .eq("stripe_dispute_id", dispute.id)
    .maybeSingle();
  if (existingError) throw new Error(`Could not read the dispute record: ${existingError.message}`);
  const existing = existingData as DisputeRow | null;

  // A closed dispute never reopens: a late `updated` delivered after `closed` is stale.
  if (existing?.outcome || (existing && !open && !outcome && existing.frozen_cents === 0)) return true;

  const frozenCents = open ? frozenCentsForDispute(dispute.amount, payout.amount_cents) : 0;
  const now = new Date().toISOString();
  const { error: upsertError } = await db.from("vendor_banking_disputes").upsert(
    {
      stripe_dispute_id: dispute.id,
      stripe_charge_id: stripeChargeId,
      vendor_user_id: payout.vendor_user_id,
      manager_user_id: payout.manager_user_id,
      payout_id: payout.id,
      amount_cents: dispute.amount,
      frozen_cents: frozenCents,
      status: dispute.status,
      reason: dispute.reason ?? null,
      outcome,
      updated_at: now,
    },
    { onConflict: "stripe_dispute_id" },
  );
  if (upsertError) throw new Error(`Could not record the dispute: ${upsertError.message}`);

  const facts = { amountCents: dispute.amount };
  if (!existing?.opened_notified_at && (open || outcome)) {
    await emitVendorBankingEvent(db, {
      kind: "dispute_opened",
      eventId: `dispute:${dispute.id}:opened`,
      vendorUserId: payout.vendor_user_id,
      managerUserId: payout.manager_user_id,
      facts,
    });
    await db.from("vendor_banking_disputes").update({ opened_notified_at: now }).eq("stripe_dispute_id", dispute.id);
  }

  if (outcome === "lost") {
    const debitCents = lostDisputeVendorDebitCents({
      disputeAmountCents: dispute.amount,
      payoutAmountCents: payout.amount_cents,
      platformFeeCents: payout.platform_fee_cents,
      refundedGrossCents: payout.refunded_gross_cents,
    });
    if (debitCents > 0) {
      const ledger = await recordVendorBankingLedgerEntry(db, {
        vendorUserId: payout.vendor_user_id,
        managerUserId: payout.manager_user_id,
        kind: "dispute",
        amountCents: -debitCents,
        source: "dispute",
        sourceId: payout.id,
        description: "Dispute lost — deducted from your next payments",
        stripeObjectId: dispute.id,
        idempotencyKey: `dispute:${dispute.id}:lost`,
      });
      // The shortfall is booked once, with the ledger line it belongs to.
      if (!ledger.alreadyRecorded) await recordVendorBankingShortfall(db, payout.vendor_user_id, debitCents);
    }
  }

  if (outcome && !existing?.closed_notified_at) {
    await emitVendorBankingEvent(db, {
      kind: "dispute_closed",
      eventId: `dispute:${dispute.id}:closed`,
      vendorUserId: payout.vendor_user_id,
      managerUserId: payout.manager_user_id,
      facts: { ...facts, outcome },
    });
    await db.from("vendor_banking_disputes").update({ closed_notified_at: now }).eq("stripe_dispute_id", dispute.id);
  }
  return true;
}
