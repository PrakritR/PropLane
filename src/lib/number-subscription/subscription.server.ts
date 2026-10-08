import "server-only";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { stripeInvoiceSubscriptionId, stripeSubscriptionPeriodEndSec } from "@/lib/stripe-subscription-helpers";
import {
  NUMBER_SUBSCRIPTION_LOOKUP_KEY,
  NUMBER_SUBSCRIPTION_PRICE_CENTS,
  NUMBER_SUBSCRIPTION_PURPOSE,
  safeNumberReturnPath,
  type NumberOwnerRole,
  type NumberSubscriptionStatus,
} from "./constants";
import { ensureNumberOwnerStripeCustomerId, ensureNumberSubscriptionPrice } from "./stripe.server";

/** A refusal the route turns into an HTTP status without leaking internals. */
export class NumberBillingError extends Error {
  constructor(
    public readonly code: "already_subscribed" | "not_subscribed" | "unavailable" | "invalid",
    public readonly status: 400 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
    this.name = "NumberBillingError";
  }
}

export type NumberSubscription = {
  ownerUserId: string;
  ownerRole: NumberOwnerRole;
  status: NumberSubscriptionStatus;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** Server-only: never put these in a response. */
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
};

type Row = {
  owner_user_id: string;
  owner_role: NumberOwnerRole;
  status: NumberSubscriptionStatus;
  current_period_end: string | null;
  cancel_at_period_end: boolean | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
};

const COLUMNS =
  "owner_user_id, owner_role, status, current_period_end, cancel_at_period_end, stripe_customer_id, stripe_subscription_id";

function fromRow(row: Row): NumberSubscription {
  return {
    ownerUserId: row.owner_user_id,
    ownerRole: row.owner_role,
    status: row.status,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end === true,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
  };
}

/** The caller-safe projection: no Stripe ids. */
export function toPublicNumberSubscription(sub: NumberSubscription | null) {
  if (!sub) return null;
  return {
    status: sub.status,
    role: sub.ownerRole,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
  };
}

/** One owner's subscription row, or null. Pass the authenticated user's own id, never a request id. */
export async function getNumberSubscription(
  ownerUserId: string,
  db: SupabaseClient = createSupabaseServiceRoleClient(),
): Promise<NumberSubscription | null> {
  const { data, error } = await db
    .from("number_subscriptions")
    .select(COLUMNS)
    .eq("owner_user_id", ownerUserId)
    .maybeSingle();
  if (error) throw new NumberBillingError("unavailable", 503, "Your number subscription could not be loaded.");
  return data ? fromRow(data as Row) : null;
}

/** Paid up: status is exactly `active`. The only state that carries the included monthly credit. */
export async function numberSubscriptionActive(
  ownerUserId: string,
  db?: SupabaseClient,
): Promise<boolean> {
  return (await getNumberSubscription(ownerUserId, db))?.status === "active";
}

/**
 * Entitled to the number and its features: `active`, or `past_due` while Stripe retries the card.
 * Use this to gate features; it is also what lets purchased credit be spent.
 */
export async function numberServiceEntitled(ownerUserId: string, db?: SupabaseClient): Promise<boolean> {
  const status = (await getNumberSubscription(ownerUserId, db))?.status;
  return status === "active" || status === "past_due";
}

const LIVE_STRIPE_STATUSES = new Set(["active", "trialing", "past_due", "unpaid"]);

type CheckoutInput = {
  userId: string;
  email: string;
  role: NumberOwnerRole;
  origin: string;
  returnPath?: unknown;
};

function returnUrl(origin: string, path: string, key: string, value: string): string {
  const url = new URL(path, origin);
  url.searchParams.set(key, value);
  return url.toString();
}

/**
 * A subscription-mode Checkout Session for the caller's OWN customer. The owner id and role are
 * written here, by the server, into the session and subscription metadata; the webhook still
 * cross-checks them against the row this function creates before it trusts them.
 */
