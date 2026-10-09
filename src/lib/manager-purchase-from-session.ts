import type Stripe from "stripe";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { captureTestWorkspaceEffectForUser } from "@/lib/test-workspaces/effects.server";
import { getStripe } from "@/lib/stripe";
import { resolveCheckoutSessionPromoCodeResult } from "@/lib/stripe/checkout-promo-code.server";

type ManagerPurchaseDb = ReturnType<typeof createSupabaseServiceRoleClient>;

export type ResolvedManagerCheckoutPurchase = {
  id: string;
  userId: string | null;
  managerId: string;
  email: string;
};

function checkoutEmail(session: Stripe.Checkout.Session): string {
  return String(
    session.customer_details?.email ??
      session.customer_email ??
      session.metadata?.email ??
      "",
  ).trim().toLowerCase();
}

/** Resolve a Checkout event only through a durable purchase row. */
export async function resolveManagerCheckoutPurchase(
  db: ManagerPurchaseDb,
  session: Stripe.Checkout.Session,
): Promise<ResolvedManagerCheckoutPurchase> {
  const managerId = session.metadata?.manager_id?.trim() ?? "";
  const claimedUserId = session.metadata?.userId?.trim() ?? "";
  const email = checkoutEmail(session);
  const select = "id,user_id,manager_id,email";

  const { data: reserved, error: reservedError } = await db
    .from("manager_purchases")
    .select(select)
    .eq("stripe_checkout_session_id", session.id)
    .maybeSingle();
  if (reservedError) throw new Error("Could not verify manager checkout ownership.");

  let stored = reserved as {
    id: string;
    user_id?: string | null;
    manager_id?: string | null;
    email?: string | null;
  } | null;
  if (!stored && claimedUserId) {
    const { data, error } = await db
      .from("manager_purchases")
      .select(select)
      .eq("user_id", claimedUserId)
      .or("paid_at.is.null,tier.is.null")
      .maybeSingle();
    if (error) throw new Error("Could not verify manager checkout ownership.");
    stored = data as typeof stored;
  }
  if (!stored && managerId) {
    const { data, error } = await db
      .from("manager_purchases")
      .select(select)
      .eq("manager_id", managerId)
      .or("paid_at.is.null,tier.is.null")
      .maybeSingle();
    if (error) throw new Error("Could not verify manager checkout ownership.");
    stored = data as typeof stored;
  }
  if (!stored) throw new Error("Could not verify manager checkout ownership.");

  const storedUserId = String(stored.user_id ?? "").trim();
  const storedManagerId = String(stored.manager_id ?? "").trim();
  const storedEmail = String(stored.email ?? "").trim().toLowerCase();
  if (
    (claimedUserId && claimedUserId !== storedUserId) ||
    (managerId && storedManagerId && managerId !== storedManagerId) ||
    (email && storedEmail && email !== storedEmail)
  ) {
    throw new Error("Could not verify manager checkout ownership.");
  }
  // Guest checkouts have no auth owner. Both manager id and email must match
  // their durable pending row, including for legacy rows without a reservation.
  if (!storedUserId && (!managerId || managerId !== storedManagerId || !email || email !== storedEmail)) {
    throw new Error("Could not verify manager checkout ownership.");
  }

  return { id: stored.id, userId: storedUserId || null, managerId: storedManagerId, email: storedEmail };
}

/** A completed Checkout session or subscription id alone is not payment.
 * Trials that owe nothing are explicitly `no_payment_required`; async unpaid
 * sessions stay pending until Stripe confirms payment. */
export function checkoutSessionIndicatesPaidPurchase(session: Stripe.Checkout.Session): boolean {
  return session.status === "complete" &&
    (session.payment_status === "paid" || session.payment_status === "no_payment_required");
}

