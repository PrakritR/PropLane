import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { COMPLIMENTARY_COUPON_ID } from "@/lib/admin/admin-billing-constants";
import {
  normalizeAdminAuditReason,
  writeAdminBillingAudit,
  type AdminBillingAuditEntry,
} from "@/lib/admin-billing-audit.server";
import { isAppleBilledManagerPurchase } from "@/lib/manager-apple-purchase";
import {
  loadManagerBillingOverrides,
  parsePromoCodeOverride,
  saveManagerBillingOverrides,
  type ManagerBillingOverrides,
} from "@/lib/manager-billing-overrides";
import { normalizeManagerSkuTier } from "@/lib/manager-access";
import { invalidateManagerTierCache } from "@/lib/manager-tier-sync-cache";
import {
  isSignupTrialManagerPurchase,
  managerPurchasePeriodEndMs,
  paidAtForSignupTrialEnd,
  signupTrialEndInstantMs,
} from "@/lib/manager-tier-expiry";
import { reconcileManagerPurchaseByStripeSubscriptionId } from "@/lib/manager-stripe-subscription-sync";
import { assertTestWorkspaceProviderEffectAllowed } from "@/lib/test-workspaces/effects.server";

/**
 * The three LIVE billing actions PropLane staff take on one manager account, each of which changes
 * what the account is actually billed or entitled to:
 *
 *  - {@link extendAccountTrial} moves the trial end the plan resolver reads.
 *  - {@link setAccountComplimentary} stops billing the account (and undoes that).
 *  - {@link applyAccountPromoCode} attaches an existing Stripe promotion code.
 *
 * These used to be "recorded only" switches; a control that does nothing is worse than none, so
 * each now acts through the one place that decides — the Stripe subscription when there is one,
 * the purchase row the plan resolver reads (`resolveEffectiveManagerSkuTier`) when there is not.
 *
 * Every action REQUIRES a reason (refused before any side effect) and writes exactly one
 * `audit_log` row (actor, field, before, after, reason) through `writeAdminBillingAudit`. This
 * module does no authorization of its own; the admin route that calls it is the boundary.
 */

export { COMPLIMENTARY_COUPON_ID };

/** Stripe refuses a trial end further than two years out. */
const MAX_TRIAL_AHEAD_MS = 2 * 365 * 24 * 60 * 60 * 1000;

export type BillingActionFailure = { ok: false; status: number; error: string };
export type BillingActionSuccess<T extends object = object> = { ok: true; auditRecorded: boolean } & T;
export type BillingActionResult<T extends object = object> = BillingActionSuccess<T> | BillingActionFailure;

type ActionContext = {
  db: SupabaseClient;
  actorUserId: string;
  managerUserId: string;
  reason: unknown;
};

type PurchaseRow = {
  id: string;
  tier: string | null;
  billing: string | null;
  paid_at: string | null;
  user_id: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  promo_code: string | null;
  apple_original_transaction_id: string | null;
};

const fail = (status: number, error: string): BillingActionFailure => ({ ok: false, status, error });
const trimmed = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** A reason is the part a future reader needs; without one nothing changes. */
function requireReason(raw: unknown): { ok: true; reason: string } | BillingActionFailure {
  const reason = normalizeAdminAuditReason(raw);
  return reason ? { ok: true, reason } : fail(400, "A reason is required.");
}

/**
 * The purchase row the plan resolver reads for this manager (most recent paid_at on their own
 * `user_id`). `null` is a real answer — an account that never reached pricing has no row — and is
 * kept distinct from a read failure, which must never be treated as "no purchase".
 */
async function loadPurchase(
  db: SupabaseClient,
  managerUserId: string,
): Promise<{ ok: true; purchase: PurchaseRow | null } | BillingActionFailure> {
  const { data, error } = await db
    .from("manager_purchases")
    .select(
      "id, tier, billing, paid_at, user_id, stripe_customer_id, stripe_subscription_id, promo_code, apple_original_transaction_id",
    )
    .eq("user_id", managerUserId);
  if (error) {
    console.error("admin billing action: purchase read failed", error);
    return fail(500, "Could not read this account's billing.");
  }
  const rows = ((data ?? []) as PurchaseRow[]).slice();
  rows.sort((a, b) => (Date.parse(b.paid_at ?? "") || 0) - (Date.parse(a.paid_at ?? "") || 0));
  return { ok: true, purchase: rows[0] ?? null };
}

async function updatePurchase(
  db: SupabaseClient,
  purchaseId: string,
  patch: Record<string, string | null>,
): Promise<BillingActionFailure | null> {
  const { error } = await db.from("manager_purchases").update(patch).eq("id", purchaseId);
  if (error) {
    console.error("admin billing action: purchase write failed", error);
    return fail(500, "Could not save that change.");
  }
  return null;
}

