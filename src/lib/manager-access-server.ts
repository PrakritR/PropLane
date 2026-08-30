import "server-only";
import { cache } from "react";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { generateManagerId } from "@/lib/manager-id";
import {
  normalizeManagerSkuTier,
  pickBestManagerPurchaseRow,
  resolveEffectiveManagerSkuTier,
  resolveManagerSubscriptionTierFromPurchase,
  type ManagerSkuTier,
  type ManagerSubscriptionTier,
  type ManagerPurchaseRowRecord,
} from "@/lib/manager-access";
import { isAppleBilledManagerPurchase } from "@/lib/manager-apple-purchase";
import { loadManagerManualPaymentSettings } from "@/lib/manager-manual-payment-settings";
import { resolveServiceFeePayerFor, type ServiceFeePayer } from "@/lib/payment-policy";

/**
 * Server-only manager_purchases reads/writes (service role). Split out of
 * `manager-access.ts` so client components can import the pure tier helpers
 * there without pulling the service-role client (and `server-only`) into the
 * client bundle.
 */

/**
 * `readFailed` distinguishes "this account has no purchase row" from "we could
 * not find out". They look identical here — a PostgREST error yields zero rows
 * — but they mean opposite things to a quota: no row resolves to Free, while an
 * unknown plan must never be enforced AS Free (that refuses a paying Business
 * manager their sixth listing on a transient database error).
 */
async function loadManagerPurchaseRowsResult(
  userId: string,
): Promise<{ rows: ManagerPurchaseRowRecord[]; readFailed: boolean }> {
  const supabase = createSupabaseServiceRoleClient();
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("email")
    .eq("id", userId)
    .maybeSingle();
  const email = profile?.email?.trim().toLowerCase() ?? "";

  const select =
    "id, tier, billing, stripe_customer_id, stripe_subscription_id, stripe_checkout_session_id, promo_code, apple_original_transaction_id, paid_at, user_id";
  const [byUserId, byEmail] = await Promise.all([
    supabase.from("manager_purchases").select(select).eq("user_id", userId),
    email
      ? supabase.from("manager_purchases").select(select).ilike("email", email)
      : Promise.resolve({ data: [] as ManagerPurchaseRowRecord[], error: null }),
  ]);

  const merged = new Map<string, ManagerPurchaseRowRecord>();
  for (const row of [...(byUserId.data ?? []), ...(byEmail.data ?? [])]) {
    merged.set(String(row.id), row as ManagerPurchaseRowRecord);
  }
  return {
    rows: [...merged.values()],
    // A failed profiles read also counts: it blanks the email, which silently
    // drops the by-email half of the lookup rather than erroring.
    readFailed: Boolean(profileError) || Boolean(byUserId.error) || Boolean(byEmail.error),
  };
}

async function loadManagerPurchaseRowsForUser(userId: string): Promise<ManagerPurchaseRowRecord[]> {
  return (await loadManagerPurchaseRowsResult(userId)).rows;
}

const getManagerPurchaseRowByUserId = cache(async (userId: string): Promise<{
  tier: string | null;
  billing: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripeCheckoutSessionId: string | null;
  promoCode: string | null;
  appleOriginalTransactionId: string | null;
  paidAt: string | null;
  readFailed: boolean;
}> => {
  const { rows, readFailed } = await loadManagerPurchaseRowsResult(userId);
  const best = pickBestManagerPurchaseRow(rows, userId);
  if (!best) {
    return {
      tier: null,
      billing: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      stripeCheckoutSessionId: null,
      promoCode: null,
      appleOriginalTransactionId: null,
      paidAt: null,
      readFailed,
    };
  }
  return {
    readFailed,
    tier: best.tier != null ? String(best.tier) : null,
    billing: best.billing != null ? String(best.billing) : null,
    stripeCustomerId:
      best.stripe_customer_id != null && String(best.stripe_customer_id).trim() !== ""
        ? String(best.stripe_customer_id).trim()
        : null,
    stripeSubscriptionId:
      best.stripe_subscription_id != null && String(best.stripe_subscription_id).trim() !== ""
        ? String(best.stripe_subscription_id).trim()
        : null,
    stripeCheckoutSessionId:
      best.stripe_checkout_session_id != null && String(best.stripe_checkout_session_id).trim() !== ""
        ? String(best.stripe_checkout_session_id).trim()
        : null,
    promoCode:
      best.promo_code != null && String(best.promo_code).trim() !== ""
        ? String(best.promo_code).trim()
        : null,
    appleOriginalTransactionId:
      best.apple_original_transaction_id != null && String(best.apple_original_transaction_id).trim() !== ""
        ? String(best.apple_original_transaction_id).trim()
        : null,
    paidAt: best.paid_at != null ? String(best.paid_at) : null,
  };
});

