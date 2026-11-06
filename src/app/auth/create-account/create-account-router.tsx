"use client";

import { ResidentSignupBlocked } from "@/components/auth/resident-signup-blocked";
import { AuthCard } from "@/components/auth/auth-card";
import { EmailFirstSignup } from "@/components/auth/email-first-signup";
import { useSearchParams } from "next/navigation";

import { CreateAccountRoleGateway } from "./create-account-role-gateway";

/**
 * Unified create-account surface (PRP-193).
 * Special cases (checkout session, legacy axis_id) stay isolated; everything else
 * flows through CreateAccountRoleGateway so manager signup is always
 * ManagerTrialSignupForm + manager-register.
 */
export default function CreateAccountRouter() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("session_id")?.trim() ?? "";
  const axisId = searchParams.get("axis_id")?.trim() ?? "";

  if (sessionId) {
    return <AuthCard variant="blend"><EmailFirstSignup intent="manager_paid" checkoutSessionId={sessionId} /></AuthCard>;
  }

  if (axisId) {
    return (
      <AuthCard variant="blend">
        <ResidentSignupBlocked />
      </AuthCard>
    );
  }

  return <CreateAccountRoleGateway />;
}
