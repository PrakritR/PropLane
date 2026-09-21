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
import { markHouseholdChargePaidFromPaymentIntent } from "@/lib/stripe-household-charge";
import { notifyAutopayDeclined, runAttempt } from "@/lib/resident-autopay.server";
import { feeCentsForMethod, normalizePayoutStatus } from "@/lib/stripe-payouts";
import { captureTestWorkspaceEffectForUser } from "@/lib/test-workspaces/effects.server";

async function refuseClassifiedFinancialMutation(
  db: SupabaseClient,
  userId: string,
  operation: string,
): Promise<boolean> {
  return (await captureTestWorkspaceEffectForUser({
    userId,
    kind: "payment",
    summary: "Stripe financial mutation was refused for a test workspace.",
    metadata: { operation },
    db,
  })).captured;
}

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
  // Signed metadata is only a candidate. The durable Connect mapping owns the
  // mutation and must agree before profile state changes.
  const targetId = (await resolveUserIdByConnectAccountId(db, account.id)) || null;
  if (!targetId) return;
  const claimedId = account.metadata?.axis_user_id?.trim();
  if (claimedId && claimedId !== targetId) throw new Error("Stripe account ownership mismatch.");
  if (await refuseClassifiedFinancialMutation(db, targetId, "connect_account_updated")) return;

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

  const payment = await ledgerPaymentForStripeCharge(db, chargeId);
  if (!payment?.manager_user_id) return;
  if (await refuseClassifiedFinancialMutation(db, payment.manager_user_id, "transfer_created")) return;

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

  const chargeId =
    typeof transfer.source_transaction === "string"
      ? transfer.source_transaction
      : transfer.source_transaction?.id ?? null;
  const { data: storedTransfer, error: transferReadError } = await db
    .from("ledger_entries")
    .select("manager_user_id")
    .eq("stripe_transfer_id", transfer.id)
    .eq("entry_type", "payment")
    .maybeSingle();
  if (transferReadError) throw new Error(transferReadError.message);
  const transferOwner = String(storedTransfer?.manager_user_id ?? "").trim()
    || (chargeId ? String((await ledgerPaymentForStripeCharge(db, chargeId))?.manager_user_id ?? "").trim() : "");
  if (!transferOwner) return;
  if (await refuseClassifiedFinancialMutation(db, transferOwner, "transfer_reversed")) return;

  const byTransferId = await db
    .from("ledger_entries")
    .update(patch)
    .eq("stripe_transfer_id", transfer.id)
    .eq("entry_type", "payment");

  if (byTransferId.error) throw new Error(byTransferId.error.message);

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
 * Whether the Connect account's owner is a vendor rather than a manager —
 * decided from `profile_roles` (a vendor role with no manager role; legacy
 * `profiles.role` when no role rows exist), never from how many listings the
 * owner happens to have. A manager who set up payouts before creating a
 * listing, or who deleted every listing, is still a manager.
 */
