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
import { VendorDashboardBalanceCard } from "@/components/portal/vendor-dashboard-balance-card";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { portalEmptyCopy } from "@/lib/portal-empty-copy";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { CalendarDays, ListChecks, Wrench, FileText, Mail } from "lucide-react";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  MANAGER_WORK_ORDERS_EVENT,
  readVendorWorkOrderRows,
  syncManagerWorkOrdersFromServer,
} from "@/lib/manager-work-orders-storage";
import { vendorWorkOrderListHref } from "@/lib/portal-detail-routes";
import {
  loadPersistedInbox,
  PORTAL_INBOX_CHANGED_EVENT,
  syncPersistedInboxFromServer,
  VENDOR_INBOX_STORAGE_KEY,
} from "@/lib/portal-inbox-storage";

const BASE = "/vendor";

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

  return (
    <ManagerPortalPageShell
      title="Dashboard"
      hideTitleOnNative
      hideTitleOnMobileNav
    >
      <PortalHomeLayout
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
            <AttentionPanel
              rows={attentionRows}
              hideRowDetail
              emptyCopy="No items need attention."
              rowClassName="flex items-center gap-3 p-4 min-h-[44px]"
              actionClassName="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full border border-border bg-card px-4 text-[12.5px] font-semibold text-foreground transition hover:border-primary/40 hover:text-primary"
            />
            <UpcomingPanel
              rows={upcomingRows}
              nowMs={nowMs}
              calendarHref={`${BASE}/calendar`}
              emptyCopy="No upcoming visits."
              rowLinkClassName="flex min-h-[44px] items-center gap-3 p-4 transition hover:bg-accent/30"
              aside={<PortalIconAction icon={CalendarDays} label="Open calendar" onClick={() => router.push(`${BASE}/calendar`)} data-attr="vendor-dashboard-calendar-open" />}
            />
          </>
        }
        below={
          <>
            <VendorDashboardBalanceCard />
            <section className="space-y-3" data-attr="dashboard-your-jobs">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold tracking-[-0.01em] text-foreground">Services</h2>
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
              // Exactly one create control for "Services": the header icon
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
          </>
        }
      />
    </ManagerPortalPageShell>
  );
}
