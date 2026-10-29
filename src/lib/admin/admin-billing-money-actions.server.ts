import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import {
  normalizeAdminAuditReason,
  writeAdminBillingAudit,
  type AdminBillingAuditEntry,
} from "@/lib/admin-billing-audit.server";
import { normalizeManagerSkuTier } from "@/lib/manager-access";
import { reconcileManagerPurchaseByStripeSubscriptionId } from "@/lib/manager-stripe-subscription-sync";
import { invalidateManagerTierCache } from "@/lib/manager-tier-sync-cache";
import { isDoorOverageLookupKey } from "@/lib/billing/quantity-sync.server";
import { assertManagerPriceMatchesRateCard } from "@/lib/stripe/resolve-manager-price";
import { stripePriceIdForPaidTier, managerSkuToPaidTier } from "@/lib/stripe-price-ids";
import { assertTestWorkspaceProviderEffectAllowed } from "@/lib/test-workspaces/effects.server";

/**
 * The three MONEY actions PropLane staff take on one manager's Stripe subscription: change the
 * price from the next invoice, refund a paid invoice, cancel. (Trial / complimentary / promo live
 * in `admin-billing-actions.server.ts`.)
 *
 * Every action, in this order:
 *  1. refuses a missing reason BEFORE any Stripe call,
 *  2. reads Stripe (read-only) to learn the before-value and to re-derive every limit server-side,
 *  3. writes the `audit_log` row FIRST (`writeAdminBillingAudit`); if the row cannot be written the
 *     action is refused and Stripe is never mutated,
 *  4. only then mutates Stripe; a Stripe failure after the audit row leaves a `<field>Failed` row.
 *
 * This module does no authorization of its own: the route (`requireAdminRoute()` = Overall admin)
 * is the boundary, and the account id is re-validated there as a manager account.
 */

export type MoneyActionFailure = { ok: false; status: number; error: string };
export type MoneyActionResult<T extends object = object> = ({ ok: true } & T) | MoneyActionFailure;

export type MoneyActionContext = {
  db: SupabaseClient;
  actorUserId: string;
  managerUserId: string;
  reason: unknown;
};

type PurchaseRow = {
  tier: string | null;
  paid_at: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
};

/** Longest custom monthly price accepted: $10,000.00. A typo guard, not a business rule. */
export const MAX_CUSTOM_MONTHLY_CENTS = 1_000_000;
const NONCE_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const CUSTOM_PRICE_METADATA_KEY = "axis_custom_monthly_cents";