/**
 * The single authoritative manager access tier, sourced from the manager's OWN
 * `manager_purchases` row — the SAME source and logic the Settings "Compare plans"
 * page uses via `/api/manager/subscription`. Every portal surface (sidebar brand
 * badge, sidebar feature-gating, page paywalls, reports) must resolve tier through
 * here so they can never disagree with Settings.
 *
 * Authorization + expiry are enforced at WRITE time by `syncManagerPurchaseTierState`
 * (revoke unauthorized self-assigned paid tiers, downgrade lapsed admin grants), which
 * runs first here exactly as the Settings route does. We then TRUST the committed SKU:
 * a pro/business row is paid, free is free, no row is legacy-unlimited. This mirrors
 * Settings' `subscriptionJson` so the two are consistent by construction — no separate
 * read-time downgrade that would show "Free" while Settings shows "Business".
 *
 * Returns "free" for the free tier, "paid" for pro/business, null when there is no
 * purchase row (legacy / unknown — treat as full access).
 */
const getManagerSubscriptionTierCached = cache(async (userId: string): Promise<ManagerSubscriptionTier> => {
  try {
    const { syncManagerPurchaseTierState } = await import("@/lib/manager-tier-sync");
    await syncManagerPurchaseTierState(userId);
    const rows = await loadManagerPurchaseRowsForUser(userId);
    if (rows.length === 0) return null;
    const purchase = await getManagerPurchaseRowByUserId(userId);
    const sku = normalizeManagerSkuTier(purchase.tier);
    if (sku === "free") return "free";
    if (sku === "pro" || sku === "business") return "paid";
    // Row exists but tier is missing/unrecognized — mirror Settings: Free unless a
    // live Stripe subscription backs it.
    return purchase.stripeSubscriptionId ? "paid" : "free";
  } catch {
    return null;
  }
});

export async function getManagerSubscriptionTier(userId: string): Promise<ManagerSubscriptionTier> {
  return getManagerSubscriptionTierCached(userId);
}

const getManagerPortalNavSubscriptionTierCached = cache(
  async (userId: string): Promise<ManagerSubscriptionTier> => {
    const ownTier = await getManagerSubscriptionTierCached(userId);
    try {
      const supabase = createSupabaseServiceRoleClient();
      const { data: ownedRow } = await supabase
        .from("manager_property_records")
        .select("id")
        .eq("manager_user_id", userId)
        .limit(1)
        .maybeSingle();
      const hasOwnedProperties = Boolean(ownedRow?.id);
      if (hasOwnedProperties) return ownTier;

      const { data: links } = await supabase
        .from("account_link_invites")
        .select("inviter_user_id")
        .eq("invitee_user_id", userId)
        .eq("status", "accepted");
      const inviterIds = [
        ...new Set(
          (links ?? [])
            .map((row) => String((row as { inviter_user_id?: string }).inviter_user_id ?? "").trim())
            .filter(Boolean),
        ),
      ];
      if (inviterIds.length === 0) return ownTier;

      const { pickManagerPortalNavSubscriptionTier } = await import("@/lib/manager-access");
      const linkedOwnerTiers = await Promise.all(
        inviterIds.map((inviterId) => getManagerSubscriptionTierCached(inviterId)),
      );
      return pickManagerPortalNavSubscriptionTier(ownTier, false, linkedOwnerTiers);
    } catch {
      return ownTier;
    }
  },
);

/** Plan tier used for manager sidebar locks and section paywalls (not billing UI). */
export async function getManagerPortalNavSubscriptionTier(
  userId: string,
): Promise<ManagerSubscriptionTier> {
  return getManagerPortalNavSubscriptionTierCached(userId);
}

