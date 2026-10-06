import "server-only";

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { HouseholdCharge } from "@/lib/household-charges";
import { parseMoneyAmount } from "@/lib/parse-money";
import { findPlatformHold, findPlatformHoldByPaymentIntent } from "@/lib/stripe-platform-hold.server";
import { enrichLedgerPaymentFromStripeCharge } from "@/lib/stripe-ledger-fees";
import { verifyPlatformHoldSourceRefundHistory,
  releaseVerifiedPlatformHoldsForOwner, type HeldSourceRow } from "@/lib/platform-hold-release.server";
import { settleClearedPlatformOwnerRecovery,
  verifiedCapturedChargeAvailability } from "@/lib/platform-owner-recovery.server";

type CapturedComponent = {
  source_id: string; kind: HouseholdCharge["kind"];
  liability_class: "income" | "deposit";
  principal_cents: number; recipient_net_cents: number;
};

function idOf(value: string | { id: string } | null | undefined): string | null {
  return typeof value === "string" ? value : value?.id ?? null;
}

function exactPositive(value: string | undefined): number {
  const amount = Number(value);
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("Captured household source has an invalid amount.");
  }
  return amount;
}

/** Provider-only preflight before a marked claim first stamps paid. It does
 * not read or mutate charge rows, so the claim writer can call it before its
 * atomic paid/ledger transition. A replay with a later refund uses the
 * existing source reconciliation path instead. */
export async function assertFreshHouseholdCapturedSource(
  stripe: Stripe,
  source: { checkoutSession: Stripe.Checkout.Session; paymentIntent?: Stripe.PaymentIntent } |
    { checkoutSession?: never; paymentIntent: Stripe.PaymentIntent },
): Promise<{ paymentIntent: Stripe.PaymentIntent; charge: Stripe.Charge }> {
  const session = source.checkoutSession;
  const pi = session
    ? await (async () => {
      const piId = idOf(session.payment_intent);
      if (!piId) throw new Error("Paid household Checkout has no PaymentIntent.");
      if (source.paymentIntent) {
        if (source.paymentIntent.id !== piId) {
          throw new Error("Paid household Checkout has another PaymentIntent.");
        }
        return source.paymentIntent;
      }
      return stripe.paymentIntents.retrieve(piId);
    })()
    : source.paymentIntent;
  const meta = session?.metadata ?? pi.metadata ?? {};
  const manualIntent = !session && meta.manual_ach === "1";
  const owner = meta.manager_user_id?.trim() ?? "";
  const principal = exactPositive(session ? meta.subtotal_cents : meta.principal_cents);
  const net = exactPositive(meta.manager_payout_cents);
  const processing = Number(meta.processing_fee_cents);
  const gross = session ? session.amount_total : pi.amount_received;
  if (meta.source_arbitration_v !== "1" || meta.purpose !== "household_charge" ||
      !owner || !meta.charge_id || !Number.isSafeInteger(processing) || processing < 0 ||
      !Number.isSafeInteger(gross) || gross !== principal + processing ||
      net > principal || meta.hold_amount_cents !== String(net) ||
      meta.platform_hold !== "1" || meta.funding_model ||
      !["resident", "manager", "proplane"].includes(meta.fee_payer ?? "") ||
      (meta.fee_payer === "resident" && net !== principal) ||
      (meta.fee_payer === "proplane" && (net !== principal || processing !== 0)) ||
      (meta.fee_payer === "manager" && processing !== 0) ||
      pi.status !== "succeeded" || pi.currency !== "usd" ||
      pi.amount !== gross || pi.amount_received !== gross || pi.metadata?.source_arbitration_v !== "1" ||
      pi.metadata?.purpose !== "household_charge" ||
      pi.metadata?.charge_id !== meta.charge_id ||
      pi.metadata?.manager_user_id !== owner ||
      pi.metadata?.fee_payer !== meta.fee_payer ||
      pi.metadata?.hold_amount_cents !== String(net) ||
      pi.transfer_data?.destination || pi.application_fee_amount ||
      (session && (session.status !== "complete" || session.payment_status !== "paid" ||
        session.currency?.toLowerCase() !== "usd" || meta.charge_ids !== pi.metadata?.charge_ids ||
        meta.charge_id !== (meta.charge_ids || meta.charge_id).split(",")[0])) ||
      (!session && (meta.subtotal_cents !== String(principal) ||
        meta.total_cents !== String(gross) ||
        (manualIntent ? (!meta.charge_ids || meta.autopay_run_id ||
          meta.charge_id !== meta.charge_ids.split(",")[0]) : !meta.autopay_run_id)))) {
    throw new Error("Household capture differs from its frozen central source.");
  }
  const chargeId = idOf(pi.latest_charge);
  if (!chargeId) throw new Error("Paid household source has no captured Charge.");
  const charge = await stripe.charges.retrieve(chargeId);
  if (idOf(charge.payment_intent) !== pi.id || !charge.paid || !charge.captured ||
      charge.status !== "succeeded" || charge.currency !== "usd" ||
      charge.amount !== gross || charge.disputed || charge.refunded ||
      (charge.amount_refunded ?? 0) !== 0) {
    throw new Error("Household captured Charge differs from its PaymentIntent.");
  }
  const refunds = await stripe.refunds.list({ charge: charge.id, limit: 1 });
  if (refunds.data.length || refunds.has_more) {
    throw new Error("Household source has refund evidence before paid settlement.");
  }
  return { paymentIntent: pi, charge };
}

