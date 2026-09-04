"use client";

import { AuthCard } from "@/components/auth/auth-card";
import { AuthAccountFooterLink, AuthLegalConsent, AuthPageHeader } from "@/components/auth/auth-mobile-primitives";
import { ManagerPlanBillingToggle, ManagerPlanTierCards } from "@/components/auth/manager-plan-tier-cards";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { persistManagerPricingOffer, readManagerPricingOffer } from "@/lib/auth/manager-pricing-oauth-storage";
import { detectNativePlatformSync } from "@/lib/native/detect-native";
import { MANAGER_PLAN_TIERS, isPlanTierId, type ManagerPlanTierDefinition, type PlanTierId } from "@/data/manager-plan-tiers";
import { loadManagerPlanTiers } from "@/lib/site-content";
import { MANAGER_SUBSCRIPTION_TRIAL_DAYS } from "@/lib/stripe/subscription-checkout-session";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";

function tierById(tiers: ManagerPlanTierDefinition[], id: PlanTierId) {
  return tiers.find((t) => t.id === id) ?? tiers[0]!;
}

function defaultTier(): PlanTierId {
  return detectNativePlatformSync() ? "free" : "pro";
}

function ManagerPlanPickerInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { showToast } = useAppUi();

  const [billing, setBilling] = useState<"monthly" | "annual">("monthly");
  const [selectedTierId, setSelectedTierId] = useState<PlanTierId>(defaultTier);
  const [planTiers, setPlanTiers] = useState(MANAGER_PLAN_TIERS);

  const selected = useMemo(() => tierById(planTiers, selectedTierId), [planTiers, selectedTierId]);

  useEffect(() => {
    let cancelled = false;
    loadManagerPlanTiers()
      .then((tiers) => {
        if (!cancelled) setPlanTiers(tiers);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void Promise.resolve().then(() => {
      const stored = readManagerPricingOffer();
      const tier = searchParams.get("tier");
      if (tier && isPlanTierId(tier)) setSelectedTierId(tier);
      else if (stored?.tier) setSelectedTierId(stored.tier);
      const billingParam = searchParams.get("billing");
      if (billingParam === "monthly" || billingParam === "annual") setBilling(billingParam);
      else if (stored?.billing) setBilling(stored.billing);
    });
  }, [searchParams]);

  const continueToSignup = useCallback(() => {
    persistManagerPricingOffer({
      tier: selectedTierId,
      billing,
      returnSurface: "mobile-plan",
      trialSignup: true,
    });
    const params = new URLSearchParams({
      mode: "create",
      role: "manager",
      tier: selectedTierId,
      billing,
    });
    router.push(`/auth/create-account?${params.toString()}`);
  }, [billing, router, selectedTierId]);

  return (
    // `widest`, like the post-signup chooser: three plan cards inside 52rem
    // wrapped their feature copy every few words on a desktop browser. The two
    // plan surfaces must not disagree about how much room a comparison needs.
    <AuthCard widest>
      <div className="auth-plan-picker auth-plan-picker-wide">
        <AuthPageHeader
          eyebrow="Manager"
          title="Choose your plan"
          subtitle={`Pro and Business include a ${MANAGER_SUBSCRIPTION_TRIAL_DAYS}-day free trial · no card required`}
          accent={false}
        />

        <div className="mt-4 sm:mt-5">
          <ManagerPlanBillingToggle billing={billing} onChange={setBilling} />
        </div>

        <div className="auth-plan-tier-grid mt-4 sm:mt-5">
          <ManagerPlanTierCards
            tiers={planTiers}
            billing={billing}
            selectedTierId={selectedTierId}
            onSelectTier={setSelectedTierId}
          />
        </div>

        <p className="auth-plan-price-block mt-4 text-center text-xs text-muted sm:mt-5">
          {selectedTierId === "free"
            ? `${selected.label} · no card required`
            : `${selected.label} · ${MANAGER_SUBSCRIPTION_TRIAL_DAYS}-day free trial, then downgrades to Free`}
        </p>

        <div className="auth-plan-form-block mt-5 sm:mt-6">
          <Button
            type="button"
            data-attr="manager-plan-continue"
            className="btn-cobalt w-full rounded-full py-2.5 text-[15px] font-semibold"
            onClick={() => {
              try {
                continueToSignup();
              } catch {
                showToast("Could not continue. Try again.");
              }
            }}
          >
            Continue with {selected.label}
          </Button>
        </div>

        <AuthAccountFooterLink href="/auth/sign-in">Already have an account? Sign in</AuthAccountFooterLink>

        <AuthLegalConsent action="create" className="mt-4" />
      </div>
    </AuthCard>
  );
}

export function ManagerPlanPicker() {
  return (
    <Suspense
      fallback={
        <AuthCard>
          <p className="text-center text-sm text-muted">Loading…</p>
        </AuthCard>
      }
    >
      <ManagerPlanPickerInner />
    </Suspense>
  );
}
