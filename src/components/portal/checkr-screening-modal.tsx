"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ScreeningInlinePayment } from "@/components/portal/screening-inline-payment";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { track } from "@/lib/analytics/track-client";
import { formatCheckrPrice, sumScreeningOrderCents } from "@/lib/checkr/packages";
import type { CheckrAddOnSlug } from "@/lib/checkr/packages";
import { applyDemoBackgroundCheckResolution } from "@/lib/screening/apply-demo-background-check";
import type { CheckrPackage } from "@/lib/checkr/config";
import type { ApplicationBackgroundCheck } from "@/lib/checkr/types";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { isScreeningTestModeActive } from "@/lib/screening/screening-test-mode";
import { MANAGER_PLAN_PORTAL_URL } from "@/lib/portals/manager-plan-path";
import { applicantDisplayName } from "@/lib/rental-application/applicant-name";
import { BackgroundCheckHouseholdTable } from "@/components/portal/background-check-household-table";
import type { ScreeningSubject } from "@/lib/background-check-subjects";
import type { DemoApplicantRow } from "@/data/demo-portal";

const DEMO_SCREENING_RESOLVE_DELAY_MS = 1800;
const processedScreeningSessions = new Set<string>();

function screeningReturnPath(row: DemoApplicantRow, pathname: string): string {
  if (pathname.includes(encodeURIComponent(row.id)) || pathname.endsWith(`/${row.id}`)) {
    return pathname;
  }
  const bucket = row.bucket ?? "approved";
  return `/portal/applications/${bucket}/${encodeURIComponent(row.id)}`;
}

type PackageOption = {
  slug: CheckrPackage;
  name: string;
  priceCents: number;
  tagline: string;
  features: string[];
  inheritsLabel?: string;
  popular?: boolean;
};

type AddOnOption = {
  slug: CheckrAddOnSlug;
  name: string;
  priceCents: number;
  description: string;
  badge?: string;
};

const DEMO_PACKAGES: PackageOption[] = [
  {
    slug: "starter",
    name: "Starter",
    priceCents: 2499,
    tagline: "Essential checks for landlords just getting started.",
    features: ["Criminal history", "Global watchlist", "Sex offender registry"],
  },
  {
    slug: "essential",
    name: "Essential",
    priceCents: 3499,
    tagline: "Financials, rental history, and background in one report.",
    inheritsLabel: "Starter",
    features: ["Credit report", "Credit score", "Eviction history"],
    popular: true,
  },
  {
    slug: "complete",
    name: "Complete",
    priceCents: 4499,
    tagline: "Income, employment, and asset verification included.",
    inheritsLabel: "Essential",
    features: ["Income verification", "Assets & bank report"],
  },
];

const DEMO_ADD_ONS: AddOnOption[] = [
  {
    slug: "identity_verification",
    name: "Identity protection",
    priceCents: 295,
    description: "Government ID verification to reduce impersonation risk.",
    badge: "New",
  },
];

/**
 * Package picker + confirmation for Checkr Tenant screening orders.
 */
