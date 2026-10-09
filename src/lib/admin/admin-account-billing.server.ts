import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { getStripe, isStripeLiveMode } from "@/lib/stripe";
import { COMPLIMENTARY_COUPON_ID } from "@/lib/admin/admin-billing-constants";
import { isAdminManagedManagerPurchase } from "@/lib/manager-admin-purchase";
import {
  isWaiverGrantedManagerPurchase,
  maxPropertiesForManagerTier,
  pickBestManagerPurchaseRow,
  resolveEffectiveManagerSkuTier,
  type ManagerSkuTier,
} from "@/lib/manager-access";
import { isAppleBilledManagerPurchase } from "@/lib/manager-apple-purchase";
import {
  loadManagerBillingOverrides,
  resolveManagerPropertyCap,
  type ManagerBillingOverrides,
} from "@/lib/manager-billing-overrides";
import { isSignupTrialManagerPurchase, managerPurchasePeriodEndMs } from "@/lib/manager-tier-expiry";

/**
 * One manager account's billing as the admin record shows it: the subscription facts, the trial and
 * discount terms, the limits staff can bend, and the payments Stripe has taken from the customer.
 *
 * The plan comes from the SAME resolver enforcement uses (`resolveEffectiveManagerSkuTier`), the
 * subscription facts from Stripe when there is a subscription, and "paid to date" and the payments
 * list from Stripe invoices for the account's customer. Stripe is read server-side only; if it
 * cannot be reached the database facts still render and `stripe.available` says why the rest is
 * missing — a number Stripe did not give is `null`, never `0`.
 */

export type AdminAccountBillingPayment = {
  id: string;
  at: string | null;
  amountCents: number;
  currency: string;
  status: string;
  /** What was bought — the invoice's first line, else its number. */
  description: string;
  number: string | null;
  invoiceUrl: string | null;
};

export type AdminAccountBilling = {
  plan: {
    /** The plan enforcement uses; `null` for a legacy account with no committed plan. */
    tier: ManagerSkuTier | null;
    /** `Pro monthly`, `Business annual`, `Free`. */
    planLabel: string;
    source: "stripe" | "app_store" | "admin" | "promo" | "trial" | "none";
    sourceLabel: string;
    status: string;
    statusTone: "ok" | "bad" | null;
    since: string | null;
    /** The next renewal, or the end of a subscription set to cancel. */
    renewsAt: string | null;
    renewsLabel: "Renews" | "Ends";
    trialEndsAt: string | null;
    complimentary: boolean;
    promoCode: string | null;
  };
  limits: {
    /** Listing cap actually enforced; `null` = uncapped. */
    propertyCap: number | null;
    propertyCapIsOverride: boolean;
  };
  paidToDateCents: number | null;
  currency: string;
  payments: AdminAccountBillingPayment[];
  stripe: {
    linked: boolean;
    /** Stripe could not be read, so the subscription facts and payments are the database's only. */
    available: boolean;
    testMode: boolean;
    customerUrl: string | null;
  };
};

type PurchaseRow = {
  id: string;
  tier: string | null;
  billing: string | null;
  paid_at: string | null;
  user_id: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_checkout_session_id: string | null;
  promo_code: string | null;
  stripe_promotion_code?: string | null;
  apple_original_transaction_id: string | null;
};

const PLAN_LABELS: Record<ManagerSkuTier, string> = { free: "Free", pro: "Pro", business: "Business" };
const CADENCE: Record<string, string> = { monthly: "monthly", annual: "annual" };

const STRIPE_STATUS: Record<string, { label: string; tone: "ok" | "bad" | null }> = {
  active: { label: "Active", tone: "ok" },
  trialing: { label: "Trial", tone: null },
  past_due: { label: "Past due", tone: "bad" },
  unpaid: { label: "Unpaid", tone: "bad" },
  canceled: { label: "Canceled", tone: "bad" },
  incomplete: { label: "Incomplete", tone: "bad" },
  incomplete_expired: { label: "Expired", tone: "bad" },
  paused: { label: "Paused", tone: null },
};

const iso = (seconds: number | null | undefined): string | null =>
  typeof seconds === "number" ? new Date(seconds * 1000).toISOString() : null;
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The Stripe dashboard page for a customer; test-mode keys link into the test dashboard. */
export function stripeCustomerDashboardUrl(customerId: string, live = isStripeLiveMode()): string {
  return `https://dashboard.stripe.com/${live ? "" : "test/"}customers/${encodeURIComponent(customerId)}`;
}

