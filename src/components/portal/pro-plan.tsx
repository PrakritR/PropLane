"use client";

import { usePathname, useRouter } from "next/navigation";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { track } from "@/lib/analytics/track-client";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { AxisLogoMark } from "@/components/brand/axis-logo";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalSettingsGroup, PortalSettingsSection } from "@/components/portal/portal-settings-ui";
import { formatPacificDate } from "@/lib/pacific-time";
import { formatUsdFromCents } from "@/lib/comms-billing/rates";
import { MANAGER_PLAN_TIERS, type ManagerPlanTierDefinition } from "@/data/manager-plan-tiers";
import {
  BUSINESS_MAX_PROPERTIES,
  FREE_MAX_PROPERTIES,
  PRO_MAX_PROPERTIES,
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
import { PlanAdjustSheet, type AdjustablePaidTier, type BillingInterval } from "@/components/portal/pro-plan-adjust-sheet";
import { ManagerUsagePanel, ManagerExtraUsagePanel, useUsageSummary } from "@/components/portal/manager-usage-panel";
import { ManagerPlanAddonsPanel } from "@/components/portal/manager-plan-addons-panel";
import { ManagerPaymentMethodsPanel } from "@/components/portal/manager-payment-methods-panel";
import type { ManagerInvoiceRow } from "@/app/api/manager/invoices/route";
import {
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

function tierLabel(t: ManagerSkuTier): string {
  if (t === "free") return "Free";
  if (t === "pro") return "Pro";
  return "Business";
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
 * What actually happens on a downgrade to Free, stated plainly before it is
 * confirmed. The plan limits are creation gates only (see "Plan entitlements"
 * in AGENTS.md): an over-limit portfolio keeps every listing and co-manager
 * link it already has — the account just can't add MORE until it's under the
 * new cap. Free additionally paywalls the Pro-only sections; the data behind
 * them is kept, not deleted.
 */
function DowngradeConsequences({ target }: { target: ManagerSkuTier }) {
  const cap = tierPropertyCap(target);
  return (
    <ul className="list-disc space-y-1.5 ps-5 text-sm leading-6 text-muted">
      <li>
        Nothing is deleted — every property, resident, lease, payment record, and message you&apos;ve created stays on
        your account.
      </li>
      <li>
        Free includes {cap === 1 ? "1 property listing" : `up to ${cap} property listings`}. If you have more,
        existing listings keep working — you just can&apos;t add new ones until you&apos;re under the limit.
      </li>
      <li>
        On Free, the Residents, Leases, Services, Communication, Finances, Documents, Team (co-managers), and
        Promotion sections are locked behind an upgrade prompt. Everything in them is kept and unlocks again if
        you re-subscribe.
      </li>
      <li>
        Your dedicated phone number &amp; texting are included only with an actively paid Pro or Business
        subscription — downgrading to Free means losing your number.
      </li>
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
      kind: "cancel_plan";
      fromTier: ManagerSkuTier;
    };

/** Settings → Billing & plan → Invoices. Stripe invoices plus credit-purchase
 * receipts, newest first; every "View" link is a server-minted hosted URL. */
function ManagerInvoicesSection() {
  const [invoices, setInvoices] = useState<ManagerInvoiceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/manager/invoices", { credentials: "include", cache: "no-store" });
        const body = (await res.json()) as { invoices?: ManagerInvoiceRow[]; error?: string };
        if (!res.ok) throw new Error(body.error || "Could not load invoices.");
        if (!cancelled) setInvoices(body.invoices ?? []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load invoices.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <PortalSettingsSection title="Invoices">
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {!invoices && !error ? (
        <p role="status" className="text-sm text-muted">
          Loading invoices…
        </p>
      ) : null}
      {invoices && invoices.length === 0 ? <p className="text-sm text-muted">No invoices yet.</p> : null}
      {invoices && invoices.length > 0 ? (
        <PortalSettingsGroup>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-attr="billing-invoices-table">
              <thead>
                <tr className="border-b border-border text-left text-xs font-semibold uppercase tracking-wide text-muted">
                  <th className="px-4 py-2.5 font-semibold">Date</th>
                  <th className="px-4 py-2.5 font-semibold">Total</th>
                  <th className="px-4 py-2.5 font-semibold">Status</th>
                  <th className="px-4 py-2.5 font-semibold" aria-hidden />
                </tr>
              </thead>
              <tbody>
                {invoices.map((row) => (
                  <tr key={row.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-3 whitespace-nowrap">
                      {formatPacificDate(row.date, { month: "short", day: "numeric", year: "numeric" })}
                    </td>
                    <td className="px-4 py-3 tabular-nums">{formatUsdFromCents(row.totalCents)}</td>
                    <td className="px-4 py-3 text-muted">{row.status}</td>
                    <td className="px-4 py-3 text-right">
                      {row.url ? (
                        <a
                          href={row.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-semibold text-primary hover:underline"
                        >
                          View
                        </a>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </PortalSettingsGroup>
      ) : null}
    </PortalSettingsSection>
  );
}

/**
 * `showCurrentPlan` is accepted for signature compatibility with the one
 * caller that still passes it (`portal-profile-client.tsx`'s Settings embed),
 * but the PLAN-0920-1400 page has only one shape now — there is no longer a
 * "compact strip" vs. "full card" distinction to switch between.
 */
export function ManagerPlan(props: { embedded?: boolean; showCurrentPlan?: boolean } = {}) {
  const { embedded = false } = props;
  const router = useRouter();
  const pathname = usePathname();
  const planSettingsPath = MANAGER_PLAN_PORTAL_PATH;
  const { showToast } = useAppUi();
  const { userId, email } = useManagerUserId();
  const [sub, setSub] = useState<SubPayload | null>(null);
  const [priceView, setPriceView] = useState<"monthly" | "annual">("monthly");
  const [planTiers, setPlanTiers] = useState<ManagerPlanTierDefinition[]>(MANAGER_PLAN_TIERS);
  const [busyTier, setBusyTier] = useState<ManagerSkuTier | null>(null);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustBusy, setAdjustBusy] = useState(false);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [cancelDowngradeBusy, setCancelDowngradeBusy] = useState(false);
  const [planModal, setPlanModal] = useState<PlanModalState>(null);
  const [feedbackReason, setFeedbackReason] = useState("");
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [promoCode, setPromoCode] = useState("");
  const [promoBusy, setPromoBusy] = useState(false);
  const [promoError, setPromoError] = useState<string | null>(null);
  const { summary: usageSummary, error: usageError, load: loadUsage } = useUsageSummary();

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
  const isTrialBilling = sub?.billing?.toLowerCase().trim() === "trial";
  const renewalLabel = periodEndLabel(sub?.currentPeriodEnd ?? null);
  const anyBusy = busyTier !== null || adjustBusy || resumeBusy || cancelDowngradeBusy || feedbackBusy;

  useEffect(() => {
    const id = window.setTimeout(() => setPriceView(currentBilling), 0);
    return () => window.clearTimeout(id);
  }, [currentBilling]);

  const checkoutHandledRef = useRef(false);
  const activatePaidHandledRef = useRef(false);
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
        return isTrialBilling
          ? `Activate ${tierLabel(planModal.tier)}`
          : `Subscribe to ${tierLabel(planModal.tier)}`;
      case "cancel_plan":
        return "Before you cancel";
      default:
        return "";
    }
  }, [planModal, isTrialBilling]);

  const scheduledBillingChange =
    sub?.scheduledDowngrade &&
    !sub.cancelAtPeriodEnd &&
    sub.scheduledDowngrade.tier === currentTier &&
    sub.scheduledDowngrade.billing !== currentBilling;

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
        body: JSON.stringify({ tier, billing: billingInterval, returnBasePath: "/portal", embedded: true }),
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

  useEffect(() => {
    if (typeof window === "undefined" || !sub || activatePaidHandledRef.current) return;
    const q = new URLSearchParams(window.location.search);
    if (q.get("activatePaid") !== "1") return;
    activatePaidHandledRef.current = true;
    q.delete("activatePaid");
    const next = `${pathname}${q.toString() ? `?${q.toString()}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", next);
    if (!isTrialBilling || currentTier === "free") return;
    void startEmbeddedCheckout(currentTier as "pro" | "business", priceView);
  }, [sub, isTrialBilling, currentTier, pathname, priceView]);

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
    opts?: { billingInterval?: "monthly" | "annual" },
  ) => {
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
      else if (!body.scheduledDowngrade && !body.cancelAtPeriodEnd) {
        showToast(`You're now on ${tierLabel(tier)}.`);
      }
      await load();
      startTransition(() => router.refresh());
    } catch {
      showToast("Network error.");
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
        showToast(body.error ?? "Could not cancel that change.");
        return;
      }
      showToast("Scheduled change cancelled.");
      await load();
      startTransition(() => router.refresh());
    } catch {
      showToast("Network error.");
    } finally {
      setCancelDowngradeBusy(false);
    }
  };

  /** The Adjust plan sheet's one Confirm action: a same-tier billing switch or
   * a tier change both flow through `setTierViaApi` (upgrade / same-tier
   * annual now, downgrade / annual→monthly scheduled — see
   * `docs/agents/plan-entitlements.md` § Settings → Billing & plan page
   * shape). A not-yet-Stripe-managed account (still on Free, or a comped /
   * waiver account) starts checkout instead. */
  const handleAdjustConfirm = async (target: AdjustablePaidTier, billing: BillingInterval) => {
    if (!sub) return;
    setAdjustBusy(true);
    try {
      if (!sub.stripeManaged) {
        setAdjustOpen(false);
        await startEmbeddedCheckout(target, billing);
        return;
      }
      await setTierViaApi(target, { billingInterval: billing });
      setAdjustOpen(false);
    } finally {
      setAdjustBusy(false);
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

  const openCancelModal = () => {
    if (!sub || anyBusy || currentTier === "free") return;
    if (sub.cancelAtPeriodEnd) {
      showToast("Cancellation is already scheduled.");
      return;
    }
    setFeedbackReason("");
    setPlanModal({ kind: "cancel_plan", fromTier: currentTier });
  };

  const activatePaidPlan = () => {
    if (currentTier === "free") return;
    void startEmbeddedCheckout(currentTier as "pro" | "business", priceView);
  };

  useEffect(() => {
    if (!embedded || typeof window === "undefined") return;
    if (window.location.hash !== `#${MANAGER_PLAN_PORTAL_SECTION_ID}`) return;
    const id = window.requestAnimationFrame(() => {
      document.getElementById(MANAGER_PLAN_PORTAL_SECTION_ID)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(id);
  }, [embedded]);

  const planStatusLabel = isTrialBilling
    ? `Free trial of ${tierLabel(currentTier)}`
    : currentTier === "free"
      ? "Free plan"
      : `${tierLabel(currentTier)} plan`;

  /** The scheduled-change banner and its Undo — the full-cancellation state
   * (`cancelAtPeriodEnd`) is shown in Cancellation below instead, so this
   * banner is only for a still-active plan moving to a different tier or
   * billing interval at the next renewal. */
  const pendingChangeBanner =
    sub && sub.stripeManaged && sub.scheduledDowngrade && !sub.cancelAtPeriodEnd ? (
      <div className="border-t border-[var(--status-pending-bg)] bg-[var(--status-pending-bg)] px-4 py-3.5">
        <p className="text-sm text-[var(--status-pending-fg)]" data-attr="billing-scheduled-change-banner">
          {scheduledBillingChange
            ? renewalLabel
              ? `Billing changes to monthly on ${renewalLabel}.`
              : "Billing changes to monthly at your next renewal."
            : renewalLabel
              ? `Your plan changes to ${tierLabel(sub.scheduledDowngrade.tier as ManagerSkuTier)} on ${renewalLabel}.`
              : `Your plan changes to ${tierLabel(sub.scheduledDowngrade.tier as ManagerSkuTier)} at your next renewal.`}
        </p>
        <div className="mt-2.5">
          <Button
            type="button"
            variant="outline"
            className="rounded-full text-[13px]"
            disabled={cancelDowngradeBusy}
            onClick={() => cancelScheduledDowngrade()}
          >
            {cancelDowngradeBusy ? "Undoing…" : "Undo"}
          </Button>
        </div>
      </div>
    ) : null;

  const planBody = (
    <div
      className={embedded ? "space-y-8" : "mx-auto max-w-3xl space-y-8"}
      id={embedded ? MANAGER_PLAN_PORTAL_SECTION_ID : undefined}
    >
      <PortalSettingsSection title="Plan">
        {!sub ? (
          <div className="h-24 animate-pulse rounded-2xl border border-border bg-accent/30" aria-hidden />
        ) : (
          <PortalSettingsGroup>
            <div className="flex flex-wrap items-center gap-4 px-4 py-4">
              <AxisLogoMark size="compact" />
              <div className="min-w-0 flex-1">
                <p className="text-base font-bold tracking-tight text-foreground" data-attr="billing-plan-status">
                  {planStatusLabel}
                </p>
                <p className="text-sm text-muted">
                  {currentTier === "free"
                    ? "No subscription"
                    : sub.stripeManaged
                      ? `${currentBilling === "annual" ? "Annual" : "Monthly"}${renewalLabel ? ` · renews ${renewalLabel}` : ""}`
                      : isTrialBilling
                        ? "14-day trial · no card on file"
                        : "Complimentary"}
                </p>
              </div>
              {isTrialBilling && currentTier !== "free" ? (
                <Button
                  type="button"
                  variant="primary"
                  className="rounded-full text-[13px]"
                  disabled={anyBusy}
                  onClick={() => activatePaidPlan()}
                  data-attr="billing-activate-paid-plan"
                >
                  Activate paid plan
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  className="rounded-full text-[13px]"
                  disabled={anyBusy}
                  onClick={() => setAdjustOpen(true)}
                  data-attr="billing-adjust-plan"
                >
                  Adjust plan
                </Button>
              )}
            </div>
            {pendingChangeBanner}
          </PortalSettingsGroup>
        )}
      </PortalSettingsSection>

      <ManagerUsagePanel summary={usageSummary} error={usageError} onRefresh={() => void loadUsage()} />
      <ManagerExtraUsagePanel summary={usageSummary} load={loadUsage} />
      <ManagerPlanAddonsPanel />
      <ManagerPaymentMethodsPanel />
      <ManagerInvoicesSection />

      <PortalSettingsSection title="Cancellation">
        {!sub ? null : currentTier === "free" ? (
          <p className="text-sm text-muted">You&apos;re on the Free plan.</p>
        ) : sub.cancelAtPeriodEnd ? (
          <PortalSettingsGroup>
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
              <p className="text-sm text-foreground">
                {renewalLabel ? `Cancellation scheduled · ends ${renewalLabel}.` : "Cancellation scheduled."}
              </p>
              <Button
                type="button"
                variant="outline"
                className="rounded-full text-[13px]"
                disabled={resumeBusy}
                onClick={() => resumeSubscription()}
              >
                {resumeBusy ? "Resuming…" : "Keep my plan"}
              </Button>
            </div>
          </PortalSettingsGroup>
        ) : (
          <PortalSettingsGroup>
            <div className="flex items-center justify-between gap-3 px-4 py-3.5">
              <p className="text-sm text-foreground">
                {renewalLabel ? `Keep ${tierLabel(currentTier)} until ${renewalLabel}, then move to Free.` : `Cancel your ${tierLabel(currentTier)} plan.`}
              </p>
              <Button type="button" variant="danger" onClick={() => openCancelModal()} data-attr="billing-cancel-plan">
                Cancel plan
              </Button>
            </div>
          </PortalSettingsGroup>
        )}
      </PortalSettingsSection>
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
            ) : null}
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
  // In-App Purchase inside the iOS app. The web plan UI (Adjust plan, Stripe
  // checkout) stays hidden on native via `.native-hide`; in its place we
  // render the StoreKit/RevenueCat purchase surface (`.native-only`). Web is
  // unchanged.
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

  const adjustSheet = sub ? (
    <PlanAdjustSheet
      open={adjustOpen}
      onClose={() => setAdjustOpen(false)}
      currentTier={currentTier}
      currentBilling={currentBilling}
      renewalLabel={renewalLabel}
      busy={adjustBusy}
      onConfirm={(target, billing) => void handleAdjustConfirm(target, billing)}
    />
  ) : null;

  if (embedded) {
    return (
      <>
        <div className="native-hide">{planBody}</div>
        {nativeNotice}
        <div className="native-hide">
          {planModals}
          {adjustSheet}
        </div>
      </>
    );
  }

  return (
    <ManagerPortalPageShell title="Billing">
      <div className="native-hide">{planBody}</div>
      {nativeNotice}
      <div className="native-hide">
        {planModals}
        {adjustSheet}
      </div>
    </ManagerPortalPageShell>
  );
}