/** A claim-backed manual bank PaymentIntent uses its own id as the immutable
 * household source key; paid charge rows stamp that same id. Reuse the exact
 * cart/component/owner/recovery path used by marked Checkout captures. */
export async function creditVerifiedHouseholdManualSource(
  db: SupabaseClient, stripe: Stripe, pi: Stripe.PaymentIntent,
): Promise<void> {
  const meta = pi.metadata ?? {};
  if (meta.manual_ach !== "1" || meta.autopay_run_id ||
      meta.principal_cents !== meta.subtotal_cents ||
      meta.total_cents !== String(pi.amount_received) ||
      !meta.charge_ids || !meta.charge_id ||
      meta.charge_id !== meta.charge_ids.split(",")[0]) {
    throw new Error("Manual bank capture lacks an exact claim-backed source.");
  }
  await creditVerifiedHouseholdCheckoutSource(db, stripe, {
    id: pi.id, payment_intent: pi.id, metadata: meta,
    amount_total: pi.amount_received, currency: "usd", mode: "payment",
    status: "complete", payment_status: "paid",
  } as Stripe.Checkout.Session);
}

/** Assign the frozen recipient fee across the actual paid charges, with stable rounding. */
function allocateComponents(
  charges: Array<{ id: string; charge: HouseholdCharge }>, principal: number, net: number,
): CapturedComponent[] {
  const parts = charges.map(({ id, charge }) => {
    const face = Math.round(parseMoneyAmount(charge.amountLabel) * 100);
    const paid = charge.paidAmountCents;
    if (!Number.isSafeInteger(face) || face <= 0 ||
        !Number.isSafeInteger(paid) || !paid || paid <= 0 || paid > face) {
      throw new Error("Paid household charge lacks its exact saved principal.");
    }
    return { source_id: id, kind: charge.kind,
      liability_class: (["security_deposit", "holding_deposit"].includes(charge.kind)
        ? "deposit" : "income") as "income" | "deposit",
      principal_cents: paid, recipient_net_cents: 0 };
  }).sort((a, b) => a.source_id.localeCompare(b.source_id));
  if (parts.some((part) => !Number.isSafeInteger(part.principal_cents) || part.principal_cents <= 0) ||
      parts.reduce((sum, part) => sum + part.principal_cents, 0) !== principal ||
      net <= 0 || net > principal) {
    throw new Error("Paid household charges do not sum to the captured principal.");
  }
  const fee = principal - net;
  const shares = parts.map((part) => ({
    base: Math.floor(fee * part.principal_cents / principal),
    remainder: (fee * part.principal_cents) % principal,
  }));
  let residue = fee - shares.reduce((sum, share) => sum + share.base, 0);
  const rank = parts.map((_, index) => index)
    .sort((a, b) => shares[b]!.remainder - shares[a]!.remainder ||
      parts[a]!.source_id.localeCompare(parts[b]!.source_id));
  for (const index of rank) {
    if (residue-- <= 0) break;
    shares[index]!.base += 1;
  }
  return parts.map((part, index) => ({ ...part,
    recipient_net_cents: part.principal_cents - shares[index]!.base }));
}

