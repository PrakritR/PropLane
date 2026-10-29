import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isGrandfatheredNumberRow, planMayHavePersonalNumber, type GrandfatherNumberRow } from "@/lib/one-number/personal-number";

/**
 * Who may hold a personalized work number (number model, captain Oct 18; tightened Oct 28). A manager does when they
 * pay for it, one of two ways: a BILLABLE Pro or Business plan (a Stripe subscription or an Apple grant), or the
 * standalone PropLane Number subscription ($5/month, `numberServiceEntitled`: active or past_due), which a Free
 * manager can buy alone with every other Pro feature staying locked.
 *
 * NOT entitled by plan, though every other Pro/Business feature works: a live signup trial, a payment-waiver
 * (FREE100) grant and an admin comp / portal grant. They keep the shared PropLane line. The plan is read only through
 * `getEffectiveManagerSkuTier` (`resolveEffectiveManagerSkuTier`), whose `billablePlan` says whether money backs it.
 *
 * Grandfather (`via: "grandfathered"`): an owner on a Pro/Business plan that is not billable who ALREADY holds a live
 * number provisioned before 2026-10-29 stays entitled for that number, so this rule never pauses or releases an
 * existing line. It never entitles a NEW number (`provisionNumberForWorkspace` caps it at the numbers held).
 */
export type PersonalNumberEntitlement =
  | { ok: true; entitled: true; via: "plan" | "add_on" | "grandfathered"; tier: "free" | "pro" | "business" | null }
  | { ok: true; entitled: false; tier: "free" | "pro" | "business" | null }
  | { ok: false };

/**
 * True when the owner holds a live, pre-cutoff number. A failed read throws, so the caller answers `ok: false`
 * (never "not entitled" off a database blip, and never "entitled" off one either).
 */
async function holdsGrandfatheredNumber(db: SupabaseClient, managerUserId: string): Promise<boolean> {
  const { data, error } = await db
    .from("manager_sms_numbers")
    .select("phone_number, provision_state, released_at, provisioned_at, requested_at")
    .eq("manager_user_id", managerUserId)
    .is("released_at", null);
  if (error) throw new Error(`grandfather read failed: ${error.message}`);
  return ((data ?? []) as GrandfatherNumberRow[]).some((row) => isGrandfatheredNumberRow(row));
}

export async function managerPersonalNumberEntitlement(db: SupabaseClient, managerUserId: string): Promise<PersonalNumberEntitlement> {
  const id = managerUserId.trim();
  if (!id) return { ok: true, entitled: false, tier: null };
  try {
    const { getEffectiveManagerSkuTier } = await import("@/lib/manager-access-server");
    const plan = await getEffectiveManagerSkuTier(id);
    if (!plan.ok) return { ok: false };
    const tier = plan.tier ?? null;
    const planIncludesNumber = planMayHavePersonalNumber(tier) && !plan.liveSignupTrial;
    if (planIncludesNumber && plan.billablePlan === true) return { ok: true, entitled: true, via: "plan", tier };
    // A paid-tier plan that nothing bills (waiver / comp): only a number that already exists is kept.
    if (planIncludesNumber && (await holdsGrandfatheredNumber(db, id))) {
      return { ok: true, entitled: true, via: "grandfathered", tier };
    }
    const { numberServiceEntitled } = await import("@/lib/number-subscription/subscription.server");
    if (await numberServiceEntitled(id, db)) return { ok: true, entitled: true, via: "add_on", tier };
    return { ok: true, entitled: false, tier };
  } catch {
    return { ok: false };
  }
}
