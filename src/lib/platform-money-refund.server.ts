import "server-only";

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

type ReservedRefund = {
  id: string;
  hold_id: string;
  payout_id: string | null;
  owner_user_id: string;
  attempt_key: string;
  gross_cents: number;
  principal_cents: number;
  refund_components: Array<{ source_id: string; principal_cents: number }> | null;
  recipient_debit_components: Array<{
    source_id: string; principal_cents: number; recipient_debit_cents: number;
  }> | null;
  source_charge_id: string;
  provider_reason: Stripe.RefundCreateParams.Reason;
  reverse_transfer: boolean;
  refund_application_fee: boolean;
  hold_debit_cents: number;
  transfer_reversal_cents: number;
  fee_share_cents: number;
  status: "reserved" | "succeeded" | "failed";
  stripe_refund_id: string | null;
  terminal_provider_status: "failed" | "canceled" | null;
  reversal_status: "not_required" | "pending" | "succeeded" | "shortfall" | null;
  stripe_reversal_id: string | null;
  created_at: string;
};

type RefundTransferLeg = {
  id: string;
  refund_attempt_id: string;
  transfer_attempt_id: string;
  hold_id: string;
  source_charge_id: string;
  source_transfer_id: string;
  amount_cents: number;
  component_breakdown: Array<{ source_id: string; recipient_net_cents: number }>;
  status: "reserved" | "created" | "failed";
  stripe_reversal_id: string | null;
  reversed_at: string | null;
};

async function loadRefundTransferLegs(db: SupabaseClient, attempt: ReservedRefund): Promise<RefundTransferLeg[]> {
  const { data, error } = await db.from("platform_hold_refund_transfer_legs")
    .select("*").eq("refund_attempt_id", attempt.id);
  if (error) throw new Error("Refund transfer vector needs exact reconciliation.");
  const legs = (data ?? []) as RefundTransferLeg[];
  if (legs.reduce((sum, leg) => sum + leg.amount_cents, 0) !== attempt.transfer_reversal_cents ||
      legs.some((leg) => leg.hold_id !== attempt.hold_id ||
        leg.refund_attempt_id !== attempt.id || leg.source_charge_id !== attempt.source_charge_id ||
        !leg.source_transfer_id || !Number.isSafeInteger(leg.amount_cents) || leg.amount_cents <= 0 ||
        !Array.isArray(leg.component_breakdown) ||
        leg.component_breakdown.reduce((sum, part) => sum + part.recipient_net_cents, 0) !== leg.amount_cents)) {
    throw new Error("Refund transfer vector differs from frozen recipient debit.");
  }
  return legs;
}

function validateTransferReversal(reversal: Stripe.TransferReversal,
  leg: RefundTransferLeg, attempt: ReservedRefund, refundId: string): void {
  if (!reversal.id || reversal.amount !== leg.amount_cents ||
      idOf(reversal.transfer) !== leg.source_transfer_id ||
      (reversal.source_refund && idOf(reversal.source_refund) !== refundId) ||
      reversal.metadata?.platform_refund_attempt !== attempt.id ||
      reversal.metadata?.platform_refund_id !== refundId ||
      reversal.metadata?.platform_refund_transfer_leg !== leg.id) {
    throw new Error("Recipient reversal differs from frozen transfer leg.");
  }
}

