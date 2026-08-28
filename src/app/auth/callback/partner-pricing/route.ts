import { handleOAuthCallback } from "@/lib/auth/oauth-callback-handler";
import { maybeNativeOAuthBridgeResponse } from "@/lib/auth/native-oauth-bridge";
import { ensureFreeManagerPortalAccess } from "@/lib/auth/manager-portal-provision";
import { MANAGER_PRICING_ENTRY_PATH } from "@/lib/auth/manager-pricing-entry-path";
import {
  clearPricingOfferCookie,
  readPricingOfferFromRequest,
} from "@/lib/auth/manager-pricing-oauth-storage";
import type { NextRequest } from "next/server";

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