const fail = (status: number, error: string): MoneyActionFailure => ({ ok: false, status, error });
const trimmed = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const idOf = (v: unknown): string => {
  if (typeof v === "string") return v.trim();
  if (v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string") return (v as { id: string }).id.trim();
  return "";
};
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function requireReason(raw: unknown): { ok: true; reason: string } | MoneyActionFailure {
  const reason = normalizeAdminAuditReason(raw);
  return reason ? { ok: true, reason } : fail(400, "A reason is required.");
}

async function loadPurchase(
  db: SupabaseClient,
  managerUserId: string,
): Promise<{ ok: true; purchase: PurchaseRow | null } | MoneyActionFailure> {
  const { data, error } = await db
    .from("manager_purchases")
    .select("tier, paid_at, stripe_customer_id, stripe_subscription_id")
    .eq("user_id", managerUserId);
  if (error) {
    console.error("admin billing money action: purchase read failed", error);
    return fail(500, "Could not read this account's billing.");
  }
  const rows = ((data ?? []) as PurchaseRow[]).slice();
  rows.sort((a, b) => (Date.parse(b.paid_at ?? "") || 0) - (Date.parse(a.paid_at ?? "") || 0));
  return { ok: true, purchase: rows[0] ?? null };
}

async function assertStripeAllowed(ctx: MoneyActionContext): Promise<MoneyActionFailure | null> {
  try {
    await assertTestWorkspaceProviderEffectAllowed({
      userId: ctx.managerUserId,
      kind: "payment",
      summary: "Admin billing change refused for a test workspace.",
      db: ctx.db,
    });
    return null;
  } catch {
    return fail(409, "Billing changes are unavailable for test accounts.");
  }
}

function stripeFailure(label: string, e: unknown): MoneyActionFailure {
  // Stripe's message can name ids and request shape; it is logged, never returned.
  console.error(`admin billing money action: Stripe ${label} failed`, e);
  return fail(502, "Stripe could not apply that change. Try again.");
}

/** Audit row FIRST. `false` means nothing was recorded and the caller must not touch Stripe. */
async function auditFirst(ctx: MoneyActionContext, reason: string, entry: AdminBillingAuditEntry): Promise<boolean> {
  const result = await writeAdminBillingAudit({
    db: ctx.db,
    actorUserId: ctx.actorUserId,
    managerUserId: ctx.managerUserId,
    entries: [entry],
    reason,
  });
  if (!result.ok) console.error("admin billing money action: audit row not written", entry.field);
  return result.ok;
}

/** The Stripe call failed after its audit row landed: say so, so the trail never claims it applied. */
async function auditFailed(ctx: MoneyActionContext, reason: string, entry: AdminBillingAuditEntry): Promise<void> {
  await writeAdminBillingAudit({
    db: ctx.db,
    actorUserId: ctx.actorUserId,
    managerUserId: ctx.managerUserId,
    entries: [{ field: `${entry.field}Failed`, before: entry.after, after: null }],
    reason,
  }).catch(() => undefined);
}

async function reconcileQuietly(subscriptionId: string, managerUserId: string): Promise<void> {
  try {
    await reconcileManagerPurchaseByStripeSubscriptionId(subscriptionId);
  } catch (e) {
    console.error("admin billing money action: reconcile failed", e);
  }
  invalidateManagerTierCache(managerUserId);
}

/**
 * The plan's own line: the one item that is not the per-door overage item. Exported because the admin
 * billing CARD must name the same item this file's Change price acts on; two rules would show a
 * monthly price staff cannot change.
 */
export function subscriptionPlanItem(sub: Stripe.Subscription): Stripe.SubscriptionItem | null {
  const items = (sub.items?.data ?? []).filter((item) => {
    const key = typeof item.price === "object" && item.price ? (item.price.lookup_key ?? "") : "";
    return !isDoorOverageLookupKey(key);
  });
  return items.length === 1 ? items[0]! : null;
}

async function loadLiveSubscription(
  ctx: MoneyActionContext,
): Promise<
  | { ok: true; purchase: PurchaseRow; subscriptionId: string; stripe: Stripe; sub: Stripe.Subscription }
  | MoneyActionFailure
> {
  const loaded = await loadPurchase(ctx.db, ctx.managerUserId);
  if (!loaded.ok) return loaded;
  const subscriptionId = trimmed(loaded.purchase?.stripe_subscription_id);
  if (!loaded.purchase || !subscriptionId) return fail(409, "No card subscription.");
  const blocked = await assertStripeAllowed(ctx);
  if (blocked) return blocked;
  try {
    const stripe = getStripe();
    const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["items.data.price"] });
    return { ok: true, purchase: loaded.purchase, subscriptionId, stripe, sub };
  } catch (e) {
    return stripeFailure("subscription read", e);
  }
}

/* -------------------------------------------------------------------------- */
/* Change price                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Set the account's monthly price from the NEXT invoice (`proration_behavior: "none"`): a custom
 * amount replaces the plan item with `price_data` on the same product, currency and interval; the
 * string `"rate-card"` puts the tier's rate-card Price back. Monthly subscriptions only (a custom
 * "monthly amount" on an annual plan would mean something else), and only when the plan line is
 * unambiguous.
 */
