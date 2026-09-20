import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { connectAccountTransfersActive } from "@/lib/stripe-connect";
import { createNsfFeeForFailedPayment } from "@/lib/nsf-fees";
import { postGlRefundEntry } from "@/lib/reports/gl-posting";
import { syncLedgerRefundEntry } from "@/lib/reports/ledger-sync";
import type { HouseholdCharge } from "@/lib/household-charges";
import { emitHouseholdChargeTransition } from "@/lib/domain-action-events.server";
import { parseMoneyAmount } from "@/lib/parse-money";
import { enqueueWebhookEvent } from "@/lib/webhooks/deliver.server";
import { webhookEventBuilders } from "@/lib/webhooks/events";
import { feeCentsForMethod, normalizePayoutStatus } from "@/lib/stripe-payouts";

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

/**
 * Best-effort last4 for the payout's destination bank account. The webhook
 * payload only gives `destination` as an id string (not expanded), so this
 * is one extra platform-level API call; a failure here must never fail the
 * payout write — it just means `destinationLast4` stays whatever was already
 * stored (or null for a payout that only ever arrives via webhook).
 */
async function resolveDestinationLast4(
  stripe: Stripe | undefined,
  connectAccountId: string,
  destination: Stripe.Payout["destination"],
): Promise<string | null> {
  if (!stripe) return null;
  const destinationId = typeof destination === "string" ? destination : destination?.id;
  if (!destinationId) return null;
  try {
    const account = await stripe.accounts.retrieveExternalAccount(connectAccountId, destinationId);
    return "last4" in account && typeof account.last4 === "string" ? account.last4 : null;
  } catch {
    return null;
  }
}

/**
 * Vendor accounts never belong to a property-owning manager (co-managers
 * never get their own Connect account — payouts always land in the OWNER's
 * account; see `resolveStripePayoutContext`). So "this account's owner has no
 * `manager_property_records`" reliably means it's a vendor's own account.
 */
async function isVendorOwnedAccount(db: SupabaseClient, ownerUserId: string): Promise<boolean> {
  const { count } = await db
    .from("manager_property_records")
    .select("id", { count: "exact", head: true })
    .eq("manager_user_id", ownerUserId);
  return (count ?? 0) === 0;
}

export async function upsertStripePayoutRecord(
  db: SupabaseClient,
  managerUserId: string,
  payout: Stripe.Payout,
  connectAccountId: string,
  stripe?: Stripe,
): Promise<void> {
  const normalized = normalizePayoutStatus(payout.status ?? "pending", payout.failure_code);
  const method = payout.method === "instant" || payout.method === "standard" ? payout.method : null;
  const [destinationLast4, vendorOwned, existing] = await Promise.all([
    resolveDestinationLast4(stripe, connectAccountId, payout.destination),
    isVendorOwnedAccount(db, managerUserId),
    db
      .from("stripe_payouts")
      .select("amount_cents, fee_cents, initiated_in_app")
      .eq("stripe_payout_id", payout.id)
      .maybeSingle()
      .then((r) => r.data as { amount_cents: number; fee_cents: number | null; initiated_in_app: boolean } | null),
  ]);

  // An in-app "Pay out" already knows the GROSS amount the user typed and its
  // fee (computed off that gross); for Instant, Stripe's `payout.amount` is
  // deliberately the NET amount we requested (see `createInAppPayout`), which
  // is not the same number — so a row this app already claimed keeps its own
  // amount/fee rather than being overwritten by the webhook's raw figures. A
  // row this webhook is the first to see (an automatic, Stripe-scheduled
  // payout PropLane never initiated) has no such gross/net split — standard
  // only, fee 0 — so `payout.amount` is authoritative there.
  const appClaimedInstant = Boolean(existing?.initiated_in_app) && method === "instant";
  const amountCents = appClaimedInstant ? (existing!.amount_cents ?? payout.amount) : payout.amount;
  const feeCents = appClaimedInstant
    ? (existing!.fee_cents ?? feeCentsForMethod("instant", amountCents))
    : method
      ? feeCentsForMethod(method, payout.amount)
      : null;

  const patch: Record<string, unknown> = {
    manager_user_id: managerUserId,
    stripe_payout_id: payout.id,
    stripe_connect_account_id: connectAccountId,
    amount_cents: amountCents,
    currency: payout.currency ?? "usd",
    status: normalized,
    method,
    fee_cents: feeCents,
    arrival_date: payout.arrival_date ? new Date(payout.arrival_date * 1000).toISOString().slice(0, 10) : null,
    failure_message: payout.failure_message ?? null,
    row_data: { id: payout.id, status: payout.status, method: payout.method, type: payout.type },
    updated_at: new Date().toISOString(),
  };
  if (destinationLast4) patch.destination_last4 = destinationLast4;
  if (vendorOwned) patch.vendor_user_id = managerUserId;
  // `initiated_in_app` is deliberately omitted from the patch: an in-app "Pay
  // out" already set it true when it claimed this row before calling Stripe,
  // and Postgres upsert only touches columns present in the patch, so leaving
  // it out here preserves that value. A row this webhook is INSERTing fresh
  // gets the column default of `false`.

  await db.from("stripe_payouts").upsert(patch, { onConflict: "stripe_payout_id" });
}

export async function handleConnectPayoutEvent(
  db: SupabaseClient,
  payout: Stripe.Payout,
  connectAccountId: string | null | undefined,
  stripe?: Stripe,
): Promise<void> {
  if (!connectAccountId) return;
  const managerUserId = await resolveUserIdByConnectAccountId(db, connectAccountId);
  if (!managerUserId) return;
  await upsertStripePayoutRecord(db, managerUserId, payout, connectAccountId, stripe);
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
      // Outbound webhooks: ids, amount and status only, and never throws here.
      await enqueueWebhookEvent(managerUserId, "payment.failed", webhookEventBuilders["payment.failed"]({
        chargeId,
        propertyId: failedCharge.propertyId,
        amountCents: Math.round(parseMoneyAmount(failedCharge.amountLabel) * 100),
        kind: failedCharge.kind,
      }));
    }
  }
}