async function finishHoldRecipientReversals(stripe: Stripe, db: SupabaseClient,
  attempt: ReservedRefund, refund: Stripe.Refund, ownerRole: "manager" | "vendor"): Promise<void> {
  const legs = await loadRefundTransferLegs(db, attempt);
  if (attempt.reversal_status === "not_required" && legs.length) {
    throw new Error("Refund has an unexpected recipient reversal vector.");
  }
  if (attempt.reversal_status !== "not_required" &&
      (!legs.length || !["pending", "succeeded"].includes(attempt.reversal_status ?? ""))) {
    throw new Error("Recipient reversal vector needs source review.");
  }
  // Every created provider reversal is checked before creating another leg.
  // A lost response is adopted only when it names this exact frozen leg.
  const { data: allLegs, error } = await db.from("platform_hold_refund_transfer_legs")
    .select("*").eq("hold_id", attempt.hold_id);
  if (error) throw new Error("Recipient reversal history needs exact reconciliation.");
  const { data: transfers, error: transferError } = await db.from("platform_hold_transfer_attempts")
    .select("id,hold_id,source_charge_id,amount_cents,stripe_transfer_id,status")
    .eq("hold_id", attempt.hold_id).eq("status", "created");
  if (transferError) throw new Error("Recipient transfer history needs exact reconciliation.");
  const { data: refundAttempts, error: refundError } = await db.from("platform_hold_refund_attempts")
    .select("id,stripe_refund_id,status").eq("hold_id", attempt.hold_id);
  if (refundError) throw new Error("Recipient refund history needs exact reconciliation.");
  const refundsById = new Map((refundAttempts ?? []).map((row) => [row.id, row]));
  const byTransfer = new Map<string, RefundTransferLeg[]>();
  for (const row of (allLegs ?? []) as RefundTransferLeg[]) {
    if (row.hold_id !== attempt.hold_id || row.status === "failed" ||
        (row.status === "reserved" && row.refund_attempt_id !== attempt.id)) {
      throw new Error("Recipient reversal history has an unresolved source.");
    }
    const group = byTransfer.get(row.source_transfer_id) ?? [];
    group.push(row);
    byTransfer.set(row.source_transfer_id, group);
  }
  const accepted = new Map<string, Stripe.TransferReversal>();
  const transferIds = new Set<string>();
  for (const row of transfers ?? []) {
    const transferId = String(row.stripe_transfer_id ?? "");
    if (!transferId || transferIds.has(transferId) ||
        row.hold_id !== attempt.hold_id || row.source_charge_id !== attempt.source_charge_id ||
        !Number.isSafeInteger(row.amount_cents) || row.amount_cents <= 0) {
      throw new Error("Recipient transfer history differs from captured source.");
    }
    transferIds.add(transferId);
  }
  if ([...byTransfer.keys()].some((id) => !transferIds.has(id))) {
    throw new Error("Recipient reversal refers to an unknown source transfer.");
  }
  for (const transferId of transferIds) {
    const history = byTransfer.get(transferId) ?? [];
    const transfer = await stripe.transfers.retrieve(transferId);
    const provider = await stripe.transfers.listReversals(transferId, { limit: 100 });
    const source = (transfers ?? []).find((row) => row.stripe_transfer_id === transferId);
    if (transfer.id !== transferId || idOf(transfer.source_transaction) !== attempt.source_charge_id ||
        transfer.amount !== source?.amount_cents || provider.has_more ||
        !Number.isSafeInteger(transfer.amount_reversed)) {
      throw new Error("Recipient transfer has unreserved provider recovery.");
    }
    let total = 0;
    const seen = new Set<string>();
    for (const reversal of provider.data) {
      total += reversal.amount;
      const matched = history.find((leg) => leg.stripe_reversal_id === reversal.id ||
        (leg.refund_attempt_id === attempt.id && leg.status === "reserved" &&
          reversal.metadata?.platform_refund_transfer_leg === leg.id));
      if (!matched || seen.has(matched.id) ||
          (matched.status === "created" && matched.stripe_reversal_id !== reversal.id) ||
          (matched.status === "reserved" && matched.refund_attempt_id !== attempt.id)) {
        throw new Error("Recipient transfer has unreserved provider recovery.");
      }
      const parent = refundsById.get(matched.refund_attempt_id);
      const refundId = matched.refund_attempt_id === attempt.id ? refund.id : parent?.stripe_refund_id;
      if (!refundId || parent?.status !== "succeeded" ||
          parent.stripe_refund_id !== refundId) {
        throw new Error("Recipient transfer has unreserved provider recovery.");
      }
      validateTransferReversal(reversal, matched, {
        ...attempt, id: matched.refund_attempt_id,
      }, refundId);
      seen.add(matched.id);
      if (matched.refund_attempt_id === attempt.id) accepted.set(matched.id, reversal);
    }
    if (total !== transfer.amount_reversed ||
        history.some((leg) => leg.status === "created" && !seen.has(leg.id))) {
      throw new Error("Recipient transfer has unreserved provider recovery.");
    }
  }
  if (attempt.reversal_status === "not_required") return;
  for (const leg of legs) {
    let reversal = accepted.get(leg.id);
    if (leg.status === "created") {
      if (!reversal || leg.stripe_reversal_id !== reversal.id ||
          !Number.isSafeInteger(reversal.created) ||
          !leg.reversed_at ||
          Date.parse(leg.reversed_at) !== reversal.created * 1000) {
        throw new Error("Recipient reversal replay changed its provider leg.");
      }
    } else {
      if (leg.status !== "reserved") throw new Error("Recipient reversal vector needs source review.");
      if (!reversal) {
        if (!safeRetryAge(attempt.created_at)) {
          throw new Error("Recipient reversal needs exact provider reconciliation.");
        }
        reversal = await stripe.transfers.createReversal(leg.source_transfer_id,
          { amount: leg.amount_cents, metadata: { platform_refund_attempt: attempt.id,
            platform_refund_id: refund.id, platform_refund_transfer_leg: leg.id } },
          { idempotencyKey: `${attempt.attempt_key}:reversal:${leg.id}` });
      }
      validateTransferReversal(reversal, leg, attempt, refund.id);
      if (!Number.isSafeInteger(reversal.created) || reversal.created <= 0) {
        throw new Error("Recipient reversal has no provider date.");
      }
      await rpcResult<boolean>(db, "finish_platform_refund_transfer_leg", {
        p_attempt: attempt.attempt_key, p_source_transfer: leg.source_transfer_id,
        p_reversal: reversal.id, p_amount: leg.amount_cents,
        p_reversed_at: new Date(reversal.created * 1000).toISOString(),
      });
    }
    if (ownerRole === "manager") {
      for (const component of leg.component_breakdown) {
        if (component.recipient_net_cents <= 0) continue;
        await rpcResult<string>(db, "book_platform_refund_transfer_recovery_component", {
          p_attempt: attempt.attempt_key, p_reversal: reversal.id,
          p_component_source: component.source_id,
        });
      }
    }
  }
}

