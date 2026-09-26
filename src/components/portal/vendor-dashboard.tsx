"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { PortalHomeLayout } from "@/components/portal/portal-home-layout";
import {
  AttentionPanel,
  KpiCard,
  UpcomingPanel,
  type UpcomingRow,
} from "@/components/portal/pro-dashboard-kpis";
import type { ManagerAttentionRow } from "@/lib/manager-attention-queue";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { portalEmptyCopy } from "@/lib/portal-empty-copy";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { Button } from "@/components/ui/button";
import { CalendarDays, ListChecks, Wrench, FileText, Mail } from "lucide-react";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  MANAGER_WORK_ORDERS_EVENT,
  readVendorWorkOrderRows,
  syncManagerWorkOrdersFromServer,
} from "@/lib/manager-work-orders-storage";
import { vendorWorkOrderListHref } from "@/lib/portal-detail-routes";
import { takePendingNotice } from "@/lib/pending-notice";
import {
  loadPersistedInbox,
  PORTAL_INBOX_CHANGED_EVENT,
  syncPersistedInboxFromServer,
  VENDOR_INBOX_STORAGE_KEY,
} from "@/lib/portal-inbox-storage";

const BASE = "/vendor";
const CONTACT_NUDGE_DISMISSED_KEY = "axis_vendor_contact_nudge_dismissed";

function readContactNudgeDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(CONTACT_NUDGE_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function propertyLabel(row: DemoManagerWorkOrderRow): string {
  const unit = row.unit?.trim();
  return unit && unit !== "—" ? `${row.propertyName} · ${unit}` : row.propertyName;
}

/** Vendor Home — same tree as the manager dashboard with vendor numbers. */
export function VendorDashboard({}: { displayName: string }) {
  const router = useRouter();
  const [tick, setTick] = useState(0);
  const [nowMs] = useState(() => Date.now());
  const bump = () => setTick((n) => n + 1);
  const [paymentsConnected, setPaymentsConnected] = useState(false);
  const [needsContact, setNeedsContact] = useState(false);
  const [contactNudgeDismissed, setContactNudgeDismissed] = useState(false);
  const [signupNotice, setSignupNotice] = useState<string | null>(null);
  // STATE-driven, not delivery-driven: a vendor with no linked manager sees this
  // every time they load the dashboard while unlinked — not just once, right
  // after the signup redirect that happened to queue a reason (docs/agents/vendor-portal.md).
  const [unlinked, setUnlinked] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [onboarding, setOnboarding] = useState<{
    businessDone: boolean;
    tradesAreaDone: boolean;
    licenseInsuranceDone: boolean;
    completedAt: string | null;
  } | null>(null);

  useEffect(() => {
    if (isDemoModeActive()) return;
    void fetch("/api/vendor/business-profile", { credentials: "include" })
      .then((r) => r.json())
      .then(
        (data: {
          profile?: {
            businessName?: string;
            trades?: string[];
            serviceArea?: string;
            serviceAreaZips?: string[];
            serviceRadiusMiles?: number | null;
            licenseNumber?: string;
            insuranceProvider?: string;
            onboardingCompletedAt?: string | null;
          };
        }) => {
          const p = data.profile;
          if (!p) return;
          setOnboarding({
            businessDone: Boolean(p.businessName?.trim()),
            tradesAreaDone:
              Boolean(p.trades?.length) &&
              Boolean(p.serviceArea?.trim() || p.serviceAreaZips?.length || p.serviceRadiusMiles != null),
            licenseInsuranceDone: Boolean(p.licenseNumber?.trim() || p.insuranceProvider?.trim()),
            completedAt: p.onboardingCompletedAt ?? null,
          });
        },
      )
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const pending = takePendingNotice(window.location.pathname);
    if (pending) setSignupNotice(pending);
  }, []);

  useEffect(() => {
    void Promise.allSettled([
      syncManagerWorkOrdersFromServer(),
      syncPersistedInboxFromServer(VENDOR_INBOX_STORAGE_KEY),
    ]).then(bump);
    window.addEventListener(MANAGER_WORK_ORDERS_EVENT, bump);
    window.addEventListener(PORTAL_INBOX_CHANGED_EVENT, bump);
    window.addEventListener("storage", bump);
    return () => {
      window.removeEventListener(MANAGER_WORK_ORDERS_EVENT, bump);
      window.removeEventListener(PORTAL_INBOX_CHANGED_EVENT, bump);
      window.removeEventListener("storage", bump);
    };
  }, []);


  useEffect(() => {
    if (isDemoModeActive()) {
      setPaymentsConnected(true);
      return;
    }
    void fetch("/api/vendor/stripe-connect/status", { credentials: "include" })
      .then((r) => r.json())
      .then((data: { paymentReady?: boolean; transfersEnabled?: boolean; payoutsEnabled?: boolean }) => {
        setPaymentsConnected(Boolean(data.paymentReady ?? (data.transfersEnabled && data.payoutsEnabled)));
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    setContactNudgeDismissed(readContactNudgeDismissed());
    if (isDemoModeActive()) return;
    void fetch("/api/vendor/profile", { credentials: "include" })
      .then((r) => r.json())
      .then((data: { linked?: boolean; contact?: { phone?: string; smsConsent?: boolean } }) => {
        setNeedsContact(!data.contact?.phone || !data.contact?.smsConsent);
        setUnlinked(data.linked === false);
      })
      .catch(() => undefined);
  }, []);

  function dismissContactNudge() {
    setContactNudgeDismissed(true);
    try {
      window.localStorage.setItem(CONTACT_NUDGE_DISMISSED_KEY, "1");
    } catch {
      /* ignore */
    }
  }

  const data = useMemo(() => {
    void tick;
    const rows = readVendorWorkOrderRows();
    const openWorkOrders = rows.filter((r) => r.bucket !== "completed");
    const upcomingVisits = rows
      .filter((r) => r.scheduledAtIso && r.bucket !== "completed")
      .sort((a, b) => (a.scheduledAtIso ?? "").localeCompare(b.scheduledAtIso ?? ""));
    const quotesPending = rows
      .filter((r) => r.biddingOpen && !r.biddingResolvedAt)
      .sort((a, b) => (b.biddingOpenedAt ?? "").localeCompare(a.biddingOpenedAt ?? ""));
    const pendingPayouts = rows
      .filter((r) => r.bucket === "completed" && r.automationStatus === "vendor_marked_done" && !r.paidAt)
      .sort((a, b) => (b.vendorMarkedDoneAt ?? b.completedAt ?? "").localeCompare(a.vendorMarkedDoneAt ?? b.completedAt ?? ""));
    const inboxThreads = loadPersistedInbox(VENDOR_INBOX_STORAGE_KEY, [])
      .filter((t) => t.folder === "inbox" && t.unread)
      .slice(0, 5);
    return { openWorkOrders, upcomingVisits, quotesPending, pendingPayouts, inboxThreads };
  }, [tick]);

  const { openWorkOrders, upcomingVisits, quotesPending, pendingPayouts, inboxThreads } = data;
  const payoutItems = paymentsConnected ? pendingPayouts : [];

  const attentionRows: ManagerAttentionRow[] = [];
  if (needsContact && !contactNudgeDismissed) {
    attentionRows.push({
      id: "phone",
      title: "Phone number not set up",
      detail: "Phone",
      actionLabel: "Set up",
      href: `${BASE}/profile`,
      tone: "pending",
    });
  }
  if (quotesPending.length > 0) {
    attentionRows.push({
      id: "quotes",
      title: `${quotesPending.length} ${quotesPending.length === 1 ? "job" : "jobs"} waiting on a quote`,
      detail: quotesPending[0] ? propertyLabel(quotesPending[0]) : "Services",
      actionLabel: "Continue",
      href: vendorWorkOrderListHref(BASE, "pending"),
      tone: "pending",
    });
  }
  if (inboxThreads.length > 0) {
    attentionRows.push({
      id: "inbox",
      title: `${inboxThreads.length} unread ${inboxThreads.length === 1 ? "message" : "messages"}`,
      detail: inboxThreads[0]?.from || "Communication",
      actionLabel: "Reply",
      href: `${BASE}/communication/active`,
      tone: "info",
    });
  }
  if (payoutItems.length > 0) {
    attentionRows.push({
      id: "payouts",
      title: `${payoutItems.length} payout${payoutItems.length === 1 ? "" : "s"} waiting`,
      detail: "Finances",
      actionLabel: "Confirm",
      href: `${BASE}/financials/payouts`,
      tone: "pending",
    });
  }

  const upcomingRows: UpcomingRow[] = [
    ...upcomingVisits.slice(0, 6).map((row) => ({
      id: `visit-${row.id}`,
      kind: "Visit",
      title: row.title,
      detail: propertyLabel(row),
      at: Date.parse(row.scheduledAtIso ?? "") || nowMs,
      href: `${BASE}/calendar`,
    })),
  ];

  const jobCards = openWorkOrders.slice(0, 3);

  // Shown until every item is done — Payout bank reuses the existing payouts
  // connect flow rather than duplicating it here.
  const onboardingChecklistItems = onboarding
    ? [
        { id: "business", label: "Business", done: onboarding.businessDone, href: "/vendor/onboarding" },
        { id: "trades-area", label: "Trades & area", done: onboarding.tradesAreaDone, href: "/vendor/onboarding" },
        { id: "license-insurance", label: "License & insurance", done: onboarding.licenseInsuranceDone, href: "/vendor/onboarding" },
        { id: "payout-bank", label: "Payout bank", done: paymentsConnected, href: `${BASE}/financials/payouts` },
      ]
    : [];
  const onboardingChecklistOpen = onboarding !== null && onboardingChecklistItems.some((item) => !item.done);

  return (
    <ManagerPortalPageShell
      title="Dashboard"
      hideTitleOnNative
      hideTitleOnMobileNav
    >
      <PortalHomeLayout
        banner={
          <>
            {unlinked && !bannerDismissed ? (
              <div className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-border bg-card px-4 py-3 shadow-sm" role="status">
                <p className="min-w-0 text-sm font-semibold text-foreground">
                  {signupNotice ?? "Waiting on a property manager to connect with you."}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  className="shrink-0 rounded-full px-3 py-1 text-xs"
                  data-attr="vendor-signup-notice-dismiss"
                  onClick={() => setBannerDismissed(true)}
                >
                  Dismiss
                </Button>
              </div>
            ) : null}
            {onboardingChecklistOpen ? (
              <div className="rounded-2xl border border-border bg-card p-4" data-attr="vendor-onboarding-checklist">
                <p className="text-sm font-semibold text-foreground">Finish setting up</p>
                <ul className="mt-3 flex flex-wrap gap-2">
                  {onboardingChecklistItems.map((item) => (
                    <li key={item.id}>
                      <Link
                        href={item.href}
                        className="flex min-h-11 items-center gap-2 rounded-full border border-border px-3 text-sm font-medium text-foreground hover:bg-secondary/60"
                        data-attr={`vendor-onboarding-checklist-${item.id}`}
                      >
                        <span
                          aria-hidden
                          className={`size-2 rounded-full ${item.done ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
                        />
                        {item.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        }
        kpis={
          <>
            <KpiCard
              label="Open jobs"
              value={String(openWorkOrders.length)}
              href={vendorWorkOrderListHref(BASE, "pending")}
              dataAttr="vendor-dashboard-kpi-jobs"
              icon={Wrench}
            />
            <KpiCard
              label="Quotes due"
              value={String(quotesPending.length)}
              href={vendorWorkOrderListHref(BASE, "pending")}
              dataAttr="vendor-dashboard-kpi-quotes"
              icon={FileText}
            />
            <KpiCard
              label="Upcoming visits"
              value={String(upcomingVisits.length)}
              href={`${BASE}/calendar`}
              dataAttr="vendor-dashboard-kpi-visits"
              icon={CalendarDays}
            />
            <KpiCard
              label="Unread messages"
              value={String(inboxThreads.length)}
              href={`${BASE}/communication/active`}
              dataAttr="vendor-dashboard-kpi-inbox"
              icon={Mail}
            />
          </>
        }
        split={
          <>
            <AttentionPanel rows={attentionRows} hideRowDetail emptyCopy="No items need attention." />
            <UpcomingPanel
              rows={upcomingRows}
              nowMs={nowMs}
              calendarHref={`${BASE}/calendar`}
              emptyCopy="No upcoming visits."
              aside={<PortalIconAction icon={CalendarDays} label="Open calendar" onClick={() => router.push(`${BASE}/calendar`)} data-attr="vendor-dashboard-calendar-open" />}
            />
          </>
        }
        below={
          <section className="space-y-3" data-attr="dashboard-your-jobs">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold tracking-[-0.01em] text-foreground">Your jobs</h2>
              <div className="flex flex-wrap items-center gap-2">
                <PortalPrimaryIconAction
                  label="Add"
                  data-attr="vendor-dashboard-add"
                  onClick={() => router.push(`${vendorWorkOrderListHref(BASE, "pending")}?add=1`)}
                />
                <PortalIconAction
                  icon={ListChecks}
                  label="Manage services"
                  data-attr="vendor-dashboard-manage-jobs"
                  onClick={() => router.push(vendorWorkOrderListHref(BASE, "pending"))}
                />
              </div>
            </div>
            {jobCards.length === 0 ? (
              // Exactly one create control for "Your jobs": the header icon
              // action above stays the CTA — this card explains the empty
              // state without a second, duplicate "Add" button (C147).
              <PortalListEmptyCard
                title={portalEmptyCopy("work-orders.pending").title}
                section="work-orders"
              />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {jobCards.map((row) => (
                  <Link
                    key={row.id}
                    href={vendorWorkOrderListHref(BASE, "pending")}
                    className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition hover:border-primary/35"
                    data-attr="vendor-dashboard-job-card"
                  >
                    <div className="relative aspect-[16/10] bg-accent">
                      <span className="absolute left-3 top-3 rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold text-primary">
                        {row.bucket === "completed" ? "Done" : row.biddingOpen ? "Quote" : "Scheduled"}
                      </span>
                    </div>
                    <div className="flex flex-col gap-0.5 px-4 py-3">
                      <p className="truncate text-[15px] font-semibold text-foreground">{row.title}</p>
                      <p className="truncate text-sm text-muted">{propertyLabel(row)}</p>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </section>
        }
      />
    </ManagerPortalPageShell>
  );
}
