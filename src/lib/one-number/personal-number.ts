/**
 * Number model (captain, Oct 18; Oct 28): every workspace texts on the set PropLane line. Only a Pro or
 * Business workspace whose plan is BILLABLE (a Stripe subscription or an Apple grant) may take a personalized
 * number of its own, or one that pays the $5 PropLane Number; a trial, a FREE100 waiver and an admin comp do
 * not (`managerPersonalNumberEntitlement`). PropLane's managed service uses the same default line as everyone
 * and has no exemption. The plan is read only through
 * `resolveEffectiveManagerSkuTier` (docs/agents/plan-entitlements.md); this module holds what a
 * refusal says and the tier rule.
 */

/**
 * A workspace without a paying plan stays on the PropLane line. The one message the number-request error slot
 * shows (captain, Oct 28): a Free plan, a signup trial, a payment-waiver (FREE100) grant and an admin comp all get it.
 */
export const PERSONAL_NUMBER_FREE_REFUSAL = {
  code: "personal_number_needs_paid_plan",
  error: "Your plan uses the PropLane line. A number of your own needs a paid plan or the $5 PropLane Number.",
} as const;

/**
 * Numbers provisioned BEFORE this instant stay entitled on their holder's existing Pro/Business plan even when
 * that plan is not billable (a waiver or comp grant), so the Oct 28 "paid plans only" rule never pauses or
 * releases a number that already exists. 2026-10-29 00:00 Pacific (PDT, UTC-7).
 */
export const PERSONAL_NUMBER_GRANDFATHER_BEFORE_MS = Date.parse("2026-10-29T00:00:00-07:00");

/** A manager_sms_numbers row, reduced to what the grandfather rule reads. */
export type GrandfatherNumberRow = {
  phone_number?: string | null;
  provision_state?: string | null;
  released_at?: string | null;
  provisioned_at?: string | null;
  requested_at?: string | null;
};

/**
 * True for a LIVE row that actually holds a number and was provisioned before the cutoff. A released row, a row with
 * no number yet (the signup placeholder), or one with no readable date is never grandfathered.
 */
export function isGrandfatheredNumberRow(row: GrandfatherNumberRow): boolean {
  if (row.released_at) return false;
  if (String(row.provision_state ?? "").trim().toLowerCase() === "released") return false;
  if (!String(row.phone_number ?? "").trim()) return false;
  const at = Date.parse(String(row.provisioned_at ?? row.requested_at ?? ""));
  return Number.isFinite(at) && at < PERSONAL_NUMBER_GRANDFATHER_BEFORE_MS;
}

/** The plan tiers that may hold a personalized number. */
export function planMayHavePersonalNumber(tier: "free" | "pro" | "business" | null | undefined): boolean {
  return tier === "pro" || tier === "business";
}
