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
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { portalEmptyCopy } from "@/lib/portal-empty-copy";
import {
  ManagerPortalPageShell,
  portalDashboardWelcomeSubtitle,
} from "@/components/portal/portal-metrics";
import { Button } from "@/components/ui/button";
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
export function VendorDashboard({ displayName }: { displayName: string }) {
  const router = useRouter();
  const [tick, setTick] = useState(0);
  const [nowTick] = useState(() => Date.now());
  const bump = () => setTick((n) => n + 1);
  const [paymentsConnected, setPaymentsConnected] = useState(false);
  const [needsContact, setNeedsContact] = useState(false);
  const [contactNudgeDismissed, setContactNudgeDismissed] = useState(false);
  const [signupNotice, setSignupNotice] = useState<string | null>(null);

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
      .then((data: { contact?: { phone?: string; smsConsent?: boolean } }) => {
        setNeedsContact(!data.contact?.phone || !data.contact?.smsConsent);
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
      detail: "Set up messaging in Settings",
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
      at: Date.parse(row.scheduledAtIso ?? "") || nowTick,
      href: `${BASE}/calendar`,
    })),
  ];

  const jobCards = openWorkOrders.slice(0, 3);

  return (
    <ManagerPortalPageShell
      title="Dashboard"
      subtitle={portalDashboardWelcomeSubtitle(displayName)}
      hideTitleOnNative
      hideTitleOnMobileNav
      welcomeSubtitle
    >
      <PortalHomeLayout
        banner={
          signupNotice ? (
            <div className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-border bg-card px-4 py-3 shadow-sm" role="status">
              <p className="min-w-0 text-sm font-semibold text-foreground">{signupNotice}</p>
              <Button type="button" variant="outline" className="shrink-0 rounded-full px-3 py-1 text-xs" data-attr="vendor-signup-notice-dismiss" onClick={() => setSignupNotice(null)}>
                Dismiss
              </Button>
            </div>
          ) : null
        }
        kpis={
          <>
            <KpiCard
              label="Open jobs"
              value={String(openWorkOrders.length)}
              detail={openWorkOrders.length === 0 ? "No jobs yet" : "Active services"}
              delta={null}
              href={vendorWorkOrderListHref(BASE, "pending")}
              dataAttr="vendor-dashboard-kpi-jobs"
            />
            <KpiCard
              label="Quotes due"
              value={String(quotesPending.length)}
              detail={quotesPending.length === 0 ? "Nothing waiting" : "Waiting on your price"}
              delta={null}
              href={vendorWorkOrderListHref(BASE, "pending")}
              dataAttr="vendor-dashboard-kpi-quotes"
            />
            <KpiCard
              label="Upcoming visits"
              value={String(upcomingVisits.length)}
              detail={upcomingVisits.length === 0 ? "Nothing scheduled" : "On the calendar"}
              delta={null}
              href={`${BASE}/calendar`}
              dataAttr="vendor-dashboard-kpi-visits"
            />
            <KpiCard
              label="Unread messages"
              value={String(inboxThreads.length)}
              detail={inboxThreads.length === 0 ? "All caught up" : "Needs a reply"}
              delta={null}
              href={`${BASE}/communication/active`}
              dataAttr="vendor-dashboard-kpi-inbox"
            />
          </>
        }
        split={
          <>
            <AttentionPanel rows={attentionRows} />
            <UpcomingPanel rows={upcomingRows} nowMs={nowTick} calendarHref={`${BASE}/calendar`} />
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
                <Link
                  href={vendorWorkOrderListHref(BASE, "pending")}
                  className="inline-flex min-h-10 items-center rounded-lg bg-accent px-3 text-sm font-semibold text-primary transition hover:bg-accent/70"
                  data-attr="vendor-dashboard-manage-jobs"
                >
                  Manage services →
                </Link>
              </div>
            </div>
            {jobCards.length === 0 ? (
              <PortalListEmptyCard
                title={portalEmptyCopy("work-orders.pending").title}
                section="work-orders"
                actions={[
                  {
                    label: "Add",
                    onClick: () => router.push(`${vendorWorkOrderListHref(BASE, "pending")}?add=1`),
                    dataAttr: "vendor-dashboard-empty-add",
                  },
                ]}
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
