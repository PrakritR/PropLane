"use client";

import posthog from "posthog-js";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AuthDivider, AuthLegalConsent, AuthLoadingCard } from "@/components/auth/auth-mobile-primitives";
import { useSignedInPortalRoles } from "@/components/auth/use-signed-in-portal-roles";
import { PricingAppleContinueButton } from "@/components/auth/pricing-apple-continue-button";
import { PricingGoogleContinueButton } from "@/components/auth/pricing-google-continue-button";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import type { PlanTierId } from "@/data/manager-plan-tiers";
import {
  buildPricingOffer,
  continuePartnerPricingWithOffer,
  handleGoogleSignedInReturn,
  type ContinuePartnerPricingResult,
} from "@/lib/auth/partner-pricing-google-flow";
import { readManagerPricingOffer } from "@/lib/auth/manager-pricing-oauth-storage";
import { waitForAuthUser } from "@/lib/auth/wait-for-auth-user";
import { waitForOAuthUser } from "@/lib/auth/wait-for-oauth-user";
import { FetchTimeoutError } from "@/lib/auth/fetch-with-timeout";
import { normalizeE164 } from "@/lib/phone-e164";
import { MANAGER_SUBSCRIPTION_TRIAL_DAYS } from "@/lib/stripe/subscription-checkout-session";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { goToManagerAccountSetup } from "@/lib/auth/manager-google-services-onboarding";
import { portalDashboardPath } from "@/components/auth/portal-switcher";
import { normalizeAuthEmail } from "@/lib/auth/normalize-auth-email";
import { withAuthTimeout } from "@/lib/auth/with-timeout";

function trialSignupSubtitle(tier: PlanTierId): string {
  if (tier === "free") return "Free plan · no card required";
  return `${MANAGER_SUBSCRIPTION_TRIAL_DAYS}-day free trial · no card required`;
}

function dropOAuthReturnParams(tier: PlanTierId, billing: "monthly" | "annual"): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams({ mode: "create", role: "manager", tier, billing });
  window.history.replaceState({}, "", `/auth/create-account?${params}`);
}

type SignedInUser = { id: string; email: string | null };