/** Best-effort: stamp the payment ledger row with the captured charge id and Stripe's real fee/net.
 * Money is already credited atomically above, so a failure here only leaves those columns for the
 * next delivery or reconcile; it never fails the settlement. */
async function recordLedgerChargeFacts(
  db: SupabaseClient, stripe: Stripe, chargeId: string, sourceId: string,
): Promise<void> {
  await enrichLedgerPaymentFromStripeCharge(db, stripe, {
    stripeChargeId: chargeId, stripeCheckoutSessionId: sourceId, destinationCharge: false,
  }).catch((error) => console.error("[household source] ledger charge facts", error));
}

/** Frozen pre-marker Checkout terms may replay, but cannot mint a new raw hold. */
export async function verifyExistingHistoricalHouseholdHold(
  db: SupabaseClient, stripe: Stripe, session: Stripe.Checkout.Session,
): Promise<void> {
  if (session.metadata?.platform_hold !== "1") return;
  const owner = session.metadata.manager_user_id?.trim() ?? "";
  const net = exactPositive(session.metadata.hold_amount_cents);
  const piId = idOf(session.payment_intent);
  if (!owner || !piId || session.status !== "complete" ||
      session.payment_status !== "paid") {
    throw new Error("Historical household hold lacks a paid frozen source.");
  }
  const pi = await stripe.paymentIntents.retrieve(piId);
  const chargeId = idOf(pi.latest_charge);
  if (!chargeId || pi.status !== "succeeded" || pi.currency !== "usd" ||
      pi.amount_received !== session.amount_total ||
      pi.metadata?.manager_user_id !== owner || pi.transfer_data?.destination) {
    throw new Error("Historical household PaymentIntent differs from its source.");
  }
  const charge = await stripe.charges.retrieve(chargeId);
  if (!charge.paid || charge.status !== "succeeded" || charge.currency !== "usd" ||
      charge.amount !== session.amount_total || idOf(charge.payment_intent) !== pi.id ||
      charge.disputed) {
    throw new Error("Historical household Charge differs from its PaymentIntent.");
  }
  const existing = await findPlatformHold(db, "household_charge", session.id);
  if (!existing || existing.ownerUserId !== owner || existing.ownerRole !== "manager" ||
      existing.stripeChargeId !== charge.id || existing.amountCents > net) {
    throw new Error("Historical household capture needs exact hold reconciliation.");
  }
  if (existing.amountCents !== net || charge.refunded || (charge.amount_refunded ?? 0) > 0) {
    const { data, error } = await db.from("platform_payment_holds")
      .select("id,owner_user_id,owner_role,source,source_id,amount_cents,status,stripe_charge_id,original_amount_cents,source_charge_gross_cents,source_payment_intent_id,source_verified_at")
      .eq("id", existing.id).maybeSingle();
    if (error || !data || !data.source_verified_at) {
      throw new Error("Historical household refund needs verified source reconciliation.");
    }
    await verifyPlatformHoldSourceRefundHistory(db, stripe, data as HeldSourceRow);
  } else {
    const refunds = await stripe.refunds.list({ charge: charge.id, limit: 1 });
    if (refunds.data.length || refunds.has_more) {
      throw new Error("Historical household source has unmapped refund evidence.");
    }
  }
}

