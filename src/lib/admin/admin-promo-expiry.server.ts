import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { z } from "zod";
import { AdminInputError } from "@/lib/admin/admin-input-error";
import { loadWaiverPurchases } from "@/lib/admin/admin-promo-codes.server";
import { normalizeAdminAuditReason, writeAdminBillingAudit } from "@/lib/admin-billing-audit.server";
import { pacificEndOfDayMs } from "@/lib/pacific-time";
import { LISTING_PROCESSING_FEE_PROMO_CODE } from "@/lib/processing-coverage-codes.server";
import { clearPromoCodePolicyCache } from "@/lib/promo-code-policy.server";
import { promoPolicyKey } from "@/lib/promo-code-expiry";
import { BUILTIN_PAYMENT_WAIVER_CODE, getPaymentWaiverCode } from "@/lib/server-env";
import { getStripe } from "@/lib/stripe";
import { normalizePromoCodeInput } from "@/lib/stripe-promos";
import { assertTestWorkspaceProviderEffectAllowed } from "@/lib/test-workspaces/effects.server";

/**
 * Expire a promo code (captain, Oct 28): "be able to expire FREE100 or other promo codes so that the
 * manager has to pay."
 *
 *  - A PAYMENT-WAIVER code (FREE100 and the configured waiver code) is not a Stripe object. Expiring it
 *    upserts a row in `manager_promo_code_policies`; from `expires_at` the code no longer redeems and every
 *    waiver-only grant made with it resolves to Free (`waiverGrantEndedFor`). Rows are never rewritten.
 *  - A STRIPE promotion code is set inactive (nothing new redeems). With `endStripeDiscounts` the discount
 *    also comes off each active subscription that redeemed it, so the next invoice is full price.
 *
 * Every call needs a reason and writes its audit row BEFORE anything changes; a failed audit write refuses
 * the whole action. This module does no authorization; the admin route (`requireAdminRoute`) is the boundary.
 */

const MAX_FUTURE_MS = 5 * 365 * 24 * 60 * 60 * 1000;
const PAST_GRACE_MS = 60_000;

export const expirePromoCodeSchema = z.object({
  verb: z.literal("expire"),
  /** The code text ("FREE100", "FIRST20"). */
  code: z.string().trim().min(1, "Choose a code.").max(64),
  /** The Stripe promotion code id; present for a Stripe code, absent for a payment-waiver code. */
  id: z.string().regex(/^promo_[A-Za-z0-9]{6,64}$/, "Invalid promo code id.").optional(),
  /** "now", a YYYY-MM-DD Pacific date (the code stops at the end of that day), or an ISO instant. */
  expiresAt: z.string().trim().min(1, "Say when the code expires."),
  reason: z.unknown(),
  endStripeDiscounts: z.boolean().optional(),
});

export type ExpirePromoCodeInput = z.infer<typeof expirePromoCodeSchema>;

export type ExpirePromoCodeResult = {
  kind: "waiver" | "stripe";
  code: string;
  expiresAt: string;
  /** Distinct accounts that hold a grant made with this code (waiver) or redeemed it (Stripe). */
  accounts: number;
  auditRecorded: true;
  /** Stripe only: subscriptions whose discount came off, and how many could not be changed. */
  discountsEnded?: number;
  discountsFailed?: number;
};

/** The instant a request means: "now", a Pacific calendar date (end of that day) or an ISO instant. */
export function resolveExpiryInstant(raw: string, nowMs: number = Date.now()): number {
  const text = raw.trim();
  if (text.toLowerCase() === "now") return nowMs;
  let ms: number | null = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const end = pacificEndOfDayMs(text);
    ms = end === null ? null : end - 1000;
  } else {
    const parsed = Date.parse(text);
    ms = Number.isFinite(parsed) ? parsed : null;
  }
  if (ms === null) throw new AdminInputError("Pick Now or a calendar date.", 400);
  if (ms < nowMs - PAST_GRACE_MS) throw new AdminInputError("Pick Now or a date that has not passed.", 400);
  if (ms - nowMs > MAX_FUTURE_MS) throw new AdminInputError("That date is too far out.", 400);
  return Math.max(ms, nowMs);
}

function requireReason(raw: unknown): string {
  const reason = normalizeAdminAuditReason(raw);
  if (!reason) throw new AdminInputError("A reason is required.", 400);
  return reason;
}

