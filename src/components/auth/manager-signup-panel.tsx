"use client";

import { AuthDivider, AuthLegalConsent } from "@/components/auth/auth-mobile-primitives";
import { PricingGoogleContinueButton } from "@/components/auth/pricing-google-continue-button";
import { PricingAppleContinueButton } from "@/components/auth/pricing-apple-continue-button";
import { EmbeddedCheckoutMount } from "@/components/stripe/embedded-checkout";
import { SubscriptionCheckoutHint } from "@/components/stripe/subscription-checkout-hint";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { track } from "@/lib/analytics/track-client";
import { MANAGER_PLAN_TIERS, type ManagerPlanTierDefinition, type PlanTierId } from "@/data/manager-plan-tiers";
import {
  buildPricingOffer,
  continuePartnerPricingWithOffer,
  handleGoogleSignedInReturn,
  type ContinuePartnerPricingResult,
} from "@/lib/auth/partner-pricing-google-flow";
import { readManagerPricingOffer } from "@/lib/auth/manager-pricing-oauth-storage";
import { managerPortalEntryPath } from "@/lib/auth/manager-google-services-onboarding";
import { partnerPricingFinishPath } from "@/lib/auth/resume-partner-pricing-oauth";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { MANAGER_SUBSCRIPTION_TRIAL_DAYS } from "@/lib/stripe/subscription-checkout-session";
import { stripeLiveJsBlockedMessage } from "@/lib/stripe/stripe-js-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Manager account creation: Continue with Google or the manual details form, with the
 * paid-tier payment step revealed in place (embedded Stripe checkout). This single
 * implementation backs the integrated pricing-page signup — the ONLY manager signup
 * surface on the web.
 */