export async function changeAccountPrice(
  ctx: MoneyActionContext,
  amount: unknown,
): Promise<MoneyActionResult<{ monthlyCents: number | null; rateCard: boolean; effective: "next_invoice" }>> {
  const reason = requireReason(ctx.reason);
  if (!reason.ok) return reason;

  const rateCard = amount === "rate-card";
  let cents = 0;
  if (!rateCard) {
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
      return fail(400, "Enter a monthly price above $0, or choose Rate card.");
    }
    if (amount > MAX_CUSTOM_MONTHLY_CENTS) return fail(400, `The monthly price can be at most ${dollars(MAX_CUSTOM_MONTHLY_CENTS)}.`);
    cents = amount;
  }

  const live = await loadLiveSubscription(ctx);
  if (!live.ok) return live;
  const { sub, stripe, subscriptionId, purchase } = live;
  if (sub.status === "canceled" || sub.status === "incomplete_expired") {
    return fail(409, "That subscription is canceled, so there is no price to change.");
  }
  const item = subscriptionPlanItem(sub);
  const price = item && typeof item.price === "object" ? item.price : null;
  if (!item || !price) return fail(409, "This subscription's plan line could not be identified.");
  if (price.recurring?.interval !== "month" || (price.recurring?.interval_count ?? 1) !== 1) {
    return fail(409, "Change price applies to monthly subscriptions only.");
  }

  const before = price.unit_amount ?? null;
  const productId = idOf(price.product);
  if (!productId) return fail(409, "This subscription's plan line could not be identified.");

  let newItem: Stripe.SubscriptionUpdateParams.Item;
  let after: number | null;
  if (rateCard) {
    const tier = normalizeManagerSkuTier(purchase.tier);
    const paidTier = tier ? managerSkuToPaidTier(tier) : null;
    const rateCardPriceId = paidTier ? stripePriceIdForPaidTier(paidTier, "monthly") : undefined;
    if (!paidTier || !rateCardPriceId) return fail(409, "No rate-card price is configured for this plan.");
    try {
      await assertManagerPriceMatchesRateCard(stripe, rateCardPriceId, paidTier, "monthly");
      const rc = await stripe.prices.retrieve(rateCardPriceId);
      after = rc.unit_amount ?? null;
    } catch (e) {
      return stripeFailure("rate-card price read", e);
    }
    if (price.id === rateCardPriceId) return fail(409, "This subscription is already on the rate card.");
    newItem = { id: item.id, price: rateCardPriceId };
  } else {
    if (before === cents && sub.metadata?.[CUSTOM_PRICE_METADATA_KEY]) {
      return fail(409, `This subscription already bills ${dollars(cents)} a month.`);
    }
    after = cents;
    newItem = {
      id: item.id,
      price_data: {
        currency: price.currency,
        product: productId,
        recurring: { interval: "month", interval_count: 1 },
        unit_amount: cents,
        ...(price.tax_behavior && price.tax_behavior !== "unspecified" ? { tax_behavior: price.tax_behavior } : {}),
      },
    };
  }

  const entry: AdminBillingAuditEntry = { field: "monthlyPriceCents", before, after };
  if (!(await auditFirst(ctx, reason.reason, entry))) {
    return fail(500, "Could not record the audit entry, so nothing was changed.");
  }
  try {
    await stripe.subscriptions.update(subscriptionId, {
      items: [newItem],
      proration_behavior: "none",
      // Empty string unsets the key: the metadata says exactly whether a custom price is live.
      metadata: { [CUSTOM_PRICE_METADATA_KEY]: rateCard ? "" : String(cents) },
    });
  } catch (e) {
    await auditFailed(ctx, reason.reason, entry);
    return stripeFailure("price update", e);
  }
  await reconcileQuietly(subscriptionId, ctx.managerUserId);
  return { ok: true, monthlyCents: rateCard ? null : cents, rateCard, effective: "next_invoice" };
}

/* -------------------------------------------------------------------------- */
/* Refund                                                                      */
/* -------------------------------------------------------------------------- */

type RefundableInvoice = {
  invoiceId: string;
  chargeId: string;
  paidCents: number;
  refundableCents: number;
  currency: string;
};

/**
 * Re-derive, from Stripe alone, what can still be refunded on one invoice: it must be a PAID
 * subscription invoice of THIS account's Stripe customer, and the answer is the charge's remaining
 * amount (never the client's idea of it).
 */