/** The audit row comes first: if it cannot be written nothing changes. */
async function auditFirst(args: {
  db: SupabaseClient;
  actorUserId: string;
  reason: string;
  field: string;
  before: string | null;
  after: string;
}): Promise<void> {
  const result = await writeAdminBillingAudit({
    db: args.db,
    actorUserId: args.actorUserId,
    // The change is about a code, not one manager: the audit's account key is the staff member who made it.
    managerUserId: args.actorUserId,
    entries: [{ field: args.field, before: args.before, after: args.after }],
    reason: args.reason,
  });
  if (!result.ok) throw new AdminInputError("Could not record the audit entry, so nothing was changed. Try again.", 500);
}

function isWaiverCodeKey(key: string): boolean {
  const configured = getPaymentWaiverCode();
  return key === promoPolicyKey(BUILTIN_PAYMENT_WAIVER_CODE) || (configured !== null && key === promoPolicyKey(configured));
}

async function expireWaiverCode(
  deps: { db: SupabaseClient; actorUserId: string; nowMs: number },
  input: ExpirePromoCodeInput,
  reason: string,
): Promise<ExpirePromoCodeResult> {
  const key = promoPolicyKey(input.code);
  if (!key || key === promoPolicyKey(LISTING_PROCESSING_FEE_PROMO_CODE)) {
    throw new AdminInputError("That code cannot be expired here.", 400);
  }
  const purchases = await loadWaiverPurchases(deps.db).catch(() => {
    throw new AdminInputError("Could not read the accounts on that code. Try again.", 500);
  });
  const holders = new Set<string>();
  for (const row of purchases) {
    if (promoPolicyKey(row.promo_code) !== key) continue;
    const billing = (row.billing ?? "").trim().toLowerCase();
    if (billing === "admin" || (row.stripe_checkout_session_id ?? "").startsWith("admin_")) continue;
    holders.add(row.user_id || (row.email ?? "").trim().toLowerCase() || `row-${holders.size}`);
  }
  // Only a code that is in use, or is the configured waiver code, has anything to expire.
  if (!isWaiverCodeKey(key) && holders.size === 0) throw new AdminInputError("That code is not a payment-waiver code.", 404);

  const expiresMs = resolveExpiryInstant(input.expiresAt, deps.nowMs);
  const expiresIso = new Date(expiresMs).toISOString();

  const { data: existing, error: readError } = await deps.db
    .from("manager_promo_code_policies")
    .select("expires_at")
    .eq("code", key)
    .maybeSingle();
  if (readError) throw new AdminInputError("Could not read the code's current terms. Try again.", 500);

  await auditFirst({
    db: deps.db,
    actorUserId: deps.actorUserId,
    reason,
    field: `promoCodeExpiry:${key}`,
    before: (existing as { expires_at?: string | null } | null)?.expires_at ?? null,
    after: expiresIso,
  });

  const { error } = await deps.db.from("manager_promo_code_policies").upsert(
    {
      code: key,
      expires_at: expiresIso,
      reason,
      updated_by: deps.actorUserId,
      updated_at: new Date(deps.nowMs).toISOString(),
    },
    { onConflict: "code" },
  );
  if (error) {
    console.error("promo code expiry write failed", error);
    throw new AdminInputError("Could not save that change. Try again.", 500);
  }
  clearPromoCodePolicyCache();
  return { kind: "waiver", code: key, expiresAt: expiresIso, accounts: holders.size, auditRecorded: true };
}

type SubDiscountRef = { id: string; promotionCodeId: string | null };

function discountsOf(sub: Stripe.Subscription): SubDiscountRef[] {
  const out: SubDiscountRef[] = [];
  for (const d of sub.discounts ?? []) {
    if (typeof d === "string") continue;
    out.push({
      id: d.id,
      promotionCodeId: d.promotion_code ? (typeof d.promotion_code === "string" ? d.promotion_code : d.promotion_code.id) : null,
    });
  }
  return out;
}

