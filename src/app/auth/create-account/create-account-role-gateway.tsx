"use client";

import { useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthCard } from "@/components/auth/auth-card";
import { AuthAccountFooterLink, AuthPageHeader, AuthRoleStack } from "@/components/auth/auth-mobile-primitives";
import { PortalAuthForm } from "@/components/auth/portal-auth-form";
import { ManagerTrialSignupForm } from "@/components/auth/manager-trial-signup-form";
import { useAuthWelcomeChrome } from "@/components/auth/use-auth-welcome-chrome";
import type { PlanTierId } from "@/data/manager-plan-tiers";
import { AUTH_PORTAL_PICKER_OPTIONS } from "@/lib/auth/auth-portal-picker-options";

function parseManagerTier(raw: string | null): PlanTierId {
  if (raw === "pro" || raw === "business" || raw === "free") return raw;
  return "pro";
}

function parseBilling(raw: string | null): "monthly" | "annual" {
  return raw === "annual" ? "annual" : "monthly";
}

function isCreateRoleParam(role: string): role is "manager" | "resident" | "vendor" {
  return role === "manager" || role === "resident" || role === "vendor";
}

/**
 * PRP-193 — one manager signup surface: every path that creates a manager account
 * lands on ManagerTrialSignupForm + `/api/auth/manager-register`, not the hub
 * signup route that deferred role and trial state to get-started.
 */
export function CreateAccountRoleGateway() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const role = searchParams.get("role")?.trim().toLowerCase() ?? "";
  const tierParam = searchParams.get("tier")?.trim() ?? "";
  const billingParam = searchParams.get("billing");
  const googleSignedIn = searchParams.get("google_signed_in") === "1";
  const accountReady = searchParams.get("account_ready") === "1";
  const emailFromUrl = searchParams.get("email")?.trim() ?? "";

  useAuthWelcomeChrome(true);

  const pickerOptions = useMemo(
    () =>
      AUTH_PORTAL_PICKER_OPTIONS.map((opt) => ({
        id: opt.id,
        label: opt.label,
        hint: opt.hint,
        icon: opt.icon,
        tone: opt.tone,
      })),
    [],
  );

  if (role === "manager") {
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

  if (isCreateRoleParam(role)) {
    return <PortalAuthForm mode="create" variant="hub" />;
  }

  const selectRole = (nextRole: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("role", nextRole);
    if (nextRole === "manager" && !params.get("tier")) {
      params.set("tier", "pro");
    }
    router.replace(`/auth/create-account?${params.toString()}`);
  };

  return (
    <AuthCard>
      <AuthPageHeader
        title="Create your account"
        subtitle="Choose how you will use PropLane — you can add another role later."
      />
      <AuthRoleStack options={pickerOptions} onSelect={selectRole} />
      <AuthAccountFooterLink
        prompt="Already have an account?"
        href="/auth/sign-in"
        label="Sign in"
      />
    </AuthCard>
  );
}