function idOf(value: string | { id: string } | null | undefined): string | null {
  return typeof value === "string" ? value : value?.id ?? null;
}

function safeRetryAge(createdAt: string): boolean {
  const ageMs = Date.now() - Date.parse(createdAt);
  // created_at is the database clock; tolerate small app/db clock skew.
  return Number.isFinite(ageMs) && ageMs >= -5 * 60 * 1000 && ageMs < 20 * 60 * 60 * 1000;
}

async function rpcResult<T>(db: SupabaseClient, functionName: string,
  args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(functionName, args);
  if (error || data == null) throw new Error(`Could not ${functionName}: ${error?.message ?? "no result"}`);
  return data as T;
}

async function loadReservedRefund(db: SupabaseClient, attemptKey: string): Promise<ReservedRefund> {
  const { data, error } = await db.from("platform_hold_refund_attempts")
    .select("*").eq("attempt_key", attemptKey).maybeSingle();
  if (error || !data) throw new Error("Refund reservation needs exact reconciliation.");
  return data as ReservedRefund;
}

function validateProviderRefund(refund: Stripe.Refund, attempt: ReservedRefund): void {
  if (!refund.id || idOf(refund.charge) !== attempt.source_charge_id ||
      refund.amount !== attempt.gross_cents || refund.currency !== "usd" ||
      refund.metadata?.platform_refund_attempt !== attempt.id ||
      idOf(refund.transfer_reversal) || idOf(refund.source_transfer_reversal)) {
    throw new Error("Provider refund differs from reserved source and amount.");
  }
}

