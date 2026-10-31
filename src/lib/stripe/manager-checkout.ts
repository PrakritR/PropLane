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
import type Stripe from "stripe";
import { isMissingSubscriptionStatusColumn } from "@/lib/manager-purchase-subscription-status";
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

type PriorReservation = {
  id: string;
  user_id: string | null;
  email: string | null;
  stripe_checkout_session_id: string | null;
  tier: string | null;
  billing: string | null;
  stripe_subscription_id: string | null;
  apple_original_transaction_id: string | null;
  /** Absent on a database still ahead of 20261020130000; an unknown status cannot disprove a live plan. */
  subscription_status?: string | null;
};

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;
type Refusal = { ok: false; status: number; error: string };

const PRIOR_RESERVATION_COLUMNS =
  "id,user_id,email,stripe_checkout_session_id,tier,billing,stripe_subscription_id,apple_original_transaction_id";

const CHECKOUT_RACE_REFUSAL: Refusal = {
  ok: false,
  status: 409,
  error: "Another checkout already started for this account. Refresh and try again.",
};
const CHECKOUT_UNCERTAIN_REFUSAL: Refusal = {
  ok: false,
  status: 503,
  error: "Your earlier checkout could not be confirmed closed. Please try again in a moment.",
};
/**
 * True only when Stripe definitively reports this id does not exist on the configured account
 * (`resource_missing` / a 404 invalid request). A network error, a rate limit or an outage must NOT
 * read as "already gone", or an abandoned-but-live session would be replaced with a second payable one.
 */
function stripeResourceMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; statusCode?: unknown; type?: unknown };
  if (e.code === "resource_missing") return true;
  return e.type === "StripeInvalidRequestError" && e.statusCode === 404;
}

const ACTIVE_PLAN_REFUSAL: Refusal = {
  ok: false,
  status: 409,
  error: "You already have an active plan. Manage it from Billing instead of starting another subscription.",
};

/**
 * The only subscription states that prove a stored subscription id is dead. Everything else (paused,
 * incomplete, unpaid, past_due, active, trialing, empty, or a value this code has never seen) still
 * counts as a live entitlement: an allowlist of live states would let a new Stripe status through.
 */
const TERMINAL_STRIPE_SUBSCRIPTION_STATUSES = new Set(["canceled", "incomplete_expired"]);

/**
 * A plan this account is already on, which no new Stripe Checkout may be reserved over: a live
 * Stripe subscription, an Apple IAP subscription, an admin grant or a 100% waiver, or any paid tier
 * already settled against something other than a `cs_` session. Taking the reservation id would bill
 * the account twice and leave two systems contending over one row's tier.
 *
 * The live Stripe subscription has to be named here and not left to `closePriorCheckoutSession`: a
 * prior `cs_` id Stripe no longer knows (a key rotation, a database seeded from another mode) is
 * reported "gone" and lets the compare-and-swap proceed, which is correct for an abandoned attempt
 * and wrong for a subscription that is still charging. Only an explicitly terminal status (`canceled`, `incomplete_expired`) disproves one; an UNKNOWN
 * status (the column not there yet, never written, or a value this code does not recognise) cannot, so it still refuses.
 *
 * A signup trial (`billing: "trial"` with no subscription behind it) and an `axis_intent_` free/trial
 * row are NOT plans of this kind: a verified Checkout is exactly what they are waiting for.
 */
function holdsLiveEntitlement(prior: PriorReservation): boolean {
  if (String(prior.apple_original_transaction_id ?? "").trim()) return true;
  const sessionId = String(prior.stripe_checkout_session_id ?? "").trim();
  if (/^(?:apple_iap_|admin_|axis_waiver_)/.test(sessionId)) return true;
  const subscriptionId = String(prior.stripe_subscription_id ?? "").trim();
  if (subscriptionId) {
    const status = String(prior.subscription_status ?? "").trim().toLowerCase();
    if (!TERMINAL_STRIPE_SUBSCRIPTION_STATUSES.has(status)) return true;
  }
  const tier = String(prior.tier ?? "").trim().toLowerCase();
  const signupTrial = String(prior.billing ?? "").trim().toLowerCase() === "trial" && !subscriptionId;
  return Boolean(tier) && tier !== "free" && !signupTrial && !sessionId.startsWith("cs_");
}