export function CheckrScreeningModal({
  row,
  open,
  onClose,
  onUpdated,
  showPackagePickerInitially = false,
  screeningSubjects = [],
  screeningSubjectId,
  onScreeningSubjectChange,
  cosignerSubmissionId = null,
}: {
  row: DemoApplicantRow | null;
  open: boolean;
  onClose: () => void;
  onUpdated?: () => void;
  /** When true, skip the completed summary and show package/payment immediately (e.g. Run again). */
  showPackagePickerInitially?: boolean;
  screeningSubjects?: ScreeningSubject[];
  screeningSubjectId?: string;
  onScreeningSubjectChange?: (subjectId: string) => void;
  /** When set, the order runs against this co-signer submission instead of the primary applicant. */
  cosignerSubmissionId?: string | null;
}) {
  const { showToast } = useAppUi();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const isDemo = isDemoModeActive() || isScreeningTestModeActive();
  const [configured, setConfigured] = useState(() => isDemo);
  const [screeningAllowed, setScreeningAllowed] = useState(() => isDemo);
  const [packagesLoaded, setPackagesLoaded] = useState(() => isDemo);
  const [packagesLoadError, setPackagesLoadError] = useState<string | null>(null);
  const [packages, setPackages] = useState<PackageOption[]>(() => (isDemo ? DEMO_PACKAGES : []));
  const [addOns, setAddOns] = useState<AddOnOption[]>(() => (isDemo ? DEMO_ADD_ONS : []));
  const [selectedPackage, setSelectedPackage] = useState<CheckrPackage>("essential");
  const [selectedAddOns, setSelectedAddOns] = useState<CheckrAddOnSlug[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bg, setBg] = useState<ApplicationBackgroundCheck | undefined>(() => row?.backgroundCheck);
  const [showPackagePicker, setShowPackagePicker] = useState(showPackagePickerInitially);
  const [checkoutPackage, setCheckoutPackage] = useState<CheckrPackage>("essential");
  const [checkoutAddOns, setCheckoutAddOns] = useState<CheckrAddOnSlug[]>([]);
  const checkoutSelectionReadyRef = useRef(false);
  const demoResolveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    const justOpened = !wasOpenRef.current;
    wasOpenRef.current = true;

    setBg(row?.backgroundCheck);
    setError(null);
    setBusy(false);
    if (justOpened) {
      setSelectedPackage("essential");
      setSelectedAddOns([]);
      setCheckoutPackage("essential");
      setCheckoutAddOns([]);
      checkoutSelectionReadyRef.current = false;
      setShowPackagePicker(showPackagePickerInitially || row?.backgroundCheck?.status !== "complete");
      setPackagesLoaded(isDemo);
      setPackagesLoadError(null);
    }
  }, [open, row?.id, row?.backgroundCheck, showPackagePickerInitially, isDemo]);

  useEffect(() => {
    if (!open || isDemo) return;
    let cancelled = false;
    void fetch("/api/screening/packages", { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? "Could not load screening packages.");
        }
        const body = (await res.json()) as {
          configured?: boolean;
          screeningAllowed?: boolean;
          packages?: PackageOption[];
          addOns?: AddOnOption[];
        };
        if (cancelled) return;
        setConfigured(Boolean(body.configured));
        setScreeningAllowed(body.screeningAllowed !== false);
        if (body.packages?.length) setPackages(body.packages);
        if (body.addOns?.length) setAddOns(body.addOns);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setPackagesLoadError(e instanceof Error ? e.message : "Could not load screening packages.");
      })
      .finally(() => {
        if (!cancelled) setPackagesLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, isDemo]);

  useEffect(() => {
    if (!open || !showPackagePicker) return;
    const delay = checkoutSelectionReadyRef.current ? 350 : 0;
    const timer = window.setTimeout(() => {
      setCheckoutPackage(selectedPackage);
      setCheckoutAddOns([...selectedAddOns]);
      checkoutSelectionReadyRef.current = true;
    }, delay);
    return () => window.clearTimeout(timer);
  }, [open, showPackagePicker, selectedPackage, selectedAddOns]);

  const checkoutSelectionSyncing =
    checkoutPackage !== selectedPackage || checkoutAddOns.join(",") !== selectedAddOns.join(",");

  const handlePaymentComplete = useCallback(
    (backgroundCheck: ApplicationBackgroundCheck) => {
      setBg(backgroundCheck);
      setShowPackagePicker(false);
      showToast(
        backgroundCheck.status === "complete" ? "Screening complete." : "Payment received. Background check is running.",
      );
      onUpdated?.();
      onClose();
    },
    [onClose, onUpdated, showToast],
  );

  useEffect(() => {
    if (!open || !row || bg?.status !== "pending" || isDemo) return;
    let cancelled = false;
    const timer = setInterval(() => {
      // Skip the poll for a hidden/background tab (egress on the free plan).
      if (cancelled || document.hidden) return;
      void fetch("/api/screening/background-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          applicationId: row.id,
          cosignerSubmissionId: cosignerSubmissionId ?? undefined,
          action: "refresh",
        }),
      })
        .then(async (res) => {
          if (cancelled || !res.ok) return;
          const body = (await res.json()) as { backgroundCheck?: ApplicationBackgroundCheck };
          if (!body.backgroundCheck) return;
          setBg(body.backgroundCheck);
          if (body.backgroundCheck.status === "complete") {
            handlePaymentComplete(body.backgroundCheck);
          }
        })
        .catch(() => undefined);
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open, row, bg?.status, isDemo, handlePaymentComplete, cosignerSubmissionId]);

  useEffect(() => () => {
    if (demoResolveTimer.current) clearTimeout(demoResolveTimer.current);
  }, []);

  const returnPath = useMemo(() => (row ? screeningReturnPath(row, pathname) : pathname), [row, pathname]);

  // After embedded Stripe checkout, verify payment and return to the background check tab.
  useEffect(() => {
    if (!open || !row || isDemo) return;
    const screening = searchParams.get("screening");
    if (screening !== "return") return;
    const sessionId = searchParams.get("session_id")?.trim();
    if (!sessionId || processedScreeningSessions.has(sessionId)) return;

    processedScreeningSessions.add(sessionId);

    void (async () => {
      const res = await fetch("/api/screening/checkout-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ sessionId }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        paid?: boolean;
        backgroundCheck?: ApplicationBackgroundCheck;
        error?: string;
      };

      const params = new URLSearchParams(searchParams.toString());
      params.delete("screening");
      params.delete("session_id");
      const query = params.toString();
      router.replace(`${pathname}${query ? `?${query}` : ""}`);

      if (!res.ok || !data.paid || !data.backgroundCheck) {
        const message = data.error ?? "Could not confirm screening payment.";
        setError(message);
        return;
      }
      handlePaymentComplete(data.backgroundCheck);
    })();
  }, [open, row, isDemo, searchParams, pathname, router, handlePaymentComplete]);

  const totalCents = useMemo(
    () => sumScreeningOrderCents(selectedPackage, selectedAddOns, packages, addOns),
    [selectedPackage, selectedAddOns, packages, addOns],
  );

  const selectedPackageOption = useMemo(
    () => packages.find((pkg) => pkg.slug === selectedPackage) ?? null,
    [packages, selectedPackage],
  );

  const selectedAddOnOptions = useMemo(
    () => addOns.filter((addOn) => selectedAddOns.includes(addOn.slug)),
    [addOns, selectedAddOns],
  );

  const toggleAddOn = (slug: CheckrAddOnSlug) => {
    setSelectedAddOns((cur) => (cur.includes(slug) ? cur.filter((s) => s !== slug) : [...cur, slug]));
  };

  const confirm = useCallback(async () => {
    if (!row) return;
    setBusy(true);
    setError(null);
    track("background_check_started", { provider: "checkr", package: selectedPackage });

    if (isDemo) {
      const pending: ApplicationBackgroundCheck = {
        provider: "checkr",
        candidateId: `demo_applicant_${row.id}`,
        reportId: `demo_order_${row.id}`,
        packageSlug: selectedPackage,
        addOnProducts: selectedAddOns.length > 0 ? selectedAddOns : undefined,
        status: "pending",
        result: null,
        orderedAt: new Date().toISOString(),
        simulated: true,
        costCents: 0,
      };
      setBg(pending);
      setBusy(false);
      showToast("Demo screening started. No real charge. Results resolve in a few seconds.");
      if (demoResolveTimer.current) clearTimeout(demoResolveTimer.current);
      demoResolveTimer.current = setTimeout(() => {
        const resolved = applyDemoBackgroundCheckResolution(row, {
          cosignerSubmissionId: cosignerSubmissionId ?? undefined,
          packageSlug: selectedPackage,
          addOnProducts: selectedAddOns,
        });
        setBg(resolved);
        handlePaymentComplete(resolved);
      }, DEMO_SCREENING_RESOLVE_DELAY_MS);
      return;
    }
  }, [row, handlePaymentComplete, showToast, isDemo, selectedPackage, selectedAddOns, cosignerSubmissionId]);

  if (!row) return null;

  const canRun =
    screeningAllowed &&
    configured &&
    (isDemo || Boolean(row.application?.consentCredit)) &&
    bg?.status !== "pending";
  const showInlinePayment = !isDemo && canRun && showPackagePicker;
  const backgroundCheckComplete = bg?.status === "complete";
  const modalTitle = backgroundCheckComplete && !showPackagePicker
    ? `Background check · ${applicantDisplayName(row)}`
    : `Run screening · ${applicantDisplayName(row)}`;

  const activeModalSubjectId = screeningSubjectId ?? row?.id ?? "";

  return (
    <Modal open={open} onClose={onClose} title={modalTitle} panelClassName="max-w-4xl max-h-[min(92vh,56rem)] overflow-y-auto">
      <div className="space-y-5 text-sm">
        {screeningSubjects.length > 1 ? (
          <BackgroundCheckHouseholdTable
            mode="view-only"
            subjects={screeningSubjects}
            viewSubjectId={activeModalSubjectId}
            onViewSubjectChange={(id) => onScreeningSubjectChange?.(id)}
            selectedSubjectIds={new Set([activeModalSubjectId])}
            onSelectedSubjectIdsChange={() => {}}
          />
        ) : null}
        {!packagesLoaded ? (
          <p className="text-muted">Loading screening options…</p>
        ) : packagesLoadError ? (
          <p className="rounded-xl border px-3 py-2 text-xs portal-banner-pending">{packagesLoadError}</p>
        ) : !screeningAllowed ? (
          <>
            <p className="native-hide text-muted">
              Applicant screening requires Pro or Business.{" "}
              <Link href={MANAGER_PLAN_PORTAL_URL} className="font-semibold text-primary hover:underline">
                Upgrade your plan
              </Link>{" "}
              to run background checks.
            </p>
            <p className="native-only text-muted">
              Applicant screening isn&apos;t included on your current plan.
            </p>
          </>
        ) : !configured ? (
          <p className="text-muted">Background checks are not configured. Add CHECKR_API_KEY to enable Checkr Tenant.</p>
        ) : !row.application?.consentCredit && !isDemo ? (
          <p className="text-muted">This applicant has not authorized a background check.</p>
        ) : backgroundCheckComplete && !showPackagePicker ? (
          <div className="space-y-4" data-attr="screening-completed-summary">
            <div className="rounded-2xl border border-border bg-card px-4 py-4">
              <p className="text-base font-semibold text-foreground">Background check already completed</p>
              <p className="mt-2 text-sm text-muted">
                A report is on file for this applicant. Run again to place a new Checkr order — for example to upgrade
                from Starter to Complete — even when applicant details are unchanged.
              </p>
            </div>
            <div className="flex flex-wrap justify-end gap-3">
              <Button type="button" variant="outline" onClick={onClose}>
                Close
              </Button>
              <Button
                type="button"
                data-attr="screening-run-again"
                onClick={() => setShowPackagePicker(true)}
              >
                Run again
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-3">
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted">Select a package</p>
              <div className="grid gap-3 lg:grid-cols-3">
                {packages.map((pkg) => {
                  const active = selectedPackage === pkg.slug;
                  return (
                    <button
                      key={pkg.slug}
                      type="button"
                      data-attr={`screening-package-${pkg.slug}`}
                      className={`rounded-2xl border p-4 text-left transition ${
                        active
                          ? "border-primary bg-primary/10 ring-2 ring-primary/30"
                          : "border-border bg-card hover:border-primary/40"
                      }`}
                      onClick={() => setSelectedPackage(pkg.slug)}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="font-semibold text-foreground">{pkg.name}</p>
                        {pkg.popular ? (
                          <span className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary">
                            Most popular
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 text-lg font-bold tabular-nums text-foreground">
                        {formatCheckrPrice(pkg.priceCents)}
                        <span className="text-xs font-normal text-muted"> / screening</span>
                      </p>
                      <p className="mt-2 text-xs leading-relaxed text-muted">{pkg.tagline}</p>
                      {pkg.inheritsLabel ? (
                        <p className="mt-2 text-xs font-medium text-foreground">Everything in {pkg.inheritsLabel}</p>
                      ) : null}
                      <ul className="mt-2 space-y-1 text-xs text-muted">
                        {pkg.features.map((feature) => (
                          <li key={feature}>· {feature}</li>
                        ))}
                      </ul>
                    </button>
                  );
                })}
              </div>
            </div>

            {addOns.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted">Add-ons</p>
                {addOns.map((addOn) => {
                  const on = selectedAddOns.includes(addOn.slug);
                  return (
                    <label
                      key={addOn.slug}
                      className={`flex cursor-pointer items-start justify-between gap-3 rounded-2xl border p-4 ${
                        on ? "border-primary bg-primary/5" : "border-border bg-card"
                      }`}
                    >
                      <div className="min-w-0">
                        <p className="font-semibold text-foreground">
                          {addOn.name}
                          {addOn.badge ? (
                            <span className="ml-2 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-700 dark:text-amber-300">
                              {addOn.badge}
                            </span>
                          ) : null}
                        </p>
                        <p className="mt-1 text-xs text-muted">{addOn.description}</p>
                        <p className="mt-1 text-xs font-semibold text-primary">+{formatCheckrPrice(addOn.priceCents)} per screening</p>
                      </div>
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 rounded border-border accent-primary"
                        checked={on}
                        onChange={() => toggleAddOn(addOn.slug)}
                        aria-label={`Add ${addOn.name}`}
                      />
                    </label>
                  );
                })}
              </div>
            ) : null}

            <div className="rounded-xl border border-border bg-foreground/5 p-3">
              {isDemo ? (
                <>
                  <p className="font-semibold text-foreground">Demo mode: no real charge</p>
                  <p className="mt-1 text-xs text-muted">
                    Uses Checkr Tenant test scenarios when applicant data matches canned profiles (e.g. Herbert Humphrey,
                    Tim Watkins). Otherwise returns a deterministic clear/consider result.
                  </p>
                </>
              ) : (
                <dl className="space-y-1 text-sm" data-attr="screening-order-summary">
                  {selectedPackageOption ? (
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-muted">{selectedPackageOption.name} package</dt>
                      <dd className="shrink-0 tabular-nums font-medium text-foreground">
                        {formatCheckrPrice(selectedPackageOption.priceCents)}
                      </dd>
                    </div>
                  ) : null}
                  {selectedAddOnOptions.map((addOn) => (
                    <div key={addOn.slug} className="flex items-center justify-between gap-3">
                      <dt className="text-muted">{addOn.name}</dt>
                      <dd className="shrink-0 tabular-nums font-medium text-foreground">
                        +{formatCheckrPrice(addOn.priceCents)}
                      </dd>
                    </div>
                  ))}
                  <div className="flex items-center justify-between gap-3 border-t border-border pt-2">
                    <dt className="font-semibold text-foreground">Total per run</dt>
                    <dd className="shrink-0 tabular-nums text-base font-bold text-foreground">
                      {formatCheckrPrice(totalCents)}
                      {checkoutSelectionSyncing ? (
                        <span className="ml-2 text-xs font-normal text-muted">Updating…</span>
                      ) : null}
                    </dd>
                  </div>
                </dl>
              )}
            </div>

            {showInlinePayment ? (
              checkoutSelectionSyncing ? (
                <div
                  className="flex min-h-[120px] items-center justify-center rounded-2xl border border-border bg-card text-sm text-muted"
                  data-attr="screening-checkout-syncing"
                >
                  Updating payment for your selection…
                </div>
              ) : (
                <ScreeningInlinePayment
                  key={`${row.id}:${cosignerSubmissionId ?? ""}:${checkoutPackage}:${checkoutAddOns.join(",")}`}
                  applicationId={row.id}
                  cosignerSubmissionId={cosignerSubmissionId ?? undefined}
                  packageSlug={checkoutPackage}
                  addOnProducts={checkoutAddOns}
                  returnPath={returnPath}
                  onPaid={handlePaymentComplete}
                  onError={setError}
                />
              )
            ) : null}

            {bg?.status === "pending" ? (
              <p className="rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-foreground">
                Background check in progress. Results usually arrive within a few minutes — you can close this and
                check back later.
              </p>
            ) : null}
          </>
        )}

        {error ? <p className="rounded-xl border px-3 py-2 text-xs portal-banner-pending">{error}</p> : null}

        {bg?.result === "consider" ? (
          <p className="rounded-xl border px-3 py-2 text-xs portal-banner-pending">
            Checkr flagged records to review. Consult the full report and applicable fair-chance rules before any
            adverse action (FCRA).
          </p>
        ) : null}

        <div
          data-portal-detail-actions=""
          className="flex flex-wrap items-center justify-end gap-3 border-t border-border py-6 sm:gap-4"
        >
          {isDemo && bg?.status === "pending" ? (
            <Button
              type="button"
              variant="outline"
              data-attr="update-test-data"
              onClick={() => {
                const resolved = applyDemoBackgroundCheckResolution(row, {
                  cosignerSubmissionId: cosignerSubmissionId ?? undefined,
                  packageSlug: selectedPackage,
                  addOnProducts: selectedAddOns,
                });
                setBg(resolved);
                handlePaymentComplete(resolved);
                showToast("Test screening report updated.");
              }}
            >
              Update test data
            </Button>
          ) : null}
          {screeningAllowed && configured && isDemo && bg?.status !== "pending" ? (
            <Button
              type="button"
              data-attr="run-screening-checkr"
              disabled={busy || !canRun}
              onClick={() => confirm()}
            >
              {busy ? "Starting…" : bg ? "Re-run screening" : "Confirm · $0.00"}
            </Button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
