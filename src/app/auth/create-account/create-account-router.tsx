"use client";

import { PortalAuthForm } from "@/components/auth/portal-auth-form";
import { ResidentSignupBlocked } from "@/components/auth/resident-signup-blocked";
import { ManagerTrialSignupForm } from "@/components/auth/manager-trial-signup-form";
import { AuthCard } from "@/components/auth/auth-card";
import type { PlanTierId } from "@/data/manager-plan-tiers";
import { useSearchParams } from "next/navigation";
import CreateAccountClient from "./create-account-client";

function parseManagerTier(raw: string | null): PlanTierId {
  if (raw === "pro" || raw === "business" || raw === "free") return raw;
  return "pro";
}

function parseBilling(raw: string | null): "monthly" | "annual" {
  return raw === "annual" ? "annual" : "monthly";
}

/**
 * Unified create-account surface.
 * Default path: role-agnostic account creation, then `/auth/get-started` for
 * resident / manager / vendor. Legacy `axis_id` links keep `ResidentSignupBlocked`
 * (emailed setup-token handoff). Manager checkout `session_id` uses CreateAccountClient.
 * Partner-pricing / marketing manager links (`role=manager&tier=…`) use
 * `ManagerTrialSignupForm` (phone + tier-aware manager-register).
 * Tour / message prospect handoffs use the same hub create form as generic signup.
 */
export default function CreateAccountRouter() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("session_id")?.trim() ?? "";
  const axisId = searchParams.get("axis_id")?.trim() ?? "";
  const role = searchParams.get("role")?.trim().toLowerCase() ?? "";
  const tierParam = searchParams.get("tier")?.trim() ?? "";
  const billingParam = searchParams.get("billing");
  const googleSignedIn = searchParams.get("google_signed_in") === "1";
  const accountReady = searchParams.get("account_ready") === "1";
  const emailFromUrl = searchParams.get("email")?.trim() ?? "";

  if (sessionId) {
    return <CreateAccountClient />;
  }

  if (axisId) {
    return (
      <AuthCard>
        <ResidentSignupBlocked />
      </AuthCard>
    );
  }

  if (
    role === "manager" &&
    (tierParam || googleSignedIn || accountReady)
  ) {
    return (
      <AuthCard>
        <ManagerTrialSignupForm
          tier={parseManagerTier(tierParam || null)}
          billing={parseBilling(billingParam)}
          initialEmail={emailFromUrl}
          googleReturn={googleSignedIn}
          accountReadyReturn={accountReady}
        />
      </AuthCard>
    );
  }

  return <PortalAuthForm mode="create" variant="hub" />;
}