async function assertNoUnreservedRecipientRecovery(
  stripe: Stripe, db: SupabaseClient, attempt: ReservedRefund,
): Promise<Stripe.TransferReversal | null> {
  const { data: hold, error } = await db.from("platform_payment_holds")
    .select("id,stripe_charge_id,stripe_transfer_id,source_application_fee_id,source_allocation_mode")
    .eq("id", attempt.hold_id).maybeSingle();
  if (error || !hold || hold.stripe_charge_id !== attempt.source_charge_id) {
    throw new Error("Refund recipient allocation needs source review.");
  }
  if (hold.source_allocation_mode === "hold") {
    // The canonical payer fact is durable before inspecting any exact
    // recipient reversals. The vector path below checks every source transfer.
    if (hold.source_application_fee_id) {
      throw new Error("Central source has an unexpected recipient application fee.");
    }
    return null;
  }
  let currentReversal: Stripe.TransferReversal | null = null;
  if (hold.stripe_transfer_id) {
    const transfer = await stripe.transfers.retrieve(hold.stripe_transfer_id);
    const [providerReversals, storedReversals] = await Promise.all([
      stripe.transfers.listReversals(hold.stripe_transfer_id, { limit: 100 }),
      db.from("platform_hold_refund_attempts")
        .select("id,stripe_refund_id,stripe_reversal_id,hold_debit_cents,reversal_status,status")
        .eq("hold_id", hold.id),
    ]);
    if (transfer.id !== hold.stripe_transfer_id || storedReversals.error ||
        providerReversals.has_more || !Number.isSafeInteger(transfer.amount_reversed)) {
      throw new Error("Recipient transfer has unreserved provider recovery.");
    }
    const mapped = (storedReversals.data ?? []).filter((row) =>
      row.status === "succeeded" && row.reversal_status === "succeeded");
    const pendingCurrent = attempt.status === "succeeded" && attempt.reversal_status === "pending";
    const known = new Set<string>();
    for (const provider of providerReversals.data) {
      const row = mapped.find((stored) => stored.stripe_reversal_id === provider.id);
      if (row) {
        if (known.has(row.id) || row.hold_debit_cents !== provider.amount ||
            idOf(provider.transfer) !== transfer.id ||
            provider.metadata?.platform_refund_attempt !== row.id ||
            provider.metadata?.platform_refund_id !== row.stripe_refund_id) {
          throw new Error("Recipient transfer has unreserved provider recovery.");
        }
        known.add(row.id);
      } else if (pendingCurrent && !currentReversal &&
          provider.metadata?.platform_refund_attempt === attempt.id &&
          provider.metadata?.platform_refund_id === attempt.stripe_refund_id &&
          provider.amount === attempt.hold_debit_cents &&
          idOf(provider.transfer) === transfer.id &&
          (!provider.source_refund || idOf(provider.source_refund) === attempt.stripe_refund_id)) {
        currentReversal = provider;
      } else {
        throw new Error("Recipient transfer has unreserved provider recovery.");
      }
    }
    if (known.size !== mapped.length ||
        providerReversals.data.reduce((sum, row) => sum + row.amount, 0) !== transfer.amount_reversed) {
      throw new Error("Recipient transfer has unreserved provider recovery.");
    }
  }
  if (hold.source_application_fee_id) {
    const fee = await stripe.applicationFees.retrieve(hold.source_application_fee_id);
    if (fee.id !== hold.source_application_fee_id || fee.amount_refunded !== 0 ||
        fee.refunds?.data.length || fee.refunds?.has_more) {
      throw new Error("Recipient application fee has unreserved provider recovery.");
    }
  }
  return currentReversal;
}

async function findAcceptedOrClearProviderRefund(
  stripe: Stripe, db: SupabaseClient, attempt: ReservedRefund,
): Promise<Stripe.Refund | null> {
  const { data: hold, error: holdError } = await db.from("platform_payment_holds")
    .select("id,stripe_charge_id,source_charge_gross_cents,source_payment_intent_id,source_verified_at")
    .eq("id", attempt.hold_id).maybeSingle();
  if (holdError || !hold || !hold.source_verified_at ||
      hold.stripe_charge_id !== attempt.source_charge_id ||
      !hold.source_payment_intent_id || !hold.source_charge_gross_cents) {
    throw new Error("Refund source allocation needs captured provider review.");
  }
  const charge = await stripe.charges.retrieve(attempt.source_charge_id);
  if (charge.id !== attempt.source_charge_id || !charge.paid || charge.status !== "succeeded" ||
      charge.currency !== "usd" || charge.disputed ||
      charge.amount !== hold.source_charge_gross_cents ||
      idOf(charge.payment_intent) !== hold.source_payment_intent_id) {
    throw new Error("Refund source charge differs from captured payment.");
  }
  const [provider, stored] = await Promise.all([
    stripe.refunds.list({ charge: charge.id, limit: 100 }),
    db.from("platform_hold_refund_attempts")
      .select("id,stripe_refund_id,source_charge_id,gross_cents,status,terminal_provider_status")
      .eq("source_charge_id", charge.id),
  ]);
  if (stored.error || provider.has_more) throw new Error("Refund history needs exact reconciliation.");
  const byId = new Map((stored.data ?? []).filter((row) => row.stripe_refund_id)
    .map((row) => [String(row.stripe_refund_id), row]));
  let current: Stripe.Refund | null = null;
  let refundedCents = 0;
  for (const providerRefund of provider.data) {
    if (idOf(providerRefund.charge) !== charge.id || providerRefund.currency !== "usd") {
      throw new Error("Refund history differs from captured charge.");
    }
    if (providerRefund.status === "succeeded") refundedCents += providerRefund.amount;
    if (providerRefund.metadata?.platform_refund_attempt === attempt.id) {
      validateProviderRefund(providerRefund, attempt);
      if (current) throw new Error("Refund attempt has multiple provider objects.");
      current = providerRefund;
      continue;
    }
    const matched = byId.get(providerRefund.id);
    if (!matched || matched.source_charge_id !== charge.id ||
        matched.gross_cents !== providerRefund.amount ||
        (providerRefund.status === "succeeded" && matched.status !== "succeeded") ||
        ((providerRefund.status === "failed" || providerRefund.status === "canceled") &&
          (matched.status !== "failed" || matched.terminal_provider_status !== providerRefund.status)) ||
        (providerRefund.status === "pending" && matched.status !== "reserved")) {
      throw new Error("Captured source has an unmapped provider refund.");
    }
  }
  if (charge.amount_refunded !== refundedCents) {
    throw new Error("Captured charge refund total needs reconciliation.");
  }
  return current;
}

