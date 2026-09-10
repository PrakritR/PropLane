import "server-only";
import { ensureManagerBillingCustomer } from "@/lib/manager-stripe-customer.server";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getStripe } from "@/lib/stripe";
import { resolveAppOrigin } from "@/lib/app-url";
import { COMMS_CREDIT_PURPOSE, isCommsCreditPack } from "./credit-packs";

export async function createCommsCreditCheckout(
  db: SupabaseClient,
  owner: string,
  purchaseId: string,
  creditCents: number,
  req: Request,
) {
  if (!isCommsCreditPack(creditCents))
    throw new Error("Choose an available credit amount.");
  const { error: insertError } = await db
    .from("manager_comms_credit_purchases")
    .insert({
      id: purchaseId,
      manager_user_id: owner,
      credit_cents: creditCents,
    });
  if (insertError && insertError.code !== "23505")
    throw new Error("Could not start the credit purchase.");
  const { data: purchase, error } = await db
    .from("manager_comms_credit_purchases")
    .select(
      "manager_user_id, credit_cents, stripe_session_id, status, created_at",
    )
    .eq("id", purchaseId)
    .eq("manager_user_id", owner)
    .single();
  if (error || !purchase || purchase.credit_cents !== creditCents)
    throw new Error("Credit purchase does not match this account.");
  if (purchase.status !== "pending")
    throw new Error(
      "This purchase has already been processed. Refresh your balance.",
    );
  // Stripe's idempotency cache is bounded. Never create a second session from
  // an old unresolved operation after that cache may have expired.
  if (Date.now() - Date.parse(purchase.created_at) > 23 * 60 * 60 * 1000) {
    throw new Error(
      "This checkout attempt expired. Close it and start a new purchase.",
    );
  }
  const stripe = getStripe();
  if (purchase.stripe_session_id) {
    const existing = await stripe.checkout.sessions.retrieve(
      purchase.stripe_session_id,
    );
    if (existing.status !== "open" || !existing.client_secret)
      throw new Error("This checkout is no longer open. Refresh your balance.");
    return { clientSecret: existing.client_secret, purchaseId };
  }
  const customer = await ensureManagerBillingCustomer(db, owner);
  const metadata = {
    purpose: COMMS_CREDIT_PURPOSE,
    manager_user_id: owner,
    purchase_id: purchaseId,
    credit_cents: String(creditCents),
  };
  const session = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      customer,
      saved_payment_method_options: { payment_method_save: "enabled" },
      ui_mode: "embedded_page",
      payment_method_types: ["card"],
      client_reference_id: owner,
      metadata,
      payment_intent_data: { metadata },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: creditCents,
            product_data: {
              name: "PropLane communication credit",
              description:
                "One-time credit for texts, calls and work-number AI. No automatic recharge.",
            },
          },
        },
      ],
      return_url: `${resolveAppOrigin(req)}/portal/profile?tab=billing&comms_purchase=${purchaseId}`,
    },
    { idempotencyKey: `comms-credit:${owner}:${purchaseId}` },
  );
  if (!session.client_secret) throw new Error("Checkout could not be opened.");
  const { error: saveError } = await db
    .from("manager_comms_credit_purchases")
    .update({ stripe_session_id: session.id })
    .eq("id", purchaseId)
    .eq("manager_user_id", owner);
  if (saveError)
    throw new Error("Checkout could not be saved. Retry this purchase.");
  return { clientSecret: session.client_secret, purchaseId };
}

/** Signed webhook only. A browser redirect or metadata alone never creates credit. */
export async function fulfillCommsCreditPurchase(
  db: SupabaseClient,
  session: Stripe.Checkout.Session,
  eventId: string,
) {
  if (session.metadata?.purpose !== COMMS_CREDIT_PURPOSE) return false;
  if (session.payment_status !== "paid") return false;
  const owner = session.metadata.manager_user_id;
  const purchase = session.metadata.purchase_id;
  const credit = Number(session.metadata.credit_cents);
  const paymentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id;
  if (
    !owner ||
    !purchase ||
    !paymentId ||
    session.mode !== "payment" ||
    session.currency !== "usd" ||
    !isCommsCreditPack(credit) ||
    session.amount_subtotal !== credit ||
    session.amount_total !== credit ||
    session.client_reference_id !== owner ||
    (session.total_details?.amount_discount ?? 0) !== 0
  ) {
    throw new Error("Communication payment did not match the purchase.");
  }
  const { data, error } = await db.rpc("fulfill_comms_credit_purchase", {
    p_purchase: purchase,
    p_owner: owner,
    p_session: session.id,
    p_payment_intent: paymentId,
    p_credit: credit,
    p_event: eventId,
    p_receipt: null,
  });
  if (error) throw new Error("Communication credit could not be added.");
  return data === true;
}

/** Reconcile cumulative successful refunds, including delayed/out-of-order events. */
export async function reverseCommsCreditForCharge(
  db: SupabaseClient,
  charge: Stripe.Charge,
  eventId: string,
  dispute = false,
) {
  const paymentId =
    typeof charge.payment_intent === "string"
      ? charge.payment_intent
      : charge.payment_intent?.id;
  if (!paymentId) return false;
  const { data: purchase, error: readError } = await db
    .from("manager_comms_credit_purchases")
    .select("id, credit_cents")
    .eq("stripe_payment_intent_id", paymentId)
    .maybeSingle();
  if (readError) throw new Error("Credit reversal could not be verified.");
  if (!purchase) {
    // A refund can arrive before checkout fulfillment. Ask Stripe to retry
    // rather than acknowledge a reversal and later grant the refunded credit.
    if (charge.metadata?.purpose === COMMS_CREDIT_PURPOSE)
      throw new Error("Credit purchase fulfillment is pending.");
    return false;
  }
  const reversed = dispute
    ? purchase.credit_cents
    : Math.min(purchase.credit_cents, charge.amount_refunded);
  const { data, error } = await db.rpc("reverse_comms_credit_purchase", {
    p_payment_intent: paymentId,
    p_reversed: reversed,
    p_event: eventId,
    p_reason: dispute ? "dispute" : "refund",
  });
  if (error) throw new Error("Communication credit reversal failed.");
  return data === true;
}
