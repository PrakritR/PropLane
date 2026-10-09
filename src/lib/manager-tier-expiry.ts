import { MANAGER_SUBSCRIPTION_TRIAL_DAYS } from "@/lib/stripe/subscription-checkout-session";
import { normalizeManagerSkuTier, type ManagerSkuTier } from "@/lib/manager-access";

export type ManagerPurchaseExpiryInput = {
  tier: string | null | undefined;
  billing: string | null | undefined;
  paid_at?: string | null;
  stripe_subscription_id?: string | null;
};

export function isSignupTrialManagerPurchase(billing: string | null | undefined): boolean {
  return billing?.toLowerCase().trim() === "trial";
}

/** End of the current paid period for admin-assigned / non-Stripe purchases. */
export function managerPurchasePeriodEndMs(
  input: ManagerPurchaseExpiryInput,
  nowMs = Date.now(),
): number | null {
  void nowMs;
  const tier = normalizeManagerSkuTier(input.tier);
  if (!tier || tier === "free") return null;
  if (input.stripe_subscription_id?.trim()) return null;

  const billing = input.billing?.toLowerCase().trim();
  if (billing === "trial") {
    const paidAt = input.paid_at ? new Date(input.paid_at) : null;
    if (!paidAt || Number.isNaN(paidAt.getTime())) return null;
    const end = new Date(paidAt);
    end.setUTCDate(end.getUTCDate() + MANAGER_SUBSCRIPTION_TRIAL_DAYS);
    return end.getTime();
  }

  if (billing !== "monthly" && billing !== "annual") return null;

  const paidAt = input.paid_at ? new Date(input.paid_at) : null;
  if (!paidAt || Number.isNaN(paidAt.getTime())) return null;

  const end = new Date(paidAt);
  if (billing === "annual") {
    end.setUTCFullYear(end.getUTCFullYear() + 1);
  } else {
    end.setUTCMonth(end.getUTCMonth() + 1);
  }
  return end.getTime();
}

export function isManagerPurchasePeriodExpired(
  input: ManagerPurchaseExpiryInput,
  nowMs = Date.now(),
): boolean {
  const endMs = managerPurchasePeriodEndMs(input, nowMs);
  return endMs !== null && nowMs >= endMs;
}

/** Tier after applying date-based expiry (does not call Stripe). */
export function resolveEffectiveManagerTier(
  input: ManagerPurchaseExpiryInput,
  nowMs = Date.now(),
): ManagerSkuTier | null {
  const tier = normalizeManagerSkuTier(input.tier);
  if (!tier) return null;
  if (tier === "free") return "free";
  if (isManagerPurchasePeriodExpired(input, nowMs)) return "free";
  return tier;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The calendar day a signup trial ends, as the instant the resolver compares against:
 * the last second of that UTC day, so a trial set to end on Oct 15 is live all of Oct 15.
 */
export function signupTrialEndInstantMs(endsOn: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endsOn)) return null;
  const ms = Date.parse(`${endsOn}T23:59:59.000Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The `paid_at` that makes a no-card signup trial end at `endMs`.
 *
 * A signup trial has no stored end date — the resolver derives it as `paid_at` plus
 * `MANAGER_SUBSCRIPTION_TRIAL_DAYS` ({@link managerPurchasePeriodEndMs}) and every plan reader
 * (property cap, nav locks, comms allowance, the admin lists) goes through that one derivation.
 * So extending such a trial means moving the one value they all read; a separate "trial end"
 * field would be honoured by whichever reader remembered to consult it. This is the inverse of
 * that derivation, kept beside it so the two cannot drift.
 */
export function paidAtForSignupTrialEnd(endMs: number): string {
  return new Date(endMs - MANAGER_SUBSCRIPTION_TRIAL_DAYS * DAY_MS).toISOString();
}
