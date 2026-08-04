"use client";

import { AuthCard } from "@/components/auth/auth-card";
import { AuthPageHeader } from "@/components/auth/auth-mobile-primitives";
import { ManagerPlanBillingToggle, ManagerPlanTierCards } from "@/components/auth/manager-plan-tier-cards";
import { EmbeddedCheckoutMount } from "@/components/stripe/embedded-checkout";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { track } from "@/lib/analytics/track-client";
import { MANAGER_PLAN_TIERS, type ManagerPlanTierDefinition, type PlanTierId } from "@/data/manager-plan-tiers";
import { loadManagerPlanTiers } from "@/lib/site-content";
import { MANAGER_SUBSCRIPTION_TRIAL_DAYS } from "@/lib/stripe/subscription-checkout-session";
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Post-provisioning plan chooser — the step a manager lands on right after
 * picking "Property Manager" on /auth/get-started (web only; the native shell
 * routes straight to the portal, App Store Guideline 2.1(b)).
 *
 * The account is already provisioned (and on the no-card 14-day Pro signup
 * trial) when this renders, so this surface RECORDS the choice:
 *  - Free  → commits `tier: "free"` via the existing update-tier route.
 *  - Pro / Business → the existing signed-in signup checkout
 *    (`/api/manager/pricing-oauth-continue`): embedded Stripe Checkout that
 *    collects a payment method now with a 14-day trial, then returns through
 *    /auth/manager-oauth-finish into the portal.
 *
 * Managers who already hold a plan are never re-asked: this page is only
 * routed-to from the get-started provisioning step, and a direct visit with an
 * active Stripe/Apple subscription or a committed (non-trial) tier forwards to
 * the portal immediately.
 */

type SubPayload = {
  tier: string | null;
  billing: string | null;
  stripeManaged?: boolean;
  appleManaged?: boolean;
  planUnknown?: boolean;
};

function tierById(tiers: ManagerPlanTierDefinition[], id: PlanTierId) {
  return tiers.find((t) => t.id === id) ?? tiers[0]!;
}

/** True when this account has already chosen (or otherwise holds) a plan. */
export function managerEntryPlanAlreadySettled(sub: SubPayload): boolean {
  // A plan we could not READ arrives as `{tier: null, billing: null,
  // stripeManaged: false, appleManaged: false}` — indistinguishable from a
  // fresh trial account. Showing the chooser there lets "Continue with Free"
  // rewrite a paying manager's row to tier=free. Fail closed: forward to the
  // portal and never offer a tier write off an unreadable plan.
  if (sub.planUnknown) return true;
  if (sub.stripeManaged || sub.appleManaged) return true;
  const tier = sub.tier?.toLowerCase().trim() ?? "";
  if (tier === "free") return true; // explicitly committed Free before
  const billing = sub.billing?.toLowerCase().trim() ?? "";
  // A paid tier NOT on the signup trial is a real grant (waiver / admin) —
  // don't ask its holder to pick again. The trial is the "hasn't chosen yet"
  // state this chooser exists for.
  return (tier === "pro" || tier === "business") && billing !== "trial";
}

