/** Default trial for new manager software subscriptions (card or Apple Pay required). */
export const MANAGER_SUBSCRIPTION_TRIAL_DAYS = 14;

export type ManagerSubscriptionCheckoutDiscount = {
  coupon?: string;
  promotion_code?: string;
};

export type ManagerSubscriptionCheckoutBaseInput = {
  priceId: string;
  metadata: Record<string, string>;
  customerEmail?: string;
  clientReferenceId?: string;
  discounts?: ManagerSubscriptionCheckoutDiscount[];
  allowPromotionCodes?: boolean;
  /** When set, Checkout collects a payment method and defers billing until trial ends. */
  trialPeriodDays?: number;
  /**
   * Additional subscription line items beyond the tier floor `priceId` — e.g.
   * the per-door overage price, when the account already has doors to bill
   * for at signup (`manager-checkout.ts`). Appended after the floor item;
   * omit for the common case of a brand-new account with none yet.
   */
  extraLineItems?: Array<{ price: string; quantity: number }>;
};

export type ManagerSubscriptionCheckoutBaseParams = {
  mode: "subscription";
  line_items: Array<{ price: string; quantity: number }>;
  metadata: Record<string, string>;
  customer_email?: string;
  client_reference_id?: string;
  discounts?: ManagerSubscriptionCheckoutDiscount[];
  allow_promotion_codes?: boolean;
  payment_method_configuration?: string;
  subscription_data?: {
    trial_period_days?: number;
    metadata?: Record<string, string>;
  };
};

/**
 * Manager Pro/Business subscription checkout — shared by signup and portal upgrade.
 *
 * Apple Pay (and Link) appear when:
 * 1. This module omits `payment_method_types` (Stripe dynamic payment methods).
 * 2. Apple Pay is enabled in Stripe Dashboard → Settings → Payment methods.
 * 3. Checkout domains are registered — run scripts/setup-stripe-apple-pay-domains.mjs.
 *
 * @see docs/stripe-apple-pay-subscriptions.md
 */

/** Checkout fields shared by embedded and hosted manager subscription sessions. */
export function buildManagerSubscriptionCheckoutBase(
  input: ManagerSubscriptionCheckoutBaseInput,
): ManagerSubscriptionCheckoutBaseParams {
  const paymentMethodConfiguration = process.env.STRIPE_SUBSCRIPTION_PAYMENT_METHOD_CONFIGURATION?.trim();

  const trialDays =
    typeof input.trialPeriodDays === "number" && input.trialPeriodDays > 0
      ? Math.floor(input.trialPeriodDays)
      : null;

  return {
    mode: "subscription",
    line_items: [{ price: input.priceId, quantity: 1 }, ...(input.extraLineItems ?? [])],
    metadata: input.metadata,
    ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
    ...(input.clientReferenceId ? { client_reference_id: input.clientReferenceId } : {}),
    ...(input.discounts?.length ? { discounts: input.discounts } : {}),
    ...(input.allowPromotionCodes ? { allow_promotion_codes: true } : {}),
    ...(paymentMethodConfiguration ? { payment_method_configuration: paymentMethodConfiguration } : {}),
    ...(trialDays
      ? {
          subscription_data: {
            trial_period_days: trialDays,
            metadata: input.metadata,
          },
        }
      : {}),
    // Do not set payment_method_types — it restricts to card-only and blocks Apple Pay.
  };
}

/** Guard used in tests — subscription checkout must stay on dynamic payment methods. */
export function subscriptionCheckoutUsesDynamicPaymentMethods(
  params: Record<string, unknown>,
): boolean {
  return !("payment_method_types" in params);
}

/** Hostnames that should be registered for Apple Pay on subscription checkout. */
export function subscriptionCheckoutApplePayDomains(): string[] {
  const raw = [
    process.env.NEXT_PUBLIC_CANONICAL_APP_URL?.trim(),
    process.env.NEXT_PUBLIC_APP_URL?.trim(),
  ].filter(Boolean) as string[];

  const hostnames = new Set<string>();
  for (const value of raw) {
    try {
      const hostname = new URL(value).hostname.toLowerCase();
      if (hostname && hostname !== "localhost" && hostname !== "127.0.0.1") {
        hostnames.add(hostname);
      }
    } catch {
      /* ignore invalid URLs */
    }
  }
  return [...hostnames];
}