async function readRefundableInvoice(
  stripe: Stripe,
  purchase: PurchaseRow,
  invoiceId: string,
): Promise<{ ok: true; invoice: RefundableInvoice } | MoneyActionFailure> {
  const customerIds = new Set<string>();
  const storedCustomer = trimmed(purchase.stripe_customer_id);
  if (storedCustomer) customerIds.add(storedCustomer);
  const subscriptionId = trimmed(purchase.stripe_subscription_id);
  if (subscriptionId) {
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const c = idOf(sub.customer);
    if (c) customerIds.add(c);
  }
  if (customerIds.size === 0) return fail(409, "No card subscription.");

  const invoice = await stripe.invoices.retrieve(invoiceId, { expand: ["payments"] });
  if (!customerIds.has(idOf(invoice.customer))) return fail(404, "That invoice does not belong to this account.");
  if (invoice.status !== "paid" || (invoice.amount_paid ?? 0) <= 0) return fail(409, "Only a paid invoice can be refunded.");
  if (invoice.parent?.type !== "subscription_details") return fail(409, "Only subscription invoices can be refunded here.");

  let chargeId = "";
  for (const row of invoice.payments?.data ?? []) {
    if (row.status !== "paid") continue;
    const payment = row.payment as { charge?: unknown; payment_intent?: unknown } | null | undefined;
    const direct = idOf(payment?.charge);
    if (direct) {
      chargeId = direct;
      break;
    }
    const intentId = idOf(payment?.payment_intent);
    if (intentId) {
      const intent = await stripe.paymentIntents.retrieve(intentId);
      const latest = idOf(intent.latest_charge);
      if (latest) {
        chargeId = latest;
        break;
      }
    }
  }
  if (!chargeId) return fail(409, "That invoice was not paid by card, so there is no charge to refund.");

  const charge = await stripe.charges.retrieve(chargeId);
  if (charge.disputed) return fail(409, "That charge is disputed and cannot be refunded.");
  if (!charge.paid) return fail(409, "That charge did not complete.");
  const paidCents = Math.min(charge.amount, invoice.amount_paid ?? 0);
  const refundableCents = Math.max(0, paidCents - (charge.amount_refunded ?? 0));
  return {
    ok: true,
    invoice: { invoiceId, chargeId, paidCents, refundableCents, currency: charge.currency },
  };
}

/**
 * Refund all or part of one paid subscription invoice. `amountCents` must be a whole number above 0
 * and no more than what Stripe says is still refundable on the invoice's charge (a second refund
 * cannot push the total past the invoice). The Stripe idempotency key is derived from invoice +
 * amount + the client's per-dialog nonce, so a double click replays one refund while a deliberate
 * second partial refund (new dialog, new nonce) is its own.
 */
export async function refundAccountInvoice(
  ctx: MoneyActionContext,
  input: { invoiceId: unknown; amountCents: unknown; nonce: unknown },
): Promise<MoneyActionResult<{ refundId: string; status: string; amountCents: number; remainingRefundableCents: number }>> {
  const reason = requireReason(ctx.reason);
  if (!reason.ok) return reason;
  const invoiceId = trimmed(input.invoiceId);
  if (!/^in_[A-Za-z0-9_]{6,}$/.test(invoiceId)) return fail(400, "Pick the invoice to refund.");
  const amount = input.amountCents;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
    return fail(400, "The refund amount must be more than $0.");
  }
  const nonce = trimmed(input.nonce);
  if (!NONCE_RE.test(nonce)) return fail(400, "Reload the dialog and try again.");

  const live = await loadLiveSubscriptionForRefund(ctx);
  if (!live.ok) return live;
  const { stripe, purchase } = live;

  let refundable: RefundableInvoice;
  try {
    const read = await readRefundableInvoice(stripe, purchase, invoiceId);
    if (!read.ok) return read;
    refundable = read.invoice;
  } catch (e) {
    return stripeFailure("invoice read", e);
  }
  if (amount > refundable.refundableCents) {
    return fail(
      409,
      refundable.refundableCents > 0
        ? `At most ${dollars(refundable.refundableCents)} is still refundable on that invoice.`
        : "That invoice has already been fully refunded.",
    );
  }

  const entry: AdminBillingAuditEntry = {
    field: `refund:${invoiceId}`,
    before: refundable.refundableCents,
    after: refundable.refundableCents - amount,
  };
  if (!(await auditFirst(ctx, reason.reason, entry))) {
    return fail(500, "Could not record the audit entry, so nothing was refunded.");
  }
  try {
    const refund = await stripe.refunds.create(
      {
        charge: refundable.chargeId,
        amount,
        reason: "requested_by_customer",
        metadata: { proplane_admin_refund: ctx.actorUserId, invoice: invoiceId, manager_user_id: ctx.managerUserId },
      },
      { idempotencyKey: `admin-refund:${invoiceId}:${amount}:${nonce}` },
    );
    invalidateManagerTierCache(ctx.managerUserId);
    return {
      ok: true,
      refundId: refund.id,
      status: refund.status ?? "pending",
      amountCents: amount,
      remainingRefundableCents: refundable.refundableCents - amount,
    };
  } catch (e) {
    await auditFailed(ctx, reason.reason, entry);
    return stripeFailure("refund", e);
  }
}

