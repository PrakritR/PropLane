"use client";

import { PublicPageAuthFooter } from "@/components/marketing/public-page-auth-footer";
import { MarketingPageShell } from "@/components/marketing/marketing-page-shell";
import { useIsNativeApp } from "@/hooks/use-is-native-app";
import { persistManagerPricingOffer, readManagerPricingOffer } from "@/lib/auth/manager-pricing-oauth-storage";
import { MANAGER_PLAN_TIERS, isPlanTierId, type ManagerPlanTierDefinition, type PlanTierId } from "@/data/manager-plan-tiers";
import { loadManagerPlanTiers } from "@/lib/site-content";
import { annualDiscountPercent } from "@/lib/billing/rate-card";

/** Pro and Business round to the same annual discount off the rate card; either name works here. */
const ANNUAL_DISCOUNT_PERCENT = annualDiscountPercent("pro");
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import "@/components/marketing/landing-proplane.css";

function createAccountPath(tier: PlanTierId, billing: "monthly" | "annual", extra?: Record<string, string>) {
  const params = new URLSearchParams({
    mode: "create",
    role: "manager",
    tier,
    billing,
    ...extra,
  });
  return `/auth/create-account?${params.toString()}`;
}

/**
 * Manager plan picker — used at /partner/pricing (OAuth returns & deep links).
 * Choosing a plan opens create-account with the tier pre-selected.
 */
export function ManagerStartPage() {
  const router = useRouter();
  const { isNative } = useIsNativeApp();

  const [billing, setBilling] = useState<"monthly" | "annual">("monthly");
  const [planTiers, setPlanTiers] = useState<ManagerPlanTierDefinition[]>(MANAGER_PLAN_TIERS);

  useEffect(() => {
    if (isNative !== true) return;
    router.replace("/auth/create-account?mode=create&role=manager");
  }, [isNative, router]);

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
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const b = params.get("billing");
    if (b === "monthly" || b === "annual") setBilling(b);

    if (params.get("google_signed_in") === "1" || params.get("google_checkout") === "1") {
      const stored = readManagerPricingOffer();
      const tierParam = params.get("tier");
      const tier = stored?.tier ?? (tierParam && isPlanTierId(tierParam) ? tierParam : "pro");
      const bill = stored?.billing ?? (b === "annual" ? "annual" : "monthly");
      router.replace(createAccountPath(tier, bill, { google_signed_in: "1" }));
    }
  }, [router]);

  const choosePlan = useCallback(
    (tier: PlanTierId) => {
      persistManagerPricingOffer({
        tier,
        billing,
        returnSurface: "partner-pricing",
        trialSignup: true,
      });
      router.push(createAccountPath(tier, billing));
    },
    [billing, router],
  );

  if (isNative) return null;

  return (
    <MarketingPageShell className="native-hide">
      <header className="lp-page-hero">
        <div className="lp-w">
          <h1 className="lp-page-title lp-page-title-tight">Start with PropLane.</h1>
          <div className="mt-8 inline-flex items-center gap-1 rounded-full border border-[var(--lp-line)] bg-[var(--lp-card)] p-1">
            <button
              type="button"
              onClick={() => setBilling("monthly")}
              className={`rounded-full px-5 py-2 text-sm font-medium transition-all duration-150 ${
                billing === "monthly"
                  ? "bg-[var(--lp-blue)] text-white shadow-sm"
                  : "text-[var(--lp-muted)] hover:text-[var(--lp-ink)]"
              }`}
            >
              Monthly
            </button>
            <button
              type="button"
              onClick={() => setBilling("annual")}
              className={`flex items-center gap-2 rounded-full px-5 py-2 text-sm font-medium transition-all duration-150 ${
                billing === "annual"
                  ? "bg-[var(--lp-blue)] text-white shadow-sm"
                  : "text-[var(--lp-muted)] hover:text-[var(--lp-ink)]"
              }`}
            >
              Annual
              <span
                className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                  billing === "annual"
                    ? "bg-white/20 text-white"
                    : "bg-[var(--status-confirmed-bg)] text-[var(--status-confirmed-fg)]"
                }`}
              >
                {ANNUAL_DISCOUNT_PERCENT}% off
              </span>
            </button>
          </div>
        </div>
      </header>

      <div className="lp-w-wide grid gap-4 lg:grid-cols-3 lg:items-stretch">
        {planTiers.map((t) => {
          const pb = billing === "monthly" ? t.monthly : t.annual;
          const isProFeatured = t.id === "pro";
          const cta = t.id === "free" ? "Get started free" : `Choose ${t.label}`;
          return (
            <div
              key={t.id}
              className={
                "lp-page-card flex flex-col p-7 " +
                (isProFeatured
                  ? "border-[color-mix(in_srgb,var(--lp-blue)_40%,transparent)]"
                  : "")
              }
            >
              <div className="flex min-h-[28px] items-start">
                {isProFeatured ? (
                  <span className="inline-flex rounded-full bg-[color-mix(in_srgb,var(--lp-blue)_12%,transparent)] px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--lp-blue)]">
                    Popular
                  </span>
                ) : (
                  <span className="inline-flex rounded-full bg-[var(--lp-surface-2)] px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--lp-muted)]">
                    {t.label}
                  </span>
                )}
              </div>

              <div className="mt-3 flex flex-wrap items-baseline gap-x-1 gap-y-0">
                <span className="text-4xl font-semibold tracking-tight text-[var(--lp-ink)] sm:text-5xl">
                  {pb.headline}
                </span>
                {pb.period ? (
                  <span className="text-sm font-medium text-[var(--lp-muted)]">{pb.period}</span>
                ) : null}
              </div>

              <p className="mt-2 min-h-[4.5rem] text-sm leading-snug text-[var(--lp-muted)]">{pb.sub}</p>

              <button
                type="button"
                onClick={() => choosePlan(isPlanTierId(t.id) ? t.id : "free")}
                data-attr={`pricing-choose-${t.id}`}
                className={
                  "mt-5 w-full " + (isProFeatured ? "lp-btn lp-btn-blue lp-lg" : "lp-btn lp-btn-ghost lp-lg")
                }
              >
                {cta}
              </button>

              <ul className="mt-5 space-y-2.5 border-t border-[var(--lp-line)] pt-5">
                {t.features.map((f) => (
                  <li key={f.text} className="flex items-start gap-2.5 text-sm">
                    <span
                      className={`mt-0.5 shrink-0 ${f.included ? "text-[var(--lp-blue)]" : "text-[color-mix(in_srgb,var(--lp-muted)_40%,transparent)]"}`}
                      aria-hidden
                    >
                      <CheckIcon />
                    </span>
                    <span className={f.included ? "text-[var(--lp-ink)]" : "text-[color-mix(in_srgb,var(--lp-muted)_60%,transparent)]"}>
                      {f.text}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      <PublicPageAuthFooter
        getStartedHref={createAccountPath("free", billing)}
        signInHref="/auth/sign-in"
        getStartedLabel="Get started"
        getStartedDataAttr="pricing-get-started"
        signInDataAttr="pricing-sign-in-link"
      />
    </MarketingPageShell>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