async function finishRecipientReversal(stripe: Stripe, db: SupabaseClient,
  attempt: ReservedRefund, refund: Stripe.Refund): Promise<Stripe.TransferReversal | null> {
  if (attempt.reversal_status === "not_required") return null;
  if (attempt.hold_debit_cents <= 0 || !attempt.hold_id) {
    throw new Error("Recipient reversal reservation has no source debit.");
  }
  const { data: hold, error } = await db.from("platform_payment_holds")
    .select("id,owner_user_id,status,stripe_charge_id,stripe_transfer_id")
    .eq("id", attempt.hold_id).maybeSingle();
  if (error || !hold || hold.owner_user_id !== attempt.owner_user_id ||
      hold.stripe_charge_id !== attempt.source_charge_id) {
    throw new Error("Refund recipient allocation needs source review.");
  }
  const transferId = String(hold.stripe_transfer_id ?? "");
  if (!transferId) throw new Error("Transferred refund has no original recipient transfer.");
  if (attempt.reversal_status === "succeeded") {
    if (!attempt.stripe_reversal_id) throw new Error("Recipient reversal has no provider ID.");
    const reversal = await stripe.transfers.retrieveReversal(transferId, attempt.stripe_reversal_id);
    if (reversal.id !== attempt.stripe_reversal_id || reversal.amount !== attempt.hold_debit_cents ||
        idOf(reversal.transfer) !== transferId ||
        (reversal.source_refund && idOf(reversal.source_refund) !== refund.id) ||
        reversal.metadata?.platform_refund_attempt !== attempt.id ||
        reversal.metadata?.platform_refund_id !== refund.id) {
      throw new Error("Recipient reversal replay changed its provider source.");
    }
    return reversal;
  }
  if (attempt.reversal_status !== "pending") {
    throw new Error("Recipient refund reversal state needs source review.");
  }
  const accepted = await assertNoUnreservedRecipientRecovery(stripe, db, attempt);
  if (accepted) {
    await rpcResult<boolean>(db, "finish_platform_transfer_reversal", {
      p_attempt: attempt.attempt_key, p_source_transfer: transferId,
      p_reversal: accepted.id, p_amount: attempt.hold_debit_cents,
    });
    return accepted;
  }
  if (!safeRetryAge(attempt.created_at)) {
    throw new Error("Recipient reversal needs exact provider reconciliation.");
  }
  const reversal = await stripe.transfers.createReversal(transferId,
    { amount: attempt.hold_debit_cents,
      metadata: { platform_refund_attempt: attempt.id, platform_refund_id: refund.id } },
    { idempotencyKey: `${attempt.attempt_key}:reversal` });
  if (reversal.amount !== attempt.hold_debit_cents ||
      idOf(reversal.transfer) !== transferId ||
      (reversal.source_refund && idOf(reversal.source_refund) !== refund.id) ||
      reversal.metadata?.platform_refund_attempt !== attempt.id ||
      reversal.metadata?.platform_refund_id !== refund.id) {
    throw new Error("Recipient reversal differs from reserved net debit.");
  }
  await rpcResult<boolean>(db, "finish_platform_transfer_reversal", {
    p_attempt: attempt.attempt_key, p_source_transfer: transferId,
    p_reversal: reversal.id, p_amount: attempt.hold_debit_cents,
  });
  return reversal;
}

