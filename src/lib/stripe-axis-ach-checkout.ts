import type Stripe from "stripe";
import {
  residentServiceFeeBreakdown,
  type ResidentAxisPaymentMethod,
  type ServiceFeePayer,
} from "@/lib/payment-policy";

export const APPLICATION_FEE_CHECKOUT_PURPOSE = "rental_application_fee";
export const VENDOR_INVOICE_PAY_PURPOSE = "vendor_invoice_pay";

export type AxisAchCheckoutMode = "embedded" | "hosted";

export function stripeNotConfiguredError(message: string): boolean {
  return message.includes("STRIPE_SECRET_KEY") || message.includes("Missing STRIPE");
}

export type AxisAchLineItem = {
  amountCents: number;
  productName: string;
  productDescription?: string;
};

export type AxisAchCheckoutInput = {
  residentEmail: string;
  /** Total cents when using a single line item (default). */
  amountCents?: number;
  productName?: string;
  productDescription?: string;
  /** Multiple line items for paying several charges in one checkout. */
  lineItems?: AxisAchLineItem[];
  metadata: Record<string, string>;
  returnUrl?: string;
  successUrl?: string;
  cancelUrl?: string;
  mode: AxisAchCheckoutMode;
  /**
   * Connected account to destination-charge. Omit when Connect + bank is not
   * ready — the session charges the platform and metadata.platform_hold=1
   * so the webhook credits a hold.
   */
  destinationAccountId?: string | null;
  paymentMethod?: ResidentAxisPaymentMethod;
  managerTier?: string | null;
  /**
   * Who bears the service fee on this charge. Callers resolve it from the
   * manager's plan + Pro setting (`resolveServiceFeePayer`). Defaults to
   * `proplane` (face value, no fee) when omitted, so any caller that has not
   * opted in keeps the historical behavior.
   */
  feePayer?: ServiceFeePayer;
  /**
   * `PROPLANE_BALANCE_ENABLED` switch (night/vendor-pay). Default
   * `"connect_destination"` — today's behavior, completely unchanged: a
   * destination charge to `destinationAccountId` when ready, else a platform
   * hold. `"platform_ledger"` is the ONE place that behavior changes: the
   * charge lands on the platform with NO `transfer_data` and NO
   * `application_fee_amount` at all (there is no destination to transfer to or
   * take a fee from) — `destinationAccountId` is ignored when this is set.
   * The full settled amount the manager would have received
   * (`managerPayoutCents`) is credited to that manager's PropLane balance
   * later, by the webhook, once Stripe reports the charge available
   * (`stripe-webhook-financials.ts` → `proplane-balance/ledger.server.ts`).
   * Only resident household-charge checkout ever sets this — application fees
   * and vendor-invoice-pay checkout never pass it, so they are byte-for-byte
   * unchanged whether the flag is on or off.
   */
  fundingModel?: "connect_destination" | "platform_ledger";
};

export type AxisAchCheckoutResult =
  | {
      mode: "embedded";
      clientSecret: string;
      sessionId: string;
      subtotalCents: number;
      processingFeeCents: number;
      axisFeeCents: number;
      platformFeeCents: number;
      totalCents: number;
      paymentMethod: ResidentAxisPaymentMethod;
    }
  | {
      mode: "hosted";
      url: string;
      sessionId: string;
      subtotalCents: number;
      processingFeeCents: number;
      axisFeeCents: number;
      platformFeeCents: number;
      totalCents: number;
      paymentMethod: ResidentAxisPaymentMethod;
    };

export function axisAchCheckoutPaid(session: Stripe.Checkout.Session): boolean {
  return session.payment_status === "paid" || session.payment_status === "no_payment_required";
}

export function axisAchCheckoutProcessing(session: Stripe.Checkout.Session): boolean {
  return session.status === "complete" && session.payment_status === "unpaid";
}

