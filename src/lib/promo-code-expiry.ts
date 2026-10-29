import { isAdminManagedManagerPurchase } from "@/lib/manager-admin-purchase";
import { isAppleBilledManagerPurchase } from "@/lib/manager-apple-purchase";
import { isSignupTrialManagerPurchase } from "@/lib/manager-tier-expiry";

/**
 * Expiring payment-waiver codes (captain, Oct 28). Pure rules shared by the access resolver, the
 * redeem routes and the admin screens.
 *
 * A waiver grant is VOID (the account resolves to Free, like a lapsed trial, and the stored row is
 * never rewritten) when either:
 *   - the code has a policy (`manager_promo_code_policies`) whose `expires_at` is at or before now, or
 *   - the row's own `promo_ends_at` (set per account by staff) is at or before now.
 * Only a WAIVER-ONLY grant can be void: a row with a Stripe subscription, an Apple grant, an admin
 * assignment or a signup trial is paid or comped by something else.
 */

export const PROMO_CODE_EXPIRED_MESSAGE = "This code has expired.";
export const PROMO_CODE_UNREADABLE_MESSAGE = "We could not check that code. Try again in a moment.";

/** "Your FREE100 access ended. Choose a plan to keep going." */
export function promoGrantEndedMessage(code: string | null | undefined): string {
  const label = String(code ?? "").trim().toUpperCase() || "promo";
  return `Your ${label} access ended. Choose a plan to keep going.`;
}

/** The policy / row key for a code: uppercase letters and digits only (what redemption compares). */
export function promoPolicyKey(raw: string | null | undefined): string {
  return String(raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function instantMs(value: string | null | undefined): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** True when `endsAt` is a real instant at or before now. A missing or unparseable value never ends anything. */
export function promoInstantHasPassed(endsAt: string | null | undefined, nowMs: number = Date.now()): boolean {
  const ms = instantMs(endsAt);
  return ms !== null && ms <= nowMs;
}

/** The facts that make a purchase row a waiver-ONLY grant (nothing else is paying for it). */
export function isWaiverOnlyGrant(input: {
  promoCode: string | null | undefined;
  billing?: string | null | undefined;
  stripeSubscriptionId?: string | null | undefined;
  stripeCheckoutSessionId?: string | null | undefined;
  appleOriginalTransactionId?: string | null | undefined;
}): boolean {
  if (!promoPolicyKey(input.promoCode)) return false;
  if (String(input.stripeSubscriptionId ?? "").trim()) return false;
  if (isAppleBilledManagerPurchase(input.billing, input.appleOriginalTransactionId)) return false;
  if (String(input.billing ?? "").trim().toLowerCase() === "admin") return false;
  if (isAdminManagedManagerPurchase(input.stripeCheckoutSessionId)) return false;
  if (isSignupTrialManagerPurchase(input.billing)) return false;
  return true;
}

/**
 * Whether a waiver-only grant has ended. `policyExpiresAt` is the code's policy (null = none) and
 * `promoEndsAt` the row's own end. Both are optional: an unreadable policy or column is passed as
 * null by the caller, so a database blip never knocks an existing grant to Free.
 */
export function isWaiverGrantEnded(input: {
  policyExpiresAt?: string | null;
  promoEndsAt?: string | null;
  nowMs?: number;
}): boolean {
  const now = input.nowMs ?? Date.now();
  return promoInstantHasPassed(input.policyExpiresAt, now) || promoInstantHasPassed(input.promoEndsAt, now);
}