const getManagerSubscriptionTierByManagerIdCached = cache(
  async (managerId: string): Promise<ManagerSubscriptionTier> => {
    const normalized = managerId.trim();
    if (!normalized) return null;
    try {
      const supabase = createSupabaseServiceRoleClient();
      const { data } = await supabase
        .from("manager_purchases")
        .select(
          "user_id, tier, billing, stripe_subscription_id, stripe_checkout_session_id, promo_code, apple_original_transaction_id, paid_at",
        )
        .eq("manager_id", normalized)
        .maybeSingle();
      if (!data) return null;
      const userId = data.user_id != null ? String(data.user_id) : "";
      if (userId) {
        return getManagerSubscriptionTier(userId);
      }
      return resolveManagerSubscriptionTierFromPurchase({
        tier: data.tier != null ? String(data.tier) : null,
        billing: data.billing != null ? String(data.billing) : null,
        stripeSubscriptionId: data.stripe_subscription_id ?? null,
        stripeCheckoutSessionId: data.stripe_checkout_session_id ?? null,
        promoCode: data.promo_code ?? null,
        appleOriginalTransactionId: data.apple_original_transaction_id ?? null,
        paidAt: data.paid_at ?? null,
        hasPurchaseRow: true,
      });
    } catch {
      return null;
    }
  },
);

export async function getManagerSubscriptionTierByManagerId(managerId: string): Promise<ManagerSubscriptionTier> {
  return getManagerSubscriptionTierByManagerIdCached(managerId);
}

/**
 * Who pays the resident-payment service fee for a manager. Keyed by `manager_id`
 * so a resident can resolve their OWN manager (their `profiles.manager_id`) for
 * pre-checkout disclosure. Falls back to "resident" on any failure — the safe
 * direction for disclosure, since it over-shows a possible fee rather than hiding
 * one (the checkout session is the authoritative amount either way).
 *
 * It runs the SAME `resolveServiceFeePayerFor` precedence the money paths use
 * (`createHouseholdChargeCheckout`, `createApplicationFeeCheckout`) — staff
 * override, then the property's Pricing setting, then the account default. Reading
 * only the account default here made the disclosure disagree with the charge: a
 * resident could be shown one payer and then billed under another. Pass
 * `propertyChoice` wherever the property is known; the account-wide disclosure has
 * no property in hand, so it resolves without one.
 */
export async function getManagerServiceFeePayerByManagerId(
  managerId: string,
  options: { propertyChoice?: ServiceFeePayer | null } = {},
): Promise<ServiceFeePayer> {
  const normalized = managerId.trim();
  if (!normalized) return "resident";
  try {
    const supabase = createSupabaseServiceRoleClient();
    const { data } = await supabase
      .from("manager_purchases")
      .select("user_id, tier")
      .eq("manager_id", normalized)
      .maybeSingle();
    if (!data) return "resident";
    const tier = normalizeManagerSkuTier(data.tier != null ? String(data.tier) : null) ?? "free";
    const userId = data.user_id != null ? String(data.user_id).trim() : "";
    const settings = userId ? await loadManagerManualPaymentSettings(supabase, userId) : null;
    return resolveServiceFeePayerFor({
      tier,
      adminOverride: settings?.adminServiceFeeOverride ?? null,
      propertyChoice: options.propertyChoice ?? null,
      managerChoice: settings?.serviceFeePayer ?? null,
    });
  } catch {
    return "resident";
  }
}

/**
 * Raw tier + billing from manager_purchases (service role).
 *
 * `readFailed` is carried out with the columns because a caller that DERIVES a
 * quota from `tier` cannot tell an absent plan from an unread one otherwise —
 * both arrive as `tier: null`, and that resolves to Free. Anything that only
 * wants a Stripe id can keep ignoring it.
 */
export async function getManagerPurchaseSku(userId: string): Promise<{
  tier: string | null;
  billing: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  appleOriginalTransactionId: string | null;
  readFailed: boolean;
}> {
  const row = await getManagerPurchaseRowByUserId(userId);
  return {
    tier: row.tier,
    billing: row.billing,
    stripeCustomerId: row.stripeCustomerId,
    stripeSubscriptionId: row.stripeSubscriptionId,
    appleOriginalTransactionId: row.appleOriginalTransactionId,
    readFailed: row.readFailed,
  };
}

/**
 * The plan this account is actually held to, resolved server-side from its own
 * `manager_purchases` row — never from anything a client sent. Same inputs and
 * same rule as the `isFree` the Settings plan page renders, so the enforced
 * plan and the displayed plan can never disagree.
 *
 * It returns a RESULT rather than a bare tier so an unreadable plan stays
 * distinguishable from "no committed SKU". Both produce zero purchase rows, and
 * zero rows resolves to Free — so collapsing them would enforce the harshest
 * plan on a transient database error, refusing a paying Business manager their
 * sixth listing with the Free copy. Callers must fail closed on `ok: false`,
 * exactly as the listing-slot count already does.
 */
