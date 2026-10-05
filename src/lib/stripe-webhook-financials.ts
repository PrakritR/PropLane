import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { connectAccountReadyForAchPayouts, connectAccountTransfersActive } from "@/lib/stripe-connect";
import { refreshPayoutDestinationsCacheFromStripe } from "@/lib/stripe-external-accounts.server";
import { identityStatusFromAccount } from "@/lib/stripe-connect-identity.server";
import { createNsfFeeForFailedPayment, nsfFeeIdForCharge } from "@/lib/nsf-fees";
import { postGlRefundEntry } from "@/lib/reports/gl-posting";
import { syncLedgerRefundEntry } from "@/lib/reports/ledger-sync";
import { categoryCodeForChargeKind } from "@/lib/reports/categories";
import type { HouseholdCharge } from "@/lib/household-charges";
import { emitHouseholdChargeTransition } from "@/lib/domain-action-events.server";
import { parseMoneyAmount } from "@/lib/parse-money";
import { enqueueWebhookEvent } from "@/lib/webhooks/deliver.server";
import { webhookEventBuilders } from "@/lib/webhooks/events";
import { markHouseholdChargePaidFromPaymentIntent } from "@/lib/stripe-household-charge";
import { notifyAutopayDeclined, runAttempt } from "@/lib/resident-autopay.server";
import { releaseVerifiedPlatformHoldsForOwner } from "@/lib/platform-hold-release.server";
import { settleClearedPlatformOwnerRecovery } from "@/lib/platform-owner-recovery.server";
import { creditVerifiedHouseholdAutopaySource,
  verifyExistingHistoricalAutopayHold } from "@/lib/household-captured-source.server";
import { settleReservedPlatformMoneyRefundFromWebhook } from "@/lib/platform-money-refund.server";
import { feeCentsForMethod, normalizePayoutStatus } from "@/lib/stripe-payouts";
import { captureTestWorkspaceEffectForUser } from "@/lib/test-workspaces/effects.server";
import { assertResidentCheckoutAttemptTerms, assertResidentCheckoutSession,
  type ResidentCheckoutAttempt } from "@/lib/resident-checkout-claim.server";

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
  const { error: profileError } = await db
    .from("profiles")
    .update({
      stripe_connect_charges_enabled: Boolean(account.charges_enabled),
      stripe_connect_payouts_enabled: Boolean(account.payouts_enabled && connectAccountTransfersActive(account)),
      updated_at: new Date().toISOString(),
    })
    .eq("id", targetId);
  if (profileError) throw new Error("Could not update saved payout account status.");

  // Display-only cache for Settings → Payouts (`payout_identity_status`,
  // PLAN-0920-1500 Part C) — scoped to THIS event's account only; the
  // identity route itself always reads Stripe fresh, this just saves that
  // page an extra round trip.
  const snapshot = identityStatusFromAccount(account);
  const { error: identityError } = await db.from("payout_identity_status").upsert(
    {
      owner_user_id: targetId,
      status: snapshot.status,
      currently_due: snapshot.currentlyDue,
      pending_verification: snapshot.pendingVerification,
      disabled_reason: snapshot.disabledReason,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "owner_user_id" },
  );
  if (identityError) throw new Error("Could not update payout identity status.");

  if (connectAccountReadyForAchPayouts(account)) {
    // The account event is a readiness signal, never authority for a transfer.
    // The release helper re-reads saved ownership, verified captured source,
    // refund history and the exact persisted provider attempt before money moves.
    await settleClearedPlatformOwnerRecovery(db, getStripe(), { ownerUserId: targetId });
    await releaseVerifiedPlatformHoldsForOwner(db, { ownerUserId: targetId });
  }
}