export async function createNumberSubscriptionCheckout(
  db: SupabaseClient,
  stripe: Stripe,
  input: CheckoutInput,
): Promise<{ url: string }> {
  const existing = await getNumberSubscription(input.userId, db);
  if (existing && (existing.status === "active" || existing.status === "past_due")) {
    throw new NumberBillingError("already_subscribed", 409, "You already have a PropLane Number subscription.");
  }
  const customerId = await ensureNumberOwnerStripeCustomerId(stripe, db, input.userId, input.email, input.role);
  const priceId = await ensureNumberSubscriptionPrice(stripe);

  // The webhook may lag the card: ask Stripe too, so a second tab can never buy a second subscription.
  const live = await stripe.subscriptions.list({ customer: customerId, price: priceId, status: "all", limit: 20 });
  if (live.data.some((s) => LIVE_STRIPE_STATUSES.has(s.status))) {
    throw new NumberBillingError("already_subscribed", 409, "You already have a PropLane Number subscription.");
  }

  // Our own record exists before any money moves; the webhook resolves ownership through it.
  if (!existing) {
    const { error } = await db.from("number_subscriptions").insert({
      owner_user_id: input.userId,
      owner_role: input.role,
      stripe_customer_id: customerId,
      status: "incomplete",
    });
    if (error && error.code !== "23505") {
      throw new NumberBillingError("unavailable", 503, "Checkout could not be started. Try again.");
    }
  } else if (existing.stripeCustomerId !== customerId) {
    const { error } = await db
      .from("number_subscriptions")
      .update({ stripe_customer_id: customerId, updated_at: new Date().toISOString() })
      .eq("owner_user_id", input.userId)
      .in("status", ["incomplete", "canceled"]);
    if (error) throw new NumberBillingError("unavailable", 503, "Checkout could not be started. Try again.");
  }

  const fallback = `/${input.role}`;
  const path = safeNumberReturnPath(input.returnPath, fallback);
  const metadata = {
    purpose: NUMBER_SUBSCRIPTION_PURPOSE,
    owner_user_id: input.userId,
    owner_role: input.role,
  };
  const session = await stripe.checkout.sessions.create(
    {
      mode: "subscription",
      customer: customerId,
      client_reference_id: input.userId,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata,
      subscription_data: { metadata },
      allow_promotion_codes: false,
      success_url: returnUrl(input.origin, path, "number", "success"),
      cancel_url: returnUrl(input.origin, path, "number", "canceled"),
    },
    // A double-click inside ten minutes returns the same session instead of opening a second one.
    { idempotencyKey: `number-sub:${input.userId}:${Math.floor(Date.now() / 600_000)}` },
  );
  if (!session.url) throw new NumberBillingError("unavailable", 503, "Checkout could not be opened.");
  return { url: session.url };
}

/** The Stripe billing portal for the caller's own customer (read off OUR row, never the request). */
export async function createNumberBillingPortal(
  db: SupabaseClient,
  stripe: Stripe,
  input: { userId: string; role: NumberOwnerRole; origin: string; returnPath?: unknown },
): Promise<{ url: string }> {
  const sub = await getNumberSubscription(input.userId, db);
  if (!sub?.stripeCustomerId || !sub.stripeSubscriptionId) {
    throw new NumberBillingError("not_subscribed", 404, "You do not have a PropLane Number subscription.");
  }
  const path = safeNumberReturnPath(input.returnPath, `/${input.role}`);
  const session = await stripe.billingPortal.sessions.create({
    customer: sub.stripeCustomerId,
    return_url: new URL(path, input.origin).toString(),
  });
  return { url: session.url };
}

/* ------------------------------------------------------------------------------------------
 * Webhook side. Everything below runs only after the Stripe signature has been verified.
 * ---------------------------------------------------------------------------------------- */

export function mapStripeSubscriptionStatus(status: string): NumberSubscriptionStatus {
  switch (status) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "incomplete":
      return "incomplete";
    default:
      // canceled, incomplete_expired, paused: no entitlement.
      return "canceled";
  }
}

function objectId(value: string | { id?: string } | null | undefined): string | null {
  if (!value) return null;
  const id = typeof value === "string" ? value : value.id;
  return id?.trim() || null;
}

