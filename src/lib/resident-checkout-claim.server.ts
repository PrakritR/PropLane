import "server-only";

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AxisAchCheckoutInput } from "@/lib/stripe-axis-ach-checkout";

export type ResidentCheckoutAttempt = {
  id: string;
  attempt_token: string;
  resident_user_id: string | null;
  resident_email: string;
  manager_user_id: string;
  charge_ids: string[];
  charge_cents: number[];
  subtotal_cents: number;
  payer_total_cents: number;
  recipient_net_cents: number;
  payment_method: "ach" | "card";
  currency: "usd";
  provider_params: AxisAchCheckoutInput;
  stripe_session_id: string | null;
  stripe_payment_intent_id: string | null;
  status: "pending" | "processing" | "settled" | "expired" | "failed";
  created_at: string;
};

function exactPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** The stored quote, never a fresh manager/listing calculation, drives every
 * retry of a possibly-created Stripe session. */
export function assertResidentCheckoutAttemptTerms(attempt: ResidentCheckoutAttempt): AxisAchCheckoutInput {
  const params = attempt.provider_params;
  const fee = params?.fixedFeeBreakdown;
  const items = params?.lineItems;
  const originalEmail = params?.residentEmail?.trim().toLowerCase();
  const actorDetached = attempt.resident_user_id === null;
  if (!params || !fee || !Array.isArray(items) ||
      attempt.charge_ids.length === 0 || attempt.charge_ids.length > 10 ||
      attempt.charge_ids.length !== attempt.charge_cents.length ||
      items.length !== attempt.charge_ids.length ||
      attempt.charge_ids.some((id, index) => !id ||
        (index > 0 && id <= attempt.charge_ids[index - 1]!) ||
        !exactPositive(attempt.charge_cents[index]) ||
        items[index]?.amountCents !== attempt.charge_cents[index]) ||
      attempt.charge_cents.reduce((sum, cents) => sum + cents, 0) !== attempt.subtotal_cents ||
      params.metadata?.resident_attempt_token !== attempt.attempt_token ||
      params.metadata?.charge_ids !== attempt.charge_ids.join(",") ||
      params.metadata?.charge_id !== attempt.charge_ids[0] ||
      params.metadata?.manager_user_id !== attempt.manager_user_id ||
      params.metadata?.resident_email !== originalEmail ||
      params.metadata?.source_arbitration_v !== "1" ||
      params.metadata?.purpose !== "household_charge" ||
      (attempt.payment_method === "ach" &&
       (params.metadata?.resident_payment_flow !== "manual_ach" ||
        params.metadata?.manual_ach !== "1")) ||
      (attempt.payment_method === "card" && params.metadata?.resident_payment_flow) ||
      !originalEmail ||
      (actorDetached
        ? !/^deleted-[0-9a-f-]+@deleted\.invalid$/.test(attempt.resident_email)
        : originalEmail !== attempt.resident_email) ||
      params.paymentMethod !== attempt.payment_method ||
      params.destinationAccountId || params.fundingModel !== "connect_destination" ||
      params.idempotencyKey !== `resident-checkout:${attempt.attempt_token}` ||
      (attempt.payment_method === "card" && params.forceExplicitCard !== true) ||
      fee.totalCents !== attempt.payer_total_cents ||
      fee.managerPayoutCents !== attempt.recipient_net_cents ||
      fee.totalCents !== attempt.subtotal_cents + fee.residentAddedFeeCents ||
      fee.totalCents - fee.applicationFeeCents !== fee.managerPayoutCents ||
      attempt.currency !== "usd") {
    throw new Error("Stored resident checkout terms do not reconcile.");
  }
  return params;
}

/** The manual ACH PaymentIntent is the provider reference in
 * stripe_session_id for this one claim kind; it is never a Checkout Session. */