/**
 * Stripe payment-method selection for a resident/applicant Checkout session.
 *
 * Returns EITHER an explicit `payment_method_types` allowlist OR a
 * `payment_method_configuration` (dynamic payment methods) — never both, since
 * Stripe rejects a session that sets the two together.
 *
 * Apple Pay / Google Pay are card wallets: they only ride on the `card`
 * method-class sessions, and the payer is charged face value on every method
 * anyway (PropLane absorbs Stripe's processing cost), so the total is the same
 * no matter which the buyer taps. When
 * `STRIPE_RESIDENT_CARD_PAYMENT_METHOD_CONFIGURATION` names a card-scoped PMC we
 * use dynamic payment methods (Stripe's recommended path for surfacing wallets,
 * matching the subscription flow in `subscription-checkout-session.ts`); the
 * PMC must exclude bank/ACH so `metadata.payment_method` the webhook reads back
 * stays truthful. Without the env we fall back to an explicit `["card"]` type,
 * which still surfaces Apple Pay on one-time (`mode: "payment"`) Checkout once
 * the domain is registered.
 *
 * `ach` stays an explicit `us_bank_account` session; `link` keeps its explicit
 * Link+card allowlist.
 */
async function paymentMethodStripeConfig(
  stripe: Stripe,
  method: ResidentAxisPaymentMethod,
): Promise<
  | {
      payment_method_types: ("card" | "link" | "us_bank_account")[];
      payment_method_options?: {
        us_bank_account?: {
          financial_connections: { permissions: ["payment_method"] };
          verification_method: "automatic";
        };
      };
    }
  | { payment_method_configuration: string }
> {
  if (method === "ach") {
    return {
      payment_method_types: ["us_bank_account"],
      payment_method_options: {
        us_bank_account: {
          financial_connections: { permissions: ["payment_method"] },
          verification_method: "automatic",
        },
      },
    };
  }
  if (method === "link") {
    return { payment_method_types: ["link", "card"] };
  }
  const cardPmc = process.env.STRIPE_RESIDENT_CARD_PAYMENT_METHOD_CONFIGURATION?.trim();
  if (cardPmc && (await cardScopedPaymentMethodConfiguration(stripe, cardPmc))) {
    return { payment_method_configuration: cardPmc };
  }
  return { payment_method_types: ["card"] };
}

/**
 * Payment methods that settle as the card method-class, i.e. the ones a "card"
 * session may legitimately surface. Apple Pay / Google Pay are card wallets and
 * settle as `card`; Link is commonly enabled alongside card, so a PMC carrying
 * it must not be rejected.
 */
const CARD_CLASS_PAYMENT_METHODS = new Set(["card", "apple_pay", "google_pay", "link"]);

const cardPmcScopeCache = new Map<string, { cardScoped: boolean; expiresAt: number }>();
const CARD_PMC_CACHE_TTL_MS = 10 * 60_000;
const CARD_PMC_ERROR_CACHE_TTL_MS = 60_000;

/**
 * A card session records `metadata.payment_method = "card"` before the session
 * exists, so a PMC that also enables a different method (`us_bank_account`,
 * Klarna, Affirm, …) would mislabel the payment for the webhook and for
 * reporting. Verify the configuration really is card-scoped before trusting it;
 * anything else (including a failed lookup) falls back to the explicit
 * `["card"]` allowlist, which is always truthful.
 */
async function cardScopedPaymentMethodConfiguration(stripe: Stripe, pmcId: string): Promise<boolean> {
  const cached = cardPmcScopeCache.get(pmcId);
  if (cached && cached.expiresAt > Date.now()) return cached.cardScoped;

  let config: Record<string, unknown>;
  try {
    config = (await stripe.paymentMethodConfigurations.retrieve(pmcId)) as unknown as Record<string, unknown>;
  } catch (e) {
    console.error(
      `[stripe] Could not verify STRIPE_RESIDENT_CARD_PAYMENT_METHOD_CONFIGURATION (${pmcId}) is card-scoped; falling back to explicit card payment methods.`,
      e,
    );
    cardPmcScopeCache.set(pmcId, { cardScoped: false, expiresAt: Date.now() + CARD_PMC_ERROR_CACHE_TTL_MS });
    return false;
  }

  const offending = Object.entries(config)
    .filter(([name, value]) => !CARD_CLASS_PAYMENT_METHODS.has(name) && paymentMethodEntryEnabled(value))
    .map(([name]) => name);

  const cardScoped = offending.length === 0;
  if (!cardScoped) {
    console.error(
      `[stripe] STRIPE_RESIDENT_CARD_PAYMENT_METHOD_CONFIGURATION (${pmcId}) enables non-card methods [${offending.join(", ")}], which would mislabel metadata.payment_method; falling back to explicit card payment methods. Scope the configuration to card + Apple Pay + Google Pay (+ Link).`,
    );
  }
  cardPmcScopeCache.set(pmcId, { cardScoped, expiresAt: Date.now() + CARD_PMC_CACHE_TTL_MS });
  return cardScoped;
}