/** Take the code's discount off one subscription, leaving every other discount alone. Idempotent per code and subscription. */
async function endDiscountOn(stripe: Stripe, subscriptionId: string, promotionCodeId: string): Promise<boolean> {
  const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["discounts"] });
  if (sub.status === "canceled" || sub.status === "incomplete_expired") return false;
  const all = discountsOf(sub);
  const mine = all.filter((d) => d.promotionCodeId === promotionCodeId);
  if (mine.length === 0) return false;
  const rest = all.filter((d) => d.promotionCodeId !== promotionCodeId).map((d) => ({ discount: d.id }));
  await stripe.subscriptions.update(
    subscriptionId,
    { discounts: rest.length > 0 ? rest : "" },
    { idempotencyKey: `expire-promo:${promotionCodeId}:${subscriptionId}` },
  );
  return true;
}

async function expireStripeCode(
  deps: { db: SupabaseClient; stripe: Stripe; actorUserId: string; nowMs: number },
  input: ExpirePromoCodeInput,
  reason: string,
): Promise<ExpirePromoCodeResult> {
  const id = input.id!;
  if (input.expiresAt.trim().toLowerCase() !== "now") {
    throw new AdminInputError("A Stripe code is turned off now; Stripe cannot schedule it.", 400);
  }
  let promo: Stripe.PromotionCode;
  try {
    promo = await deps.stripe.promotionCodes.retrieve(id);
  } catch (error) {
    if ((error as { code?: unknown })?.code === "resource_missing") throw new AdminInputError("That promo code no longer exists.", 404);
    throw error;
  }
  if (normalizePromoCodeInput(promo.code) !== normalizePromoCodeInput(input.code)) {
    throw new AdminInputError("That code does not match.", 400);
  }

  const nowIso = new Date(deps.nowMs).toISOString();
  await auditFirst({
    db: deps.db,
    actorUserId: deps.actorUserId,
    reason,
    field: `promoCodeExpiry:${promo.code}`,
    before: promo.active ? "active" : "inactive",
    after: input.endStripeDiscounts ? "inactive+discounts_ended" : "inactive",
  });

  await deps.stripe.promotionCodes.update(id, {
    active: false,
    metadata: { ...(promo.metadata ?? {}), proplane_expired_at: nowIso },
  });

  const result: ExpirePromoCodeResult = {
    kind: "stripe",
    code: promo.code,
    expiresAt: nowIso,
    accounts: promo.times_redeemed,
    auditRecorded: true,
  };
  if (!input.endStripeDiscounts) return result;

  // Subscribers found through the code Checkout recorded on their purchase row.
  const text = promo.code;
  const { data, error } = await deps.db
    .from("manager_purchases")
    .select("user_id, stripe_subscription_id")
    .in("stripe_promotion_code", [...new Set([text, text.toUpperCase()])])
    .not("stripe_subscription_id", "is", null);
  if (error) {
    console.error("promo expiry: subscriber read failed", error);
    throw new AdminInputError("The code is off, but we could not list its subscribers to end their discount. Try again.", 500);
  }
  let ended = 0;
  let failed = 0;
  const seen = new Set<string>();
  for (const row of (data ?? []) as Array<{ user_id: string | null; stripe_subscription_id: string | null }>) {
    const subId = String(row.stripe_subscription_id ?? "").trim();
    if (!subId || seen.has(subId)) continue;
    seen.add(subId);
    try {
      if (row.user_id) {
        // A durable test identity never reaches Stripe.
        await assertTestWorkspaceProviderEffectAllowed({
          userId: row.user_id,
          kind: "payment",
          summary: "Admin promo expiry refused for a test workspace.",
          db: deps.db,
        });
      }
      if (await endDiscountOn(deps.stripe, subId, promo.id)) ended += 1;
    } catch (e) {
      failed += 1;
      console.error("promo expiry: ending a subscription discount failed", e);
    }
  }
  return { ...result, discountsEnded: ended, discountsFailed: failed };
}

/** Entry point for the `expire` verb of `PATCH /api/admin/promo-codes`. */
export async function expirePromoCode(
  input: ExpirePromoCodeInput,
  deps: { db: SupabaseClient; actorUserId: string; stripe?: Stripe; nowMs?: number },
): Promise<ExpirePromoCodeResult> {
  const reason = requireReason(input.reason);
  const nowMs = deps.nowMs ?? Date.now();
  if (input.id) {
    return expireStripeCode({ db: deps.db, stripe: deps.stripe ?? getStripe(), actorUserId: deps.actorUserId, nowMs }, input, reason);
  }
  return expireWaiverCode({ db: deps.db, actorUserId: deps.actorUserId, nowMs }, input, reason);
}