async function finishSucceededRefund(stripe: Stripe, db: SupabaseClient,
  attempt: ReservedRefund, refund: Stripe.Refund): Promise<{
    status: "succeeded"; refundId: string; recipientNetDebitCents: number;
    vendorFeeShareCents: number;
  }> {
  validateProviderRefund(refund, attempt);
  await rpcResult<boolean>(db, "finish_platform_money_refund", {
    p_attempt: attempt.attempt_key, p_refund: refund.id, p_gross: attempt.gross_cents,
  });
  const settledAttempt = await loadReservedRefund(db, attempt.attempt_key);
  if (settledAttempt.id !== attempt.id || settledAttempt.status !== "succeeded" ||
      settledAttempt.stripe_refund_id !== refund.id ||
      settledAttempt.hold_debit_cents !== attempt.hold_debit_cents ||
      settledAttempt.source_charge_id !== attempt.source_charge_id) {
    throw new Error("Refund settlement changed its immutable source.");
  }
  const { data: allocation, error: allocationError } = await db
    .from("platform_payment_holds")
    .select("id,owner_user_id,owner_role,stripe_charge_id,source_allocation_mode")
    .eq("id", settledAttempt.hold_id).maybeSingle();
  if (allocationError || !allocation || allocation.owner_user_id !== settledAttempt.owner_user_id ||
      allocation.stripe_charge_id !== settledAttempt.source_charge_id) {
    throw new Error("Refund accounting has no exact recipient allocation.");
  }
  if (allocation.owner_role === "manager") {
    if (!Number.isSafeInteger(refund.created) || refund.created <= 0 ||
        !settledAttempt.refund_components?.length) {
      throw new Error("Refund accounting lacks provider date or captured components.");
    }
    const providerDate = new Date(refund.created * 1000).toISOString();
    for (const component of settledAttempt.refund_components) {
      if (!component.source_id?.trim() || !Number.isSafeInteger(component.principal_cents) ||
          component.principal_cents <= 0) {
        throw new Error("Refund accounting component needs source review.");
      }
      await rpcResult<string>(db, "book_platform_refund_component", {
        p_attempt: settledAttempt.attempt_key,
        p_component_source: component.source_id,
        p_refunded_at: providerDate,
      });
    }
  } else if (allocation.owner_role !== "vendor") {
    throw new Error("Refund accounting recipient role needs review.");
  }
  await assertNoUnreservedRecipientRecovery(stripe, db, settledAttempt);
  // A transferred payer refund is already posted to the platform creditor.
  // Recipient cash is posted only after this exact provider reversal succeeds.
  if (allocation.source_allocation_mode === "hold") {
    await finishHoldRecipientReversals(stripe, db, settledAttempt, refund, allocation.owner_role);
  } else if (allocation.source_allocation_mode !== "destination") {
    throw new Error("Refund allocation mode needs source review.");
  }
  const recovered = allocation.source_allocation_mode === "destination"
    ? await finishRecipientReversal(stripe, db, settledAttempt, refund) : null;
  if (allocation.owner_role === "manager" && recovered) {
    if (!Number.isSafeInteger(recovered.created) || recovered.created <= 0 ||
        !settledAttempt.refund_components?.length ||
        settledAttempt.recipient_debit_components?.length !== settledAttempt.refund_components.length) {
      throw new Error("Recipient recovery lacks exact provider date or components.");
    }
    const recoveredAt = new Date(recovered.created * 1000).toISOString();
    const seen = new Set<string>();
    let recoveredNet = 0;
    const positiveComponents: string[] = [];
    for (const component of settledAttempt.recipient_debit_components ?? []) {
      if (!component.source_id?.trim() || seen.has(component.source_id) ||
          !Number.isSafeInteger(component.principal_cents) || component.principal_cents <= 0 ||
          !Number.isSafeInteger(component.recipient_debit_cents) ||
          component.recipient_debit_cents < 0 ||
          component.recipient_debit_cents > component.principal_cents ||
          !settledAttempt.refund_components?.some((frozen) =>
            frozen.source_id === component.source_id &&
            frozen.principal_cents === component.principal_cents)) {
        throw new Error("Recipient recovery differs from frozen refund components.");
      }
      seen.add(component.source_id);
      recoveredNet += component.recipient_debit_cents;
      if (component.recipient_debit_cents > 0) positiveComponents.push(component.source_id);
    }
    if (recoveredNet !== settledAttempt.hold_debit_cents) {
      throw new Error("Recipient recovery net differs from the provider reversal.");
    }
    for (const sourceId of positiveComponents) {
      await rpcResult<string>(db, "book_platform_refund_recovery_component", {
        p_attempt: settledAttempt.attempt_key,
        p_component_source: sourceId,
        p_reversal_created_at: recoveredAt,
      });
    }
  }
  return { status: "succeeded", refundId: refund.id,
    recipientNetDebitCents: attempt.hold_debit_cents,
    vendorFeeShareCents: attempt.fee_share_cents };
}