async function verifyPaidManagerSubscription(session: Stripe.Checkout.Session): Promise<void> {
  if (!checkoutSessionIndicatesPaidPurchase(session) || session.mode !== "subscription") {
    throw new Error("Manager subscription payment has not settled.");
  }
  const raw = session.subscription;
  const subscription = typeof raw === "string" ? await getStripe().subscriptions.retrieve(raw) : raw;
  const sessionCustomer = typeof session.customer === "string" ? session.customer : session.customer?.id;
  const subscriptionCustomer = typeof subscription?.customer === "string" ? subscription.customer : subscription?.customer?.id;
  const tier = session.metadata?.tier;
  const billing = session.metadata?.billing;
  if (!subscription || !["active", "trialing"].includes(subscription.status) ||
      !sessionCustomer || subscriptionCustomer !== sessionCustomer ||
      (tier !== "free" && tier !== "pro" && tier !== "business") ||
      (billing !== "monthly" && billing !== "annual")) {
    throw new Error("Paid Checkout has no matching active manager subscription.");
  }
  const expectedInterval = tier === "free" || billing === "monthly" ? "month" : "year";
  let floorPriceId: string | null = null;
  for (const item of subscription.items?.data ?? []) {
    const id = item.price?.id;
    if (!id) continue;
    const price = await getStripe().prices.retrieve(id);
    if (price.currency !== "usd" || price.type !== "recurring" ||
        price.recurring?.interval !== expectedInterval || price.recurring.interval_count !== 1) continue;
    const product = typeof price.product === "string"
      ? await getStripe().products.retrieve(price.product) : price.product;
    if ("metadata" in product && product.metadata?.axis_plan === `axis_${tier}`) {
      floorPriceId = id;
      break;
    }
  }
  if (!floorPriceId) throw new Error("Paid Checkout subscription has no matching plan price.");
  // The new-session resolver checks the active current price before creation.
  // Fulfillment preserves captured provider terms after a catalog rotation.
}

/** Repair a pre-reservation portal session only after the authenticated owner
 * returns with an actually paid Stripe session. This never creates a payment
 * or trusts client metadata alone: profile manager id, saved billing customer,
 * and provider session must identify one owner before a missing Free row is
 * inserted or an existing Free reservation is rebound. */
export async function adoptPaidPortalCheckoutForOwner(
  session: Stripe.Checkout.Session,
  ownerUserId: string,
): Promise<void> {
  if (session.mode !== "subscription" || session.payment_status !== "paid" ||
      session.client_reference_id !== ownerUserId || session.metadata?.userId !== ownerUserId) return;
  const managerId = session.metadata.manager_id?.trim() ?? "";
  const email = checkoutEmail(session);
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
  if (!managerId || !email || !customerId) throw new Error("Paid portal checkout has incomplete ownership evidence.");
  const db = createSupabaseServiceRoleClient();
  const [{ data: purchase, error: purchaseError }, { data: profile, error: profileError },
    { data: billing, error: billingError }] = await Promise.all([
    db.from("manager_purchases")
      .select("id,user_id,email,manager_id,tier,stripe_checkout_session_id,stripe_subscription_id")
      .eq("user_id", ownerUserId).eq("manager_id", managerId).maybeSingle(),
    db.from("profiles").select("manager_id,email").eq("id", ownerUserId).maybeSingle(),
    db.from("manager_comms_billing_accounts").select("stripe_customer_id")
      .eq("manager_user_id", ownerUserId).maybeSingle(),
  ]);
  if (purchaseError || profileError || billingError || !profile || !billing ||
      (purchase && (purchase.user_id !== ownerUserId || purchase.manager_id !== managerId)) ||
      profile.manager_id !== managerId ||
      (purchase && String(purchase.email ?? "").trim().toLowerCase() !== email) ||
      String(profile.email ?? "").trim().toLowerCase() !== email ||
      billing.stripe_customer_id !== customerId) {
    throw new Error("Could not reconcile paid portal checkout ownership.");
  }
  if (purchase?.stripe_checkout_session_id === session.id) {
    // The durable reservation captured the plan terms when Checkout began.
    // A later catalog rotation must not reject this already-paid session.
    await verifyPaidManagerSubscription(session);
    return;
  }
  await verifyPaidManagerSubscription(session);
  if (!purchase) {
    const { data: other, error: otherError } = await db.from("manager_purchases")
      .select("id").eq("user_id", ownerUserId).maybeSingle();
    if (otherError || other) throw new Error("Paid portal checkout conflicts with another purchase.");
    const { data: inserted, error: insertError } = await db.from("manager_purchases").insert({
      user_id: ownerUserId, manager_id: managerId, email,
      tier: "free", billing: "monthly", stripe_checkout_session_id: session.id,
    }).select("id").maybeSingle();
    if (insertError || !inserted?.id) throw new Error("Could not reserve paid portal checkout for reconciliation.");
    return;
  }
  const priorId = String(purchase.stripe_checkout_session_id ?? "");
  if (purchase.tier !== "free" || purchase.stripe_subscription_id || !priorId.startsWith("axis_intent_")) {
    throw new Error("Paid portal checkout conflicts with an existing subscription.");
  }
  const { data: bound, error: bindError } = await db.from("manager_purchases")
    .update({ stripe_checkout_session_id: session.id })
    .eq("id", purchase.id).eq("user_id", ownerUserId).eq("manager_id", managerId)
    .eq("stripe_checkout_session_id", priorId).eq("tier", "free")
    .is("stripe_subscription_id", null)
    .select("id").maybeSingle();
  if (bindError || !bound?.id) throw new Error("Could not reserve paid portal checkout for reconciliation.");
}

