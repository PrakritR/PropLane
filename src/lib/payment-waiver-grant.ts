/**
 * What a payment-waiver code (FREE100) buys. Pure and client-safe: the three redeem paths
 * (`signup-intent`, `pricing-oauth-continue`, `update-tier`) and the pricing UI read this one rule.
 *
 * Captain, Oct 28: a waiver covers Pro, never Business. Asking for Business with a waiver code
 * switches the pick to Pro; Business requires paying. Free stays Free (a waiver never upgrades a
 * Free pick).
 */

export type WaiverGrantTier = "pro";

/** The one plan a payment-waiver code grants. */
export function waiverGrantTier(): WaiverGrantTier {
  return "pro";
}

/** The plan a waiver redemption writes for a requested pick: Free stays Free, anything paid is Pro. */
export function waiverTierForRequest(requested: "free" | "pro" | "business"): "free" | WaiverGrantTier {
  return requested === "free" ? "free" : waiverGrantTier();
}

/** Display name of a redeemed code for copy ("FREE100"). */
function codeLabel(code: string | null | undefined): string {
  const text = String(code ?? "").trim().toUpperCase();
  return text || "Your code";
}

/** The line shown after a redemption. "FREE100 covers Pro." when the pick was Business. */
export function waiverRedeemedMessage(
  requested: "free" | "pro" | "business",
  code: string | null | undefined,
): string {
  if (requested === "business") return `${codeLabel(code)} covers Pro. Your plan is Pro. No payment needed.`;
  return "Promo code applied. You're now on Pro. No payment needed.";
}