function describeInvoice(invoice: Stripe.Invoice): string {
  const line = invoice.lines?.data?.[0];
  return text(line?.description) || text(invoice.description) || (invoice.number ? `Invoice ${invoice.number}` : "Invoice");
}

export function invoiceToPayment(invoice: Stripe.Invoice): AdminAccountBillingPayment {
  return {
    id: invoice.id ?? "",
    at: iso(invoice.status_transitions?.paid_at ?? invoice.created),
    amountCents: invoice.amount_paid ?? 0,
    currency: invoice.currency ?? "usd",
    status: invoice.status ?? "unknown",
    description: describeInvoice(invoice),
    number: invoice.number ?? null,
    invoiceUrl: invoice.hosted_invoice_url ?? null,
  };
}

async function readPurchase(db: SupabaseClient, managerUserId: string): Promise<PurchaseRow | null> {
  const { data, error } = await db
    .from("manager_purchases")
    .select(
      "id, tier, billing, paid_at, user_id, stripe_customer_id, stripe_subscription_id, stripe_checkout_session_id, promo_code, stripe_promotion_code, apple_original_transaction_id",
    )
    .eq("user_id", managerUserId);
  // An unreadable plan is not the Free plan: the caller turns this into a 500, never a default.
  if (error) throw new Error("Could not read this account's purchases.");
  const rows = (data ?? []) as PurchaseRow[];
  return (
    (pickBestManagerPurchaseRow(
      rows.map((r) => ({ ...r, promo_code: r.promo_code ?? null })),
      managerUserId,
    ) as PurchaseRow | null) ?? null
  );
}

function sourceOf(purchase: PurchaseRow | null): AdminAccountBilling["plan"]["source"] {
  if (!purchase) return "none";
  if (text(purchase.stripe_subscription_id)) return "stripe";
  if (isAppleBilledManagerPurchase(purchase.billing, purchase.apple_original_transaction_id)) return "app_store";
  if (isSignupTrialManagerPurchase(purchase.billing)) return "trial";
  if (text(purchase.billing).toLowerCase() === "admin" || isAdminManagedManagerPurchase(purchase.stripe_checkout_session_id)) {
    return "admin";
  }
  if (isWaiverGrantedManagerPurchase(purchase.promo_code)) return "promo";
  return "none";
}

const SOURCE_LABEL: Record<AdminAccountBilling["plan"]["source"], string> = {
  stripe: "Stripe",
  app_store: "App Store",
  admin: "Admin",
  promo: "Promo code",
  trial: "Trial",
  none: "None",
};

/** Facts the database alone can give, used as-is when there is no subscription to ask Stripe about. */
function databasePlan(
  purchase: PurchaseRow | null,
  tier: ManagerSkuTier | null,
  overrides: ManagerBillingOverrides,
  nowMs: number,
): AdminAccountBilling["plan"] {
  const source = sourceOf(purchase);
  const cadence = CADENCE[text(purchase?.billing).toLowerCase()];
  const trialEndMs = purchase
    ? managerPurchasePeriodEndMs(
        {
          tier: purchase.tier,
          billing: purchase.billing,
          paid_at: purchase.paid_at,
          stripe_subscription_id: purchase.stripe_subscription_id,
        },
        nowMs,
      )
    : null;
  const onTrialRow = isSignupTrialManagerPurchase(purchase?.billing);
  const trialEndsAt = onTrialRow && trialEndMs !== null ? new Date(trialEndMs).toISOString() : null;

  let status = "Free";
  let statusTone: "ok" | "bad" | null = null;
  if (tier && tier !== "free") {
    if (onTrialRow) {
      status = "Trial";
    } else {
      status = "Active";
      statusTone = "ok";
    }
  } else if (onTrialRow) {
    status = "Trial ended";
    statusTone = "bad";
  }

  // An admin/promo plan has no period: it simply holds, so there is nothing to "renew".
  const periodEndMs =
    purchase && !onTrialRow && (cadence === "monthly" || cadence === "annual")
      ? managerPurchasePeriodEndMs({ tier: purchase.tier, billing: purchase.billing, paid_at: purchase.paid_at })
      : null;

  return {
    tier,
    planLabel: tier ? `${PLAN_LABELS[tier]}${tier !== "free" && cadence && !onTrialRow ? ` ${cadence}` : ""}` : "Legacy",
    source,
    sourceLabel: SOURCE_LABEL[source],
    status,
    statusTone,
    since: purchase?.paid_at ?? null,
    renewsAt: source === "app_store" || source === "stripe" ? null : periodEndMs === null ? null : new Date(periodEndMs).toISOString(),
    renewsLabel: "Renews",
    trialEndsAt,
    complimentary: overrides.complimentary,
    // The code the customer redeemed at checkout, else the waiver code. Display only.
    promoCode: text(purchase?.stripe_promotion_code) || text(purchase?.promo_code) || null,
  };
}