export async function handleStripeTransferCreated(db: SupabaseClient, transfer: Stripe.Transfer): Promise<void> {
  const chargeId =
    typeof transfer.source_transaction === "string"
      ? transfer.source_transaction
      : transfer.source_transaction?.id ?? null;
  if (!chargeId) return;
  const { data: allocations, error } = await db.from("platform_payment_holds")
    .select("id,owner_user_id,status,source_allocation_mode,source_verified_at,stripe_charge_id,stripe_transfer_id,source_transfer_gross_cents,source_destination_account_id")
    .eq("stripe_charge_id", chargeId).limit(2);
  if (error) throw new Error("Could not resolve transfer source allocation.");
  if (!allocations?.length) return; // The exact paid-source handler may still be awaiting Stripe leg hydration.
  if (allocations.length !== 1) throw new Error("Transfer charge has ambiguous recipient allocations.");
  const hold = allocations[0];
  const attemptId = transfer.metadata?.platform_hold_attempt?.trim();
  const destination = typeof transfer.destination === "string"
    ? transfer.destination : transfer.destination?.id ?? null;
  if (!transfer.id || !Number.isSafeInteger(transfer.amount) || transfer.amount <= 0 ||
      transfer.currency !== "usd" || hold.stripe_charge_id !== chargeId ||
      !hold.source_verified_at || !hold.owner_user_id) {
    throw new Error("Transfer differs from its verified recipient source.");
  }
  if (attemptId) {
    const { data: attempt, error: attemptError } = await db.from("platform_hold_transfer_attempts")
      .select("id,hold_id,attempt_key,owner_user_id,destination_account_id,source_charge_id,amount_cents,status,stripe_transfer_id")
      .eq("id", attemptId).maybeSingle();
    if (attemptError || !attempt || attempt.id !== attemptId || attempt.hold_id !== hold.id ||
        transfer.metadata?.platform_hold_id !== hold.id ||
        attempt.owner_user_id !== hold.owner_user_id ||
        attempt.source_charge_id !== chargeId || attempt.amount_cents !== transfer.amount ||
        attempt.destination_account_id !== destination ||
        hold.source_allocation_mode !== "hold" ||
        (attempt.stripe_transfer_id && attempt.stripe_transfer_id !== transfer.id)) {
      throw new Error("Transfer does not match its reserved hold release.");
    }
    if (await refuseClassifiedFinancialMutation(db, hold.owner_user_id, "transfer_created")) return;
    const { error: finishError } = await db.rpc("finish_platform_hold_transfer", {
      p_hold: hold.id, p_owner: hold.owner_user_id,
      p_attempt: attempt.attempt_key, p_transfer: transfer.id,
    });
    if (finishError) throw new Error("Could not finalize exact recipient transfer.");
    return;
  }
  // Automatic destination charges transfer the payer's raw gross, while the
  // allocation and payment ledger store recipient net. A delayed transfer
  // event must never overwrite that immutable net or fan out across a cart.
  if (hold.source_allocation_mode !== "destination" ||
      !["transferred", "refunded"].includes(hold.status) ||
      hold.stripe_transfer_id !== transfer.id ||
      hold.source_transfer_gross_cents !== transfer.amount ||
      hold.source_destination_account_id !== destination) {
    throw new Error("Transfer has no matching captured destination allocation.");
  }
}