/** A dedicated test identity must never reach Stripe; the same boundary every provider call uses. */
async function assertStripeAllowed(ctx: ActionContext): Promise<BillingActionFailure | null> {
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

function stripeFailure(label: string, e: unknown): BillingActionFailure {
  // Stripe's message can name ids and request shape; it is logged, never returned.
  console.error(`admin billing action: Stripe ${label} failed`, e);
  return fail(502, "Stripe could not apply that change. Try again.");
}

async function audit(ctx: ActionContext, reason: string, entry: AdminBillingAuditEntry): Promise<boolean> {
  const result = await writeAdminBillingAudit({
    db: ctx.db,
    actorUserId: ctx.actorUserId,
    managerUserId: ctx.managerUserId,
    entries: [entry],
    reason,
  });
  if (!result.ok) console.error("admin billing action: audit row not written", entry.field);
  return result.ok;
}

type SubDiscount = { id: string; couponId: string | null; promotionCodeId: string | null };

function readDiscounts(sub: Stripe.Subscription): SubDiscount[] {
  const out: SubDiscount[] = [];
  for (const d of sub.discounts ?? []) {
    // An unexpanded entry is a bare id and says nothing about its coupon; callers expand.
    if (typeof d === "string") continue;
    const coupon = d.source?.coupon;
    out.push({
      id: d.id,
      couponId: coupon ? (typeof coupon === "string" ? coupon : coupon.id) : null,
      promotionCodeId: d.promotion_code
        ? typeof d.promotion_code === "string"
          ? d.promotion_code
          : d.promotion_code.id
        : null,
    });
  }
  return out;
}

/** Keep every discount already on the subscription; only the one named changes. */
const keep = (discounts: SubDiscount[]): Stripe.SubscriptionUpdateParams.Discount[] =>
  discounts.map((d) => ({ discount: d.id }));

/** Best-effort: the webhook would reconcile on its own, this just makes the row current now. */
async function reconcileQuietly(subscriptionId: string): Promise<void> {
  try {
    await reconcileManagerPurchaseByStripeSubscriptionId(subscriptionId);
  } catch (e) {
    console.error("admin billing action: reconcile failed", e);
  }
}

/* -------------------------------------------------------------------------- */
/* Extend trial                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Move an account's trial end to `trialEndsOn` (`YYYY-MM-DD`, in the future).
 *
 * With a Stripe subscription that sets the subscription's `trial_end` (Stripe also moves the
 * billing anchor; no proration). Without one — a trial signup that never entered a card — the
 * trial has no stored end: the resolver derives it from `paid_at`, so the date it actually reads
 * is what gets written ({@link paidAtForSignupTrialEnd}). Anything else has no trial to extend.
 */
export async function extendAccountTrial(
  ctx: ActionContext,
  trialEndsOn: unknown,
  nowMs = Date.now(),
): Promise<BillingActionResult<{ trialEndsAt: string; via: "stripe" | "account" }>> {
  const reason = requireReason(ctx.reason);
  if (!reason.ok) return reason;
  const endsOn = trimmed(trialEndsOn);
  const endMs = signupTrialEndInstantMs(endsOn);
  if (endMs === null || isoDate(endMs) !== endsOn) return fail(400, "Pick a calendar date for the trial end.");
  if (endMs <= nowMs) return fail(400, "The trial end must be in the future.");
  if (endMs - nowMs > MAX_TRIAL_AHEAD_MS) return fail(400, "The trial end can be at most two years out.");

  const loaded = await loadPurchase(ctx.db, ctx.managerUserId);
  if (!loaded.ok) return loaded;
  const purchase = loaded.purchase;
  const subscriptionId = trimmed(purchase?.stripe_subscription_id);

  let before: string | null;
  let via: "stripe" | "account";

  if (subscriptionId) {
    const blocked = await assertStripeAllowed(ctx);
    if (blocked) return blocked;
    try {
      const stripe = getStripe();
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      if (sub.status === "canceled" || sub.status === "incomplete_expired") {
        return fail(409, "That subscription is canceled, so there is no trial to extend.");
      }
      /* Only a subscription that is actually ON trial has a trial to move. Setting `trial_end` on a
         paying one makes Stripe stop billing it until that date — up to two years of free service
         from a button whose own refusal already promises "there is no trial to extend". */
      if (sub.status !== "trialing") {
        return fail(409, "That subscription is already billing, so there is no trial to extend.");
      }
      before = sub.trial_end ? isoDate(sub.trial_end * 1000) : null;
      await stripe.subscriptions.update(subscriptionId, {
        trial_end: Math.floor(endMs / 1000),
        proration_behavior: "none",
      });
    } catch (e) {
      return stripeFailure("trial_end update", e);
    }
    via = "stripe";
    await reconcileQuietly(subscriptionId);
  } else if (
    purchase &&
    isSignupTrialManagerPurchase(purchase.billing) &&
    normalizeManagerSkuTier(purchase.tier) !== null &&
    normalizeManagerSkuTier(purchase.tier) !== "free"
  ) {
    const currentEnd = managerPurchasePeriodEndMs({
      tier: purchase.tier,
      billing: purchase.billing,
      paid_at: purchase.paid_at,
      stripe_subscription_id: null,
    });
    before = currentEnd === null ? null : isoDate(currentEnd);
    const failed = await updatePurchase(ctx.db, purchase.id, { paid_at: paidAtForSignupTrialEnd(endMs) });
    if (failed) return failed;
    via = "account";
  } else {
    return fail(409, "This account has no trial to extend.");
  }

  // A date older builds merely recorded would now disagree with the one just made live.
  const overrides = await loadManagerBillingOverrides(ctx.db, ctx.managerUserId);
  if (overrides.ok && overrides.overrides.trialEndsAt !== null) {
    await saveManagerBillingOverrides(ctx.db, ctx.managerUserId, { ...overrides.overrides, trialEndsAt: null }).catch(
      (e) => console.error("admin billing action: legacy trial date not cleared", e),
    );
  }

  invalidateManagerTierCache(ctx.managerUserId);
  const auditRecorded = await audit(ctx, reason.reason, { field: "trialEndsAt", before, after: endsOn });
  return { ok: true, auditRecorded, trialEndsAt: endsOn, via };
}

/* -------------------------------------------------------------------------- */
/* Complimentary                                                               */
/* -------------------------------------------------------------------------- */

async function ensureComplimentaryCoupon(stripe: Stripe): Promise<void> {
  try {
    await stripe.coupons.retrieve(COMPLIMENTARY_COUPON_ID);
    return;
  } catch (e) {
    if ((e as { code?: string }).code !== "resource_missing") throw e;
  }
  await stripe.coupons.create({
    id: COMPLIMENTARY_COUPON_ID,
    name: "PropLane complimentary",
    percent_off: 100,
    duration: "forever",
    metadata: { proplane_complimentary: "1" },
  });
}

/**
 * Make an account complimentary (or take that back).
 *
 * With a Stripe subscription: a 100%-off-forever coupon is attached (so the next invoice is $0)
 * or detached; every other discount on it is left alone. Without one nothing bills, but access
 * can still lapse (a trial expires by date), so the purchase becomes an admin-assigned plan that
 * never expires, remembering how it looked so Undo can put it back. A free or Apple-billed
 * account has nothing to comp and is refused.
 */
export async function setAccountComplimentary(
  ctx: ActionContext,
  on: unknown,
): Promise<BillingActionResult<{ complimentary: boolean; changed: boolean }>> {
  const reason = requireReason(ctx.reason);
  if (!reason.ok) return reason;
  if (typeof on !== "boolean") return fail(400, "complimentary must be true or false.");

  const [loaded, overridesRead] = await Promise.all([
    loadPurchase(ctx.db, ctx.managerUserId),
    loadManagerBillingOverrides(ctx.db, ctx.managerUserId),
  ]);
  if (!loaded.ok) return loaded;
  // Refuse rather than write over a settings blob we could not read: its siblings are other settings.
  if (!overridesRead.ok) return fail(500, "Could not read this account's billing.");
  const purchase = loaded.purchase;
  const overrides: ManagerBillingOverrides = { ...overridesRead.overrides };
  const subscriptionId = trimmed(purchase?.stripe_subscription_id);

  let before: boolean;

  if (subscriptionId) {
    const blocked = await assertStripeAllowed(ctx);
    if (blocked) return blocked;
    try {
      const stripe = getStripe();
      const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["discounts"] });
      const discounts = readDiscounts(sub);
      const comp = discounts.find((d) => d.couponId === COMPLIMENTARY_COUPON_ID);
      before = Boolean(comp);
      if (on && !comp) {
        await ensureComplimentaryCoupon(stripe);
        await stripe.subscriptions.update(subscriptionId, {
          discounts: [...keep(discounts), { coupon: COMPLIMENTARY_COUPON_ID }],
        });
      } else if (!on && comp) {
        const rest = keep(discounts.filter((d) => d !== comp));
        // An empty list is how Stripe is told to drop the last discount.
        await stripe.subscriptions.update(subscriptionId, { discounts: rest.length > 0 ? rest : "" });
      }
    } catch (e) {
      return stripeFailure("complimentary update", e);
    }
    await reconcileQuietly(subscriptionId);
  } else {
    before = overrides.complimentary;
    if (on && !before) {
      const tier = normalizeManagerSkuTier(purchase?.tier);
      if (!purchase || !tier || tier === "free") {
        return fail(409, "Choose a paid plan before making this account complimentary.");
      }
      if (isAppleBilledManagerPurchase(purchase.billing, purchase.apple_original_transaction_id)) {
        return fail(409, "This account is billed by the App Store, which PropLane cannot waive.");
      }
      if (trimmed(purchase.billing).toLowerCase() !== "admin") {
        overrides.complimentaryPrior = { billing: trimmed(purchase.billing).toLowerCase(), paidAt: purchase.paid_at };
        const failed = await updatePurchase(ctx.db, purchase.id, { billing: "admin" });
        if (failed) return failed;
      }
    } else if (!on && before) {
      const prior = overrides.complimentaryPrior;
      // Only undo our own conversion: a plan staff have since reassigned stays as they left it.
      if (purchase && prior && trimmed(purchase.billing).toLowerCase() === "admin") {
        const failed = await updatePurchase(ctx.db, purchase.id, {
          billing: prior.billing,
          ...(prior.paidAt ? { paid_at: prior.paidAt } : {}),
        });
        if (failed) return failed;
      }
      overrides.complimentaryPrior = null;
    }
  }

  const changed = before !== on;
  overrides.complimentary = on;
  if (!on) overrides.complimentaryPrior = null;
  try {
    await saveManagerBillingOverrides(ctx.db, ctx.managerUserId, overrides);
  } catch (e) {
    console.error("admin billing action: complimentary record not saved", e);
    return fail(500, "The change was applied but could not be recorded. Reload and check the account.");
  }
  invalidateManagerTierCache(ctx.managerUserId);
  if (!changed) return { ok: true, auditRecorded: true, complimentary: on, changed: false };
  const auditRecorded = await audit(ctx, reason.reason, { field: "complimentary", before, after: on });
  return { ok: true, auditRecorded, complimentary: on, changed: true };
}

