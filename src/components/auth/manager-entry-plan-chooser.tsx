"use client";

import { AuthCard } from "@/components/auth/auth-card";
import { AuthPageHeader } from "@/components/auth/auth-mobile-primitives";
import { ManagerPlanBillingToggle, ManagerPlanTierCards } from "@/components/auth/manager-plan-tier-cards";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { track } from "@/lib/analytics/track-client";
import { MANAGER_PLAN_TIERS, type ManagerPlanTierDefinition, type PlanTierId } from "@/data/manager-plan-tiers";
import { loadManagerPlanTiers } from "@/lib/site-content";
import { managerPortalEntryPath } from "@/lib/auth/manager-google-services-onboarding";
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
 *  - Pro / Business → starts the trial and enters the portal. NO CARD is
 *    collected (AXI-127): the trial is already live on the account, and
 *    `resolveEffectiveManagerTier` drops it to Free on day 15 by date alone, so
 *    a payment method buys nothing until the manager actually decides to
 *    upgrade. Asking for one at the door was a card wall in front of a product
 *    nobody had used yet.
 *  - A 100% promo code still commits a real paid tier immediately, which is a
 *    different thing from a trial and keeps its own path.
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
  const [promoCode, setPromoCode] = useState("");
  const [promoError, setPromoError] = useState<string | null>(null);
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
          window.location.replace(managerPortalEntryPath());
          return;
        }
        if (managerEntryPlanAlreadySettled(body)) {
          window.location.replace(managerPortalEntryPath());
          return;
        }
        setSub(body);
        setGuarding(false);
      } catch {
        window.location.replace(managerPortalEntryPath());
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
    window.location.replace(managerPortalEntryPath());
  };

  const choosePaid = async (tier: "pro" | "business") => {
    const promo = promoCode.trim();
    track("subscription_checkout_started", {
      tier,
      billing,
      entry: "portal_entry_chooser",
      ...(promo ? { waiver_attempt: true } : {}),
    });
    if (promo) {
      const promoRes = await fetch("/api/stripe/subscription/update-tier", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier, billing, promo }),
      });
      const promoBody = (await promoRes.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      if (!promoRes.ok) {
        setPromoError(promoBody.error ?? "Could not apply that promo code.");
        return;
      }
      showToast(promoBody.message ?? "Promo code applied. No payment is required.");
      window.location.replace(managerPortalEntryPath());
      return;
    }
    // The trial is ALREADY active on this account — provisioning put it there —
    // so starting it is just entering the portal. No card, no checkout, nothing
    // to fail. Upgrading is a deliberate, separate act in Settings once they
    // have used the thing (AXI-127).
    window.location.replace(managerPortalEntryPath());
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
      <AuthCard wide variant="blend">
        <p className="py-8 text-center text-sm text-muted">Loading your account…</p>
      </AuthCard>
    );
  }

  return (
    <AuthCard widest variant="blend">
      <div className="auth-plan-picker auth-plan-picker-wide">
        <AuthPageHeader
          eyebrow="Manager"
          title="Choose your plan"
          subtitle={`Your account starts with a ${MANAGER_SUBSCRIPTION_TRIAL_DAYS}-day free Pro trial — pick the plan to continue with. No card, whichever you choose.`}
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
            : `${selected.label} · no card required · after ${MANAGER_SUBSCRIPTION_TRIAL_DAYS} days you move to Free unless you upgrade in Settings · the dedicated phone number & texting start with a paid subscription, not during the trial`}
        </p>

        {selectedTierId !== "free" ? (
          <div className="auth-plan-form-block mt-4">
            <label htmlFor="manager-entry-promo-code" className="text-sm font-semibold text-foreground">
              Promo code <span className="font-normal text-muted">(optional)</span>
            </label>
            <Input
              id="manager-entry-promo-code"
              value={promoCode}
              onChange={(event) => {
                setPromoCode(event.target.value);
                if (promoError) setPromoError(null);
              }}
              placeholder="Enter code"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              className="mt-2 uppercase placeholder:normal-case"
              data-attr="manager-entry-promo-code"
            />
            {promoError ? (
              <p className="mt-2 text-xs font-medium text-[var(--status-overdue-fg)]" role="alert">
                {promoError}
              </p>
            ) : (
              <p className="mt-2 text-xs leading-5 text-muted">
                Valid 100% discount codes activate the plan without a card.
              </p>
            )}
          </div>
        ) : null}

        <div className="auth-plan-form-block mt-5 sm:mt-6">
          <Button
            type="button"
            data-attr="manager-entry-plan-continue"
            className="btn-cobalt w-full rounded-full py-2.5 text-[15px] font-semibold"
            disabled={busy || sub == null}
            onClick={() => continueWithSelection()}
          >
            {busy
              ? "One moment…"
              : selectedTierId === "free"
                ? "Continue with Free"
                : promoCode.trim()
                  ? "Apply code and continue"
                  : `Start ${MANAGER_SUBSCRIPTION_TRIAL_DAYS}-day free trial`}
          </Button>
        </div>

        <p className="mt-4 text-center">
          <button
            type="button"
            className="text-sm font-medium text-muted underline-offset-2 hover:text-foreground hover:underline"
            data-attr="manager-entry-plan-skip"
            disabled={busy}
            onClick={() => window.location.replace(managerPortalEntryPath())}
          >
            Skip for now — decide later in Settings
          </button>
        </p>
      </div>
    </AuthCard>
  );
}