function paymentMethodEntryEnabled(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const entry = value as { available?: unknown; display_preference?: { value?: unknown } };
  if (!("display_preference" in entry)) return false;
  return entry.available === true || entry.display_preference?.value === "on";
}

/**
 * Creates a Stripe Checkout Session for Connect DESTINATION charges: the charge
 * is created on the PLATFORM account (PropLane is merchant of record) with
 * `transfer_data.destination` pointing at the manager's connected account. It is
 * never a direct charge and never uses `on_behalf_of` / a `Stripe-Account`
 * header, so the manager's own account always receives the money.
 *
 * Who bears the service fee (Stripe's real processing cost) is decided by
 * `input.feePayer` (default `proplane`). All three cases keep the SAME
 * destination charge; only the numbers move, per `residentServiceFeeBreakdown`:
 *   - `resident`  → charged `subtotal + fee`; `application_fee_amount = fee` is
 *     retained by PropLane (which pays Stripe); manager receives `subtotal`.
 *   - `manager`   → charged `subtotal`; `application_fee_amount = fee` retained;
 *     manager receives `subtotal - fee` (the manager absorbs the cost).
 *   - `proplane`  → charged `subtotal`; NO `application_fee_amount`; the whole
 *     subtotal transfers out of PropLane's platform balance, which Stripe has
 *     already debited its fee from — so PropLane bears the cost (face value).
 *
 * Used for resident portal payments (rent, utilities, application fees) — not
 * manager subscriptions.
 */
