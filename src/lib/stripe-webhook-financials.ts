import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { connectAccountTransfersActive } from "@/lib/stripe-connect";
import { createNsfFeeForFailedPayment } from "@/lib/nsf-fees";
import { postGlRefundEntry } from "@/lib/reports/gl-posting";
import { syncLedgerRefundEntry } from "@/lib/reports/ledger-sync";
import type { HouseholdCharge } from "@/lib/household-charges";
import { emitHouseholdChargeTransition } from "@/lib/domain-action-events.server";

export async function resolveUserIdByConnectAccountId(
  db: SupabaseClient,
  connectAccountId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from("profiles")
    .select("id")
    .eq("stripe_connect_account_id", connectAccountId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.id ? String(data.id) : null;
}

export async function handleStripeAccountUpdated(db: SupabaseClient, account: Stripe.Account): Promise<void> {
  const userId = account.metadata?.axis_user_id?.trim();
  const targetId = userId || (await resolveUserIdByConnectAccountId(db, account.id)) || null;
  if (!targetId) return;

  await db
    .from("profiles")
    .update({
      stripe_connect_charges_enabled: Boolean(account.charges_enabled),
      stripe_connect_payouts_enabled: Boolean(account.payouts_enabled && connectAccountTransfersActive(account)),
      updated_at: new Date().toISOString(),
    })
    .eq("id", targetId);
}

export async function handleStripeTransferCreated(db: SupabaseClient, transfer: Stripe.Transfer): Promise<void> {
  const chargeId =
    typeof transfer.source_transaction === "string"
      ? transfer.source_transaction
      : transfer.source_transaction?.id ?? null;
  if (!chargeId) return;

  const patch: Record<string, unknown> = {
    stripe_transfer_id: transfer.id,
    updated_at: new Date().toISOString(),
  };
  if (typeof transfer.amount === "number") patch.net_cents = transfer.amount;

  await db.from("ledger_entries").update(patch).eq("stripe_charge_id", chargeId).eq("entry_type", "payment");
}

/** Clears Connect transfer linkage when Stripe reverses a transfer (e.g. failed payout). */
export async function handleStripeTransferReversed(db: SupabaseClient, transfer: Stripe.Transfer): Promise<void> {
  const patch: Record<string, unknown> = {
    stripe_transfer_id: null,
    updated_at: new Date().toISOString(),
  };

  const byTransferId = await db
    .from("ledger_entries")
    .update(patch)
    .eq("stripe_transfer_id", transfer.id)
    .eq("entry_type", "payment");

  if (byTransferId.error) throw new Error(byTransferId.error.message);

  const chargeId =
    typeof transfer.source_transaction === "string"
      ? transfer.source_transaction
      : transfer.source_transaction?.id ?? null;
  if (!chargeId) return;

  await db
    .from("ledger_entries")
    .update(patch)
    .eq("stripe_charge_id", chargeId)
    .eq("entry_type", "payment");
}

export async function upsertStripePayoutRecord(
  db: SupabaseClient,
  managerUserId: string,
  payout: Stripe.Payout,
  connectAccountId: string,
): Promise<void> {
  const status = payout.status ?? "pending";
  const allowed = new Set(["paid", "pending", "in_transit", "failed", "canceled"]);
  const normalized = allowed.has(status) ? status : "pending";

  await db.from("stripe_payouts").upsert(
    {
      manager_user_id: managerUserId,
      stripe_payout_id: payout.id,
      stripe_connect_account_id: connectAccountId,
      amount_cents: payout.amount,
      currency: payout.currency ?? "usd",
      status: normalized,
      arrival_date: payout.arrival_date ? new Date(payout.arrival_date * 1000).toISOString().slice(0, 10) : null,
      failure_message: payout.failure_message ?? null,
      row_data: { id: payout.id, status: payout.status, method: payout.method, type: payout.type },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "stripe_payout_id" },
  );
}

export async function handleConnectPayoutEvent(
  db: SupabaseClient,
  payout: Stripe.Payout,
  connectAccountId: string | null | undefined,
): Promise<void> {
  if (!connectAccountId) return;
  const managerUserId = await resolveUserIdByConnectAccountId(db, connectAccountId);
  if (!managerUserId) return;
  await upsertStripePayoutRecord(db, managerUserId, payout, connectAccountId);
}

async function ledgerPaymentForStripeCharge(
  db: SupabaseClient,
  stripeChargeId: string,
): Promise<{
  id: string;
  manager_user_id: string;
  source_charge_id: string | null;
  category_code: string;
  amount_cents: number;
  property_id: string | null;
  resident_user_id: string | null;
} | null> {
  const { data, error } = await db
    .from("ledger_entries")
    .select("id, manager_user_id, source_charge_id, category_code, amount_cents, property_id, resident_user_id")
    .eq("stripe_charge_id", stripeChargeId)
    .eq("entry_type", "payment")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as typeof data | null;
}

export async function handleStripeRefund(
  db: SupabaseClient,
  refund: Stripe.Refund,
  stripeChargeId: string,
): Promise<void> {
  const payment = await ledgerPaymentForStripeCharge(db, stripeChargeId);
  if (!payment?.source_charge_id || !payment.manager_user_id) return;

  const refundCents = refund.amount ?? 0;
  if (refundCents <= 0) return;

  const postedDate = new Date((refund.created ?? Date.now() / 1000) * 1000).toISOString().slice(0, 10);

  const ledgerId = await syncLedgerRefundEntry(db, {
    managerUserId: payment.manager_user_id,
    sourceChargeId: payment.source_charge_id,
    categoryCode: payment.category_code,
    amountCents: refundCents,
    postedDate,
    stripeChargeId,
    stripeRefundId: refund.id,
    propertyId: payment.property_id,
    residentUserId: payment.resident_user_id,
    description: `Refund — ${payment.source_charge_id}`,
  });

  await postGlRefundEntry(db, {
    managerUserId: payment.manager_user_id,
    sourceChargeId: payment.source_charge_id,
    stripeRefundId: refund.id,
    categoryCode: payment.category_code,
    amountCents: refundCents,
    entryDate: postedDate,
    propertyId: payment.property_id,
    residentUserId: payment.resident_user_id,
    description: `Refund ${refund.id}`,
    linkLedgerEntryId: ledgerId,
  });
}

export async function upsertStripeDisputeRecord(
  db: SupabaseClient,
  dispute: Stripe.Dispute,
  managerUserId: string,
  sourceChargeId: string | null,
): Promise<void> {
  const stripeChargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id ?? "";
  await db.from("stripe_disputes").upsert(
    {
      manager_user_id: managerUserId,
      stripe_dispute_id: dispute.id,
      stripe_charge_id: stripeChargeId,
      amount_cents: dispute.amount,
      status: dispute.status,
      reason: dispute.reason ?? null,
      source_charge_id: sourceChargeId,
      row_data: {
        id: dispute.id,
        status: dispute.status,
        reason: dispute.reason,
        is_charge_refundable: dispute.is_charge_refundable,
      },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "stripe_dispute_id" },
  );
}

export async function handleStripeDisputeEvent(db: SupabaseClient, dispute: Stripe.Dispute): Promise<void> {
  const stripeChargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id;
  if (!stripeChargeId) return;

  const payment = await ledgerPaymentForStripeCharge(db, stripeChargeId);
  const managerUserId = payment?.manager_user_id;
  if (!managerUserId) return;

  await upsertStripeDisputeRecord(db, dispute, managerUserId, payment?.source_charge_id ?? null);
}

export async function handlePaymentIntentFailed(
  db: SupabaseClient,
  paymentIntent: Stripe.PaymentIntent,
): Promise<void> {
  const chargeIds =
    paymentIntent.metadata?.charge_ids?.split(",").map((id) => id.trim()).filter(Boolean) ?? [];
  const fallback = paymentIntent.metadata?.charge_id?.trim();
  const ids = chargeIds.length > 0 ? chargeIds : fallback ? [fallback] : [];
  if (ids.length === 0) return;

  const now = new Date().toISOString();
  for (const chargeId of ids) {
    const { data: row } = await db
      .from("portal_household_charge_records")
      .select("id, row_data, status, manager_user_id")
      .eq("id", chargeId)
      .maybeSingle();
    if (!row || row.status === "paid") continue;
    const charge = row.row_data as HouseholdCharge | null;
    if (!charge) continue;

    const failedCharge = {
      ...charge,
      status: "failed" as const,
      stripePaymentStatus: "failed",
      stripePaymentFailedAt: now,
    };
    await db.from("portal_household_charge_records").upsert(
      {
        id: chargeId,
        manager_user_id: row.manager_user_id,
        resident_email: charge.residentEmail?.trim().toLowerCase() ?? "",
        status: "failed",
        row_data: failedCharge,
        updated_at: now,
      },
      { onConflict: "id" },
    );

    const managerUserId = String(row.manager_user_id ?? charge.managerUserId ?? "");
    if (managerUserId) {
      await createNsfFeeForFailedPayment(db, charge, managerUserId).catch(() => undefined);
      await emitHouseholdChargeTransition(db, {
        managerUserId,
        previousStatus: charge.status,
        charge: failedCharge,
        transitionId: `${chargeId}:payment_failed:${paymentIntent.id}`,
      }).catch(() => undefined);
    }
  }
}