/**
 * One source-bound provider refund attempt. Unknown provider outcomes retain
 * the same claim and key; a pending refund retains its exact provider ID.
 * The caller owns charge/payout authorization and subsequent idempotent GL.
 */
export async function runReservedPlatformMoneyRefund(
  stripe: Stripe, db: SupabaseClient,
  input: { ownerUserId: string; holdId: string; payoutId?: string | null;
    principalCents: number; attemptKey: string;
    components?: Array<{ sourceId: string; principalCents: number }>;
    reason?: Stripe.RefundCreateParams.Reason },
): Promise<{ status: "succeeded" | "pending" | "failed"; refundId: string;
  recipientNetDebitCents: number; vendorFeeShareCents: number }> {
  const gross = input.principalCents;
  if (!input.attemptKey.trim() || !Number.isSafeInteger(gross) || gross <= 0) {
    throw new Error("Refund attempt and positive principal are required.");
  }
  const components = input.components?.map((component) => ({
    source_id: component.sourceId, principal_cents: component.principalCents,
  })) ?? null;
  if (components && (components.length === 0 ||
      components.some((component) => !component.source_id?.trim() ||
        !Number.isSafeInteger(component.principal_cents) || component.principal_cents <= 0) ||
      new Set(components.map((component) => component.source_id)).size !== components.length ||
      components.reduce((sum, component) => sum + component.principal_cents, 0) !== gross)) {
    throw new Error("Refund components must identify the exact principal source.");
  }
  const attempt = await rpcResult<ReservedRefund>(db, "reserve_platform_money_refund", {
    p_owner: input.ownerUserId, p_attempt: input.attemptKey,
    p_gross: gross, p_principal: gross, p_hold: input.holdId,
    p_payout: input.payoutId ?? null,
    p_reason: input.reason ?? "requested_by_customer",
    p_reverse_transfer: false, p_refund_application_fee: false,
    p_components: components,
  });
  if (attempt.owner_user_id !== input.ownerUserId || attempt.hold_id !== input.holdId ||
      attempt.payout_id !== (input.payoutId ?? null) ||
      attempt.attempt_key !== input.attemptKey || attempt.gross_cents !== gross ||
      attempt.principal_cents !== gross || !attempt.source_charge_id ||
      attempt.reverse_transfer || attempt.refund_application_fee ||
      (components !== null && (attempt.refund_components?.length !== components.length ||
        components.some((component) => !attempt.refund_components?.some((stored) =>
          stored.source_id === component.source_id &&
          stored.principal_cents === component.principal_cents))))) {
    throw new Error("Reserved refund changed its immutable source.");
  }
  if (attempt.status === "failed") {
    return { status: "failed", refundId: attempt.stripe_refund_id ?? "",
      recipientNetDebitCents: 0, vendorFeeShareCents: 0 };
  }
  let refund: Stripe.Refund;
  if (attempt.stripe_refund_id) {
    refund = await stripe.refunds.retrieve(attempt.stripe_refund_id);
  } else {
    const accepted = await findAcceptedOrClearProviderRefund(stripe, db, attempt);
    if (accepted) {
      refund = accepted;
    } else {
    if (!safeRetryAge(attempt.created_at)) {
      throw new Error("Uncertain refund needs exact provider reconciliation.");
    }
    refund = await stripe.refunds.create({ charge: attempt.source_charge_id,
      amount: attempt.gross_cents, reason: attempt.provider_reason,
      reverse_transfer: false, refund_application_fee: false,
      metadata: { platform_refund_attempt: attempt.id,
        ...(input.payoutId ? { vendor_payout_id: input.payoutId } : { platform_hold_id: input.holdId }) } },
    { idempotencyKey: attempt.attempt_key });
    }
  }
  validateProviderRefund(refund, attempt);
  if (refund.status === "pending") {
    await rpcResult<boolean>(db, "stamp_platform_pending_refund", {
      p_attempt: attempt.attempt_key, p_refund: refund.id,
      p_charge: attempt.source_charge_id, p_gross: attempt.gross_cents,
    });
    const afterStamp = await loadReservedRefund(db, attempt.attempt_key);
    if (afterStamp.id !== attempt.id || afterStamp.stripe_refund_id !== refund.id ||
        afterStamp.source_charge_id !== attempt.source_charge_id ||
        afterStamp.gross_cents !== attempt.gross_cents) {
      throw new Error("Pending refund changed its durable provider source.");
    }
    if (afterStamp.status !== "reserved") {
      const terminal = await stripe.refunds.retrieve(refund.id);
      validateProviderRefund(terminal, attempt);
      if (afterStamp.status === "succeeded" && terminal.status === "succeeded") {
        return finishSucceededRefund(stripe, db, attempt, terminal);
      }
      if (afterStamp.status === "failed" && terminal.status === afterStamp.terminal_provider_status) {
        return { status: "failed", refundId: refund.id,
          recipientNetDebitCents: 0, vendorFeeShareCents: 0 };
      }
      throw new Error("Provider refund and durable terminal result need reconciliation.");
    }
    return { status: "pending", refundId: refund.id,
      recipientNetDebitCents: 0, vendorFeeShareCents: 0 };
  }
  if (refund.status === "failed" || refund.status === "canceled") {
    await rpcResult<boolean>(db, "fail_platform_money_refund", {
      p_attempt: attempt.attempt_key, p_refund: refund.id,
      p_terminal_status: refund.status, p_charge: attempt.source_charge_id,
      p_gross: attempt.gross_cents,
    });
    return { status: "failed", refundId: refund.id,
      recipientNetDebitCents: 0, vendorFeeShareCents: 0 };
  }
  if (refund.status !== "succeeded") throw new Error("Provider refund status needs review.");
  // A held source is deducted under the same lock; a transferred recipient
  // needs its exact separate provider reversal before claiming recovery.
  return finishSucceededRefund(stripe, db, attempt, refund);
}

