import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertTestWorkspaceProviderEffectAllowed } from "@/lib/test-workspaces/effects.server";

/** Resolve or create the Stripe Customer id stored on the resident profile. */
export async function ensureResidentStripeCustomerId(
  stripe: Stripe,
  db: SupabaseClient,
  userId: string,
  email: string,
  name?: string | null,
): Promise<string> {
  await assertTestWorkspaceProviderEffectAllowed({
    userId,
    kind: "payment",
    summary: "Stripe customer setup refused for a test workspace.",
    db,
  });
  const { data: profile, error } = await db
    .from("profiles")
    .select("stripe_customer_id, full_name")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;

  const existing = profile?.stripe_customer_id?.trim();
  if (existing) return existing;

  const customer = await stripe.customers.create({
    email: email.trim().toLowerCase(),
    name: name?.trim() || profile?.full_name?.trim() || undefined,
    metadata: { axis_portal: "resident", axis_user_id: userId },
  });

  const { error: updateErr } = await db
    .from("profiles")
    .update({ stripe_customer_id: customer.id, updated_at: new Date().toISOString() })
    .eq("id", userId);
  if (updateErr) throw updateErr;

  return customer.id;
}

export type ResidentSavedPaymentMethod = {
  id: string;
  type: "card" | "us_bank_account";
  label: string;
  isDefault: boolean;
};

export async function listResidentSavedPaymentMethods(
  stripe: Stripe,
  customerId: string,
): Promise<ResidentSavedPaymentMethod[]> {
  const customer = await stripe.customers.retrieve(customerId);
  const defaultPmId =
    typeof customer !== "string" && !customer.deleted
      ? typeof customer.invoice_settings?.default_payment_method === "string"
        ? customer.invoice_settings.default_payment_method
        : customer.invoice_settings?.default_payment_method?.id ?? null
      : null;

  const [cards, banks] = await Promise.all([
    stripe.paymentMethods.list({ customer: customerId, type: "card", limit: 20 }),
    stripe.paymentMethods.list({ customer: customerId, type: "us_bank_account", limit: 20 }),
  ]);

  const out: ResidentSavedPaymentMethod[] = [];
  for (const pm of cards.data) {
    const card = pm.card;
    out.push({
      id: pm.id,
      type: "card",
      label: card ? `${card.brand?.toUpperCase() ?? "Card"} •••• ${card.last4}` : "Card",
      isDefault: pm.id === defaultPmId,
    });
  }
  for (const pm of banks.data) {
    const bank = pm.us_bank_account;
    out.push({
      id: pm.id,
      type: "us_bank_account",
      label: bank
        ? `${bank.bank_name ?? "Bank"} •••• ${bank.last4 ?? "****"}`
        : "Bank account",
      isDefault: pm.id === defaultPmId,
    });
  }
  return out;
}

/** Pin a saved Stripe payment method as the customer's default. */
export async function setResidentDefaultPaymentMethod(
  stripe: Stripe,
  customerId: string,
  paymentMethodId: string,
): Promise<void> {
  const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
  const pmCustomer = typeof pm.customer === "string" ? pm.customer : pm.customer?.id ?? null;
  if (pmCustomer !== customerId) {
    throw new Error("Payment method not found.");
  }
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });
}