export async function loadResidentManualAchAttemptForPaymentIntent(
  db: SupabaseClient, paymentIntent: Stripe.PaymentIntent,
  expectedResidentUserId?: string,
): Promise<ResidentCheckoutAttempt> {
  const token = paymentIntent.metadata?.resident_attempt_token?.trim();
  if (!token || paymentIntent.metadata?.resident_payment_flow !== "manual_ach" ||
      paymentIntent.metadata?.manual_ach !== "1") {
    throw new Error("Bank payment has no exact resident attempt.");
  }
  const { data, error } = await db.from("resident_checkout_attempts")
    .select("*").eq("attempt_token", token).maybeSingle();
  if (error || !data) throw new Error("Bank payment attempt was not found.");
  const attempt = data as ResidentCheckoutAttempt;
  const params = assertResidentCheckoutAttemptTerms(attempt);
  const meta = paymentIntent.metadata ?? {};
  if (attempt.payment_method !== "ach" ||
      paymentIntent.currency !== "usd" ||
      paymentIntent.amount !== attempt.payer_total_cents ||
      meta.charge_ids !== attempt.charge_ids.join(",") ||
      meta.charge_id !== attempt.charge_ids[0] ||
      meta.manager_user_id !== attempt.manager_user_id ||
      meta.resident_email !== params.residentEmail ||
      meta.subtotal_cents !== String(attempt.subtotal_cents) ||
      meta.principal_cents !== String(attempt.subtotal_cents) ||
      meta.total_cents !== String(attempt.payer_total_cents) ||
      meta.processing_fee_cents !== String(attempt.payer_total_cents - attempt.subtotal_cents) ||
      meta.manager_payout_cents !== String(attempt.recipient_net_cents) ||
      meta.fee_payer !== params.feePayer ||
      meta.platform_hold !== "1" ||
      meta.hold_amount_cents !== String(attempt.recipient_net_cents) ||
      paymentIntent.transfer_data?.destination || paymentIntent.application_fee_amount ||
      (attempt.stripe_session_id && attempt.stripe_session_id !== paymentIntent.id)) {
    throw new Error("Bank PaymentIntent differs from its frozen attempt.");
  }
  if (expectedResidentUserId && attempt.resident_user_id !== expectedResidentUserId) {
    throw new Error("This bank payment does not belong to your account.");
  }
  if (!attempt.stripe_session_id) {
    const { data: bound, error: bindError } = await db.rpc("bind_resident_checkout_session", {
      p_attempt_id: attempt.id, p_attempt_token: attempt.attempt_token,
      p_session_id: paymentIntent.id,
    });
    if (bindError || bound !== true) throw new Error("Bank PaymentIntent could not be bound.");
    attempt.stripe_session_id = paymentIntent.id;
  }
  return attempt;
}

/** A delayed webhook may arrive before the create response stamps its session.
 * The metadata token can bind only after all immutable claim facts match. */
export function assertResidentCheckoutSession(
  attempt: ResidentCheckoutAttempt,
  session: Stripe.Checkout.Session,
): void {
  const params = assertResidentCheckoutAttemptTerms(attempt);
  const meta = session.metadata ?? {};
  if (session.mode !== "payment" || session.currency?.toLowerCase() !== "usd" ||
      session.amount_total !== attempt.payer_total_cents ||
      meta.resident_attempt_token !== attempt.attempt_token ||
      meta.source_arbitration_v !== "1" ||
      meta.purpose !== "household_charge" ||
      meta.manager_user_id !== attempt.manager_user_id ||
      meta.resident_email !== params.residentEmail ||
      meta.charge_ids !== attempt.charge_ids.join(",") ||
      meta.charge_id !== attempt.charge_ids[0] ||
      meta.payment_method !== attempt.payment_method ||
      meta.subtotal_cents !== String(attempt.subtotal_cents) ||
      meta.processing_fee_cents !== String(attempt.payer_total_cents - attempt.subtotal_cents) ||
      meta.manager_payout_cents !== String(attempt.recipient_net_cents) ||
      meta.fee_payer !== params.feePayer ||
      meta.platform_hold !== "1" || meta.hold_amount_cents !== String(attempt.recipient_net_cents) ||
      (attempt.stripe_session_id && attempt.stripe_session_id !== session.id)) {
    throw new Error("Resident checkout session differs from its saved attempt.");
  }
}

export async function loadResidentCheckoutAttemptForSession(
  db: SupabaseClient,
  session: Stripe.Checkout.Session,
  expectedResidentUserId?: string,
): Promise<ResidentCheckoutAttempt> {
  const token = session.metadata?.resident_attempt_token?.trim();
  if (!token || session.metadata?.source_arbitration_v !== "1") {
    throw new Error("Resident checkout has no durable attempt token.");
  }
  const { data, error } = await db.from("resident_checkout_attempts")
    .select("*").eq("attempt_token", token).maybeSingle();
  if (error || !data) throw new Error("Resident checkout attempt was not found.");
  const attempt = data as ResidentCheckoutAttempt;
  assertResidentCheckoutSession(attempt, session);
  if (expectedResidentUserId && attempt.resident_user_id !== expectedResidentUserId) {
    throw new Error("This checkout session does not belong to your account.");
  }
  if (!attempt.stripe_session_id) {
    const { data: bound, error: bindError } = await db.rpc("bind_resident_checkout_session", {
      p_attempt_id: attempt.id, p_attempt_token: attempt.attempt_token,
      p_session_id: session.id,
    });
    if (bindError || bound !== true) throw new Error("Resident checkout session could not be bound.");
    attempt.stripe_session_id = session.id;
  }
  return attempt;
}