/* -------------------------------------------------------------------------- */
/* Promo code                                                                  */
/* -------------------------------------------------------------------------- */



async function promoCodesOn(stripe: Stripe, discounts: SubDiscount[]): Promise<string[]> {
  const codes: string[] = [];
  for (const d of discounts) {
    if (!d.promotionCodeId) continue;
    try {
      codes.push((await stripe.promotionCodes.retrieve(d.promotionCodeId)).code);
    } catch {
      // A promotion code we cannot name still counts as one: the audit row says so.
      codes.push(d.promotionCodeId);
    }
  }
  return codes;
}

/**
 * Attach an EXISTING Stripe promotion code to the account's subscription. Creating codes is the
 * Promo codes page; this never makes one. Needs a Stripe subscription — an Apple or admin plan has
 * no invoice for a code to discount.
 */
export async function applyAccountPromoCode(
  ctx: ActionContext,
  code: unknown,
): Promise<BillingActionResult<{ promoCode: string }>> {
  const reason = requireReason(ctx.reason);
  if (!reason.ok) return reason;
  const parsed = parsePromoCodeOverride(code);
  if (!parsed.ok) return fail(400, parsed.error);
  const clean = parsed.value;

  const loaded = await loadPurchase(ctx.db, ctx.managerUserId);
  if (!loaded.ok) return loaded;
  const subscriptionId = trimmed(loaded.purchase?.stripe_subscription_id);
  if (!subscriptionId) return fail(409, "Promo codes apply to a Stripe subscription, and this account has none.");

  const blocked = await assertStripeAllowed(ctx);
  if (blocked) return blocked;

  let before: string | null;
  let applied: string;
  try {
    const stripe = getStripe();
    const found = await stripe.promotionCodes.list({ code: clean, active: true, limit: 1 });
    const promotion = found.data[0];
    if (!promotion) return fail(404, `No active promotion code named ${clean.toUpperCase()}.`);
    const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["discounts"] });
    const discounts = readDiscounts(sub);
    if (discounts.some((d) => d.promotionCodeId === promotion.id)) {
      return fail(409, `${promotion.code} is already applied to this subscription.`);
    }
    const existing = await promoCodesOn(stripe, discounts);
    before = existing.length > 0 ? existing.join(", ") : null;
    applied = promotion.code;
    await stripe.subscriptions.update(subscriptionId, {
      discounts: [...keep(discounts), { promotion_code: promotion.id }],
    });
  } catch (e) {
    return stripeFailure("promotion code attach", e);
  }
  await reconcileQuietly(subscriptionId);
  invalidateManagerTierCache(ctx.managerUserId);
  const auditRecorded = await audit(ctx, reason.reason, { field: "promoCode", before, after: applied });
  return { ok: true, auditRecorded, promoCode: applied };
}