export async function loadAdminAccountBilling(
  db: SupabaseClient,
  managerUserId: string,
  nowMs = Date.now(),
): Promise<AdminAccountBilling> {
  const purchase = await readPurchase(db, managerUserId);
  const overridesRead = await loadManagerBillingOverrides(db, managerUserId);
  if (!overridesRead.ok) throw new Error(overridesRead.error);
  const overrides = overridesRead.overrides;

  const appleManaged = isAppleBilledManagerPurchase(purchase?.billing, purchase?.apple_original_transaction_id);
  const tier = resolveEffectiveManagerSkuTier({
    tier: purchase?.tier ?? null,
    stripeSubscriptionId: purchase?.stripe_subscription_id ?? null,
    appleManaged,
    billing: purchase?.billing ?? null,
    paidAt: purchase?.paid_at ?? null,
    nowMs,
  });

  const cap = resolveManagerPropertyCap({
    planLimit: maxPropertiesForManagerTier(tier),
    capOverride: overrides.propertyCap,
  });

  const subscriptionId = text(purchase?.stripe_subscription_id);
  let customerId = text(purchase?.stripe_customer_id);
  const plan = databasePlan(purchase, tier, overrides, nowMs);
  let stripeAvailable = true;
  let payments: AdminAccountBillingPayment[] = [];
  let paidToDateCents: number | null = null;
  let currency = "usd";

  if (subscriptionId || customerId) {
    try {
      const stripe = getStripe();
      if (subscriptionId) {
        const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["discounts"] });
        const known = STRIPE_STATUS[sub.status] ?? { label: sub.status, tone: null };
        plan.status = known.label;
        plan.statusTone = known.tone;
        plan.since = iso(sub.start_date) ?? plan.since;
        plan.trialEndsAt = sub.trial_end ? iso(sub.trial_end) : null;
        // In this API version the period lives on the item, not the subscription.
        plan.renewsAt = iso(sub.items?.data?.[0]?.current_period_end);
        plan.renewsLabel = sub.cancel_at_period_end ? "Ends" : "Renews";
        const interval = sub.items?.data?.[0]?.price?.recurring?.interval;
        const cadence = interval === "year" ? "annual" : interval === "month" ? "monthly" : null;
        if (tier && tier !== "free" && cadence) plan.planLabel = `${PLAN_LABELS[tier]} ${cadence}`;
        currency = sub.currency ?? currency;
        if (!customerId) customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;

        const comp = (sub.discounts ?? []).some((d) => {
          if (typeof d === "string") return false;
          const coupon = d.source?.coupon;
          return (typeof coupon === "string" ? coupon : coupon?.id) === COMPLIMENTARY_COUPON_ID;
        });
        // The subscription is the truth for an account billed through Stripe.
        plan.complimentary = comp;
        const promoIds = (sub.discounts ?? []).flatMap((d) =>
          typeof d === "string" || !d.promotion_code
            ? []
            : [typeof d.promotion_code === "string" ? d.promotion_code : d.promotion_code.id],
        );
        const codes: string[] = [];
        for (const id of promoIds) {
          try {
            codes.push((await stripe.promotionCodes.retrieve(id)).code);
          } catch {
            // Unnamed but still applied: leave it out of the label rather than print an id.
          }
        }
        plan.promoCode = codes.length > 0 ? codes.join(", ") : plan.promoCode;
      }
      if (customerId) {
        const list = await stripe.invoices.list({ customer: customerId, limit: 100 });
        payments = list.data.filter((i) => i.status === "paid" && (i.amount_paid ?? 0) > 0).map(invoiceToPayment);
        paidToDateCents = payments.reduce((sum, p) => sum + p.amountCents, 0);
        if (list.data[0]?.currency) currency = list.data[0].currency;
      }
    } catch (e) {
      // Stripe's message can name ids and request shape; log it, report only that it was unreachable.
      console.error("admin account billing: Stripe read failed", e);
      stripeAvailable = false;
      payments = [];
      paidToDateCents = null;
    }
  }

  return {
    plan,
    limits: { propertyCap: cap.limit, propertyCapIsOverride: cap.source === "override" },
    paidToDateCents,
    currency,
    payments,
    stripe: {
      linked: Boolean(subscriptionId || customerId),
      available: stripeAvailable,
      testMode: !isStripeLiveMode(),
      customerUrl: customerId ? stripeCustomerDashboardUrl(customerId) : null,
    },
  };
}