/** Settle only an exact provider refund that names its durable reservation. */
export async function settleReservedPlatformMoneyRefundFromWebhook(
  stripe: Stripe, db: SupabaseClient, refund: Stripe.Refund,
): Promise<"pending" | "failed" | "succeeded" | "unmatched"> {
  const attemptId = refund.metadata?.platform_refund_attempt?.trim();
  if (!attemptId) return "unmatched";
  const { data, error } = await db.from("platform_hold_refund_attempts")
    .select("*").eq("id", attemptId).maybeSingle();
  if (error || !data) throw new Error("Provider refund reservation needs exact reconciliation.");
  const attempt = data as ReservedRefund;
  validateProviderRefund(refund, attempt);
  if (refund.status === "pending") {
    await rpcResult<boolean>(db, "stamp_platform_pending_refund", {
      p_attempt: attempt.attempt_key, p_refund: refund.id,
      p_charge: attempt.source_charge_id, p_gross: attempt.gross_cents,
    });
    const afterStamp = await loadReservedRefund(db, attempt.attempt_key);
    if (afterStamp.status === "succeeded" || afterStamp.status === "failed") {
      const current = await stripe.refunds.retrieve(refund.id);
      validateProviderRefund(current, attempt);
      if (afterStamp.status === "succeeded" && current.status === "succeeded") {
        await finishSucceededRefund(stripe, db, attempt, current);
        return "succeeded";
      }
      if (afterStamp.status === "failed" && current.status === afterStamp.terminal_provider_status) {
        return "failed";
      }
      throw new Error("Refund event is older than its durable provider result.");
    }
    return "pending";
  }
  if (refund.status === "failed" || refund.status === "canceled") {
    await rpcResult<boolean>(db, "fail_platform_money_refund", {
      p_attempt: attempt.attempt_key, p_refund: refund.id,
      p_terminal_status: refund.status, p_charge: attempt.source_charge_id,
      p_gross: attempt.gross_cents,
    });
    return "failed";
  }
  if (refund.status !== "succeeded") throw new Error("Refund provider status needs review.");
  await finishSucceededRefund(stripe, db, attempt, refund);
  return "succeeded";
}
