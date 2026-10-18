import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { planMayHavePersonalNumber } from "@/lib/one-number/personal-number";

/**
 * Who may hold a personalized work number (number model, captain Oct 18). A manager does when they
 * pay for it, one of two ways: a Pro or Business plan (which includes it), or the standalone PropLane
 * Number subscription ($5/month, `numberServiceEntitled`: active or past_due), which a Free manager
 * can buy alone with every other Pro feature staying locked. A live signup trial is not paid. The plan
 * is read only through `getEffectiveManagerSkuTier` (`resolveEffectiveManagerSkuTier`).
 */
export type PersonalNumberEntitlement =
  | { ok: true; entitled: true; via: "plan" | "add_on"; tier: "free" | "pro" | "business" | null }
  | { ok: true; entitled: false; tier: "free" | "pro" | "business" | null }
  | { ok: false };

export async function managerPersonalNumberEntitlement(db: SupabaseClient, managerUserId: string): Promise<PersonalNumberEntitlement> {
  const id = managerUserId.trim();
  if (!id) return { ok: true, entitled: false, tier: null };
  try {
    const { getEffectiveManagerSkuTier } = await import("@/lib/manager-access-server");
    const plan = await getEffectiveManagerSkuTier(id);
    if (!plan.ok) return { ok: false };
    const tier = plan.tier ?? null;
    if (planMayHavePersonalNumber(tier) && !plan.liveSignupTrial) return { ok: true, entitled: true, via: "plan", tier };
    const { numberServiceEntitled } = await import("@/lib/number-subscription/subscription.server");
    if (await numberServiceEntitled(id, db)) return { ok: true, entitled: true, via: "add_on", tier };
    return { ok: true, entitled: false, tier };
  } catch {
    return { ok: false };
  }
}