/**
 * One reservation row per manager id holds the ONE checkout that may be paid. Replacing it is a
 * compare-and-swap on the session id this caller read, never an unconditional overwrite: a second
 * writer that read the same row loses and its session is expired before it is ever returned.
 *
 * Returns "reserved" or "lost"; a database error throws.
 */
async function reserveManagerCheckoutSession(
  db: Db,
  reservation: ReservedManagerPurchase,
  prior: PriorReservation | null,
): Promise<"reserved" | "lost"> {
  if (prior) {
    let query = db
      .from("manager_purchases")
      .update({
        stripe_checkout_session_id: reservation.stripe_checkout_session_id,
        email: reservation.email,
        full_name: reservation.full_name,
        ...(reservation.user_id ? { user_id: reservation.user_id } : {}),
      })
      .eq("id", prior.id)
      .eq("manager_id", reservation.manager_id);
    query = prior.stripe_checkout_session_id
      ? query.eq("stripe_checkout_session_id", prior.stripe_checkout_session_id)
      : query.is("stripe_checkout_session_id", null);
    const { data, error } = await query.select("id").maybeSingle();
    if (error) throw new Error("Could not reserve manager checkout ownership.");
    return data?.id ? "reserved" : "lost";
  }
  // No row yet: insert-if-absent. A concurrent first-time creator that got there first wins and
  // this insert is ignored (zero rows back).
  const { data, error } = await db
    .from("manager_purchases")
    .upsert(reservation, { onConflict: "manager_id", ignoreDuplicates: true })
    .select("id");
  if (error) throw new Error("Could not reserve manager checkout ownership.");
  return Array.isArray(data) && data.length > 0 ? "reserved" : "lost";
}

/**
 * Close the previously reserved session before it is replaced. The old URL/secret was handed out, so
 * it stays payable until Stripe says otherwise: only a confirmed `expired` lets the replacement go on.
 * A complete session (paid, or complete but still settling) is never overwritten, and any error or
 * unexpected state refuses the new checkout rather than assuming the old one is closed.
 */