export async function createAxisAchCheckoutSession(
  stripe: Stripe,
  input: AxisAchCheckoutInput,
): Promise<AxisAchCheckoutResult> {
  const paymentMethod = input.paymentMethod ?? "ach";
  const feePayer: ServiceFeePayer = input.feePayer ?? "proplane";
  const chargeLineItems =
    input.lineItems && input.lineItems.length > 0
      ? input.lineItems
      : [
          {
            amountCents: Math.round(input.amountCents ?? 0),
            productName: input.productName?.trim() || "Resident payment",
            productDescription: input.productDescription,
          },
        ];

  const subtotalCents = chargeLineItems.reduce((sum, item) => sum + Math.round(item.amountCents), 0);
  if (subtotalCents < 100) {
    throw new Error("Amount must be at least $1.00.");
  }

  const fee = residentServiceFeeBreakdown(subtotalCents, paymentMethod, feePayer);
  // `processingFeeCents` in the result/metadata means "what the resident is
  // charged on top" (0 unless the resident pays), so the resident-facing
  // itemization derives straight from it. `axisFeeCents` stays the 0-bps
  // platform take. `applicationFeeAmount` is what PropLane retains on the
  // destination charge; `managerPayoutCents` is what the manager nets.
  const processingFeeCents = fee.residentAddedFeeCents;
  const axisFeeCents = 0;
  const applicationFeeAmount = fee.applicationFeeCents;
  const managerPayoutCents = fee.managerPayoutCents;
  if (applicationFeeAmount > 0 && applicationFeeAmount >= fee.totalCents) {
    throw new Error("Service fee configuration prevents this charge.");
  }

  const residentEmail = input.residentEmail.trim().toLowerCase();
  const fundingModel = input.fundingModel ?? "connect_destination";
  const isPlatformLedger = fundingModel === "platform_ledger";
  const destinationAccountId = isPlatformLedger ? "" : input.destinationAccountId?.trim() || "";
  const holdPath = !isPlatformLedger && !destinationAccountId;
  const paymentIntentData: {
    transfer_data?: { destination: string };
    metadata: Record<string, string>;
    application_fee_amount?: number;
  } = {
    metadata: {
      ...input.metadata,
      payment_method: paymentMethod,
      manager_tier: input.managerTier?.trim().toLowerCase() || "free",
      fee_payer: feePayer,
      ...(holdPath
        ? { platform_hold: "1", hold_amount_cents: String(managerPayoutCents) }
        : {}),
      // `platform_ledger`: no transfer_data, no application_fee_amount — the
      // charge stays on the platform outright (separate charges and
      // transfers). The webhook reads this flag plus `manager_payout_cents`
      // (already carried in the session metadata below) to credit the
      // manager's PropLane balance once Stripe settles the charge.
      ...(isPlatformLedger ? { funding_model: "platform_ledger" } : {}),
    },
  };
  if (!holdPath && !isPlatformLedger) {
    paymentIntentData.transfer_data = { destination: destinationAccountId };
    if (applicationFeeAmount > 0) {
      paymentIntentData.application_fee_amount = applicationFeeAmount;
    }
  }

  const stripeLineItems: {
    price_data: {
      currency: "usd";
      product_data: { name: string; description?: string };
      unit_amount: number;
    };
    quantity: number;
  }[] = chargeLineItems.map((item) => ({
    price_data: {
      currency: "usd",
      product_data: {
        name: item.productName,
        description: item.productDescription,
      },
      unit_amount: Math.round(item.amountCents),
    },
    quantity: 1,
  }));

  // The service fee is a disclosed line item ONLY when the resident actually
  // pays it (added on top). When the manager absorbs it or PropLane covers it,
  // the resident pays face value and sees no fee line. Keeping the fee retention
  // (`application_fee_amount`) and the resident-visible line item in lockstep is
  // what stops a fee from ever being collected from the resident undisclosed.
  if (processingFeeCents > 0) {
    stripeLineItems.push({
      price_data: {
        currency: "usd",
        product_data: {
          name: "Payment processing fee",
          description: residentProcessingFeeLabel(paymentMethod),
        },
        unit_amount: processingFeeCents,
      },
      quantity: 1,
    });
  }

  const totalCents = subtotalCents + processingFeeCents + axisFeeCents;

  // Hard money invariant, checked against the numbers actually sent to Stripe.
  // Destination: payer total minus retained fee equals the recipient payout.
  // Hold: no application_fee_amount — Stripe's cost stays on the platform charge.
  if (totalCents !== fee.totalCents) {
    throw new Error("Checkout total does not reconcile with the manager payout.");
  }
  if (!holdPath && totalCents - applicationFeeAmount !== managerPayoutCents) {
    throw new Error("Checkout total does not reconcile with the manager payout.");
  }

  const paymentMethodConfig = await paymentMethodStripeConfig(stripe, paymentMethod);

  const sessionBase = {
    mode: "payment" as const,
    customer_email: residentEmail,
    ...paymentMethodConfig,
    line_items: stripeLineItems,
    metadata: {
      ...input.metadata,
      payment_method: paymentMethod,
      manager_tier: input.managerTier?.trim().toLowerCase() || "free",
      fee_payer: feePayer,
      subtotal_cents: String(subtotalCents),
      processing_fee_cents: String(processingFeeCents),
      axis_fee_cents: String(axisFeeCents),
      service_fee_cents: String(fee.serviceFeeCents),
      manager_payout_cents: String(managerPayoutCents),
      ...(holdPath ? { platform_hold: "1", hold_amount_cents: String(managerPayoutCents) } : {}),
      ...(isPlatformLedger ? { funding_model: "platform_ledger" } : {}),
    },
    payment_intent_data: paymentIntentData,
  };

  const feeResultBase = {
    subtotalCents,
    processingFeeCents,
    axisFeeCents,
    platformFeeCents: applicationFeeAmount,
    totalCents,
    paymentMethod,
  };

  if (input.mode === "embedded") {
    if (!input.returnUrl?.trim()) throw new Error("returnUrl is required for embedded checkout.");
    const session = await stripe.checkout.sessions.create({
      ui_mode: "embedded_page",
      ...sessionBase,
      return_url: input.returnUrl,
    } as unknown as Parameters<typeof stripe.checkout.sessions.create>[0]);
    if (!session.client_secret) throw new Error("Stripe did not return a client secret.");
    return {
      mode: "embedded",
      clientSecret: session.client_secret,
      sessionId: session.id,
      ...feeResultBase,
    };
  }

  if (!input.successUrl?.trim() || !input.cancelUrl?.trim()) {
    throw new Error("successUrl and cancelUrl are required for hosted checkout.");
  }
  const session = await stripe.checkout.sessions.create({
    ...sessionBase,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  } as Parameters<typeof stripe.checkout.sessions.create>[0]);
  if (!session.url) throw new Error("Stripe did not return a checkout URL.");
  return {
    mode: "hosted",
    url: session.url,
    sessionId: session.id,
    ...feeResultBase,
  };
}

function residentProcessingFeeLabel(method: ResidentAxisPaymentMethod): string {
  if (method === "ach") return "Bank processing";
  if (method === "link") return "Link processing";
  return "Card processing";
}