/** Unmarked in-flight autopay may reconcile an existing exact PI hold only. */
export async function verifyExistingHistoricalAutopayHold(
  db: SupabaseClient, stripe: Stripe, pi: Stripe.PaymentIntent, householdChargeId: string,
): Promise<void> {
  if (pi.metadata?.platform_hold !== "1") return;
  const owner = pi.metadata.manager_user_id?.trim() ?? "";
  const net = exactPositive(pi.metadata.hold_amount_cents);
  const chargeId = idOf(pi.latest_charge);
  if (!owner || pi.metadata.charge_id !== householdChargeId || !chargeId ||
      pi.status !== "succeeded" || pi.currency !== "usd" ||
      pi.transfer_data?.destination) {
    throw new Error("Historical autopay PaymentIntent lacks exact source terms.");
  }
  const charge = await stripe.charges.retrieve(chargeId);
  if (!charge.paid || charge.status !== "succeeded" || charge.currency !== "usd" ||
      charge.amount !== pi.amount_received || idOf(charge.payment_intent) !== pi.id ||
      charge.disputed) {
    throw new Error("Historical autopay Charge differs from its PaymentIntent.");
  }
  const existing = await findPlatformHold(db, "household_charge", pi.id);
  if (!existing || existing.ownerUserId !== owner || existing.ownerRole !== "manager" ||
      existing.stripeChargeId !== charge.id || existing.amountCents > net) {
    throw new Error("Historical autopay capture needs exact hold reconciliation.");
  }
  if (existing.amountCents !== net || charge.refunded || (charge.amount_refunded ?? 0) > 0) {
    const { data, error } = await db.from("platform_payment_holds")
      .select("id,owner_user_id,owner_role,source,source_id,amount_cents,status,stripe_charge_id,original_amount_cents,source_charge_gross_cents,source_payment_intent_id,source_verified_at")
      .eq("id", existing.id).maybeSingle();
    if (error || !data || !data.source_verified_at) {
      throw new Error("Historical autopay refund needs verified source reconciliation.");
    }
    await verifyPlatformHoldSourceRefundHistory(db, stripe, data as HeldSourceRow);
  } else {
    const refunds = await stripe.refunds.list({ charge: charge.id, limit: 1 });
    if (refunds.data.length || refunds.has_more) {
      throw new Error("Historical autopay source has unmapped refund evidence.");
    }
  }
}