async function loadLiveSubscriptionForRefund(
  ctx: MoneyActionContext,
): Promise<{ ok: true; purchase: PurchaseRow; stripe: Stripe } | MoneyActionFailure> {
  const loaded = await loadPurchase(ctx.db, ctx.managerUserId);
  if (!loaded.ok) return loaded;
  const purchase = loaded.purchase;
  if (!purchase || (!trimmed(purchase.stripe_customer_id) && !trimmed(purchase.stripe_subscription_id))) {
    return fail(409, "No card subscription.");
  }
  const blocked = await assertStripeAllowed(ctx);
  if (blocked) return blocked;
  try {
    return { ok: true, purchase, stripe: getStripe() };
  } catch (e) {
    return stripeFailure("client", e);
  }
}

/* -------------------------------------------------------------------------- */
/* Cancel                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Cancel the account's Stripe subscription: `when: "period_end"` keeps access to the end of the
 * paid period (`cancel_at_period_end`), `"now"` ends it immediately with no proration and no final
 * invoice. The existing tier sync then applies (a canceled subscription resolves the account Free).
 */
export async function cancelAccountSubscription(
  ctx: MoneyActionContext,
  when: unknown,
): Promise<MoneyActionResult<{ when: "period_end" | "now"; endsAt: string | null }>> {
  const reason = requireReason(ctx.reason);
  if (!reason.ok) return reason;
  if (when !== "period_end" && when !== "now") return fail(400, "Choose when the subscription ends.");

  const live = await loadLiveSubscription(ctx);
  if (!live.ok) return live;
  const { sub, stripe, subscriptionId } = live;
  if (sub.status === "canceled" || sub.status === "incomplete_expired") {
    return fail(409, "That subscription is already canceled.");
  }
  if (when === "period_end" && sub.cancel_at_period_end) {
    return fail(409, "That subscription is already set to cancel at the end of the period.");
  }
  const periodEnd = sub.items?.data?.[0]?.current_period_end;
  const endsAt = typeof periodEnd === "number" ? new Date(periodEnd * 1000).toISOString() : null;

  const entry: AdminBillingAuditEntry = {
    field: "subscriptionCancel",
    before: sub.cancel_at_period_end ? "cancel_at_period_end" : sub.status,
    after: when,
  };
  if (!(await auditFirst(ctx, reason.reason, entry))) {
    return fail(500, "Could not record the audit entry, so nothing was changed.");
  }
  try {
    if (when === "now") {
      await stripe.subscriptions.cancel(subscriptionId, { prorate: false, invoice_now: false });
    } else {
      await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
    }
  } catch (e) {
    await auditFailed(ctx, reason.reason, entry);
    return stripeFailure("cancel", e);
  }
  await reconcileQuietly(subscriptionId, ctx.managerUserId);
  return { ok: true, when, endsAt: when === "now" ? new Date().toISOString() : endsAt };
}
