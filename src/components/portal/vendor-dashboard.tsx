"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { PortalHomeLayout } from "@/components/portal/portal-home-layout";
import {
  AttentionPanel,
  KpiCard,
  UpcomingPanel,
  dayLabel,
  type UpcomingRow,
} from "@/components/portal/pro-dashboard-kpis";
import type { ManagerAttentionRow } from "@/lib/manager-attention-queue";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { VendorDashboardBalanceCard } from "@/components/portal/vendor-dashboard-balance-card";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { portalEmptyCopy } from "@/lib/portal-empty-copy";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { CalendarDays, Clock, Wrench, FileText, Mail } from "lucide-react";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalRowFact, PortalServiceRecordRow } from "@/components/portal/portal-record-row";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  MANAGER_WORK_ORDERS_EVENT,
  readVendorWorkOrderRows,
  syncManagerWorkOrdersFromServer,
} from "@/lib/manager-work-orders-storage";
import { vendorJobDetailHref, vendorWorkOrderListHref } from "@/lib/portal-detail-routes";
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
    const bidsPending = rows
      .filter((r) => r.biddingOpen && !r.biddingResolvedAt)
      .sort((a, b) => (b.biddingOpenedAt ?? "").localeCompare(a.biddingOpenedAt ?? ""));
    const pendingPayouts = rows
      .filter((r) => r.bucket === "completed" && r.automationStatus === "vendor_marked_done" && !r.paidAt)
      .sort((a, b) => (b.vendorMarkedDoneAt ?? b.completedAt ?? "").localeCompare(a.vendorMarkedDoneAt ?? b.completedAt ?? ""));
    const inboxThreads = loadPersistedInbox(VENDOR_INBOX_STORAGE_KEY, [])
      .filter((t) => t.folder === "inbox" && t.unread)
      .slice(0, 5);
    return { openWorkOrders, upcomingVisits, bidsPending, pendingPayouts, inboxThreads };
  }, [tick]);

  const { openWorkOrders, upcomingVisits, bidsPending, pendingPayouts, inboxThreads } = data;
  const payoutItems = paymentsConnected ? pendingPayouts : [];

  const attentionRows: ManagerAttentionRow[] = [];
  if (bidsPending.length > 0) {
    attentionRows.push({
      id: "bids",
      title: `${bidsPending.length} ${bidsPending.length === 1 ? "job" : "jobs"} waiting on a bid`,
      detail: bidsPending[0] ? propertyLabel(bidsPending[0]) : "Services",
      actionLabel: "Continue",
      href: vendorWorkOrderListHref(BASE, "open"),
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

  // The sub-line under "Upcoming visits": when the next one is, from the same
  // scheduled stamp the Upcoming panel sorts on. Omitted when nothing is booked.
  const nextVisitMs = upcomingRows[0] ? Math.min(...upcomingRows.map((r) => r.at)) : null;
  const nextVisitLabel = nextVisitMs
    ? (() => {
        const { day, time } = dayLabel(nextVisitMs, nowMs);
        return `Next: ${day}${time ? ` ${time}` : ""}`;
      })()
    : undefined;

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
              href={vendorWorkOrderListHref(BASE, "open")}
              dataAttr="vendor-dashboard-kpi-jobs"
              icon={Wrench}
            />
            <KpiCard
              label="Bids due"
              value={String(bidsPending.length)}
              href={vendorWorkOrderListHref(BASE, "open")}
              dataAttr="vendor-dashboard-kpi-bids"
              icon={FileText}
            />
            <KpiCard
              label="Upcoming visits"
              value={String(upcomingVisits.length)}
              unit={nextVisitLabel}
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
              rowClassName="flex min-h-[44px] items-center gap-2.5 px-3.5 py-2.5"
              actionClassName="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-[7px] border border-border bg-card px-3 text-[13px] font-[550] text-foreground transition hover:bg-[var(--secondary)] lg:min-h-8"
            />
            <UpcomingPanel
              rows={upcomingRows}
              nowMs={nowMs}
              calendarHref={`${BASE}/calendar`}
              emptyCopy="No upcoming visits."
              rowLinkClassName="flex min-h-[44px] items-center gap-2.5 px-3.5 py-2.5 transition hover:bg-[var(--secondary)]"
              aside={null}
            />
          </>
        }
        below={
          <>
            <VendorDashboardBalanceCard />
            <section className="space-y-3" data-attr="dashboard-your-jobs">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-[15px] font-[650] text-foreground">Services</h2>
              <div className="flex flex-wrap items-center gap-2">
                <PortalPrimaryIconAction
                  label="Add"
                  data-attr="vendor-dashboard-add"
                  onClick={() => router.push(`${vendorWorkOrderListHref(BASE, "open")}?add=1`)}
                />
              </div>
            </div>
            {jobCards.length === 0 ? (
              // Exactly one create control for "Services": the header icon
              // action above stays the CTA — this card explains the empty
              // state without a second, duplicate "Add" button (C147).
              <PortalListEmptyCard
                title={portalEmptyCopy("work-orders.open").title}
                section="work-orders"
              />
            ) : (
              <PortalRecordListSurface isEmpty={false} dataAttr="vendor-dashboard-services">
                {jobCards.map((row) => (
                  <PortalServiceRecordRow
                    key={row.id}
                    title={row.title}
                    subtitle={propertyLabel(row)}
                    facts={
                      row.biddingOpen && row.bucket !== "completed" ? (
                        <PortalRowFact icon={Clock}>Bid needed</PortalRowFact>
                      ) : (
                        <PortalRowFact icon={CalendarDays}>
                          {row.bucket === "completed" ? "Done" : row.scheduled && row.scheduled !== "—" ? row.scheduled : "Scheduled"}
                        </PortalRowFact>
                      )
                    }
                    onOpen={() => router.push(vendorJobDetailHref(BASE, row.id))}
                    dataAttr="vendor-dashboard-job-card"
                  />
                ))}
              </PortalRecordListSurface>
            )}
            </section>
          </>
        }
      />
    </ManagerPortalPageShell>
  );
}