/** The version marker is frozen at Checkout creation, including on the PI. */
export async function creditVerifiedHouseholdCheckoutSource(
  db: SupabaseClient, stripe: Stripe, session: Stripe.Checkout.Session,
): Promise<void> {
  const meta = session.metadata ?? {};
  const manager = meta.manager_user_id?.trim() ?? "";
  const ids = (meta.charge_ids || meta.charge_id || "").split(",").map((id) => id.trim());
  if (meta.source_arbitration_v !== "1" || meta.purpose !== "household_charge" ||
      !manager || ids.length === 0 || ids.length > 10 ||
      ids.some((id) => !id) || new Set(ids).size !== ids.length ||
      meta.charge_id !== ids[0] || session.status !== "complete" ||
      session.payment_status !== "paid" || session.currency?.toLowerCase() !== "usd" ||
      meta.funding_model || !["resident", "manager", "proplane"].includes(meta.fee_payer ?? "")) {
    throw new Error("Household capture lacks an exact central source claim.");
  }
  const gross = exactPositive(String(session.amount_total ?? ""));
  const principal = exactPositive(meta.subtotal_cents);
  const net = exactPositive(meta.manager_payout_cents);
  const processing = Number(meta.processing_fee_cents);
  if (!Number.isSafeInteger(processing) || processing < 0 ||
      gross !== principal + processing || net > principal ||
      (meta.fee_payer === "resident" && net !== principal) ||
      (meta.fee_payer === "proplane" && (net !== principal || processing !== 0)) ||
      (meta.fee_payer === "manager" && processing !== 0) ||
      meta.hold_amount_cents !== String(net) || meta.platform_hold !== "1") {
    throw new Error("Household capture economics differ from the frozen quote.");
  }
  const piId = idOf(session.payment_intent);
  if (!piId) throw new Error("Paid household capture has no PaymentIntent.");
  const pi = await stripe.paymentIntents.retrieve(piId);
  const chargeId = idOf(pi.latest_charge);
  if (!chargeId || pi.status !== "succeeded" || pi.currency !== "usd" ||
      pi.amount_received !== gross || pi.metadata?.source_arbitration_v !== "1" ||
      pi.metadata?.purpose !== "household_charge" ||
      pi.metadata?.charge_ids !== meta.charge_ids || pi.metadata?.charge_id !== meta.charge_id ||
      pi.metadata?.manager_user_id !== manager || pi.metadata?.fee_payer !== meta.fee_payer ||
      pi.metadata?.hold_amount_cents !== String(net) || pi.metadata?.funding_model ||
      pi.transfer_data?.destination || pi.application_fee_amount) {
    throw new Error("Household PaymentIntent differs from its central capture.");
  }
  const charge = await stripe.charges.retrieve(chargeId);
  if (idOf(charge.payment_intent) !== pi.id || !charge.paid ||
      charge.status !== "succeeded" || charge.currency !== "usd" || charge.amount !== gross ||
      charge.disputed) {
    throw new Error("Household captured charge differs from its PaymentIntent.");
  }
  const { data: stored, error: storedError } = await db.from("portal_household_charge_records")
    .select("id,manager_user_id,kind,status,row_data").in("id", ids);
  if (storedError || stored?.length !== ids.length) {
    throw new Error("Paid household cart is incomplete after settlement.");
  }
  const byId = new Map((stored ?? []).map((row) => [String(row.id), row]));
  const paid = ids.map((id) => {
    const row = byId.get(id);
    const saved = row?.row_data as HouseholdCharge | undefined;
    if (!row || !saved || saved.id !== id || row.manager_user_id !== manager ||
        saved.managerUserId !== manager || row.kind !== saved.kind ||
        !["paid", "refunded"].includes(row.status) ||
        !["paid", "refunded"].includes(saved.status) ||
        saved.stripeCheckoutSessionId !== session.id) {
      throw new Error("Paid household cart changed its captured owner or source.");
    }
    return { id, charge: saved };
  });
  const components = allocateComponents(paid, principal, net);
  const existing = await findPlatformHoldByPaymentIntent(db, pi.id);
  if (existing) {
    const { data: verified, error: verifiedError } = await db.from("platform_payment_holds")
      .select("id,owner_user_id,owner_role,source,source_id,amount_cents,status,stripe_charge_id,original_amount_cents,source_charge_gross_cents,source_payment_intent_id,source_verified_at")
      .eq("id", existing.id).maybeSingle();
    if (verifiedError || !verified || verified.owner_user_id !== manager ||
        verified.owner_role !== "manager" || verified.source !== "household_charge" ||
        verified.stripe_charge_id !== charge.id || !verified.source_verified_at) {
      throw new Error("Household captured source has an unverified prior allocation.");
    }
    await verifyPlatformHoldSourceRefundHistory(db, stripe, verified as HeldSourceRow);
  } else {
    const refunds = await stripe.refunds.list({ charge: charge.id, limit: 1 });
    if (charge.refunded || (charge.amount_refunded ?? 0) > 0 ||
        refunds.data.length || refunds.has_more) {
      throw new Error("Refunded household source needs allocation reconciliation.");
    }
  }
  const availability = await verifiedCapturedChargeAvailability(stripe, charge);
  const { data: credited, error: creditError } = await db.rpc("credit_platform_income_with_recovery", {
    p_owner: manager, p_source: "household_charge", p_source_id: session.id,
    p_charge: charge.id, p_payment_intent: pi.id,
    p_charge_gross: gross, p_principal: principal, p_original_net: net,
    p_fee_payer: meta.fee_payer, p_components: components,
    p_available_on: availability?.availableOn ?? null,
  });
  const result = Array.isArray(credited) ? credited[0] : credited;
  if (creditError || !result?.hold_id || (existing && existing.id !== result.hold_id)) {
    throw new Error("Household source could not be atomically credited.");
  }
  await recordLedgerChargeFacts(db, stripe, charge.id, session.id);
  await settleClearedPlatformOwnerRecovery(db, stripe, {
    ownerUserId: manager, holdId: result.hold_id,
  });
  await releaseVerifiedPlatformHoldsForOwner(db, {
    ownerUserId: manager, holdId: result.hold_id, stripe,
  });
}