function subscriptionPriceOk(sub: Stripe.Subscription): boolean {
  const items = sub.items?.data ?? [];
  return (
    items.length === 1 &&
    items[0]!.price?.lookup_key === NUMBER_SUBSCRIPTION_LOOKUP_KEY &&
    items[0]!.price?.unit_amount === NUMBER_SUBSCRIPTION_PRICE_CENTS &&
    (items[0]!.quantity ?? 1) === 1
  );
}

async function rowBySubscriptionId(db: SupabaseClient, subscriptionId: string): Promise<Row | null> {
  const { data, error } = await db
    .from("number_subscriptions")
    .select(COLUMNS)
    .eq("stripe_subscription_id", subscriptionId)
    .maybeSingle();
  if (error) throw new Error("Number subscription ownership could not be verified.");
  return (data as Row | null) ?? null;
}

async function rowByOwner(db: SupabaseClient, ownerUserId: string): Promise<Row | null> {
  const { data, error } = await db.from("number_subscriptions").select(COLUMNS).eq("owner_user_id", ownerUserId).maybeSingle();
  if (error) throw new Error("Number subscription ownership could not be verified.");
  return (data as Row | null) ?? null;
}

/** Whether a subscription belongs to this feature (so the manager subscription handlers leave it alone). */
export async function isNumberSubscription(db: SupabaseClient, sub: Stripe.Subscription): Promise<boolean> {
  if (sub.metadata?.purpose === NUMBER_SUBSCRIPTION_PURPOSE) return true;
  return (await rowBySubscriptionId(db, sub.id)) !== null;
}

/** Whether an invoice belongs to a number subscription (known row, or our metadata on the first invoice). */
export async function isNumberSubscriptionInvoice(db: SupabaseClient, invoice: Stripe.Invoice): Promise<boolean> {
  const details = (invoice as unknown as { parent?: { subscription_details?: { metadata?: Record<string, string> } } })
    .parent?.subscription_details;
  const legacyDetails = (invoice as unknown as { subscription_details?: { metadata?: Record<string, string> } })
    .subscription_details;
  if ((details?.metadata ?? legacyDetails?.metadata)?.purpose === NUMBER_SUBSCRIPTION_PURPOSE) return true;
  const subId = stripeInvoiceSubscriptionId(invoice);
  return subId ? (await rowBySubscriptionId(db, subId)) !== null : false;
}

export type NumberSyncResult = "applied" | "stale" | "other_subscription" | "customer_mismatch" | "unresolved" | "rejected";

/**
 * Writes one subscription's CURRENT Stripe state. Every webhook path re-reads the subscription from
 * Stripe first and stamps the write with the time of that read, so a replayed or reordered event can
 * only ever write what Stripe says now, and the database function drops any write older than the last
 * one it applied.
 */
async function applyLiveSubscription(
  db: SupabaseClient,
  stripe: Pick<Stripe, "subscriptions">,
  row: Row,
  subscriptionId: string,
  expectedCustomerId: string,
): Promise<NumberSyncResult> {
  const live = await stripe.subscriptions.retrieve(subscriptionId);
  const readAt = new Date().toISOString();
  if (
    objectId(live.customer) !== expectedCustomerId ||
    live.metadata?.purpose !== NUMBER_SUBSCRIPTION_PURPOSE ||
    live.metadata?.owner_user_id !== row.owner_user_id ||
    !subscriptionPriceOk(live)
  ) {
    console.error("[number subscription] subscription does not match its checkout record", { subscription: subscriptionId });
    return "rejected";
  }
  const periodEnd = stripeSubscriptionPeriodEndSec(live);
  const { data, error } = await db.rpc("apply_number_subscription_event", {
    p_owner: row.owner_user_id,
    p_role: row.owner_role,
    p_customer: expectedCustomerId,
    p_subscription: live.id,
    p_status: mapStripeSubscriptionStatus(live.status),
    p_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    p_cancel_at_period_end: live.cancel_at_period_end === true,
    p_event_at: readAt,
  });
  if (error || typeof data !== "string") throw new Error("Number subscription could not be recorded.");
  if (data !== "applied") console.warn("[number subscription] state not applied", { subscription: live.id, outcome: data });
  return data as NumberSyncResult;
}