export type ManagerEffectiveSkuTierResult =
  | { ok: true; tier: ManagerSkuTier | null }
  | { ok: false; error: string };

export async function getEffectiveManagerSkuTier(userId: string): Promise<ManagerEffectiveSkuTierResult> {
  const row = await getManagerPurchaseRowByUserId(userId);
  if (row.readFailed) return { ok: false, error: "Could not read this account's plan." };
  return {
    ok: true,
    tier: resolveEffectiveManagerSkuTier({
      tier: row.tier,
      stripeSubscriptionId: row.stripeSubscriptionId,
      appleManaged: isAppleBilledManagerPurchase(row.billing, row.appleOriginalTransactionId),
    }),
  };
}

/**
 * Sets `manager_purchases.tier` for the account (service role). Creates a row if needed (same rules as checkout completion).
 * Admin overrides use `billing: "admin"` and clear any stale Stripe subscription id.
 * Waiver grants (server-validated payment-waiver promo code) record `promo_code` so
 * tier-sync treats the paid tier as authorized comp access without a Stripe subscription.
 */
export async function setManagerPurchaseTier(
  userId: string,
  tier: ManagerSkuTier,
  opts?: { adminOverride?: boolean; waiver?: { promoCode: string; billing: "monthly" | "annual" } },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const waiver = tier !== "free" ? opts?.waiver : undefined;
  if (!opts?.adminOverride && !waiver && tier !== "free") {
    return { ok: false, error: "Paid plans require Stripe checkout or an admin assignment." };
  }

  const supabase = createSupabaseServiceRoleClient();
  const billing =
    tier === "free" ? "free" : opts?.adminOverride ? "admin" : waiver ? waiver.billing : "portal";
  const clearStripeSubscription = tier === "free" || opts?.adminOverride || Boolean(waiver) || billing === "portal";

  const { data: profile } = await supabase
    .from("profiles")
    .select("email, manager_id")
    .eq("id", userId)
    .maybeSingle();

  if (!profile?.email?.trim()) {
    return { ok: false, error: "Account email not found." };
  }

  const email = profile.email.trim().toLowerCase();
  const existingRows = await loadManagerPurchaseRowsForUser(userId);
  const updatePatch: Record<string, unknown> = {
    tier,
    billing,
    user_id: userId,
  };
  if (waiver) {
    updatePatch.promo_code = waiver.promoCode;
    updatePatch.paid_at = new Date().toISOString();
  }
  if (clearStripeSubscription) {
    updatePatch.stripe_subscription_id = null;
  }

  if (existingRows.length > 0) {
    for (const row of existingRows) {
      const { error } = await supabase.from("manager_purchases").update(updatePatch).eq("id", row.id);
      if (error) return { ok: false, error: error.message };
    }
    return { ok: true };
  }

  let managerId = profile.manager_id?.trim() ?? "";
  if (!managerId) {
    managerId = generateManagerId();
    const { error: profileErr } = await supabase
      .from("profiles")
      .update({ manager_id: managerId, updated_at: new Date().toISOString() })
      .eq("id", userId);
    if (profileErr) return { ok: false, error: profileErr.message };
  }

  const sessionId = waiver ? `axis_waiver_${tier}_${userId}` : `admin_portal_${tier}_${userId}`;
  const { error: insErr } = await supabase.from("manager_purchases").insert({
    stripe_checkout_session_id: sessionId,
    email,
    manager_id: managerId,
    tier,
    billing,
    user_id: userId,
    ...(waiver ? { promo_code: waiver.promoCode, paid_at: new Date().toISOString() } : {}),
  });

  if (insErr) {
    if (insErr.code === "23505") {
      const { error: upErr } = await supabase
        .from("manager_purchases")
        .update({ ...updatePatch, manager_id: managerId })
        .ilike("email", email);
      if (upErr) return { ok: false, error: upErr.message };
      return { ok: true };
    }
    return { ok: false, error: insErr.message };
  }

  return { ok: true };
}

/**
 * Sets this account to Business in `manager_purchases` (service role).
 * Used for self-serve upgrade from the property portal; billing is marked `portal` until live checkout is wired.
 */
export async function upgradeManagerAccountToBusiness(): Promise<
  { ok: true; alreadyBusiness?: boolean } | { ok: false; error: string }
> {
  return { ok: false, error: "Business upgrades require Stripe checkout or an admin assignment." };
}