/** Settle only exact refund-linked reversal legs; preserve original transfer identity. */
export async function handleStripeTransferReversed(db: SupabaseClient, transfer: Stripe.Transfer): Promise<void> {
  const chargeId =
    typeof transfer.source_transaction === "string"
      ? transfer.source_transaction
      : transfer.source_transaction?.id ?? null;
  if (!chargeId) return;
  const { data: allocations, error } = await db.from("platform_payment_holds")
    .select("id,owner_user_id,stripe_charge_id,stripe_transfer_id,source_verified_at")
    .eq("stripe_charge_id", chargeId).limit(2);
  if (error) throw new Error("Could not resolve reversed transfer source.");
  if (!allocations?.length) return;
  if (allocations.length !== 1 || allocations[0].stripe_transfer_id !== transfer.id ||
      !allocations[0].source_verified_at || transfer.currency !== "usd") {
    throw new Error("Reversed transfer does not match one verified allocation.");
  }
  const hold = allocations[0];
  const reversals = transfer.reversals;
  if (!reversals || reversals.has_more || !reversals.data.length ||
      reversals.data.reduce((sum, leg) => sum + leg.amount, 0) !== transfer.amount_reversed) {
    throw new Error("Transfer reversal legs need exact source review.");
  }
  if (await refuseClassifiedFinancialMutation(db, hold.owner_user_id, "transfer_reversed")) return;
  for (const reversal of reversals.data) {
    const attemptId = reversal.metadata?.platform_refund_attempt?.trim();
    const refundId = reversal.metadata?.platform_refund_id?.trim();
    const reversalTransferId = typeof reversal.transfer === "string"
      ? reversal.transfer : reversal.transfer?.id ?? null;
    if (!reversal.id || !Number.isSafeInteger(reversal.amount) || reversal.amount <= 0 ||
        reversalTransferId !== transfer.id || !attemptId || !refundId ||
        (reversal.source_refund &&
          (typeof reversal.source_refund === "string" ? reversal.source_refund : reversal.source_refund.id) !== refundId)) {
      throw new Error("Recipient reversal has no exact refund reservation.");
    }
    const { data: attempt, error: attemptError } = await db.from("platform_hold_refund_attempts")
      .select("id,hold_id,attempt_key,source_charge_id,stripe_refund_id,hold_debit_cents")
      .eq("id", attemptId).maybeSingle();
    if (attemptError || !attempt || attempt.id !== attemptId || attempt.hold_id !== hold.id ||
        attempt.source_charge_id !== chargeId || attempt.stripe_refund_id !== refundId ||
        attempt.hold_debit_cents !== reversal.amount) {
      throw new Error("Recipient reversal differs from its refunded source.");
    }
    const { error: finishError } = await db.rpc("finish_platform_transfer_reversal", {
      p_attempt: attempt.attempt_key, p_source_transfer: transfer.id,
      p_reversal: reversal.id, p_amount: reversal.amount,
    });
    if (finishError) throw new Error("Could not finalize exact recipient reversal.");
  }
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
      .select("amount_cents, fee_cents, initiated_in_app, row_data")
      .eq("stripe_payout_id", payout.id)
      .maybeSingle()
      .then((r) => r.data as { amount_cents: number; fee_cents: number | null;
        initiated_in_app: boolean; row_data?: unknown } | null),
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
    row_data: existing?.initiated_in_app && existing.row_data && typeof existing.row_data === "object"
      ? { ...existing.row_data, providerStatus: payout.status, providerMethod: payout.method }
      : { id: payout.id, status: payout.status, method: payout.method, type: payout.type,
          proplaneBalanceWithdrawal: payout.metadata?.proplane_balance_withdrawal ?? null,
          proplaneBalanceTransferId: payout.metadata?.proplane_balance_transfer_id ?? null },
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

/**
 * `account.external_account.created|updated|deleted` — a bank account or
 * debit card was added, changed (e.g. micro-deposit verification landed), or
 * removed on a connected account. Scoped by `event.account` (never the event
 * payload's own account id) since these are Connect events delivered to the
 * platform endpoint. Refreshes the display cache from a fresh Stripe read
 * rather than trying to reconstruct the row from the webhook payload alone.
 */
export async function handleExternalAccountEvent(
  stripe: Stripe,
  db: SupabaseClient,
  connectAccountId: string | null | undefined,
): Promise<void> {
  if (!connectAccountId) return;
  const ownerUserId = await resolveUserIdByConnectAccountId(db, connectAccountId);
  if (!ownerUserId) return;
  await refreshPayoutDestinationsCacheFromStripe(stripe, db, ownerUserId, connectAccountId);
}

async function ledgerPaymentForStripeCharge(
  db: SupabaseClient,
  stripeChargeId: string,
  sourceChargeId?: string,
): Promise<{
  id: string;
  manager_user_id: string;
  source_charge_id: string | null;
  category_code: string;
  amount_cents: number;
  property_id: string | null;
  resident_user_id: string | null;
} | null> {
  let query = db
    .from("ledger_entries")
    .select("id, manager_user_id, source_charge_id, category_code, amount_cents, property_id, resident_user_id")
    .eq("stripe_charge_id", stripeChargeId)
    .eq("entry_type", "payment");
  if (sourceChargeId) query = query.eq("source_charge_id", sourceChargeId);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  return data as typeof data | null;
}

type RefundReservationSource = {
  hold_id: string;
  owner_user_id: string;
  source_charge_id: string;
  refund_components: Array<{ source_id: string; principal_cents: number }> | null;
};

export async function handleStripeRefund(
  db: SupabaseClient,
  refund: Stripe.Refund,
  stripeChargeId: string,
  paymentIntentId?: string | null,
): Promise<void> {
  const providerChargeId = typeof refund.charge === "string" ? refund.charge : refund.charge?.id;
  if (!refund.id || !stripeChargeId || (providerChargeId && providerChargeId !== stripeChargeId) ||
      !Number.isSafeInteger(refund.amount) || refund.amount <= 0 || refund.currency !== "usd" ||
      !["pending", "succeeded", "failed", "canceled"].includes(refund.status ?? "")) {
    throw new Error("Refund event lacks exact charge, amount or terminal status.");
  }
  const stripe = getStripe();
  // Event snapshots can arrive out of order. Re-read the exact provider
  // refund before recording terminal evidence or booking money.
  const current = await stripe.refunds.retrieve(refund.id);
  const currentChargeId = typeof current.charge === "string" ? current.charge : current.charge?.id;
  const eventPi = paymentIntentId || (typeof refund.payment_intent === "string"
    ? refund.payment_intent : refund.payment_intent?.id ?? null);
  const currentPi = typeof current.payment_intent === "string"
    ? current.payment_intent : current.payment_intent?.id ?? null;
  if (current.id !== refund.id || currentChargeId !== stripeChargeId ||
      current.amount !== refund.amount || current.currency !== "usd" ||
      (eventPi && currentPi && eventPi !== currentPi) ||
      !["pending", "succeeded", "failed", "canceled"].includes(current.status ?? "")) {
    throw new Error("Current provider refund differs from its signed source event.");
  }
  const { error: evidenceError } = await db.rpc("record_platform_source_refund_evidence", {
    p_refund: current.id, p_charge: stripeChargeId, p_payment_intent: currentPi ?? eventPi,
    p_amount: current.amount, p_status: current.status,
  });
  if (evidenceError) throw new Error("Could not record captured refund evidence.");
  const reservedAttemptId = current.metadata?.platform_refund_attempt?.trim();
  let reservation: RefundReservationSource | null = null;
  if (reservedAttemptId) {
    const { data, error: reservationError } = await db
      .from("platform_hold_refund_attempts")
      .select("hold_id,owner_user_id,source_charge_id,refund_components")
      .eq("id", reservedAttemptId).maybeSingle();
    if (reservationError || !data || data.source_charge_id !== stripeChargeId ||
        !data.owner_user_id || !data.hold_id) {
      throw new Error("Refund reservation owner needs exact review.");
    }
    reservation = data as RefundReservationSource;
    if (await refuseClassifiedFinancialMutation(db, reservation.owner_user_id, "refund")) return;
  }
  const settlement = await settleReservedPlatformMoneyRefundFromWebhook(stripe, db, current);
  if (settlement === "unmatched") {
    const { data: allocations, error: allocationError } = await db.from("platform_payment_holds")
      .select("id").eq("stripe_charge_id", stripeChargeId).limit(1);
    if (allocationError) throw new Error("Could not check refund recipient allocation.");
    if (allocations?.length) throw new Error("Captured source refund needs exact allocation review.");
  }
  if (current.status !== "succeeded" && settlement !== "succeeded") return;
  const settledRefund = current.status === "succeeded" ? current : await stripe.refunds.retrieve(current.id);
  if (settledRefund.status !== "succeeded") {
    throw new Error("Refund accounting requires current succeeded provider evidence.");
  }
  if (reservation && settlement === "succeeded") {
    const { data: allocation, error: allocationError } = await db.from("platform_payment_holds")
      .select("id,owner_user_id,owner_role,stripe_charge_id")
      .eq("id", reservation.hold_id).maybeSingle();
    if (allocationError || !allocation || allocation.owner_user_id !== reservation.owner_user_id ||
        allocation.stripe_charge_id !== stripeChargeId) {
      throw new Error("Refund accounting lacks its exact recipient allocation.");
    }
    if (allocation.owner_role === "manager") {
      // The source-bound settlement already posted the canonical refund
      // ledger and journal atomically for every captured component. Running
      // the legacy full-cash poster here would erase the creditor split.
      return;
    }
  }
  const postedDate = new Date((settledRefund.created ?? Date.now() / 1000) * 1000).toISOString().slice(0, 10);
  const components = reservation?.refund_components ?? null;
  if (reservation && (!components?.length || components.some((component) =>
      !component.source_id || !Number.isSafeInteger(component.principal_cents) ||
      component.principal_cents <= 0) ||
      components.reduce((sum, component) => sum + component.principal_cents, 0) !== settledRefund.amount)) {
    throw new Error("Refund accounting lacks exact captured charge components.");
  }
  let capturedComponents: Array<{ source_id: string; kind: string; principal_cents: number }> | null = null;
  if (reservation) {
    const { data: allocation, error: allocationError } = await db.from("platform_payment_holds")
      .select("owner_user_id,stripe_charge_id,source_verified_at,source_components")
      .eq("id", reservation.hold_id).maybeSingle();
    if (allocationError || !allocation || !allocation.source_verified_at ||
        allocation.owner_user_id !== reservation.owner_user_id ||
        allocation.stripe_charge_id !== stripeChargeId ||
        !Array.isArray(allocation.source_components)) {
      throw new Error("Refund accounting lacks an attested recipient allocation.");
    }
    capturedComponents = allocation.source_components as Array<{
      source_id: string; kind: string; principal_cents: number;
    }>;
  }
  const entries = components ?? [{ source_id: settledRefund.metadata?.proplane_charge_id ?? "",
    principal_cents: settledRefund.amount }];
  for (const component of entries) {
    const captured = capturedComponents?.find((item) => item.source_id === component.source_id);
    const payment = await ledgerPaymentForStripeCharge(db, stripeChargeId, component.source_id || undefined);
    if (!payment?.source_charge_id || !payment.manager_user_id ||
        (component.source_id && payment.source_charge_id !== component.source_id) ||
        (reservation && (!captured || captured.principal_cents !== payment.amount_cents ||
          payment.manager_user_id !== reservation.owner_user_id ||
          payment.category_code !== categoryCodeForChargeKind(captured.kind)))) {
      if (reservation) throw new Error("Refund component has no matching original payment ledger.");
      return;
    }
    if (await refuseClassifiedFinancialMutation(db, payment.manager_user_id, "refund")) return;
    const ledgerId = await syncLedgerRefundEntry(db, {
      managerUserId: payment.manager_user_id,
      sourceChargeId: payment.source_charge_id,
      categoryCode: payment.category_code,
      amountCents: component.principal_cents,
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
      amountCents: component.principal_cents,
      entryDate: postedDate,
      propertyId: payment.property_id,
      residentUserId: payment.resident_user_id,
      description: `Refund ${refund.id}`,
      linkLedgerEntryId: ledgerId,
    });
  }
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

  const paid = await markHouseholdChargePaidFromPaymentIntent(db, paymentIntent, chargeId);
  if (paymentIntent.metadata?.source_arbitration_v === "1") {
    if (!paid.ok) throw new Error("Marked autopay claim did not settle the captured source.");
    await creditVerifiedHouseholdAutopaySource(db, getStripe(), paymentIntent, chargeId);
    return; // The exact claim SQL already stamped the run succeeded.
  } else {
    if (paymentIntent.metadata?.source_arbitration_v) {
      throw new Error("Unknown autopay source arbitration version.");
    }
    await verifyExistingHistoricalAutopayHold(db, getStripe(), paymentIntent, chargeId);
  }

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

/** Checkout emits PI events as well as session events. A card PI owns no
 * independent settlement path: attest its exact frozen Checkout claim and
 * provider session, then leave paid/processing transitions to the session
 * handler. This also prevents a copied version marker from bypassing NSF. */
export async function assertMarkedCheckoutPaymentIntentClaim(
  db: SupabaseClient, stripe: Stripe, paymentIntent: Stripe.PaymentIntent,
): Promise<void> {
  const meta = paymentIntent.metadata ?? {};
  const token = meta.resident_attempt_token?.trim();
  if (!token || meta.source_arbitration_v !== "1" ||
      meta.purpose !== "household_charge" || meta.payment_method !== "card" ||
      meta.manual_ach || meta.autopay_run_id ||
      paymentIntent.currency !== "usd" || paymentIntent.transfer_data?.destination ||
      paymentIntent.application_fee_amount) {
    throw new Error("Marked Checkout PaymentIntent has no exact card claim.");
  }
  const { data, error } = await db.from("resident_checkout_attempts")
    .select("*").eq("attempt_token", token).maybeSingle();
  if (error || !data) throw new Error("Marked Checkout PaymentIntent claim is missing.");
  const attempt = data as ResidentCheckoutAttempt;
  const params = assertResidentCheckoutAttemptTerms(attempt);
  if (attempt.payment_method !== "card" ||
      !["pending", "processing", "settled"].includes(attempt.status) ||
      (attempt.stripe_payment_intent_id && attempt.stripe_payment_intent_id !== paymentIntent.id) ||
      paymentIntent.amount !== attempt.payer_total_cents ||
      meta.charge_ids !== attempt.charge_ids.join(",") ||
      meta.charge_id !== attempt.charge_ids[0] ||
      meta.manager_user_id !== attempt.manager_user_id ||
      meta.resident_email !== params.residentEmail ||
      meta.fee_payer !== params.feePayer ||
      meta.platform_hold !== "1" ||
      meta.hold_amount_cents !== String(attempt.recipient_net_cents)) {
    throw new Error("Marked Checkout PaymentIntent differs from its frozen claim.");
  }
  const sessions = await stripe.checkout.sessions.list({ payment_intent: paymentIntent.id, limit: 2 });
  if (sessions.has_more || sessions.data.length !== 1) {
    throw new Error("Marked Checkout PaymentIntent has no unique provider session.");
  }
  const session = sessions.data[0]!;
  const sessionPi = typeof session.payment_intent === "string"
    ? session.payment_intent : session.payment_intent?.id;
  if (sessionPi !== paymentIntent.id) {
    throw new Error("Marked Checkout provider session belongs to another PaymentIntent.");
  }
  assertResidentCheckoutSession(attempt, session);
}

/** Retryable marked PI failures retain the exact run/slot and never mint an
 * NSF fee or authorize a second debit. An unrelated PI cannot suppress the
 * historical failure handler by copying the marker. */
export async function assertMarkedAutopayFailureClaim(
  db: SupabaseClient, paymentIntent: Stripe.PaymentIntent,
): Promise<void> {
  const metadata = paymentIntent.metadata;
  const runId = metadata?.autopay_run_id?.trim();
  const chargeId = metadata?.charge_id?.trim();
  const ownerId = metadata?.manager_user_id?.trim();
  const attempt = Number(metadata?.autopay_attempt);
  if (metadata?.source_arbitration_v !== "1" || !runId || !chargeId || !ownerId ||
      metadata?.purpose !== "household_charge" || !Number.isSafeInteger(attempt) || attempt < 1 ||
      paymentIntent.currency !== "usd" || paymentIntent.transfer_data?.destination ||
      paymentIntent.application_fee_amount) {
    throw new Error("Marked autopay failure lacks frozen claim terms.");
  }
  const { data: run, error } = await db.from("resident_autopay_runs")
    .select("id,charge_id,manager_id,attempt,stripe_payment_intent_id,status")
    .eq("id", runId).maybeSingle();
  if (error || !run || run.charge_id !== chargeId || run.manager_id !== ownerId ||
      Number(run.attempt) !== attempt || run.stripe_payment_intent_id !== paymentIntent.id ||
      !["claimed", "succeeded"].includes(run.status)) {
    throw new Error("Marked autopay failure differs from its persisted run.");
  }
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
      // Read before write: a redelivered `payment_intent.payment_failed` for the same
      // attempt must never mint a second NSF fee. The id is deterministic per failed
      // attempt — charge + PaymentIntent (`nsfFeeIdForCharge`) — so an existing row
      // here is that same fee already charged, not a coincidence, while a fresh
      // retry that fails on a new intent is fee'd on its own.
      const nsfFeeId = nsfFeeIdForCharge(chargeId, paymentIntent.id);
      const { data: existingNsfFee } = await db
        .from("portal_household_charge_records")
        .select("id")
        .eq("id", nsfFeeId)
        .maybeSingle();
      if (!existingNsfFee) {
        await createNsfFeeForFailedPayment(db, charge, managerUserId, paymentIntent.id).catch(() => undefined);
      }
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
