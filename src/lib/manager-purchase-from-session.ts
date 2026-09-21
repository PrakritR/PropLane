import type Stripe from "stripe";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { captureTestWorkspaceEffectForUser } from "@/lib/test-workspaces/effects.server";

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

/**
 * Stripe Checkout can complete a subscription while `payment_status` is still `unpaid`
 * (e.g. trial, async payment methods). Treat completed subscription sessions with a
 * subscription id as successful so we persist tier + Stripe ids.
 */
export function checkoutSessionIndicatesPaidPurchase(session: Stripe.Checkout.Session): boolean {
  if (session.payment_status === "paid" || session.payment_status === "no_payment_required") {
    return true;
  }
  if (session.status !== "complete") return false;
  const subscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription && typeof session.subscription !== "string"
        ? session.subscription.id
        : null;
  if (session.mode === "subscription" && subscriptionId) return true;
  return false;
}

/** Idempotent: records a completed Checkout session as a paid manager purchase. */
export async function recordPaidManagerCheckoutSession(session: Stripe.Checkout.Session): Promise<void> {
  const managerId = session.metadata?.manager_id?.trim();
  const email = checkoutEmail(session);

  if (!checkoutSessionIndicatesPaidPurchase(session)) return;

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

  const patch = {
    stripe_checkout_session_id: session.id,
    stripe_customer_id: customerId,
    stripe_subscription_id: subscriptionId,
    tier: tierMeta,
    billing: billingMeta,
    promo_code: session.metadata?.promo ?? null,
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