async function isVendorOwnedAccount(db: SupabaseClient, ownerUserId: string): Promise<boolean> {
  const { data: roleRows } = await db.from("profile_roles").select("role").eq("user_id", ownerUserId);
  const roles = new Set((roleRows ?? []).map((r) => String((r as { role?: unknown }).role ?? "").toLowerCase()));
  if (roles.size > 0) return roles.has("vendor") && !roles.has("manager");
  const { data: profile } = await db.from("profiles").select("role").eq("id", ownerUserId).maybeSingle();
  return String((profile as { role?: unknown } | null)?.role ?? "").toLowerCase() === "vendor";
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
  if (await refuseClassifiedFinancialMutation(db, managerUserId, "connect_payout")) return;
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
  if (await refuseClassifiedFinancialMutation(db, payment.manager_user_id, "refund")) return;

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
  const { error } = await db.from("stripe_disputes").upsert(
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
  if (error) throw new Error(error.message);
}

export async function handleStripeDisputeEvent(db: SupabaseClient, dispute: Stripe.Dispute): Promise<boolean> {
  const stripeChargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id;
  if (!stripeChargeId) return false;

  const payment = await ledgerPaymentForStripeCharge(db, stripeChargeId);
  const managerUserId = payment?.manager_user_id;
  if (!managerUserId) return false;

  if (await refuseClassifiedFinancialMutation(db, managerUserId, "dispute")) return true;

  await upsertStripeDisputeRecord(db, dispute, managerUserId, payment?.source_charge_id ?? null);
  return true;
}

/**
 * The one settle path for an autopay off-session PaymentIntent
 * (`metadata.autopay_run_id`): mark the run row succeeded and mark the charge
 * paid through the SAME per-charge core a manual Checkout payment uses
 * (`markHouseholdChargePaidFromPaymentIntent`), so the ledger write-through,
 * reminder cancellation, and outbound webhook are identical either way.
 * `chargeAutopay` already does this synchronously when Stripe confirms
 * in-request; this is the webhook's own idempotent settle for the (normal)
 * case where confirmation arrives asynchronously, and it no-ops harmlessly if
 * the charge is already paid.
 */
export async function handleAutopayPaymentIntentSucceeded(
  db: SupabaseClient,
  paymentIntent: Stripe.PaymentIntent,
): Promise<void> {
  const runId = paymentIntent.metadata?.autopay_run_id?.trim();
  const chargeId = paymentIntent.metadata?.charge_id?.trim();
  if (!runId || !chargeId) return;

  await markHouseholdChargePaidFromPaymentIntent(db, paymentIntent, chargeId);

  await db
    .from("resident_autopay_runs")
    .update({
      status: "succeeded",
      stripe_payment_intent_id: paymentIntent.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId)
    .neq("status", "succeeded");
}

/**
 * The declined side of an autopay PaymentIntent: mark the run failed and tell
 * the resident. `handlePaymentIntentFailed` (below) already flips the
 * underlying charge to `failed` + creates an NSF fee when the manager's
 * billing settings call for one, exactly like a declined manual payment — this
 * only additionally updates the autopay run row and sends the
 * autopay-specific decline notice, so the two failure paths never duplicate
 * each other's writes.
 */
export async function handleAutopayPaymentIntentFailed(
  db: SupabaseClient,
  paymentIntent: Stripe.PaymentIntent,
): Promise<void> {
  const runId = paymentIntent.metadata?.autopay_run_id?.trim();
  const chargeId = paymentIntent.metadata?.charge_id?.trim();
  const managerUserId = paymentIntent.metadata?.manager_user_id?.trim();
  if (!runId) return;

  const failureReason =
    paymentIntent.last_payment_error?.message?.trim() || "The payment was declined.";

  const { data: existingRun } = await db
    .from("resident_autopay_runs")
    .select("id, status, attempt")
    .eq("id", runId)
    .maybeSingle();
  if (!existingRun || existingRun.status === "failed" || existingRun.status === "succeeded") return;
  // A redelivered decline for an earlier attempt must not fail the row while
  // a later attempt is in flight; the row's `attempt` is the counter both
  // paths share.
  const rowAttempt = runAttempt(existingRun.attempt);
  const intentAttempt = runAttempt(paymentIntent.metadata?.autopay_attempt);
  if (intentAttempt < rowAttempt) return;

  await db
    .from("resident_autopay_runs")
    .update({ status: "failed", failure_reason: failureReason, updated_at: new Date().toISOString() })
    .eq("id", runId)
    .eq("attempt", rowAttempt);

  if (chargeId && managerUserId) {
    const { data: row } = await db
      .from("portal_household_charge_records")
      .select("row_data")
      .eq("id", chargeId)
      .maybeSingle();
    const charge = row?.row_data as HouseholdCharge | null;
    if (charge) {
      await notifyAutopayDeclined(db, { charge, managerId: managerUserId, declineMessage: failureReason }).catch(
        () => undefined,
      );
    }
  }
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
    const managerUserId = String(row.manager_user_id ?? charge.managerUserId ?? "");
    if (!managerUserId) continue;
    if (await refuseClassifiedFinancialMutation(db, managerUserId, "payment_failed")) continue;

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
