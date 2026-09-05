"use client";

import { usePathname, useRouter } from "next/navigation";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { track } from "@/lib/analytics/track-client";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { formatPacificDate } from "@/lib/pacific-time";
import { MANAGER_PLAN_TIERS, type ManagerPlanTierDefinition } from "@/data/manager-plan-tiers";
import {
  BUSINESS_MAX_PROPERTIES,
  FREE_MAX_PROPERTIES,
  PRO_MAX_PROPERTIES,
  maxAccountLinksForTier,
  normalizeManagerSkuTier,
  type ManagerSkuTier,
} from "@/lib/manager-access";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { submitBugFeedbackReport } from "@/lib/portal-bug-feedback";
import { loadManagerPlanTiers } from "@/lib/site-content";
import { EmbeddedCheckoutMount } from "@/components/stripe/embedded-checkout";
import { SubscriptionCheckoutHint } from "@/components/stripe/subscription-checkout-hint";
import { ManagerPlanNative } from "@/components/portal/pro-plan-native";
import {
  MANAGER_PLAN_BILLING_RETURN_PATH,
  MANAGER_PLAN_PORTAL_PATH,
  MANAGER_PLAN_PORTAL_SECTION_ID,
} from "@/lib/portals/manager-plan-path";

type SubPayload = {
  tier: string | null;
  billing: string | null;
  isPro: boolean;
  isBusiness: boolean;
  isFree: boolean;
  isLegacyUnlimited: boolean;
  planUnknown?: boolean;
  stripeManaged?: boolean;
  appleManaged?: boolean;
  cancelAtPeriodEnd?: boolean;
  currentPeriodEnd?: number | null;
  scheduledDowngrade?: { tier: string; billing: string } | null;
};

function committedTier(sub: SubPayload | null): ManagerSkuTier {
  if (!sub) return "free";
  return normalizeManagerSkuTier(sub.tier) ?? "free";
}

function tierRank(t: ManagerSkuTier): number {
  if (t === "free") return 0;
  if (t === "pro") return 1;
  return 2;
}

function tierLabel(t: ManagerSkuTier): string {
  if (t === "free") return "Free";
  if (t === "pro") return "Pro";
  return "Business";
}

function tierTagline(t: ManagerSkuTier): string {
  if (t === "free") return "1 property · applications & touring";
  if (t === "pro") return "Full resident management · up to 2 properties";
  return "Portfolio scale · up to 20 properties";
}

