import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";

/** Use the existing subscription customer, or the manager's dedicated billing
 * account on Free. Never borrow a resident/customer id from client input. */
export async function loadManagerBillingIdentity(
  db: SupabaseClient,
  owner: string,
) {
  // Financial credentials must be linked to the authenticated user id. Plan
  // recovery's email fallback is deliberately not an authorization source.
  const { data: purchases, error: purchaseError } = await db
    .from("manager_purchases")
    .select("user_id,stripe_customer_id,stripe_subscription_id,paid_at")
    .eq("user_id", owner)
    .or("stripe_customer_id.not.is.null,stripe_subscription_id.not.is.null")
    .order("paid_at", { ascending: false })
    .limit(1);
  if (purchaseError)
    throw new Error("Your billing account could not be verified. Try again.");
  const purchase = purchases?.find((row) => row.user_id === owner);
  const { data: account, error } = await db
    .from("manager_comms_billing_accounts")
    .select("stripe_customer_id")
    .eq("manager_user_id", owner)
    .maybeSingle();
  if (error) throw new Error("Your billing account could not be loaded.");
  let customerId: string | null = purchase?.stripe_customer_id ?? null;
  const subscriptionId: string | null =
    purchase?.stripe_subscription_id ?? null;
  if (subscriptionId) {
    const subscription =
      await getStripe().subscriptions.retrieve(subscriptionId);
    const subscriptionCustomerId = objectId(subscription.customer);
    if (
      !subscriptionCustomerId ||
      (customerId && customerId !== subscriptionCustomerId)
    )
      throw new Error("Subscription billing identity could not be verified.");
    customerId = subscriptionCustomerId;
  }
  // An older standalone Free customer must never split billing from a linked
  // subscription. Resolve that conflict explicitly before exposing any cards.
  if (
    customerId &&
    account?.stripe_customer_id &&
    customerId !== account.stripe_customer_id
  )
    throw new Error(
      "Your billing accounts need to be reconciled. Contact support.",
    );
  customerId ??= account?.stripe_customer_id ?? null;
  if (customerId) await billingCustomer(getStripe(), customerId, owner);
  return { customerId, subscriptionId };
}

export async function ensureManagerBillingCustomer(
  db: SupabaseClient,
  owner: string,
) {
  const identity = await loadManagerBillingIdentity(db, owner);
  if (identity.customerId) return identity.customerId;
  const { data: profile, error } = await db
    .from("profiles")
    .select("email,full_name")
    .eq("id", owner)
    .single();
  if (error || !profile)
    throw new Error("Your billing profile could not be loaded.");
  const customer = await getStripe().customers.create(
    {
      ...(profile.email ? { email: profile.email } : {}),
      ...(profile.full_name ? { name: profile.full_name } : {}),
      metadata: { manager_user_id: owner, purpose: "manager_billing" },
    },
    { idempotencyKey: `manager-billing-customer:${owner}` },
  );
  // Upsert only the customer identity; wallet balances and pauses stay untouched.
  const { error: saveError } = await db
    .from("manager_comms_billing_accounts")
    .upsert(
      { manager_user_id: owner, stripe_customer_id: customer.id },
      { onConflict: "manager_user_id" },
    );
  if (saveError)
    throw new Error("Your billing customer could not be saved. Retry setup.");
  return customer.id;
}

function objectId(value: string | { id: string } | null | undefined) {
  return typeof value === "string" ? value : (value?.id ?? null);
}
async function billingCustomer(
  stripe: Stripe,
  customerId: string,
  owner: string,
) {
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted)
    throw new Error("This billing customer is no longer available.");
  if (
    customer.metadata.manager_user_id &&
    customer.metadata.manager_user_id !== owner
  )
    throw new Error("This billing account does not belong to you.");
  return customer;
}

export async function listManagerBillingCards(
  db: SupabaseClient,
  owner: string,
) {
  const identity = await loadManagerBillingIdentity(db, owner);
  if (!identity.customerId) return { cards: [], defaultPaymentMethodId: null };
  const stripe = getStripe();
  const customer = await billingCustomer(stripe, identity.customerId, owner);
  let defaultId = objectId(customer.invoice_settings.default_payment_method);
  if (identity.subscriptionId) {
    const subscription = await stripe.subscriptions.retrieve(
      identity.subscriptionId,
    );
    if (objectId(subscription.customer) !== customer.id)
      throw new Error("Subscription billing identity could not be verified.");
    if (!["canceled", "incomplete_expired"].includes(subscription.status))
      defaultId = objectId(subscription.default_payment_method) ?? defaultId;
  }
  const methods = await stripe.paymentMethods.list({
    customer: customer.id,
    type: "card",
    limit: 100,
  });
  return {
    defaultPaymentMethodId: defaultId,
    cards: methods.data.map((method) => ({
      id: method.id,
      brand: method.card?.brand ?? "card",
      last4: method.card?.last4 ?? "",
      expMonth: method.card?.exp_month ?? 0,
      expYear: method.card?.exp_year ?? 0,
      isDefault: method.id === defaultId,
    })),
  };
}

/** No charge/retry is performed. Setting the same card twice is idempotent. */
export async function setManagerDefaultBillingCard(
  db: SupabaseClient,
  owner: string,
  paymentMethodId: string,
) {
  const identity = await loadManagerBillingIdentity(db, owner);
  if (!identity.customerId)
    throw new Error("Add a card before choosing a default.");
  const stripe = getStripe();
  const customer = await billingCustomer(stripe, identity.customerId, owner);
  const method = await stripe.paymentMethods.retrieve(paymentMethodId);
  if (method.type !== "card" || objectId(method.customer) !== customer.id)
    throw new Error("Choose a card saved to your billing account.");
  let updateSubscription = false;
  if (identity.subscriptionId) {
    const subscription = await stripe.subscriptions.retrieve(
      identity.subscriptionId,
    );
    if (objectId(subscription.customer) !== customer.id)
      throw new Error("Subscription billing identity could not be verified.");
    updateSubscription = !["canceled", "incomplete_expired"].includes(
      subscription.status,
    );
  }
  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: method.id },
  });
  if (identity.subscriptionId && updateSubscription)
    await stripe.subscriptions.update(identity.subscriptionId, {
      default_payment_method: method.id,
    });
  return listManagerBillingCards(db, owner);
}
