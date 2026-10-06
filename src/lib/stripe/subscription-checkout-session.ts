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
  wallet_options: { link: { display: "never" } };
  payment_method_types: ["card"];
  line_items: Array<{ price: string; quantity: number }>;
  metadata: Record<string, string>;
  customer_email?: string;
  client_reference_id?: string;
  discounts?: ManagerSubscriptionCheckoutDiscount[];
  allow_promotion_codes?: boolean;
  subscription_data?: {
    trial_period_days?: number;
    metadata?: Record<string, string>;
  };
};

/**
 * Manager Pro/Business subscription checkout — shared by signup and portal upgrade.
 *
 * Card-funded Checkout stays in-app. Stripe can show Apple Pay for eligible
 * card sessions when the domain is registered; Link and redirect methods are
 * excluded from this subscription surface.
 *
 * @see docs/stripe-apple-pay-subscriptions.md
 */

/** Checkout fields shared by embedded and hosted manager subscription sessions. */
export function buildManagerSubscriptionCheckoutBase(
  input: ManagerSubscriptionCheckoutBaseInput,
): ManagerSubscriptionCheckoutBaseParams {
  const trialDays =
    typeof input.trialPeriodDays === "number" && input.trialPeriodDays > 0
      ? Math.floor(input.trialPeriodDays)
      : null;

  return {
    mode: "subscription",
    wallet_options: { link: { display: "never" as const } },
    payment_method_types: ["card"],
    line_items: [{ price: input.priceId, quantity: 1 }, ...(input.extraLineItems ?? [])],
    metadata: input.metadata,
    ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
    ...(input.clientReferenceId ? { client_reference_id: input.clientReferenceId } : {}),
    ...(input.discounts?.length ? { discounts: input.discounts } : {}),
    ...(input.allowPromotionCodes ? { allow_promotion_codes: true } : {}),
    ...(trialDays
      ? {
          subscription_data: {
            trial_period_days: trialDays,
            metadata: input.metadata,
          },
        }
      : {}),
  };
}

/** Guard used in tests — subscription checkout must stay card scoped. */
export function subscriptionCheckoutUsesCardOnlyFunding(
  params: Record<string, unknown>,
): boolean {
  return Array.isArray(params.payment_method_types) && params.payment_method_types.length === 1 &&
    params.payment_method_types[0] === "card" &&
    !params.payment_method_configuration &&
    JSON.stringify(params.wallet_options) === JSON.stringify({ link: { display: "never" } });
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