/** Manager account creation — OAuth or email, no inline plan UI. */
export function ManagerTrialSignupForm({
  tier,
  billing,
  initialEmail = "",
  disabled = false,
  hideLegalFooter = false,
  googleReturn = false,
  accountReadyReturn = false,
  trialSignup = true,
}: {
  tier: PlanTierId;
  billing: "monthly" | "annual";
  initialEmail?: string;
  disabled?: boolean;
  hideLegalFooter?: boolean;
  googleReturn?: boolean;
  accountReadyReturn?: boolean;
  trialSignup?: boolean;
}) {
  const router = useRouter();
  const { showToast } = useAppUi();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState(initialEmail);
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [redirectingToSetup, setRedirectingToSetup] = useState(accountReadyReturn);
  const [finishingOAuth, setFinishingOAuth] = useState(googleReturn && !accountReadyReturn);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [signedInUser, setSignedInUser] = useState<SignedInUser | null>(null);
  const { roles: portalRoles, loading: rolesLoading } = useSignedInPortalRoles();
  const alreadyManager = Boolean(signedInUser) && portalRoles.includes("manager");

  const locked = disabled || busy || finishingOAuth;

  const readSignedInUser = useCallback(async (awaitOAuthSession: boolean): Promise<SignedInUser | null> => {
    const supabase = createSupabaseBrowserClient();
    if (awaitOAuthSession) {
      const user = await waitForOAuthUser(supabase, { maxWaitMs: 8_000 });
      return user ? { id: user.id, email: user.email ?? null } : null;
    }
    try {
      const {
        data: { session },
      } = await withAuthTimeout(supabase.auth.getSession());
      const user = session?.user ?? null;
      return user ? { id: user.id, email: user.email ?? null } : null;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const user = await readSignedInUser(googleReturn);
      if (!cancelled) setSignedInUser(user);
    })();
    return () => {
      cancelled = true;
    };
  }, [googleReturn, readSignedInUser]);

  useEffect(() => {
    if (!signedInUser?.email || initialEmail || alreadyManager) return;
    setEmail(signedInUser.email);
  }, [signedInUser, initialEmail, alreadyManager]);

  const applyPricingResult = useCallback(
    (result: ContinuePartnerPricingResult) => {
      if (result.status === "portal") {
        setRedirectingToSetup(true);
        goToManagerAccountSetup();
        return;
      }
      if (result.status === "error") {
        setErrorText(result.message);
      }
    },
    [],
  );

  useEffect(() => {
    if (!accountReadyReturn) return;
    setRedirectingToSetup(true);
    goToManagerAccountSetup();
  }, [accountReadyReturn]);

  useEffect(() => {
    if (!accountReadyReturn) return;
    let cancelled = false;
    void (async () => {
      dropOAuthReturnParams(tier, billing);
      const user = await readSignedInUser(false);
      if (cancelled) return;
      if (user) setSignedInUser(user);
      else setErrorText("Could not confirm your account. Please sign in.");
    })();
    return () => {
      cancelled = true;
    };
  }, [accountReadyReturn, readSignedInUser, tier, billing]);

  useEffect(() => {
    if (!googleReturn || accountReadyReturn) return;
    let cancelled = false;
    void (async () => {
      setFinishingOAuth(true);
      try {
        const stored = readManagerPricingOffer();
        const offer =
          stored ??
          buildPricingOffer({ tier, billing, returnSurface: "mobile-plan", trialSignup: true });

        const user = await readSignedInUser(true);
        if (cancelled) return;
        if (!user) {
          setErrorText("Your session isn't ready yet — try again.");
          dropOAuthReturnParams(tier, billing);
          return;
        }
        setSignedInUser(user);

        if (offer.trialSignup) {
          const continued = await continuePartnerPricingWithOffer(offer);
          if (cancelled) return;
          applyPricingResult(continued);
          dropOAuthReturnParams(offer.tier, offer.billing);
          return;
        }

        const result = await handleGoogleSignedInReturn(offer);
        if (cancelled) return;
        if (result.status !== "provisioned") {
          if (result.status === "error") {
            setErrorText(result.message);
          }
          dropOAuthReturnParams(tier, billing);
          return;
        }
        const continued = await continuePartnerPricingWithOffer(offer);
        if (cancelled) return;
        applyPricingResult(continued);
        dropOAuthReturnParams(offer.tier, offer.billing);
      } catch (error) {
        if (!cancelled) {
          setErrorText(
            error instanceof FetchTimeoutError
              ? error.message
              : "Could not finish sign-in. Please try again.",
          );
          dropOAuthReturnParams(tier, billing);
        }
      } finally {
        if (!cancelled) setFinishingOAuth(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot continuation on mount
  }, [accountReadyReturn, googleReturn]);

  const submit = async () => {
    if (!fullName.trim()) {
      setErrorText("Enter your full name.");
      return;
    }
    if (!email.trim() || password.length < 8) {
      setErrorText("Enter your email and an 8+ character password.");
      return;
    }
    const normalizedPhone = normalizeE164(phone);
    if (!normalizedPhone) {
      setErrorText("Enter a valid phone number.");
      return;
    }
    setErrorText(null);
    setBusy(true);
    try {
      const res = await fetch("/api/auth/manager-register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: normalizeAuthEmail(email),
          password,
          fullName: fullName.trim(),
          phone: normalizedPhone,
          tier,
        }),
      });
      const body = (await res.json()) as { error?: string; redirectTo?: string; existingAccount?: boolean };
      if (!res.ok) {
        setErrorText(body.error ?? "Could not create manager account.");
        return;
      }
      const supabase = createSupabaseBrowserClient();
      if (signedInUser) {
        try {
          posthog.reset();
        } catch {
          /* best-effort analytics reset */
        }
      }
      // BOUNDED. Without a timeout a network-level failure here never settles,
      // so the button stays busy forever while the account quietly exists — the
      // person concludes signup failed and retries into "already registered"
      // (PRP-187). A stall is treated exactly like a refusal: say the account
      // was created and send them to sign in.
      type SignInResult = Awaited<ReturnType<typeof supabase.auth.signInWithPassword>>;
      let signInData: SignInResult["data"] | null = null;
      let signInError: unknown = null;
      try {
        const result = await withAuthTimeout<SignInResult>(
          supabase.auth.signInWithPassword({ email: normalizeAuthEmail(email), password }),
        );
        signInData = result.data;
        signInError = result.error;
      } catch (timeoutOrNetwork) {
        signInError = timeoutOrNetwork;
      }
      if (signInError) {
        if (signedInUser) await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
        showToast("Account created. Sign in to continue.");
        router.push("/auth/sign-in?role=manager");
        return;
      }
      if (signInData?.user) posthog.identify(signInData.user.id);
      setRedirectingToSetup(true);
      goToManagerAccountSetup();
    } catch {
      setErrorText("Network error.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="manager-trial-signup-form space-y-2.5 sm:space-y-3">
      <p className="text-center text-[11px] leading-tight text-muted whitespace-nowrap sm:text-xs">
        {trialSignupSubtitle(tier)}
      </p>

      {finishingOAuth || redirectingToSetup ? (
        <AuthLoadingCard
          label={redirectingToSetup ? "Opening your portal…" : "Finishing sign-in…"}
        />
      ) : rolesLoading ? (
        <AuthLoadingCard label="Loading…" />
      ) : (
        <>
          <div className="space-y-3">
            <PricingAppleContinueButton
              tier={tier}
              billing={billing}
              returnSurface="mobile-plan"
              trialSignup={trialSignup}
              disabled={locked}
            />
            <PricingGoogleContinueButton
              tier={tier}
              billing={billing}
              returnSurface="mobile-plan"
              trialSignup={trialSignup}
              disabled={locked}
            />
          </div>

          <AuthDivider label="or enter your details" />

          <Input
            type="text"
            autoComplete="name"
            placeholder="Full name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            disabled={locked}
          />
          <Input
            type="email"
            autoComplete="email"
            // iOS/macOS autocapitalise the first letter by default, which used to
            // make Manager@… a different account from manager@… (PRP-196).
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={locked}
          />
          <Input
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="Phone number"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            disabled={locked}
          />
          <PasswordInput
            autoComplete="new-password"
            placeholder="Password (8+ characters)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={locked}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
          <Button
            type="button"
            data-attr="manager-trial-signup-submit"
            className="btn-cobalt w-full rounded-full py-2.5 text-[15px] font-semibold"
            disabled={locked}
            onClick={() => submit()}
          >
            {busy ? "Creating…" : signedInUser ? "Set up property manager" : "Create property account"}
          </Button>

          {alreadyManager ? (
            <p className="text-center text-[13px] text-muted">
              Already managing a property?{" "}
              <Link
                href={`/auth/continue?next=${encodeURIComponent(portalDashboardPath("manager"))}`}
                className="font-semibold text-primary hover:opacity-90"
                data-attr="manager-trial-signup-go-to-existing-portal"
              >
                Go to your portal
              </Link>
            </p>
          ) : null}
        </>
      )}

      {errorText ? <p className="text-center text-xs text-rose-600">{errorText}</p> : null}

      {!hideLegalFooter ? <AuthLegalConsent action="create" className="mt-2" /> : null}
    </div>
  );
}
