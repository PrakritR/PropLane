import { handleOAuthCallback } from "@/lib/auth/oauth-callback-handler";
import { maybeNativeOAuthBridgeResponse } from "@/lib/auth/native-oauth-bridge";
import { ensureFreeManagerPortalAccess } from "@/lib/auth/manager-portal-provision";
import { resolveManagerPurchaseForPricing } from "@/lib/auth/manager-pricing-selection";
import { completeManagerSignupTrial, isManagerSignupTrialTier } from "@/lib/auth/manager-signup-trial";
import { MANAGER_PRICING_ENTRY_PATH } from "@/lib/auth/manager-pricing-entry-path";
import {
  clearPricingOfferCookie,
  readPricingOfferFromRequest,
} from "@/lib/auth/manager-pricing-oauth-storage";
import type { NextRequest } from "next/server";
import type { User } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

function oauthFullName(user: User): string | null {
  const meta = user.user_metadata;
  const fullName = typeof meta?.full_name === "string" ? meta.full_name.trim() : "";
  if (fullName) return fullName;
  const name = typeof meta?.name === "string" ? meta.name.trim() : "";
  return name || null;
}

async function finalizeTrialSignupOnCallback(
  db: SupabaseClient,
  user: User,
  tier: "free" | "pro" | "business",
): Promise<boolean> {
  const email = user.email?.trim().toLowerCase() ?? "";
  if (!email || !isManagerSignupTrialTier(tier)) return false;

  const purchase = await resolveManagerPurchaseForPricing(db, user.id, email);
  if (purchase.kind === "complete") return true;

  await completeManagerSignupTrial(db, {
    userId: user.id,
    email,
    fullName: oauthFullName(user),
    tier,
  });
  return true;
}

function createAccountPath(params: Record<string, string>): string {
  return `/auth/create-account?${new URLSearchParams({ mode: "create", role: "manager", ...params })}`;
}

/**
 * Fixed OAuth return path for partner pricing. Account setup still runs here, but
 * the return always lands back on the create-account screen: entering a portal is
 * an explicit click there, never an automatic bounce.
 */
export async function GET(request: NextRequest) {
  const bridge = maybeNativeOAuthBridgeResponse(request);
  if (bridge) return bridge;

  const offer = readPricingOfferFromRequest(request);

  const response = await handleOAuthCallback(request, `${MANAGER_PRICING_ENTRY_PATH}?google_signed_in=1`, {
    resolveRedirect: async (service, user) => {
      const tier = offer?.tier ?? "free";
      const billing = offer?.billing ?? "monthly";
      if (offer?.trialSignup) {
        if (isManagerSignupTrialTier(tier)) {
          try {
            const ready = await finalizeTrialSignupOnCallback(service, user, tier);
            if (ready) {
              return createAccountPath({ account_ready: "1", tier, billing });
            }
          } catch (error) {
            console.warn("Trial manager provision on partner-pricing callback failed:", error);
          }
        }
        return createAccountPath({ google_signed_in: "1", tier, billing });
      }
      if (tier === "free") {
        // The user explicitly chose the Free manager plan — provision so the account
        // is ready the moment they choose to open the portal.
        const provisioned = await ensureFreeManagerPortalAccess(service, user, {
          trialForNewManager: false,
        });
        if (provisioned.status !== "portal_ready") {
          console.warn("Free manager provisioning skipped on partner-pricing callback:", provisioned.reason);
          return createAccountPath({ tier, billing });
        }
        return createAccountPath({ account_ready: "1", tier, billing });
      }
      if (offer?.returnSurface === "mobile-plan") {
        return "/auth/manager/plan?google_signed_in=1";
      }
      // Paid plan chosen on the pricing page — return there and resume the offer in the
      // inline signup modal (account provisioning + embedded checkout).
      return "/partner/pricing?google_signed_in=1";
    },
  });

  clearPricingOfferCookie(response);
  return response;
}
