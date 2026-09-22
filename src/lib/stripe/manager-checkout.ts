import { resolveAppOrigin } from "@/lib/app-url";
import { ensureDoorOveragePrice, resolveManagerDoorOverage } from "@/lib/billing/quantity-sync.server";
import { RATE_CARD_VERSION } from "@/lib/billing/rate-card";
import { generateManagerId } from "@/lib/manager-id";
import { normalizeProMonthlyPromoInput, PRO_MONTHLY_FIRST_FREE_PROMO_CODE } from "@/lib/stripe-promos";
import { resolveStripePriceIdForManagerTier } from "@/lib/stripe/resolve-manager-price";
import type { ManagerSubscriptionTier, StripeBilling } from "@/lib/stripe-price-ids";
import { META_RATE_CARD_VERSION } from "@/lib/stripe-subscription-metadata";
import {
  buildManagerSubscriptionCheckoutBase,
  MANAGER_SUBSCRIPTION_TRIAL_DAYS,
} from "@/lib/stripe/subscription-checkout-session";
import { getStripe } from "@/lib/stripe";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveTestWorkspaceClassification } from "@/lib/test-workspaces/index.server";

export type ManagerCheckoutInput = {
  tier: ManagerSubscriptionTier;
  billing: StripeBilling;
  email?: string;
  fullName?: string;
  phone?: string;
  userId?: string;
  /** Reuse Axis ID from a pending manager signup instead of generating a new one. */
  managerId?: string;
  promo?: string;
  embedded?: boolean;
  req: Request;
};

export type ManagerCheckoutResult =
  | { ok: true; embedded: true; clientSecret: string; sessionId: string }
  | { ok: true; embedded: false; url: string; sessionId: string }
  | { ok: false; status: number; error: string; code?: string };

type ReservedManagerPurchase = {
  stripe_checkout_session_id: string;
  email: string;
  manager_id: string;
  full_name: string | null;
  user_id?: string;
};

async function reserveManagerCheckoutSession(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  reservation: ReservedManagerPurchase,
): Promise<void> {
  const { error } = await db.from("manager_purchases").upsert(reservation, {
    onConflict: "manager_id",
  });
  if (error) throw new Error("Could not reserve manager checkout ownership.");
}