/** Off-session autopay has one durable charge and the PI itself is its source key. */
export async function creditVerifiedHouseholdAutopaySource(
  db: SupabaseClient, stripe: Stripe, pi: Stripe.PaymentIntent, chargeId: string,
): Promise<void> {
  const meta = pi.metadata ?? {};
  const owner = meta.manager_user_id?.trim() ?? "";
  const principal = exactPositive(meta.principal_cents);
  const net = exactPositive(meta.manager_payout_cents);
  const processing = Number(meta.processing_fee_cents);
  if (meta.source_arbitration_v !== "1" || meta.purpose !== "household_charge" ||
      !meta.autopay_run_id || !owner || meta.charge_id !== chargeId ||
      !["resident", "manager", "proplane"].includes(meta.fee_payer ?? "") ||
      pi.status !== "succeeded" || pi.currency !== "usd" ||
      !Number.isSafeInteger(pi.amount_received) ||
      pi.amount_received !== principal + processing ||
      !Number.isSafeInteger(processing) || processing < 0 ||
      net > principal || meta.hold_amount_cents !== String(net) ||
      meta.platform_hold !== "1" || pi.transfer_data?.destination ||
      pi.application_fee_amount ||
      (meta.fee_payer === "resident" && net !== principal) ||
      (meta.fee_payer === "proplane" && (net !== principal || processing !== 0)) ||
      (meta.fee_payer === "manager" && processing !== 0)) {
    throw new Error("Autopay PaymentIntent differs from its central source claim.");
  }
  const providerChargeId = idOf(pi.latest_charge);
  if (!providerChargeId) throw new Error("Paid autopay has no captured Charge.");
  const charge = await stripe.charges.retrieve(providerChargeId);
  if (idOf(charge.payment_intent) !== pi.id || !charge.paid ||
      charge.status !== "succeeded" || charge.currency !== "usd" ||
      charge.amount !== pi.amount_received || charge.disputed) {
    throw new Error("Autopay captured Charge differs from its PaymentIntent.");
  }
  const { data: run, error: runError } = await db.from("resident_autopay_runs")
    .select("id,charge_id,manager_id,stripe_payment_intent_id")
    .eq("id", meta.autopay_run_id).maybeSingle();
  if (runError || !run || run.charge_id !== chargeId || run.manager_id !== owner ||
      (run.stripe_payment_intent_id && run.stripe_payment_intent_id !== pi.id)) {
    throw new Error("Autopay captured run differs from its durable charge claim.");
  }
  const { data: row, error: rowError } = await db.from("portal_household_charge_records")
    .select("id,manager_user_id,kind,status,row_data").eq("id", chargeId).maybeSingle();
  const saved = row?.row_data as HouseholdCharge | undefined;
  if (rowError || !row || !saved || row.id !== chargeId ||
      row.manager_user_id !== owner || saved.managerUserId !== owner ||
      row.kind !== saved.kind || !["paid", "refunded"].includes(row.status) ||
      !["paid", "refunded"].includes(saved.status) ||
      saved.stripeCheckoutSessionId !== pi.id) {
    throw new Error("Autopay paid charge changed its captured source.");
  }
  const components = allocateComponents([{ id: chargeId, charge: saved }], principal, net);
  const existing = await findPlatformHoldByPaymentIntent(db, pi.id);
  if (existing) {
    const { data: verified, error: verifiedError } = await db.from("platform_payment_holds")
      .select("id,owner_user_id,owner_role,source,source_id,amount_cents,status,stripe_charge_id,original_amount_cents,source_charge_gross_cents,source_payment_intent_id,source_verified_at")
      .eq("id", existing.id).maybeSingle();
    if (verifiedError || !verified || verified.owner_user_id !== owner ||
        verified.owner_role !== "manager" || verified.source !== "household_charge" ||
        verified.stripe_charge_id !== charge.id || !verified.source_verified_at) {
      throw new Error("Autopay source has an unverified prior allocation.");
    }
    await verifyPlatformHoldSourceRefundHistory(db, stripe, verified as HeldSourceRow);
  } else {
    const refunds = await stripe.refunds.list({ charge: charge.id, limit: 1 });
    if (charge.refunded || (charge.amount_refunded ?? 0) > 0 ||
        refunds.data.length || refunds.has_more) {
      throw new Error("Refunded autopay source needs allocation reconciliation.");
    }
  }
  const availability = await verifiedCapturedChargeAvailability(stripe, charge);
  const { data: credited, error: creditError } = await db.rpc("credit_platform_income_with_recovery", {
    p_owner: owner, p_source: "household_charge", p_source_id: pi.id,
    p_charge: charge.id, p_payment_intent: pi.id,
    p_charge_gross: pi.amount_received, p_principal: principal,
    p_original_net: net, p_fee_payer: meta.fee_payer,
    p_components: components, p_available_on: availability?.availableOn ?? null,
  });
  const result = Array.isArray(credited) ? credited[0] : credited;
  if (creditError || !result?.hold_id || (existing && existing.id !== result.hold_id)) {
    throw new Error("Autopay source could not be atomically credited.");
  }
  await recordLedgerChargeFacts(db, stripe, charge.id, pi.id);
  await settleClearedPlatformOwnerRecovery(db, stripe, {
    ownerUserId: owner, holdId: result.hold_id,
  });
  await releaseVerifiedPlatformHoldsForOwner(db, {
    ownerUserId: owner, holdId: result.hold_id, stripe,
  });
}