export function ManagerEntryPlanChooser() {
  const { showToast } = useAppUi();

  const [sub, setSub] = useState<SubPayload | null>(null);
  const [guarding, setGuarding] = useState(true);
  const [billing, setBilling] = useState<"monthly" | "annual">("monthly");
  const [selectedTierId, setSelectedTierId] = useState<PlanTierId>("pro");
  const [planTiers, setPlanTiers] = useState(MANAGER_PLAN_TIERS);
  const [busy, setBusy] = useState(false);
  const [checkoutClientSecret, setCheckoutClientSecret] = useState<string | null>(null);
  const guardRanRef = useRef(false);

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
    if (guardRanRef.current) return;
    guardRanRef.current = true;
    void (async () => {
      try {
        const res = await fetch("/api/manager/subscription", { credentials: "include" });
        const body = (await res.json().catch(() => ({}))) as SubPayload & { error?: string };
        if (!res.ok) {
          // Can't tell — let them into the portal rather than stranding them on
          // a chooser whose actions would also fail.
          window.location.replace("/portal/dashboard");
          return;
        }
        if (managerEntryPlanAlreadySettled(body)) {
          window.location.replace("/portal/dashboard");
          return;
        }
        setSub(body);
        setGuarding(false);
      } catch {
        window.location.replace("/portal/dashboard");
      }
    })();
  }, []);

  const chooseFree = async () => {
    const res = await fetch("/api/stripe/subscription/update-tier", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier: "free" }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      showToast(body.error ?? "Could not set your plan. You can also choose later in Settings.");
      return;
    }
    window.location.replace("/portal/dashboard");
  };

  const choosePaid = async (tier: "pro" | "business") => {
    track("subscription_checkout_started", { tier, billing, entry: "portal_entry_chooser" });
    const res = await fetch("/api/manager/pricing-oauth-continue", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier, billing }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      action?: string;
      clientSecret?: string;
      sessionId?: string;
      url?: string;
      error?: string;
    };
    if (!res.ok) {
      showToast(body.error ?? "Could not start checkout. You can also subscribe later in Settings.");
      return;
    }
    if (body.action === "portal") {
      window.location.replace("/portal/dashboard");
      return;
    }
    if (body.action === "checkout" && body.clientSecret) {
      setCheckoutClientSecret(body.clientSecret);
      return;
    }
    if (body.action === "redirect" && body.url) {
      window.location.assign(body.url);
      return;
    }
    showToast("Could not start checkout. You can also subscribe later in Settings.");
  };

  const continueWithSelection = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (selectedTierId === "free") await chooseFree();
      else await choosePaid(selectedTierId);
    } catch {
      showToast("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (guarding) {
    return (
      <AuthCard wide>
        <p className="py-8 text-center text-sm text-muted">Loading your account…</p>
      </AuthCard>
    );
  }

  if (checkoutClientSecret) {
    return (
      <AuthCard wide>
        <div className="auth-plan-picker auth-plan-picker-wide">
          <AuthPageHeader
            eyebrow="Manager"
            title={`Subscribe to ${selected.label}`}
            subtitle={`Add a payment method now — billing starts after your ${MANAGER_SUBSCRIPTION_TRIAL_DAYS}-day free trial.`}
            accent={false}
          />
          <div className="mt-4">
            <EmbeddedCheckoutMount
              clientSecret={checkoutClientSecret}
              onError={(message) => {
                showToast(message);
                setCheckoutClientSecret(null);
              }}
            />
          </div>
          <p className="mt-4 text-center">
            <button
              type="button"
              className="text-sm font-medium text-primary underline-offset-2 hover:underline"
              onClick={() => setCheckoutClientSecret(null)}
            >
              Back to plans
            </button>
          </p>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard wide>
      <div className="auth-plan-picker auth-plan-picker-wide">
        <AuthPageHeader
          eyebrow="Manager"
          title="Choose your plan"
          subtitle={`Your account starts with a ${MANAGER_SUBSCRIPTION_TRIAL_DAYS}-day free Pro trial — pick the plan to continue with. Free needs no card.`}
          accent={false}
        />

        <div className="mt-4 sm:mt-5">
          <ManagerPlanBillingToggle billing={billing} onChange={setBilling} disabled={busy} />
        </div>

        <div className="auth-plan-tier-grid mt-4 sm:mt-5">
          <ManagerPlanTierCards
            tiers={planTiers}
            billing={billing}
            selectedTierId={selectedTierId}
            onSelectTier={setSelectedTierId}
            disabled={busy}
          />
        </div>

        <p className="auth-plan-price-block mt-4 text-center text-xs text-muted sm:mt-5">
          {selectedTierId === "free"
            ? `Free · no card required · ends your ${MANAGER_SUBSCRIPTION_TRIAL_DAYS}-day Pro trial now · upgrade anytime in Settings`
            : `${selected.label} · card required · first charge after your ${MANAGER_SUBSCRIPTION_TRIAL_DAYS}-day free trial · the dedicated phone number & texting start with your paid subscription, not during the trial`}
        </p>

        <div className="auth-plan-form-block mt-5 sm:mt-6">
          <Button
            type="button"
            data-attr="manager-entry-plan-continue"
            className="btn-cobalt w-full rounded-full py-2.5 text-[15px] font-semibold"
            disabled={busy || sub == null}
            onClick={() => continueWithSelection()}
          >
            {busy ? "One moment…" : `Continue with ${selected.label}`}
          </Button>
        </div>

        <p className="mt-4 text-center">
          <button
            type="button"
            className="text-sm font-medium text-muted underline-offset-2 hover:text-foreground hover:underline"
            data-attr="manager-entry-plan-skip"
            disabled={busy}
            onClick={() => window.location.replace("/portal/dashboard")}
          >
            Skip for now — decide later in Settings
          </button>
        </p>
      </div>
    </AuthCard>
  );
}