/** Idempotent: records a completed Checkout session as a paid manager purchase. */
export async function recordPaidManagerCheckoutSession(session: Stripe.Checkout.Session): Promise<void> {
  const managerId = session.metadata?.manager_id?.trim();
  const email = checkoutEmail(session);

  if (!checkoutSessionIndicatesPaidPurchase(session)) return;
  await verifyPaidManagerSubscription(session);

  const supabase = createSupabaseServiceRoleClient();
  const customerId =
    typeof session.customer === "string"
      ? session.customer
      : session.customer && typeof session.customer !== "string"
        ? session.customer.id
        : null;

  const subscriptionRaw = session.subscription;
  const subscriptionId =
    typeof subscriptionRaw === "string"
      ? subscriptionRaw
      : subscriptionRaw && typeof subscriptionRaw !== "string"
        ? subscriptionRaw.id
        : null;

  const tierMeta = session.metadata?.tier?.trim().toLowerCase() || null;
  const billingMeta = session.metadata?.billing?.trim().toLowerCase() || null;

  /* Only a discount Stripe APPLIED is recorded. When the lookup itself failed we cannot tell, so the
     column is left out of the patch entirely: a webhook retry must not erase a code an earlier
     delivery recorded correctly. */
  const promo = await resolveCheckoutSessionPromoCodeResult(session);

  const patch = {
    stripe_checkout_session_id: session.id,
    stripe_customer_id: customerId,
    stripe_subscription_id: subscriptionId,
    tier: tierMeta,
    billing: billingMeta,
    // The code Stripe applied as a discount on this session, never the free text typed on the pricing
    // form. It goes in stripe_promotion_code, NEVER promo_code: promo_code is the payment-waiver column
    // (isWaiverGrantedManagerPurchase), so a discount code there would keep paid access after cancelling.
    ...(promo.resolved ? { stripe_promotion_code: promo.code } : {}),
    paid_at: new Date().toISOString(),
    full_name: session.metadata?.full_name?.trim() || null,
    ...(email ? { email } : {}),
    ...(managerId ? { manager_id: managerId } : {}),
  };

  // A signed event still carries caller-originated metadata. Resolve the
  // already-reserved local purchase first, then use its owner as the provider
  // boundary. New checkout creation reserves this row before returning.
  const stored = await resolveManagerCheckoutPurchase(supabase, session);
  if (stored.userId && (await captureTestWorkspaceEffectForUser({
      userId: stored.userId,
      kind: "payment",
      summary: "Manager subscription fulfillment was refused for a test workspace.",
      metadata: { operation: "manager_subscription_fulfillment" },
      db: supabase,
    })).captured) return;
  const { error: verifiedUpdateError } = await supabase
    .from("manager_purchases")
    .update({
      ...patch,
      manager_id: stored.managerId || managerId,
    })
    .eq("id", stored.id);
  if (verifiedUpdateError) throw new Error(verifiedUpdateError.message);
}
