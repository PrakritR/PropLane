import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { getManagerPurchaseSku } from "@/lib/manager-access-server";
import { getStripe } from "@/lib/stripe";

const PAYMENT_METHOD_STALE_MS = 60 * 60 * 1000;

async function defaultPaymentMethodId(
  stripe: Stripe,
  customerId: string,
): Promise<string | null> {
  const customer = await stripe.customers.retrieve(customerId, {
    expand: ["invoice_settings.default_payment_method"],
  });
  if (customer.deleted) return null;
  const defaultPm = customer.invoice_settings?.default_payment_method;
  if (typeof defaultPm === "string") return defaultPm;
  if (defaultPm && typeof defaultPm === "object" && "id" in defaultPm) return defaultPm.id;

  const methods = await stripe.paymentMethods.list({ customer: customerId, type: "card", limit: 1 });
  return methods.data[0]?.id ?? null;
}

export async function refreshManagerCommsPaymentMethod(
  db: SupabaseClient,
  managerUserId: string,
): Promise<{ hasPaymentMethod: boolean; checkedAt: string }> {
  const ownerId = managerUserId.trim();
  const now = new Date();
  const nowIso = now.toISOString();

  const { data: existing } = await db
    .from("manager_comms_billing_accounts")
    .select("has_default_payment_method, payment_method_checked_at")
    .eq("manager_user_id", ownerId)
    .maybeSingle();

  const checkedAt = existing?.payment_method_checked_at
    ? Date.parse(String(existing.payment_method_checked_at))
    : 0;
  if (
    existing &&
    Number.isFinite(checkedAt) &&
    now.getTime() - checkedAt < PAYMENT_METHOD_STALE_MS
  ) {
    return {
      hasPaymentMethod: Boolean(existing.has_default_payment_method),
      checkedAt: String(existing.payment_method_checked_at),
    };
  }

  const { stripeCustomerId } = await getManagerPurchaseSku(ownerId);
  let hasPaymentMethod = false;
  if (stripeCustomerId) {
    try {
      const stripe = getStripe();
      hasPaymentMethod = Boolean(await defaultPaymentMethodId(stripe, stripeCustomerId));
    } catch {
      hasPaymentMethod = Boolean(existing?.has_default_payment_method);
    }
  }

  await db.from("manager_comms_billing_accounts").upsert(
    {
      manager_user_id: ownerId,
      has_default_payment_method: hasPaymentMethod,
      payment_method_checked_at: nowIso,
      updated_at: nowIso,
    },
    { onConflict: "manager_user_id" },
  );

  return { hasPaymentMethod, checkedAt: nowIso };
}