async function closePriorCheckoutSession(
  stripe: ReturnType<typeof getStripe>,
  priorSessionId: string,
  managerId: string,
): Promise<Refusal | null> {
  // Not a Stripe session (a pending placeholder): nothing payable to close.
  if (!priorSessionId.startsWith("cs_")) return null;
  // `gone` is Stripe answering that this id does not exist on the configured account (aged past
  // retention, a key rotation, a database seeded from another mode): there is nothing payable left to
  // close, so the replacement goes on. Every other error is indistinguishable from an outage and refuses.
  const retrieve = async (): Promise<Stripe.Checkout.Session | "gone" | null> => {
    try {
      return await stripe.checkout.sessions.retrieve(priorSessionId);
    } catch (error) {
      return stripeResourceMissing(error) ? "gone" : null;
    }
  };
  const prior = await retrieve();
  if (prior === "gone") return null;
  if (!prior) return CHECKOUT_UNCERTAIN_REFUSAL;
  if (prior.metadata?.manager_id !== managerId) {
    return { ok: false, status: 409, error: "An earlier subscription checkout needs reconciliation." };
  }
  if (prior.status === "expired") return null;
  if (prior.status === "complete") {
    return {
      ok: false,
      status: 409,
      error:
        prior.payment_status === "paid" || prior.payment_status === "no_payment_required"
          ? "Your previous subscription payment completed. Refresh to see your plan."
          : "Your previous subscription payment is still processing.",
    };
  }
  if (prior.status !== "open") return CHECKOUT_UNCERTAIN_REFUSAL;
  try {
    const expired = await stripe.checkout.sessions.expire(priorSessionId);
    if (expired?.status === "expired") return null;
  } catch {
    // Fall through to a confirming read: a concurrent writer may have expired it already.
  }
  const confirmed = await retrieve();
  if (confirmed === "gone") return null;
  return confirmed?.status === "expired" ? null : CHECKOUT_UNCERTAIN_REFUSAL;
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
  // Display-only breadcrumb: the redeemed code is read from Stripe's applied discounts, never from
  // this free text. Keep it to a code-shaped string or drop it.
  const promoMeta = promoRaw.toUpperCase();
  if (promoMeta.length <= 32 && /^[A-Z0-9_-]+$/.test(promoMeta)) metadata.promo = promoMeta;

  const promoCodeId = process.env.STRIPE_PROMOTION_CODE_ID_FIRST_MONTH_FREE?.trim();
  const autoFirstMonthFree =
    isProMonthly && promoUpper === PRO_MONTHLY_FIRST_FREE_PROMO_CODE && Boolean(promoCodeId);

  // Every plan's Checkout accepts promotion codes. FREEFIRST rides in as an applied discount, and
  // Stripe refuses a session that has both, so that one link skips the field.
  const allowPromotionCodes = !autoFirstMonthFree;

  // The reservation row this checkout will replace. It must belong to the same account: a row bound to a
  // login is never taken by a caller without that login, and an email other than the reserved one is refused.
  const readPrior = (columns: string) =>
    db.from("manager_purchases").select(columns).eq("manager_id", managerId).maybeSingle();
  let { data: priorRow, error: priorError } = await readPrior(`${PRIOR_RESERVATION_COLUMNS},subscription_status`);
  if (priorError && isMissingSubscriptionStatusColumn(priorError)) {
    ({ data: priorRow, error: priorError } = await readPrior(PRIOR_RESERVATION_COLUMNS));
  }
  if (priorError) throw new Error("Could not verify manager checkout ownership.");
  const prior = (priorRow as PriorReservation | null) ?? null;
  if (prior) {
    const priorUser = String(prior.user_id ?? "").trim();
    const priorEmail = String(prior.email ?? "").trim().toLowerCase();
    if ((priorUser && priorUser !== userId) || (priorEmail && priorEmail !== normalizedEmail.toLowerCase())) {
      return { ok: false, status: 409, error: "This account's checkout needs to be reconciled before it can start again." };
    }
    // Refuse before Stripe is asked for anything, so a live Apple/admin/waiver plan never has a
    // payable session created against it, let alone its reservation id swapped out from under it.
    if (holdsLiveEntitlement(prior)) return ACTIVE_PLAN_REFUSAL;
    const closed = await closePriorCheckoutSession(stripe, String(prior.stripe_checkout_session_id ?? "").trim(), managerId);
    if (closed) return closed;
  }

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
  // Reserve before exposing anything. On a database error or a lost race the new session is expired and
  // an error returned, so no open session is ever left that the caller was not given.
  const reserve = async (sessionId: string): Promise<Refusal | null> => {
    let outcome: "reserved" | "lost";
    try {
      outcome = await reserveManagerCheckoutSession(
        db,
        {
          stripe_checkout_session_id: sessionId,
          email: normalizedEmail,
          manager_id: managerId,
          full_name: fullName || null,
          ...(userId ? { user_id: userId } : {}),
        },
        prior,
      );
    } catch {
      await stripe.checkout.sessions.expire(sessionId).catch(() => undefined);
      return { ok: false, status: 500, error: "Could not reserve manager checkout ownership." };
    }
    if (outcome === "lost") {
      await stripe.checkout.sessions.expire(sessionId).catch(() => undefined);
      return CHECKOUT_RACE_REFUSAL;
    }
    return null;
  };

  if (useEmbedded) {
    const session = await stripe.checkout.sessions.create({
      ui_mode: "embedded_page",
      ...sessionBase,
      return_url: `${appUrl}${finishPath}`,
    } as Parameters<typeof stripe.checkout.sessions.create>[0]);

    const clientSecret = session.client_secret;
    if (!clientSecret) {
      await stripe.checkout.sessions.expire(session.id).catch(() => undefined);
      return { ok: false, status: 500, error: "Stripe did not return a client secret for embedded checkout." };
    }

    // Persist the durable session-to-owner mapping before exposing the client
    // secret. Tier and billing remain absent until the signed completion event.
    const refused = await reserve(session.id);
    if (refused) return refused;

    return { ok: true, embedded: true, clientSecret, sessionId: session.id };
  }

  const session = await stripe.checkout.sessions.create({
    ui_mode: "hosted_page",
    ...sessionBase,
    success_url: `${appUrl}${finishPath}`,
    cancel_url: `${appUrl}/partner/pricing`,
  } as Parameters<typeof stripe.checkout.sessions.create>[0]);

  if (!session.url) {
    await stripe.checkout.sessions.expire(session.id).catch(() => undefined);
    return { ok: false, status: 500, error: "Stripe did not return a checkout URL." };
  }

  // Hosted Checkout reaches the same completion webhook as embedded Checkout.
  // It must therefore reserve the exact same durable owner mapping before the
  // browser receives a URL that can collect payment.
  const refused = await reserve(session.id);
  if (refused) return refused;

  return { ok: true, embedded: false, url: session.url, sessionId: session.id };
}