export function ManagerSignupPanel({
  tier,
  billing,
  planTiers = MANAGER_PLAN_TIERS,
  returnSurface,
  googleReturn = false,
  initialEmail = "",
  showSignInLink = false,
  hideLegalFooter = false,
}: {
  tier: PlanTierId;
  billing: "monthly" | "annual";
  planTiers?: ManagerPlanTierDefinition[];
  returnSurface: "mobile-plan" | "partner-pricing";
  /** Arrived back from Google OAuth — continue the stored pricing offer immediately. */
  googleReturn?: boolean;
  initialEmail?: string;
  showSignInLink?: boolean;
  hideLegalFooter?: boolean;
}) {
  const router = useRouter();
  const { showToast } = useAppUi();

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [promo, setPromo] = useState("");
  const [busy, setBusy] = useState(false);
  const [finishingGoogle, setFinishingGoogle] = useState(googleReturn);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [checkoutClientSecret, setCheckoutClientSecret] = useState<string | null>(null);
  const [stripeBlocked, setStripeBlocked] = useState<string | null>(null);

  const isPaid = tier !== "free";
  const selectedTier = useMemo(() => planTiers.find((t) => t.id === tier) ?? planTiers[0]!, [planTiers, tier]);
  const price = billing === "monthly" ? selectedTier.monthly : selectedTier.annual;
  const trimmedPromo = promo.trim() || undefined;
  const trimmedPhone = phone.trim() || undefined;

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time client-only Stripe availability probe
    setStripeBlocked(stripeLiveJsBlockedMessage());
  }, []);

  useEffect(() => {
    // Plan changed while the payment step was open — the checkout session no longer matches.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset checkout when selection changes
    setCheckoutClientSecret(null);
  }, [tier, billing]);

  const applyPricingResult = useCallback(
    (result: ContinuePartnerPricingResult) => {
      if (result.status === "checkout") {
        if (stripeLiveJsBlockedMessage()) {
          showToast(stripeLiveJsBlockedMessage()!);
          return;
        }
        track("subscription_checkout_started", { tier, billing });
        setCheckoutClientSecret(result.clientSecret);
        return;
      }
      if (result.status === "finish") {
        router.push(partnerPricingFinishPath(result.sessionId));
        return;
      }
      if (result.status === "portal") {
        window.location.replace(managerPortalEntryPath());
        return;
      }
      if (result.status === "error") {
        setErrorText(result.message);
      }
    },
    [billing, router, tier],
  );

  useEffect(() => {
    if (!googleReturn) return;
    let cancelled = false;
    void (async () => {
      setFinishingGoogle(true);
      try {
        const stored = readManagerPricingOffer();
        const offer = stored ?? buildPricingOffer({ tier, billing, promo: trimmedPromo, returnSurface });
        const result = await handleGoogleSignedInReturn(offer);
        if (cancelled) return;
        if (result.status !== "provisioned") {
          if (result.status === "error") {
            setErrorText(result.message);
          }
          return;
        }
        const continued = await continuePartnerPricingWithOffer(offer);
        if (!cancelled) applyPricingResult(continued);
      } finally {
        if (!cancelled) setFinishingGoogle(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot continuation on mount
  }, [googleReturn]);

  const createManager = async () => {
    if (!fullName.trim() || !email.trim() || password.length < 8) {
      setErrorText("Enter your name, email, and an 8+ character password.");
      return;
    }
    setErrorText(null);
    setBusy(true);
    try {
      const res = await fetch("/api/auth/manager-register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password, fullName: fullName.trim() }),
      });
      const body = (await res.json()) as { error?: string; redirectTo?: string; existingAccount?: boolean };
      if (!res.ok) {
        setErrorText(body.error ?? "Could not create account.");
        return;
      }
      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) {
        showToast("Account created. Sign in to continue.");
        router.push("/auth/sign-in?role=manager");
        return;
      }
      if (body.existingAccount || body.redirectTo?.startsWith("/")) {
        window.location.replace(body.redirectTo ?? managerPortalEntryPath());
        return;
      }
      const offer = buildPricingOffer({ tier, billing, promo: trimmedPromo, returnSurface });
      applyPricingResult(await continuePartnerPricingWithOffer(offer, { phone: trimmedPhone }));
    } catch {
      setErrorText("Network error.");
    } finally {
      setBusy(false);
    }
  };

  const locked = busy || finishingGoogle;
  const paidBlocked = Boolean(stripeBlocked && isPaid);

  if (checkoutClientSecret) {
    return (
      <div className="manager-signup-panel">
        <p className="text-center text-sm font-semibold text-foreground">Add a payment method to finish</p>
        <p className="mt-1 text-center text-xs text-muted">
          {selectedTier.label} · {MANAGER_SUBSCRIPTION_TRIAL_DAYS}-day free trial, then {price.headline}
          {price.period ?? ""}
        </p>
        <SubscriptionCheckoutHint className="mt-2 text-center text-xs leading-relaxed text-muted" />
        <div className="mt-3 rounded-2xl border border-border bg-card/50 p-3">
          <EmbeddedCheckoutMount
            clientSecret={checkoutClientSecret}
            onError={(message) => {
              showToast(message);
              setCheckoutClientSecret(null);
            }}
          />
        </div>
        <button
          type="button"
          data-attr="manager-signup-back-to-details"
          className="mt-3 block w-full text-center text-[13px] font-semibold text-primary/90"
          onClick={() => setCheckoutClientSecret(null)}
        >
          ← Back
        </button>
      </div>
    );
  }

  return (
    <div className="manager-signup-panel space-y-3">
      <p className="text-center text-xs text-muted">
        {isPaid
          ? `${selectedTier.label} plan · ${MANAGER_SUBSCRIPTION_TRIAL_DAYS}-day free trial, then ${price.headline}${price.period ?? ""}`
          : "Free plan · no card required"}
      </p>

      {finishingGoogle ? (
        <p className="rounded-2xl border border-border bg-card/50 px-3 py-2 text-center text-sm text-muted">
          Finishing sign-in with Google…
        </p>
      ) : (
        <>
          {stripeBlocked && isPaid ? (
            <p className="auth-stripe-dev-notice px-3 py-2 text-xs">{stripeBlocked}</p>
          ) : null}
          <div className="space-y-3">
            <PricingAppleContinueButton
              tier={tier}
              billing={billing}
              promo={trimmedPromo}
              returnSurface={returnSurface}
              disabled={locked || paidBlocked}
            />
            <PricingGoogleContinueButton
              tier={tier}
              billing={billing}
              promo={trimmedPromo}
              returnSurface={returnSurface}
              disabled={locked || paidBlocked}
            />
          </div>
          <AuthDivider label="or enter your details" />
          <Input
            placeholder="Full name"
            autoComplete="name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            disabled={locked}
          />
          <Input
            type="email"
            autoComplete="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={locked}
          />
          <PasswordInput
            autoComplete="new-password"
            placeholder="Password (8+ characters)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={locked}
            onKeyDown={(e) => {
              if (e.key === "Enter") void createManager();
            }}
          />
          <Input
            type="tel"
            autoComplete="tel"
            placeholder="Phone (optional)"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            disabled={locked}
          />
          {isPaid ? (
            <Input
              placeholder="Promo code (optional)"
              autoComplete="off"
              value={promo}
              onChange={(e) => setPromo(e.target.value)}
              disabled={locked}
            />
          ) : null}
          <Button
            type="button"
            data-attr="manager-signup-submit"
            className="btn-cobalt w-full rounded-full py-2.5 text-[15px] font-semibold"
            disabled={locked || paidBlocked}
            onClick={() => createManager()}
          >
            {busy ? "Creating…" : `Continue with ${selectedTier.label}`}
          </Button>
        </>
      )}

      {errorText ? <p className="text-center text-xs text-rose-600">{errorText}</p> : null}

      {showSignInLink ? (
        <p className="text-center text-[12px] text-muted">
          Already have an account?{" "}
          <Link className="font-semibold text-primary hover:opacity-90" href="/auth/sign-in">
            Sign in
          </Link>
        </p>
      ) : null}

      {!hideLegalFooter ? <AuthLegalConsent action="create" className="mt-2" /> : null}
    </div>
  );
}