export async function createManagerCheckoutSession(input: ManagerCheckoutInput): Promise<ManagerCheckoutResult> {
  const { tier, billing, req } = input;
  const useEmbedded = input.embedded !== false;

  const db = createSupabaseServiceRoleClient();
  const suppliedUserId = typeof input.userId === "string" ? input.userId.trim() : "";
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  let emailOwnerUserId = "";
  // An email-backed account is a durable checkout owner. Resolve it before an
  // authenticated caller's id so a request body can never hide a classified
  // account by pairing its email with a different UUID.
  if (email) {
    const { data, error } = await db
      .from("manager_purchases")
      .select("user_id")
      .eq("email", email)
      .not("user_id", "is", null)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error("Could not verify manager checkout ownership.");
    emailOwnerUserId = String((data as { user_id?: string | null } | null)?.user_id ?? "").trim();
  }
  if (!emailOwnerUserId && email) {
    const { data, error } = await db.from("profiles").select("id").eq("email", email).limit(1).maybeSingle();
    if (error) throw new Error("Could not verify manager checkout ownership.");
    emailOwnerUserId = String((data as { id?: string | null } | null)?.id ?? "").trim();
  }
  if (emailOwnerUserId && suppliedUserId && emailOwnerUserId !== suppliedUserId) {
    return { ok: false, status: 403, error: "This action is unavailable." };
  }
  const verifiedUserId = emailOwnerUserId || suppliedUserId;
  if (verifiedUserId && (await resolveTestWorkspaceClassification(verifiedUserId, db)).kind !== "normal") {
    return { ok: false, status: 403, error: "This action is unavailable." };
  }

  const price = await resolveStripePriceIdForManagerTier(tier, billing);
  if (!price) {
    const tierLabel = tier === "free" ? "free" : `${tier} ${billing}`;
    return {
      ok: false,
      status: 500,
      error: `No Stripe price found for ${tierLabel}. In Stripe, set lookup_key to axis_manager_${tier === "free" ? "free_monthly" : `${tier}_${billing}`} on the active price, or run scripts/setup-stripe-plan-prices.mjs.`,
    };
  }

  const appUrl = resolveAppOrigin(req);
  const normalizedEmail = typeof input.email === "string" ? input.email.trim() : "";
  const fullName = typeof input.fullName === "string" ? input.fullName.trim() : "";
  const phone = typeof input.phone === "string" ? input.phone.trim() : "";
  const userId = suppliedUserId;
  if (!normalizedEmail) {
    return { ok: false, status: 400, error: "Email is required to start manager checkout." };
  }
  const promoRaw = typeof input.promo === "string" ? normalizeProMonthlyPromoInput(input.promo) : "";
  const promoUpper = promoRaw.toUpperCase();

  const isProMonthly = tier === "pro" && billing === "monthly";
  if (promoUpper === PRO_MONTHLY_FIRST_FREE_PROMO_CODE && !isProMonthly) {
    return {
      ok: false,
      status: 400,
      error: `Promo ${PRO_MONTHLY_FIRST_FREE_PROMO_CODE} applies only to Pro monthly billing.`,
    };
  }

  const stripe = getStripe();

  // A door-overage line beside the tier floor, sized at whatever this account
  // already bills for TODAY (almost always 0 doors for a brand-new signup,
  // but an existing manager can reach checkout from an authenticated upgrade
  // flow with real listings already on file). Free has no overage price at
  // all, and a signup with no resolvable account yet has no listings to
  // count. A door count that fails to resolve fails the checkout closed
  // rather than guessing a quantity.
  let extraLineItems: Array<{ price: string; quantity: number }> | undefined;
  if (tier !== "free" && verifiedUserId) {
    const overage = await resolveManagerDoorOverage(db, verifiedUserId, tier);
    if (!overage.ok) {
      return {
        ok: false,
        status: 503,
        error: "Could not verify your current door count for billing. Please try again.",
      };
    }
    if (overage.quantity > 0) {
      const doorPriceId = await ensureDoorOveragePrice(stripe, tier);
      extraLineItems = [{ price: doorPriceId, quantity: overage.quantity }];
    }
  }

  const managerId = input.managerId?.trim() || generateManagerId();
  const metadata: Record<string, string> = {
    tier,
    billing,
    manager_id: managerId,
    // Pins the rate card this brand-new subscription is priced under so a
    // later rate-card change can never silently re-price it.
    [META_RATE_CARD_VERSION]: RATE_CARD_VERSION,
  };
  if (normalizedEmail) metadata.email = normalizedEmail;
  if (fullName) metadata.full_name = fullName;
  if (phone) metadata.phone = phone;
  if (userId) metadata.userId = userId;
  if (promoRaw) metadata.promo = promoRaw;

  const promoCodeId = process.env.STRIPE_PROMOTION_CODE_ID_FIRST_MONTH_FREE?.trim();
  const autoFirstMonthFree =
    isProMonthly && promoUpper === PRO_MONTHLY_FIRST_FREE_PROMO_CODE && Boolean(promoCodeId);

  const allowPromotionCodes = isProMonthly && !autoFirstMonthFree;

  const sessionBase = buildManagerSubscriptionCheckoutBase({
    priceId: price,
    metadata,
    ...(normalizedEmail ? { customerEmail: normalizedEmail } : {}),
    ...(autoFirstMonthFree && promoCodeId ? { discounts: [{ promotion_code: promoCodeId }] } : {}),
    allowPromotionCodes,
    trialPeriodDays: MANAGER_SUBSCRIPTION_TRIAL_DAYS,
    ...(extraLineItems ? { extraLineItems } : {}),
  });

  const returnTarget = userId ? "manager-oauth-finish" : "manager-id";
  const finishPath = `/auth/${returnTarget}?session_id={CHECKOUT_SESSION_ID}`;
  const reserve = (sessionId: string) =>
    reserveManagerCheckoutSession(db, {
      stripe_checkout_session_id: sessionId,
      email: normalizedEmail,
      manager_id: managerId,
      full_name: fullName || null,
      ...(userId ? { user_id: userId } : {}),
    });

  if (useEmbedded) {
    const session = await stripe.checkout.sessions.create({
      ui_mode: "embedded_page",
      ...sessionBase,
      return_url: `${appUrl}${finishPath}`,
    } as Parameters<typeof stripe.checkout.sessions.create>[0]);

    const clientSecret = session.client_secret;
    if (!clientSecret) {
      return { ok: false, status: 500, error: "Stripe did not return a client secret for embedded checkout." };
    }

    // Persist the durable session-to-owner mapping before exposing the client
    // secret. Tier and billing remain absent until the signed completion event.
    await reserve(session.id);

    return { ok: true, embedded: true, clientSecret, sessionId: session.id };
  }

  const session = await stripe.checkout.sessions.create({
    ui_mode: "hosted_page",
    ...sessionBase,
    success_url: `${appUrl}${finishPath}`,
    cancel_url: `${appUrl}/partner/pricing`,
  } as Parameters<typeof stripe.checkout.sessions.create>[0]);

  if (!session.url) {
    return { ok: false, status: 500, error: "Stripe did not return a checkout URL." };
  }

  // Hosted Checkout reaches the same completion webhook as embedded Checkout.
  // It must therefore reserve the exact same durable owner mapping before the
  // browser receives a URL that can collect payment.
  await reserve(session.id);

  return { ok: true, embedded: false, url: session.url, sessionId: session.id };
}