/**
 * customer.subscription.created/updated/deleted and invoice.payment_failed. Ownership comes from OUR
 * row (found by subscription id, or, for the first event, by the owner id our checkout wrote into
 * metadata AND the customer matching that row): a metadata owner id alone is never trusted. Throws on
 * a transient failure so Stripe redelivers.
 */
export async function syncNumberSubscriptionFromStripe(
  db: SupabaseClient,
  stripe: Pick<Stripe, "subscriptions">,
  subscriptionId: string,
  eventMetadata: Record<string, string> | null | undefined,
  eventCustomerId: string | null,
): Promise<NumberSyncResult> {
  let row = await rowBySubscriptionId(db, subscriptionId);
  if (!row) {
    const claimedOwner = eventMetadata?.owner_user_id?.trim();
    if (eventMetadata?.purpose !== NUMBER_SUBSCRIPTION_PURPOSE || !claimedOwner) return "unresolved";
    row = await rowByOwner(db, claimedOwner);
    if (!row) {
      console.error("[number subscription] subscription has no checkout record", { subscription: subscriptionId });
      return "unresolved";
    }
    if (!eventCustomerId || row.stripe_customer_id !== eventCustomerId) {
      console.error("[number subscription] subscription customer does not match its checkout record", {
        subscription: subscriptionId,
      });
      return "rejected";
    }
  }
  if (!row.stripe_customer_id) return "rejected";
  return applyLiveSubscription(db, stripe, row, subscriptionId, row.stripe_customer_id);
}

export function syncNumberSubscriptionEvent(
  db: SupabaseClient,
  stripe: Pick<Stripe, "subscriptions">,
  sub: Stripe.Subscription,
) {
  return syncNumberSubscriptionFromStripe(db, stripe, sub.id, sub.metadata, objectId(sub.customer));
}

/** invoice.payment_failed: re-read the subscription; Stripe itself says whether it is past_due. */
export async function syncNumberSubscriptionFromInvoice(
  db: SupabaseClient,
  stripe: Pick<Stripe, "subscriptions">,
  invoice: Stripe.Invoice,
): Promise<NumberSyncResult | false> {
  const subId = stripeInvoiceSubscriptionId(invoice);
  if (!subId) return false;
  const row = await rowBySubscriptionId(db, subId);
  if (!row) return false;
  return syncNumberSubscriptionFromStripe(db, stripe, subId, undefined, null);
}

/**
 * checkout.session.completed in subscription mode. Grants nothing on the session's say-so: the
 * session must be paid and match the owner row the checkout route created, and the subscription is
 * re-read from Stripe and must carry our price, our customer and our owner id.
 */
export async function fulfillNumberSubscriptionCheckout(
  db: SupabaseClient,
  stripe: Pick<Stripe, "subscriptions">,
  session: Stripe.Checkout.Session,
): Promise<NumberSyncResult | false> {
  if (session.metadata?.purpose !== NUMBER_SUBSCRIPTION_PURPOSE) return false;
  const owner = session.metadata.owner_user_id?.trim();
  if (session.mode !== "subscription" || !owner || session.client_reference_id !== owner) {
    console.error("[number subscription] checkout session did not match its owner", { session: session.id });
    return "rejected";
  }
  // Async methods complete unpaid first; the subscription events follow when it settles.
  if (session.payment_status !== "paid") return "unresolved";
  const row = await rowByOwner(db, owner);
  const customerId = objectId(session.customer);
  const subscriptionId = objectId(session.subscription);
  if (!row || !customerId || !subscriptionId || row.stripe_customer_id !== customerId) {
    console.error("[number subscription] paid checkout has no matching record", { session: session.id });
    return "rejected";
  }
  if (session.currency !== "usd" || session.amount_subtotal !== NUMBER_SUBSCRIPTION_PRICE_CENTS) {
    console.error("[number subscription] paid checkout amount mismatch", { session: session.id });
    return "rejected";
  }
  return applyLiveSubscription(db, stripe, row, subscriptionId, customerId);
}
