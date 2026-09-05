import { after } from "next/server";
import { completeFreeManagerTierForUser } from "@/lib/auth/manager-pricing-selection";
import { finalizePendingManagerFreeTier } from "@/lib/auth/manager-onboarding";
import { markGoogleServicesOnboardingPending } from "@/lib/auth/manager-google-services-onboarding.server";
import { maybeSendManagerPropLaneAssistantIntro } from "@/lib/claw-onboarding-sms.server";
import type { SupabaseClient } from "@supabase/supabase-js";

type Tier = "free" | "pro" | "business";

export function isManagerSignupTrialTier(tier: string | null | undefined): tier is Tier {
  return tier === "free" || tier === "pro" || tier === "business";
}

/** Grants the chosen plan: Free immediately, paid tiers get a 14-day trial (no card). */
export async function completeManagerSignupTrial(
  supabase: SupabaseClient,
  opts: {
    userId: string;
    email: string;
    fullName?: string | null;
    tier: Tier;
  },
): Promise<{ managerId: string }> {
  let managerId: string;
  if (opts.tier === "free") {
    ({ managerId } = await completeFreeManagerTierForUser(supabase, {
      userId: opts.userId,
      email: opts.email,
      fullName: opts.fullName,
      tier: "free",
      billing: "free",
    }));
  } else {
    ({ managerId } = await finalizePendingManagerFreeTier(supabase, {
      userId: opts.userId,
      email: opts.email,
      fullName: opts.fullName,
      tier: opts.tier,
      billing: "trial",
    }));
  }

  // Best-effort PropLane intro. Messaging uses the manager's own registered number.
  const run = async () => {
    await maybeSendManagerPropLaneAssistantIntro(supabase, opts.userId).catch(() => undefined);
  };
  try {
    after(() => void run());
  } catch {
    void run();
  }

  await markGoogleServicesOnboardingPending(supabase, opts.userId).catch(() => undefined);

  return { managerId };
}