function CheckIcon({ muted }: { muted?: boolean }) {
  return (
    <svg className={`h-4 w-4 shrink-0 ${muted ? "text-muted/35" : "text-primary"}`} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function continueInCurrentTab(url: string) {
  window.location.href = url;
}

function planPriceLabel(tiers: ManagerPlanTierDefinition[], tierId: ManagerSkuTier, billing: "monthly" | "annual"): string {
  const tier = tiers.find((t) => t.id === tierId);
  if (!tier) return "";
  const pb = billing === "monthly" ? tier.monthly : tier.annual;
  return `${pb.headline}${pb.period ?? ""}`;
}

function periodEndLabel(unix: number | null | undefined): string | null {
  if (unix == null || typeof unix !== "number" || !Number.isFinite(unix) || unix <= 0) return null;
  return formatPacificDate(new Date(unix * 1000), { month: "long", day: "numeric", year: "numeric" });
}

function tierPropertyCap(t: ManagerSkuTier): number {
  if (t === "free") return FREE_MAX_PROPERTIES;
  if (t === "pro") return PRO_MAX_PROPERTIES;
  return BUSINESS_MAX_PROPERTIES;
}

/**
 * What actually happens on a downgrade, stated plainly before it is confirmed.
 * The plan limits are creation gates only (see "Plan entitlements" in
 * AGENTS.md): an over-limit portfolio keeps every listing and co-manager link
 * it already has — the account just can't add MORE until it's under the new
 * cap. Free additionally paywalls the Pro-only sections; the data behind them
 * is kept, not deleted.
 */
function DowngradeConsequences({ target }: { target: ManagerSkuTier }) {
  const cap = tierPropertyCap(target);
  const links = maxAccountLinksForTier(target) ?? 0;
  return (
    <ul className="list-disc space-y-1.5 ps-5 text-sm leading-6 text-muted">
      <li>
        Nothing is deleted — every property, resident, lease, payment record, and message you&apos;ve created stays on
        your account.
      </li>
      {target === "free" ? (
        // Free has no co-manager clause: the Team section itself is paywalled on
        // Free, so promising "1 co-manager link" would contradict the Free tier
        // card a few lines below (co-managers not included).
        <li>
          Free includes {cap === 1 ? "1 property listing" : `up to ${cap} property listings`}. If you have more,
          existing listings keep working — you just can&apos;t add new ones until you&apos;re under the limit.
        </li>
      ) : (
        <li>
          {tierLabel(target)} includes {cap === 1 ? "1 property listing" : `up to ${cap} property listings`} and{" "}
          {links === 1 ? "1 co-manager link" : `up to ${links} co-manager links`}. If you&apos;re over either limit,
          what you already have keeps working — you just can&apos;t add new ones until you&apos;re under the limit.
        </li>
      )}
      {target === "free" ? (
        <>
          <li>
            On Free, the Residents, Leases, Services, Communication, Finances, Documents, Team (co-managers), and
            Promotion sections are locked behind an upgrade prompt. Everything in them is kept and unlocks again if
            you re-subscribe.
          </li>
          <li>
            Your dedicated phone number &amp; texting are included only with an actively paid Pro or Business
            subscription — downgrading to Free means losing your number.
          </li>
        </>
      ) : null}
    </ul>
  );
}

type PlanModalState =
  | null
  | {
      kind: "checkout";
      tier: "pro" | "business";
      billing: "monthly" | "annual";
      clientSecret: string | null;
      loading?: boolean;
    }
  | {
      kind: "confirm_upgrade";
      target: "pro" | "business";
    }
  | {
      kind: "confirm_downgrade";
      target: ManagerSkuTier;
    }
  | {
      kind: "confirm_annual";
    }
  | {
      kind: "annual_to_monthly";
    }
  | {
      kind: "cancel_plan";
      fromTier: ManagerSkuTier;
    };

export function ManagerPlan({
  embedded = false,
  showCurrentPlan = true,
}: { embedded?: boolean; showCurrentPlan?: boolean } = {}) {
  const router = useRouter();
  const pathname = usePathname();
  const planBasePath = "/portal";
  const planSettingsPath = MANAGER_PLAN_PORTAL_PATH;
  const { showToast } = useAppUi();
  const { userId, email } = useManagerUserId();
  const [sub, setSub] = useState<SubPayload | null>(null);
  const [priceView, setPriceView] = useState<"monthly" | "annual">("monthly");
  const [planTiers, setPlanTiers] = useState<ManagerPlanTierDefinition[]>(MANAGER_PLAN_TIERS);
  const [busyTier, setBusyTier] = useState<ManagerSkuTier | null>(null);
  const [billingSyncBusy, setBillingSyncBusy] = useState(false);
  const [billingPortalBusy, setBillingPortalBusy] = useState(false);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [cancelDowngradeBusy, setCancelDowngradeBusy] = useState(false);
  const [planModal, setPlanModal] = useState<PlanModalState>(null);
  const [feedbackReason, setFeedbackReason] = useState("");
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [promoCode, setPromoCode] = useState("");
  const [promoBusy, setPromoBusy] = useState(false);
  const [promoError, setPromoError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/manager/subscription", { credentials: "include" });
      const body = (await res.json()) as SubPayload & { error?: string };
      if (!res.ok) {
        showToast(body.error ?? "Could not load subscription.");
        return;
      }
      setSub(body);
    } catch {
      showToast("Network error.");
    }
  }, [showToast]);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

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

  const currentTier = useMemo(() => committedTier(sub), [sub]);
  const currentBilling = useMemo<"monthly" | "annual">(() => {
    const b = sub?.billing?.toLowerCase();
    return b === "annual" ? "annual" : "monthly";
  }, [sub?.billing]);
  const renewalLabel = periodEndLabel(sub?.currentPeriodEnd ?? null);
  const anyBusy = busyTier !== null || billingSyncBusy || billingPortalBusy || resumeBusy || cancelDowngradeBusy || feedbackBusy;

  useEffect(() => {
    const id = window.setTimeout(() => setPriceView(currentBilling), 0);
    return () => window.clearTimeout(id);
  }, [currentBilling]);

  const checkoutHandledRef = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const q = new URLSearchParams(window.location.search);
    const checkout = q.get("checkout");
    if (!checkout || checkoutHandledRef.current) return;
    checkoutHandledRef.current = true;

    const sessionId = q.get("session_id");

    void (async () => {
      if (checkout === "success" && sessionId) {
        try {
          const res = await fetch("/api/stripe/confirm-checkout-session", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId }),
          });
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as { error?: string };
            showToast(body.error ?? "Could not activate your plan from checkout.");
          }
        } catch {
          showToast("Could not activate your plan from checkout.");
        }
      }

      window.history.replaceState({}, "", pathname);

      if (checkout === "cancelled") {
        showToast("Checkout was cancelled.");
        return;
      }

      if (checkout === "success") {
        showToast("Payment received. Activating your plan…");
        for (let i = 0; i < 6; i++) {
          await load();
          if (i < 5) await new Promise((r) => setTimeout(r, 1400));
        }
      }
    })();
  }, [pathname, load, showToast]);

  const submitPlanChangeFeedback = useCallback(
    async (title: string, reason: string) => {
      if (!userId || !email?.includes("@")) return;
      await submitBugFeedbackReport({
        type: "feedback",
        reporterUserId: userId,
        reporterName: email,
        reporterEmail: email,
        reporterRole: "manager",
        title,
        description: reason,
        pageUrl: typeof window !== "undefined" ? window.location.href : planSettingsPath,
      });
    },
    [email, planSettingsPath, userId],
  );

  const closePlanModal = useCallback(() => {
    if (feedbackBusy || promoBusy) return;
    setPlanModal(null);
    setFeedbackReason("");
    setPromoCode("");
    setPromoError(null);
  }, [feedbackBusy, promoBusy]);

  const planModalTitle = useMemo(() => {
    if (!planModal) return "";
    switch (planModal.kind) {
      case "checkout":
        return `Subscribe to ${tierLabel(planModal.tier)}`;
      case "confirm_upgrade":
        return `Upgrade to ${tierLabel(planModal.target)}`;
      case "confirm_downgrade":
        return `Switch to ${tierLabel(planModal.target)}`;
      case "confirm_annual":
        return "Switch to annual billing";
      case "annual_to_monthly":
        return "Switch to monthly billing";
      case "cancel_plan":
        return "Before you cancel";
      default:
        return "";
    }
  }, [planModal]);

  const scheduledBillingChange =
    sub?.scheduledDowngrade &&
    !sub.cancelAtPeriodEnd &&
    sub.scheduledDowngrade.tier === currentTier &&
    sub.scheduledDowngrade.billing !== currentBilling;

  const showBillingPromo = Boolean(sub && !sub.stripeManaged && !sub.appleManaged);

  /**
   * The interval the manager is already scheduled to move to. Offering an
   * unqualified "Switch to …" for it would re-issue the same schedule; the
   * banner and the "Billing change scheduled" chip already state it.
   */
  const billingChangeAlreadyScheduledFor = (interval: "monthly" | "annual") =>
    Boolean(scheduledBillingChange && sub?.scheduledDowngrade?.billing === interval);

  const openBillingPortal = async () => {
    if (!sub?.stripeManaged || anyBusy) return;
    flushSync(() => setBillingPortalBusy(true));
    try {
      const res = await fetch("/api/stripe/billing-portal", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ returnPath: MANAGER_PLAN_BILLING_RETURN_PATH }),
      });
      const body = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !body.url) {
        showToast(body.error ?? "Could not open billing portal.");
        return;
      }
      continueInCurrentTab(body.url);
    } catch {
      showToast("Network error.");
    } finally {
      setBillingPortalBusy(false);
    }
  };

  const startEmbeddedCheckout = async (tier: "pro" | "business", billingInterval: "monthly" | "annual") => {
    flushSync(() => setBusyTier(tier));
    setPromoCode("");
    setPromoError(null);
    setPlanModal({ kind: "checkout", tier, billing: billingInterval, clientSecret: null, loading: true });
    track("subscription_checkout_started", { tier, billing: billingInterval });
    try {
      const res = await fetch("/api/stripe/checkout-portal", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier, billing: billingInterval, returnBasePath: planBasePath, embedded: true }),
      });
      const body = (await res.json()) as { clientSecret?: string; error?: string };
      if (!res.ok || !body.clientSecret) {
        showToast(body.error ?? "Could not start checkout.");
        setPlanModal(null);
        return;
      }
      setPlanModal({ kind: "checkout", tier, billing: billingInterval, clientSecret: body.clientSecret });
    } catch {
      showToast("Network error.");
      setPlanModal(null);
    } finally {
      setBusyTier(null);
    }
  };

  const applyWaiverPromo = async (
    tier: "pro" | "business",
    billingInterval: "monthly" | "annual",
    code: string,
  ): Promise<boolean> => {
    setPromoError(null);
    flushSync(() => setPromoBusy(true));
    try {
      const res = await fetch("/api/stripe/subscription/update-tier", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier, billing: billingInterval, promo: code }),
      });
      const body = (await res.json()) as { error?: string; message?: string; waiverApplied?: boolean };
      if (!res.ok) {
        setPromoError(body.error ?? "Could not apply promo code.");
        return false;
      }
      setPlanModal(null);
      setPromoCode("");
      showToast(body.message ?? `Promo code applied. You're now on ${tierLabel(tier)}.`);
      await load();
      startTransition(() => router.refresh());
      return true;
    } catch {
      setPromoError("Network error. Try again.");
      return false;
    } finally {
      setPromoBusy(false);
    }
  };

  const applyPromoCode = async () => {
    if (!planModal || planModal.kind !== "checkout" || promoBusy) return;
    const code = promoCode.trim();
    if (!code) {
      setPromoError("Enter a promo code.");
      return;
    }
    await applyWaiverPromo(planModal.tier, planModal.billing, code);
  };

  const setTierViaApi = async (
    tier: ManagerSkuTier,
    opts?: { billingInterval?: "monthly" | "annual"; billingOnly?: boolean },
  ) => {
    if (opts?.billingOnly) flushSync(() => setBillingSyncBusy(true));
    else flushSync(() => setBusyTier(tier));
    try {
      const res = await fetch("/api/stripe/subscription/update-tier", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tier,
          ...(tier !== "free" && sub?.stripeManaged ? { billing: opts?.billingInterval ?? priceView } : {}),
        }),
      });
      const body = (await res.json()) as {
        error?: string;
        message?: string;
        scheduledDowngrade?: boolean;
        cancelAtPeriodEnd?: boolean;
      };
      if (!res.ok) {
        showToast(body.error ?? "Could not update plan.");
        return;
      }
      if (body.message) showToast(body.message);
      else if (opts?.billingOnly) {
        showToast(`Now billed ${opts.billingInterval === "annual" ? "annually" : "monthly"}.`);
      } else if (!body.scheduledDowngrade && !body.cancelAtPeriodEnd) {
        showToast(`You're now on ${tierLabel(tier)}.`);
      }
      await load();
      startTransition(() => router.refresh());
    } catch {
      showToast("Network error.");
    } finally {
      setBusyTier(null);
      setBillingSyncBusy(false);
    }
  };

  const resumeSubscription = async () => {
    if (!sub?.stripeManaged || resumeBusy) return;
    flushSync(() => setResumeBusy(true));
    try {
      const res = await fetch("/api/stripe/subscription/update-tier", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resume: true }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        showToast(body.error ?? "Could not resume subscription.");
        return;
      }
      showToast("Subscription resumed.");
      await load();
      startTransition(() => router.refresh());
    } catch {
      showToast("Network error.");
    } finally {
      setResumeBusy(false);
    }
  };

  const cancelScheduledDowngrade = async () => {
    if (!sub?.stripeManaged || cancelDowngradeBusy) return;
    flushSync(() => setCancelDowngradeBusy(true));
    try {
      const res = await fetch("/api/stripe/subscription/update-tier", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel_downgrade" }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        showToast(body.error ?? "Could not cancel downgrade.");
        return;
      }
      showToast("Scheduled downgrade cancelled.");
      await load();
      startTransition(() => router.refresh());
    } catch {
      showToast("Network error.");
    } finally {
      setCancelDowngradeBusy(false);
    }
  };

  const switchBillingInterval = async (next: "monthly" | "annual") => {
    if (!sub || currentTier === "free" || !sub.stripeManaged || anyBusy) return;
    if (next === currentBilling) return;

    if (next === "monthly" && currentBilling === "annual") {
      setFeedbackReason("");
      setPlanModal({ kind: "annual_to_monthly" });
      return;
    }

    setPlanModal({ kind: "confirm_annual" });
  };

  const confirmAnnualBilling = async () => {
    setPlanModal(null);
    await setTierViaApi(currentTier, { billingInterval: "annual", billingOnly: true });
  };

  const confirmAnnualToMonthly = async () => {
    const reason = feedbackReason.trim();
    if (!reason) {
      showToast("Please tell us why you're switching to monthly billing.");
      return;
    }
    setFeedbackBusy(true);
    try {
      await submitPlanChangeFeedback("Plan: switch from annual to monthly billing", reason);
      setPlanModal(null);
      setFeedbackReason("");
      await setTierViaApi(currentTier, { billingInterval: "monthly", billingOnly: true });
    } catch {
      showToast("Could not send feedback. Try again.");
    } finally {
      setFeedbackBusy(false);
    }
  };

  const confirmCancelPlan = async () => {
    const reason = feedbackReason.trim();
    if (!reason) {
      showToast("Please tell us why you're cancelling.");
      return;
    }
    setFeedbackBusy(true);
    try {
      await submitPlanChangeFeedback(`Plan: cancelled ${tierLabel(currentTier)} subscription`, reason);
      setPlanModal(null);
      setFeedbackReason("");
      await setTierViaApi("free");
    } catch {
      showToast("Could not send feedback. Try again.");
    } finally {
      setFeedbackBusy(false);
    }
  };

  const changePlan = async (target: ManagerSkuTier) => {
    if (!sub || anyBusy || target === currentTier) return;

    if (target === "free" && currentTier !== "free") {
      if (sub.cancelAtPeriodEnd) {
        showToast("Your subscription is already scheduled to cancel at the end of your billing period.");
        return;
      }
      setFeedbackReason("");
      setPlanModal({ kind: "cancel_plan", fromTier: currentTier });
      return;
    }

    if (sub.stripeManaged && target !== "free" && tierRank(target) < tierRank(currentTier)) {
      setPlanModal({ kind: "confirm_downgrade", target });
      return;
    }

    const paidTarget = target as "pro" | "business";
    if (!sub.stripeManaged) {
      const code = promoCode.trim();
      if (code) {
        flushSync(() => setBusyTier(paidTarget));
        await applyWaiverPromo(paidTarget, priceView, code);
        setBusyTier(null);
        return;
      }
      await startEmbeddedCheckout(paidTarget, priceView);
      return;
    }

    if (tierRank(paidTarget) > tierRank(currentTier)) {
      setPlanModal({ kind: "confirm_upgrade", target: paidTarget });
      return;
    }

    await setTierViaApi(paidTarget, { billingInterval: priceView });
  };

  const confirmPlanDowngrade = async () => {
    if (!planModal || planModal.kind !== "confirm_downgrade") return;
    const target = planModal.target;
    setPlanModal(null);
    await setTierViaApi(target, { billingInterval: priceView });
  };

  const confirmPlanUpgrade = async () => {
    if (!planModal || planModal.kind !== "confirm_upgrade") return;
    const target = planModal.target;
    setPlanModal(null);
    await setTierViaApi(target, { billingInterval: priceView });
  };

  const planActionLabel = (tierId: ManagerSkuTier): string => {
    if (tierId === currentTier) return "Current plan";
    if (sub?.scheduledDowngrade?.tier === tierId) return "Scheduled";
    if (tierRank(tierId) > tierRank(currentTier)) return `Upgrade to ${tierLabel(tierId)}`;
    return `Switch to ${tierLabel(tierId)}`;
  };

  useEffect(() => {
    if (!embedded || typeof window === "undefined") return;
    if (window.location.hash !== `#${MANAGER_PLAN_PORTAL_SECTION_ID}`) return;
    const id = window.requestAnimationFrame(() => {
      document.getElementById(MANAGER_PLAN_PORTAL_SECTION_ID)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(id);
  }, [embedded]);

  const isTrialBilling = sub?.billing?.toLowerCase().trim() === "trial";

  /** Scheduled-change notice + its actions — must stay reachable in BOTH the
   * full summary card and the compact Settings strip, or a manager who
   * schedules a downgrade from Settings has no way to cancel it there. */
  const pendingChangeBanner =
    sub && sub.stripeManaged && (sub.scheduledDowngrade || sub.cancelAtPeriodEnd) ? (
      <div className="border-t border-[var(--status-pending-bg)] bg-[var(--status-pending-bg)] px-6 py-4 sm:px-8">
        {sub.cancelAtPeriodEnd ? (
          <p className="text-sm text-[var(--status-pending-fg)]">
            <span className="font-semibold">Cancellation scheduled.</span>{" "}
            {renewalLabel
              ? `Paid access ends ${renewalLabel}.`
              : "Paid access ends at the close of your billing period."}
          </p>
        ) : sub.scheduledDowngrade ? (
          <p className="text-sm text-[var(--status-pending-fg)]">
            <span className="font-semibold">
              {scheduledBillingChange ? "Billing change scheduled." : "Downgrade scheduled."}
            </span>{" "}
            {scheduledBillingChange
              ? renewalLabel
                ? `You'll switch to monthly billing on ${renewalLabel}.`
                : "You'll switch to monthly billing at the end of your annual period."
              : renewalLabel
                ? `You'll move to ${tierLabel(sub.scheduledDowngrade.tier as ManagerSkuTier)} (${sub.scheduledDowngrade.billing}) on ${renewalLabel}.`
                : `You'll move to ${tierLabel(sub.scheduledDowngrade.tier as ManagerSkuTier)} at your next renewal.`}
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2">
          {sub.cancelAtPeriodEnd ? (
            <Button
              type="button"
              variant="outline"
              className="rounded-full text-[13px]"
              disabled={resumeBusy}
              onClick={() => resumeSubscription()}
            >
              {resumeBusy ? "Resuming…" : "Keep my plan"}
            </Button>
          ) : null}
          {sub.scheduledDowngrade && !sub.cancelAtPeriodEnd ? (
            <Button
              type="button"
              variant="outline"
              className="rounded-full text-[13px]"
              disabled={cancelDowngradeBusy}
              onClick={() => cancelScheduledDowngrade()}
            >
              {cancelDowngradeBusy ? "Cancelling…" : "Cancel downgrade"}
            </Button>
          ) : null}
        </div>
      </div>
    ) : null;

  /** Compact current-plan strip for the Settings embed (`showCurrentPlan={false}`):
   * the current plan stays clearly marked, with renewal/trial/cancel state and
   * the scheduled-change actions, without the full "Your plan" card. */
  const compactCurrentPlan = sub ? (
    <section className="surface-panel overflow-hidden rounded-2xl border border-border">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-base font-bold tracking-tight text-foreground">{tierLabel(currentTier)}</span>
          <span className="rounded-full bg-primary px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
            Current plan
          </span>
          {isTrialBilling ? (
            <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary">
              Free trial
            </span>
          ) : null}
          {sub.cancelAtPeriodEnd ? (
            <span className="rounded-full bg-[var(--status-pending-bg)] px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--status-pending-fg)]">
              Cancelling
            </span>
          ) : null}
          {sub.scheduledDowngrade && !sub.cancelAtPeriodEnd ? (
            <span className="rounded-full bg-[var(--status-pending-bg)] px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--status-pending-fg)]">
              {scheduledBillingChange ? "Billing change scheduled" : "Downgrade scheduled"}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted">
            {currentTier === "free"
              ? "No subscription"
              : sub.stripeManaged
                ? `Billed ${currentBilling === "annual" ? "annually" : "monthly"}${renewalLabel ? ` · renews ${renewalLabel}` : ""}`
                : isTrialBilling
                  ? "14-day trial · no card on file"
                  : tierTagline(currentTier)}
          </p>
          {sub.stripeManaged && currentTier !== "free" ? (
            <Button
              type="button"
              variant="outline"
              className="h-9 min-h-0 rounded-full px-4 text-[13px]"
              disabled={anyBusy}
              onClick={() => openBillingPortal()}
            >
              {billingPortalBusy ? "Opening…" : "Payment & invoices"}
            </Button>
          ) : null}
        </div>
      </div>
      {pendingChangeBanner}
    </section>
  ) : (
    <div className="h-16 animate-pulse rounded-2xl border border-border bg-accent/30" aria-hidden />
  );

  const planBody = (
    <div
      className={embedded ? "space-y-6" : "mx-auto max-w-5xl space-y-8"}
      id={embedded ? MANAGER_PLAN_PORTAL_SECTION_ID : undefined}
    >
        {!showCurrentPlan ? compactCurrentPlan : null}
        {/* Current plan summary */}
        {showCurrentPlan && (!sub ? (
          <div className="h-36 animate-pulse rounded-2xl border border-border bg-accent/30" aria-hidden />
        ) : (
          <section className="surface-panel overflow-hidden rounded-2xl border border-border shadow-[var(--shadow-card)]">
            <div className="border-b border-border px-6 py-5 sm:px-8">
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted">Your plan</p>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <h2 className="text-2xl font-bold tracking-tight text-foreground">{tierLabel(currentTier)}</h2>
                <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">Active</span>
                {sub.cancelAtPeriodEnd ? (
                  <span className="rounded-full bg-[var(--status-pending-bg)] px-3 py-1 text-xs font-semibold text-[var(--status-pending-fg)]">
                    Cancelling
                  </span>
                ) : null}
                {sub.scheduledDowngrade && !sub.cancelAtPeriodEnd ? (
                  <span className="rounded-full bg-[var(--status-pending-bg)] px-3 py-1 text-xs font-semibold text-[var(--status-pending-fg)]">
                    Downgrade scheduled
                  </span>
                ) : null}
              </div>
              <p className="mt-1.5 text-sm text-muted">{tierTagline(currentTier)}</p>
            </div>

            <div className="grid gap-5 px-6 py-5 sm:grid-cols-2 sm:px-8">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">Billing</p>
                {currentTier === "free" ? (
                  <p className="mt-1 text-sm font-medium text-foreground">No subscription</p>
                ) : sub.stripeManaged ? (
                  <p className="mt-1 text-sm font-medium text-foreground">
                    {currentBilling === "annual" ? "Billed annually" : "Billed monthly"}
                    {renewalLabel ? (
                      <>
                        {" "}
                        · Renews <span className="text-muted">{renewalLabel}</span>
                      </>
                    ) : null}
                  </p>
                ) : (
                  <p className="mt-1 text-sm font-medium text-foreground">{tierLabel(currentTier)} (not Stripe-managed)</p>
                )}
              </div>

              <div className="flex flex-wrap items-end gap-2 sm:justify-start">
                {sub.stripeManaged && currentTier !== "free" ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-full text-[13px]"
                    disabled={anyBusy}
                    onClick={() => openBillingPortal()}
                  >
                    {billingPortalBusy ? "Opening…" : "Payment & invoices"}
                  </Button>
                ) : null}
              </div>
            </div>

            {sub.stripeManaged && currentTier !== "free" && !sub.cancelAtPeriodEnd ? (
              <div className="border-t border-border px-6 py-4 sm:px-8">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Billing cycle</p>
                <div className="surface-panel inline-flex items-center gap-1 rounded-full border border-border p-1">
                  <button
                    type="button"
                    disabled={billingSyncBusy}
                    onClick={() => void switchBillingInterval("monthly")}
                    className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
                      currentBilling === "monthly" ? "bg-primary text-primary-foreground" : "text-muted hover:text-foreground"
                    }`}
                  >
                    Monthly
                  </button>
                  <button
                    type="button"
                    disabled={billingSyncBusy}
                    onClick={() => void switchBillingInterval("annual")}
                    className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
                      currentBilling === "annual" ? "bg-primary text-primary-foreground" : "text-muted hover:text-foreground"
                    }`}
                  >
                    Annual
                  </button>
                </div>
                <p className="mt-2 text-xs text-muted">
                  {currentBilling === "annual"
                    ? scheduledBillingChange
                      ? `Monthly billing starts${renewalLabel ? ` on ${renewalLabel}` : " at the end of your annual period"}.`
                      : `On annual billing for one year. Switching to monthly takes effect${renewalLabel ? ` on ${renewalLabel}` : " at the end of your annual period"}.`
                    : "Monthly billing renews each month. Switch to annual anytime for ~20% savings; after one year you can switch back to monthly."}
                </p>
              </div>
            ) : null}

            {pendingChangeBanner}
          </section>
        ))}

        {/* Compare plans */}
        <section aria-labelledby="plan-comparison-heading">
          <div className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 id="plan-comparison-heading" className="text-xl font-semibold tracking-[-0.02em] text-foreground sm:text-2xl">
                Choose the plan that fits your portfolio
              </h2>
              <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted">
                Start with the tools you need today and change plans as your portfolio grows.
              </p>
            </div>
            <div className="surface-panel inline-flex shrink-0 items-center gap-1 rounded-full border border-border p-1 shadow-sm">
              <button
                type="button"
                onClick={() => setPriceView("monthly")}
                className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
                  priceView === "monthly" ? "bg-primary text-white" : "text-muted hover:text-foreground"
                }`}
              >
                Monthly
              </button>
              <button
                type="button"
                onClick={() => setPriceView("annual")}
                className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-semibold transition ${
                  priceView === "annual" ? "bg-primary text-white" : "text-muted hover:text-foreground"
                }`}
              >
                Annual
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                    priceView === "annual" ? "bg-card/20 text-white" : "bg-[var(--status-confirmed-bg)] text-[var(--status-confirmed-fg)]"
                  }`}
                >
                  −20%
                </span>
              </button>
            </div>
          </div>

          {showBillingPromo ? (
            <div className="mt-4 rounded-xl border border-border bg-accent/20 px-4 py-3">
              <label className="text-sm font-semibold text-foreground" htmlFor="billing-plan-promo-code">
                Promo code <span className="font-normal text-muted">(optional)</span>
              </label>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <div className="min-w-40 flex-1">
                  <Input
                    id="billing-plan-promo-code"
                    value={promoCode}
                    onChange={(e) => {
                      setPromoCode(e.target.value);
                      if (promoError) setPromoError(null);
                    }}
                    placeholder="Enter code"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={promoBusy || anyBusy}
                    className="uppercase placeholder:normal-case"
                    data-attr="billing-plan-promo-code-input"
                  />
                </div>
              </div>
              {promoError ? (
                <p className="mt-2 text-xs font-medium text-[var(--status-overdue-fg)]" role="alert">
                  {promoError}
                </p>
              ) : (
                <p className="mt-2 text-xs text-muted">
                  Enter a valid code, then choose Pro or Business — no card required.
                </p>
              )}
            </div>
          ) : null}

          {!sub ? (
            <div className="mt-5 grid gap-4 lg:grid-cols-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-80 animate-pulse rounded-2xl border border-border bg-accent/30" aria-hidden />
              ))}
            </div>
          ) : (
            <div className="mt-6 grid gap-5 lg:grid-cols-3 lg:items-stretch">
              {planTiers.map((t) => {
                const tierId = t.id as ManagerSkuTier;
                const pb = priceView === "monthly" ? t.monthly : t.annual;
                const isCurrent = tierId === currentTier;
                const isScheduled = sub.scheduledDowngrade?.tier === tierId;
                const busyHere = busyTier === tierId;
                const isUpgrade = tierRank(tierId) > tierRank(currentTier);
                const isFeatured = tierId === "pro";
                const actionLabel = planActionLabel(tierId);

                return (
                  <article
                    key={t.id}
                    className={`surface-panel relative flex h-full flex-col rounded-2xl border p-6 transition sm:p-7 ${
                      isCurrent
                        ? "border-primary/50 bg-primary/[0.025] shadow-[0_10px_28px_-18px_rgba(47,107,255,0.55)]"
                        : isFeatured
                          ? "border-primary/35 shadow-[0_10px_28px_-20px_rgba(47,107,255,0.5)]"
                          : "border-border hover:border-primary/30"
                    }`}
                  >
                    {isFeatured && !isCurrent ? (
                      <span className="absolute right-4 top-4 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary">
                        Popular
                      </span>
                    ) : null}

                    <div className="min-h-[28px]">
                      {isCurrent ? (
                        <span className="inline-flex rounded-full bg-primary px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                          Current plan
                        </span>
                      ) : isScheduled ? (
                        <span className="inline-flex rounded-full bg-[var(--status-pending-bg)] px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--status-pending-fg)]">
                          Starts {renewalLabel ?? "at renewal"}
                        </span>
                      ) : (
                        <span className="inline-flex rounded-full bg-accent/30 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted">
                          {t.label}
                        </span>
                      )}
                    </div>

                    <div className="mt-3 flex items-baseline gap-1">
                      <span className="text-3xl font-black tracking-tight text-foreground">{pb.headline}</span>
                      {pb.period ? <span className="text-sm font-medium text-muted">{pb.period}</span> : null}
                    </div>
                    <p className="mt-2 min-h-[4.5rem] text-sm leading-snug text-muted">{pb.sub}</p>

                    <div className="mt-5 min-h-[52px]">
                      {isCurrent ? (
                        sub.stripeManaged &&
                        tierId !== "free" &&
                        !sub.cancelAtPeriodEnd &&
                        priceView !== currentBilling &&
                        !billingChangeAlreadyScheduledFor(priceView) ? (
                          <Button
                            type="button"
                            variant="outline"
                            className="h-[52px] w-full rounded-xl text-[15px] font-semibold"
                            disabled={anyBusy}
                            onClick={() => switchBillingInterval(priceView)}
                          >
                            {billingSyncBusy
                              ? "Processing…"
                              : `Switch to ${priceView === "annual" ? "annual" : "monthly"} billing`}
                          </Button>
                        ) : (
                          <div className="flex h-[52px] items-center justify-center rounded-xl border border-primary/20 bg-primary/5 px-4 text-sm font-semibold text-primary">
                            You&apos;re on this plan
                          </div>
                        )
                      ) : isScheduled ? (
                        <div className="flex h-[52px] items-center justify-center rounded-xl border border-[var(--status-pending-bg)] bg-[var(--status-pending-bg)] px-4 text-sm font-semibold text-[var(--status-pending-fg)]">
                          Downgrade scheduled
                        </div>
                      ) : (
                        <Button
                          type="button"
                          variant={isUpgrade ? "primary" : "outline"}
                          className="h-[52px] w-full rounded-xl text-[15px] font-semibold"
                          disabled={anyBusy && !busyHere}
                          onClick={() => changePlan(tierId)}
                        >
                          {busyHere ? "Processing…" : actionLabel}
                        </Button>
                      )}
                    </div>

                    <ul className="mt-5 space-y-2.5 border-t border-border pt-5">
                      {t.features.map((f) => (
                        <li key={f.text} className="flex items-start gap-2.5 text-sm">
                          <CheckIcon muted={!f.included} />
                          <span className={f.included ? "text-muted" : "text-muted"}>{f.text}</span>
                        </li>
                      ))}
                    </ul>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        {sub && !sub.stripeManaged && !sub.isFree ? (
          <p className="text-center text-xs text-muted">
            Subscribe through the buttons above to manage billing in Stripe.
          </p>
        ) : null}
    </div>
  );

  const planModals = (
      <Modal
        open={planModal !== null}
        title={planModalTitle}
        onClose={closePlanModal}
        panelClassName={planModal?.kind === "checkout" ? "w-full max-w-3xl" : undefined}
      >
        {planModal?.kind === "checkout" ? (
          <div className="space-y-4">
            <p className="text-sm leading-6 text-muted">
              Complete checkout below to activate{" "}
              <span className="font-semibold text-foreground">{tierLabel(planModal.tier)}</span> on your PropLane portal
              {planModal.billing === "annual" ? " with annual billing (~20% savings)." : "."}
              {" "}
              You&apos;ll stay on this page. Billing is handled securely by Stripe.
            </p>
            <SubscriptionCheckoutHint className="text-sm leading-6 text-muted" upgrade />
            <p className="text-sm font-medium text-foreground">
              {planPriceLabel(planTiers, planModal.tier, planModal.billing)}
            </p>
            <div className="rounded-xl border border-border bg-accent/20 px-4 py-3">
              <label className="text-sm font-semibold text-foreground" htmlFor="plan-promo-code">
                Have a promo code?
              </label>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <div className="min-w-40 flex-1">
                  <Input
                    id="plan-promo-code"
                    value={promoCode}
                    onChange={(e) => {
                      setPromoCode(e.target.value);
                      if (promoError) setPromoError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void applyPromoCode();
                      }
                    }}
                    placeholder="Enter code"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={promoBusy}
                    className="uppercase placeholder:normal-case"
                    data-attr="plan-promo-code-input"
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="rounded-full text-[13px]"
                  disabled={promoBusy || !promoCode.trim()}
                  onClick={() => applyPromoCode()}
                  data-attr="plan-promo-code-apply"
                >
                  {promoBusy ? "Applying…" : "Apply"}
                </Button>
              </div>
              {promoError ? (
                <p className="mt-2 text-xs font-medium text-[var(--status-overdue-fg)]" role="alert">
                  {promoError}
                </p>
              ) : (
                <p className="mt-2 text-xs text-muted">
                  A valid code activates {tierLabel(planModal.tier)} instantly. No card required.
                </p>
              )}
            </div>
            {planModal.clientSecret ? (
              <EmbeddedCheckoutMount
                clientSecret={planModal.clientSecret}
                onError={(message) => {
                  showToast(message);
                  setPlanModal(null);
                }}
              />
            ) : (
              <p className="py-8 text-center text-sm text-muted">Preparing secure checkout…</p>
            )}
          </div>
        ) : planModal?.kind === "confirm_upgrade" ? (
          <div className="space-y-4">
            <p className="text-sm leading-6 text-muted">
              Upgrade to <span className="font-semibold text-foreground">{tierLabel(planModal.target)}</span> now? Your
              saved card will be charged with proration. Changes apply immediately in your PropLane portal.
            </p>
            <div className="flex flex-wrap justify-start gap-2">
              <Button type="button" variant="primary" className="rounded-full" onClick={() => confirmPlanUpgrade()}>
                Confirm upgrade
              </Button>
            </div>
          </div>
        ) : planModal?.kind === "confirm_downgrade" ? (
          <div className="space-y-4">
            <p className="text-sm leading-6 text-muted">
              Downgrade to <span className="font-semibold text-foreground">{tierLabel(planModal.target)}</span> at your
              next renewal? You keep <span className="font-semibold text-foreground">{tierLabel(currentTier)}</span>
              {renewalLabel ? (
                <>
                  {" "}
                  until <span className="font-semibold text-foreground">{renewalLabel}</span>
                </>
              ) : (
                " until the end of your billing period"
              )}
              . Here&apos;s what changes:
            </p>
            <DowngradeConsequences target={planModal.target} />
            <div className="flex flex-wrap justify-start gap-2">
              <Button type="button" variant="outline" className="rounded-full" onClick={closePlanModal}>
                Keep {tierLabel(currentTier)}
              </Button>
              <Button type="button" variant="primary" className="rounded-full" onClick={() => confirmPlanDowngrade()}>
                Schedule downgrade
              </Button>
            </div>
          </div>
        ) : planModal?.kind === "confirm_annual" ? (
          <div className="space-y-4">
            <p className="text-sm leading-6 text-muted">
              Switch to annual billing for <span className="font-semibold text-foreground">{tierLabel(currentTier)}</span>?
              You&apos;ll be billed annually (~20% savings). After one year
              {renewalLabel ? (
                <>
                  {" "}
                  on <span className="font-semibold text-foreground">{renewalLabel}</span>
                </>
              ) : (
                " at your next renewal"
              )}
              , you can switch back to monthly billing if you prefer.
            </p>
            <div className="flex flex-wrap justify-start gap-2">
              <Button type="button" variant="outline" className="rounded-full" onClick={closePlanModal}>
                Keep monthly
              </Button>
              <Button type="button" variant="primary" className="rounded-full" onClick={() => confirmAnnualBilling()}>
                Switch to annual
              </Button>
            </div>
          </div>
        ) : planModal?.kind === "annual_to_monthly" ? (
          <div className="space-y-4">
            <p className="text-sm leading-6 text-muted">
              You&apos;re currently on <span className="font-semibold text-foreground">annual billing</span>. Switching to
              monthly will take effect
              {renewalLabel ? (
                <>
                  {" "}
                  on <span className="font-semibold text-foreground">{renewalLabel}</span>
                </>
              ) : (
                " at the end of your current annual period"
              )}
              . You&apos;ll keep annual billing until then.
            </p>
            <div className="space-y-2">
              <label className="text-sm font-semibold text-foreground" htmlFor="plan-feedback-reason">
                Why are you switching to monthly billing? *
              </label>
              <Textarea
                id="plan-feedback-reason"
                value={feedbackReason}
                onChange={(e) => setFeedbackReason(e.target.value)}
                rows={4}
                placeholder="Tell us what we could do better…"
              />
              <p className="text-xs text-muted">Your response is sent to the PropLane team as feedback.</p>
            </div>
            <div className="flex flex-wrap justify-start gap-2">
              <Button type="button" variant="outline" className="rounded-full" disabled={feedbackBusy} onClick={closePlanModal}>
                Keep annual
              </Button>
              <Button
                type="button"
                variant="primary"
                className="rounded-full"
                disabled={feedbackBusy}
                onClick={() => confirmAnnualToMonthly()}
              >
                {feedbackBusy ? "Scheduling…" : "Schedule monthly billing"}
              </Button>
            </div>
          </div>
        ) : planModal?.kind === "cancel_plan" ? (
          <div className="space-y-4">
            {sub?.stripeManaged ? (
              <p className="text-sm leading-6 text-muted">
                You&apos;ll keep <span className="font-semibold text-foreground">{tierLabel(planModal.fromTier)}</span>{" "}
                until
                {renewalLabel ? (
                  <>
                    {" "}
                    <span className="font-semibold text-foreground">{renewalLabel}</span>
                  </>
                ) : (
                  " the end of your billing period"
                )}
                , then move to Free. Paid features stay available until then. Nothing changes immediately. When Free
                starts:
              </p>
            ) : (
              // Trial / comped plans have no billing period to run out — the
              // switch to Free happens as soon as it's confirmed. Say so.
              <p className="text-sm leading-6 text-muted">
                Your <span className="font-semibold text-foreground">{tierLabel(planModal.fromTier)}</span>
                {isTrialBilling ? " trial" : " plan"} isn&apos;t billed through Stripe, so this switch takes effect{" "}
                <span className="font-semibold text-foreground">immediately</span>. On Free:
              </p>
            )}
            <DowngradeConsequences target="free" />
            <div className="space-y-2">
              <label className="text-sm font-semibold text-foreground" htmlFor="plan-cancel-reason">
                Why are you cancelling? *
              </label>
              <Textarea
                id="plan-cancel-reason"
                value={feedbackReason}
                onChange={(e) => setFeedbackReason(e.target.value)}
                rows={4}
                placeholder="Tell us what we could do better…"
              />
              <p className="text-xs text-muted">Your response is sent to the PropLane team as feedback.</p>
            </div>
            <div className="flex flex-wrap justify-start gap-2">
              <Button type="button" variant="outline" className="rounded-full" disabled={feedbackBusy} onClick={closePlanModal}>
                Keep my plan
              </Button>
              <Button
                type="button"
                variant="primary"
                className="rounded-full"
                disabled={feedbackBusy}
                onClick={() => confirmCancelPlan()}
              >
                {feedbackBusy ? "Cancelling…" : "Confirm cancellation"}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
  );

  // App Store Guideline 3.1.1: the manager subscription must be purchasable via
  // In-App Purchase inside the iOS app. The web plan UI (cards, prices, Stripe
  // checkout) stays hidden on native via `.native-hide`; in its place we render
  // the StoreKit/RevenueCat purchase surface (`.native-only`). Web is unchanged.
  const nativeNotice = (
    <ManagerPlanNative
      currentTier={currentTier}
      subLoaded={sub != null}
      stripeManaged={Boolean(sub?.stripeManaged)}
      appleManaged={Boolean(sub?.appleManaged)}
      isFree={Boolean(sub?.isFree ?? currentTier === "free")}
      planUnknown={Boolean(sub?.planUnknown)}
      trialActive={isTrialBilling}
      onReload={load}
    />
  );

  if (embedded) {
    return (
      <>
        <div className="native-hide">{planBody}</div>
        {nativeNotice}
        <div className="native-hide">{planModals}</div>
      </>
    );
  }

  return (
    <ManagerPortalPageShell title="Billing">
      <div className="native-hide">{planBody}</div>
      {nativeNotice}
      <div className="native-hide">{planModals}</div>
    </ManagerPortalPageShell>
  );
}
