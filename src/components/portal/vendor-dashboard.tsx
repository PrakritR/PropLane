"use client";

import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { useIsNativeApp } from "@/hooks/use-is-native-app";
import {
  ManagerPortalPageShell,
  portalDashboardWelcomeSubtitle,
  PortalDashboardSectionHeader,
  PORTAL_DASHBOARD_STACK,
  PortalDashboardKpiRow,
  PortalDashboardKpiTile,
  PORTAL_DASHBOARD_SECTION_CARD,
} from "@/components/portal/portal-metrics";
import {
  PortalPreviewOverflowLink,
  usePortalPreviewSlice,
} from "@/components/portal/portal-data-table";
import { Button } from "@/components/ui/button";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  MANAGER_WORK_ORDERS_EVENT,
  readVendorWorkOrderRows,
  syncManagerWorkOrdersFromServer,
} from "@/lib/manager-work-orders-storage";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { takePendingNotice } from "@/lib/pending-notice";
import {
  loadPersistedInbox,
  PORTAL_INBOX_CHANGED_EVENT,
  syncPersistedInboxFromServer,
  VENDOR_INBOX_STORAGE_KEY,
} from "@/lib/portal-inbox-storage";
import { usePortalSession } from "@/hooks/use-portal-session";
import { formatRangeLabel } from "@/lib/demo-admin-scheduling";
import { compactTaskLocationLabel } from "@/lib/manager-task-display";
import {
  fetchVendorAssignedTasks,
  VENDOR_TASKS_EVENT,
  type VendorAssignedTask,
} from "@/lib/vendor-tasks.client";

const BASE = "/vendor";

/** Semantic status foreground tokens for the leading issue-row dots. */
const DOT_PENDING = "var(--status-pending-fg)";
const DOT_CONFIRMED = "var(--status-confirmed-fg)";
const DOT_INFO = "var(--status-approved-fg)";

type PillTone = "pending" | "success" | "danger" | "info";

/** Small theme-aware status pill (light/dark flip via `.portal-badge-*`). */
function StatusPill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold portal-badge-${tone} [html[data-native]_&]:text-[9px]`}
    >
      {children}
    </span>
  );
}

/** Dense Linear "issue" row: status dot · label + subtitle · meta · status pill · chevron. */
function IssueRow({
  href,
  dot,
  title,
  subtitle,
  meta,
  pill,
  dataAttr,
}: {
  href: string;
  dot?: string;
  title: string;
  subtitle?: string;
  meta?: string | null;
  pill?: ReactNode;
  dataAttr?: string;
}) {
  return (
    <Link
      href={href}
      data-attr={dataAttr}
      className="group flex items-center gap-3 px-3.5 py-2.5 transition-colors duration-150 hover:bg-[var(--secondary)] [html[data-native]_&]:gap-2.5 [html[data-native]_&]:px-3 [html[data-native]_&]:py-2"
    >
      {dot ? (
        <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: dot }} />
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-foreground [html[data-native]_&]:text-[13px]">
          {title}
        </span>
        {subtitle ? (
          <span className="mt-0.5 block truncate text-xs text-muted [html[data-native]_&]:text-[11px]">
            {subtitle}
          </span>
        ) : null}
      </span>
      {meta ? (
        <span className="hidden shrink-0 whitespace-nowrap text-xs tabular-nums text-muted sm:block">
          {meta}
        </span>
      ) : null}
      {pill ? <span className="shrink-0">{pill}</span> : null}
      <span
        aria-hidden
        className="shrink-0 text-sm text-muted/40 transition-colors group-hover:text-muted [html[data-native]_&]:hidden"
      >
        ›
      </span>
    </Link>
  );
}

/**
 * One "Needs attention" group: tiny uppercase label + section link, then a
 * hairline-bordered stack of dense issue rows (preview-sliced so native/mobile
 * row limits + overflow link are preserved).
 */
function AttentionGroup<T>({
  title,
  href,
  linkLabel,
  badge,
  dataAttr,
  items,
  keyForItem,
  renderRow,
}: {
  title: string;
  href: string;
  linkLabel: string;
  badge?: ReactNode;
  dataAttr?: string;
  items: T[];
  keyForItem: (item: T) => string;
  renderRow: (item: T) => ReactNode;
}) {
  const { visible, overflow } = usePortalPreviewSlice(items);
  const { isNative } = useIsNativeApp();

  if (items.length === 0) return null;

  return (
    <div className="space-y-2 [html[data-native]_&]:space-y-1.5">
      <PortalDashboardSectionHeader
        title={title}
        href={href}
        linkLabel={linkLabel}
        badge={badge}
        dataAttr={dataAttr}
      />
      {items.length === 0 ? null : (
        <>
          <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {visible.map((item) => (
              <Fragment key={keyForItem(item)}>{renderRow(item)}</Fragment>
            ))}
          </div>
          <PortalPreviewOverflowLink
            overflow={overflow}
            href={href}
            label={isNative ? `View all (${items.length}) →` : undefined}
          />
        </>
      )}
    </div>
  );
}

const CONTACT_NUDGE_DISMISSED_KEY = "axis_vendor_contact_nudge_dismissed";

function readContactNudgeDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(CONTACT_NUDGE_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function fmt(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "soon";
  return formatPacificDateTime(d);
}

function propertyLabel(row: DemoManagerWorkOrderRow): string {
  const unit = row.unit?.trim();
  return unit && unit !== "—" ? `${row.propertyName} · ${unit}` : row.propertyName;
}

function taskScheduleLabel(task: VendorAssignedTask): string {
  if (task.start && task.end) return formatRangeLabel(task.start, task.end);
  if (task.start) return fmt(task.start);
  return "No schedule";
}

/** Vendor Home — KPI row + Needs attention across Services, Tasks, Calendar, Payments, and Communication. */
export function VendorDashboard({ displayName }: { displayName: string }) {
  const router = useRouter();
  const { userId } = usePortalSession();
  const [tick, setTick] = useState(0);
  const [assignedTasks, setAssignedTasks] = useState<VendorAssignedTask[]>([]);
  const bump = () => setTick((n) => n + 1);
  const [paymentsConnected, setPaymentsConnected] = useState(false);
  const [needsContact, setNeedsContact] = useState(false);
  const [contactNudgeDismissed, setContactNudgeDismissed] = useState(false);
  const [signupNotice, setSignupNotice] = useState<string | null>(null);

  // Signup can only tell the vendor WHY they arrived without a linked manager
  // by handing the message to this page — the redirect that gets them here
  // destroys anything shown before it. Rendered until they dismiss it: it is a
  // standing fact about their account plus an action they have to take, not a
  // confirmation that can auto-expire out from under them.
  //
  // The read is destructive, so only ever overwrite state when it yields a
  // message: StrictMode double-invokes this effect with state preserved, and an
  // unconditional assign let the second (empty) pass wipe what the first read.
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
    window.addEventListener(VENDOR_TASKS_EVENT, bump);
    window.addEventListener("storage", bump);
    return () => {
      window.removeEventListener(MANAGER_WORK_ORDERS_EVENT, bump);
      window.removeEventListener(PORTAL_INBOX_CHANGED_EVENT, bump);
      window.removeEventListener(VENDOR_TASKS_EVENT, bump);
      window.removeEventListener("storage", bump);
    };
  }, []);

  useEffect(() => {
    if (!userId) {
      setAssignedTasks([]);
      return;
    }
    void fetchVendorAssignedTasks(userId)
      .then(setAssignedTasks)
      .catch(() => setAssignedTasks([]));
  }, [userId, tick]);

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
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(CONTACT_NUDGE_DISMISSED_KEY, "1");
    } catch {
      /* ignore */
    }
  }

  const data = useMemo(() => {
    void tick;
    const rows = readVendorWorkOrderRows();

    const openWorkOrders = rows.filter((r) => r.bucket === "open");

    const upcomingVisits = rows
      .filter((r) => r.scheduledAtIso && r.bucket !== "completed")
      .sort((a, b) => (a.scheduledAtIso ?? "").localeCompare(b.scheduledAtIso ?? ""));

    const quotesPending = rows
      .filter((r) => r.biddingOpen && !r.biddingResolvedAt)
      .sort((a, b) => (b.biddingOpenedAt ?? "").localeCompare(a.biddingOpenedAt ?? ""));

    const pendingPayouts = rows
      .filter((r) => r.bucket === "completed" && r.automationStatus === "vendor_marked_done" && !r.paidAt)
      .sort((a, b) => (b.vendorMarkedDoneAt ?? b.completedAt ?? "").localeCompare(a.vendorMarkedDoneAt ?? a.completedAt ?? ""));

    const inboxThreads = loadPersistedInbox(VENDOR_INBOX_STORAGE_KEY, [])
      .filter((t) => t.folder === "inbox" && t.unread)
      .slice(0, 5);

    return { openWorkOrders, upcomingVisits, quotesPending, pendingPayouts, inboxThreads };
  }, [tick]);

  const { openWorkOrders, upcomingVisits, quotesPending, pendingPayouts, inboxThreads } = data;

  const openTasks = useMemo(
    () => assignedTasks.filter((task) => !task.completed),
    [assignedTasks],
  );

  const payoutItems = paymentsConnected ? pendingPayouts : [];

  const openCount =
    quotesPending.length +
    upcomingVisits.length +
    payoutItems.length +
    inboxThreads.length +
    openTasks.length;

  return (
    <ManagerPortalPageShell
      title="Dashboard"
      subtitle={portalDashboardWelcomeSubtitle(displayName)}
      hideTitleOnNative
      hideTitleOnMobileNav
      welcomeSubtitle
    >
      <div className={PORTAL_DASHBOARD_STACK}>
        {signupNotice ? (
          <div className={PORTAL_DASHBOARD_SECTION_CARD} role="status">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">You&apos;re not linked to a manager yet</p>
                <p className="mt-1 text-sm text-muted">{signupNotice}</p>
              </div>
              <Button
                type="button"
                variant="outline"
                className="shrink-0 rounded-full px-3 py-1 text-xs"
                data-attr="vendor-signup-notice-dismiss"
                onClick={() => setSignupNotice(null)}
              >
                Dismiss
              </Button>
            </div>
          </div>
        ) : null}
        {/* Prompt the vendor to add a phone for job-offer texts (from vendor dispatch). */}
        {needsContact && !contactNudgeDismissed ? (
          <div className={PORTAL_DASHBOARD_SECTION_CARD}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">Get job offers by text</p>
                <p className="mt-1 text-sm text-muted">
                  Add your phone number so managers and PropLane can reach you about jobs.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  type="button"
                  variant="primary"
                  data-attr="vendor-contact-nudge-add-phone"
                  onClick={() => router.push(`${BASE}/profile`)}
                >
                  Add phone
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="shrink-0 rounded-full px-3 py-1 text-xs"
                  onClick={dismissContactNudge}
                >
                  Dismiss
                </Button>
              </div>
            </div>
          </div>
        ) : null}
        <PortalDashboardKpiRow>
            <PortalDashboardKpiTile
              label="Open work orders"
              value={openWorkOrders.length}
              tone={openWorkOrders.length > 0 ? "warning" : "neutral"}
              emphasis={openWorkOrders.length > 0}
              href={`${BASE}/work-orders`}
              dataAttr="vendor-dashboard-kpi-work-orders"
            />
            <PortalDashboardKpiTile
              label="Awaiting quote"
              value={quotesPending.length}
              tone="brand"
              emphasis={quotesPending.length > 0}
              href={`${BASE}/work-orders`}
              dataAttr="vendor-dashboard-kpi-quotes"
            />
            <PortalDashboardKpiTile
              label="Scheduled visits"
              value={upcomingVisits.length}
              tone={upcomingVisits.length > 0 ? "success" : "neutral"}
              emphasis={upcomingVisits.length > 0}
              href={`${BASE}/calendar`}
              dataAttr="vendor-dashboard-kpi-visits"
            />
            <PortalDashboardKpiTile
              label="Pending payouts"
              value={payoutItems.length}
              tone={payoutItems.length > 0 ? "warning" : "success"}
              emphasis={payoutItems.length > 0}
              href={`${BASE}/payments`}
              dataAttr="vendor-dashboard-kpi-payouts"
            />
            <PortalDashboardKpiTile
              label="Tasks"
              value={openTasks.length}
              tone={openTasks.length > 0 ? "brand" : "neutral"}
              emphasis={openTasks.length > 0}
              href={`${BASE}/tasks`}
              dataAttr="vendor-dashboard-kpi-tasks"
            />
            <PortalDashboardKpiTile
              label="Unread messages"
              value={inboxThreads.length}
              tone={inboxThreads.length > 0 ? "brand" : "neutral"}
              emphasis={inboxThreads.length > 0}
              href={`${BASE}/communication/active`}
              dataAttr="vendor-dashboard-kpi-inbox"
            />
        </PortalDashboardKpiRow>

        {/* Needs attention — only groups with items render (no empty-state boxes). */}
        {openCount > 0 ? (
        <div className="space-y-4 [html[data-native]_&]:space-y-3">
          <div className="flex items-center gap-2">
            <span aria-hidden className="text-primary">
              ✦
            </span>
            <h2 className="text-sm font-semibold tracking-[-0.01em] text-foreground">Needs attention</h2>
            {openCount > 0 ? (
              <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-border bg-[var(--secondary)] px-2.5 py-0.5 text-[11px] font-medium text-muted">
                <span aria-hidden className="size-1.5 rounded-full" style={{ background: DOT_CONFIRMED }} />
                {openCount} open
              </span>
            ) : null}
          </div>

          <AttentionGroup
            title="Services"
            href={`${BASE}/work-orders`}
            linkLabel="Services →"
            dataAttr="vendor-dashboard-services-link"
            badge={
              quotesPending.length > 0 ? (
                <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold tabular-nums text-[var(--status-pending-fg)]">
                  <span aria-hidden className="size-1.5 rounded-full bg-current" />
                  {quotesPending.length} pending
                </span>
              ) : null
            }
            items={quotesPending}
            keyForItem={(row) => row.id}
            renderRow={(row: DemoManagerWorkOrderRow) => (
              <IssueRow
                href={`${BASE}/work-orders`}
                dot={DOT_PENDING}
                title={row.title}
                subtitle={propertyLabel(row)}
                pill={<StatusPill tone="pending">Awaiting quote</StatusPill>}
                dataAttr="vendor-dashboard-attention-quote"
              />
            )}
          />

          <AttentionGroup
            title="Upcoming visits"
            href={`${BASE}/calendar`}
            linkLabel="Calendar →"
            dataAttr="vendor-dashboard-calendar-link"
            items={upcomingVisits}
            keyForItem={(row) => row.id}
            renderRow={(row: DemoManagerWorkOrderRow) => {
              const scheduled = row.bucket === "scheduled";
              return (
                <IssueRow
                  href={`${BASE}/calendar`}
                  dot={scheduled ? DOT_CONFIRMED : DOT_PENDING}
                  title={row.title}
                  subtitle={propertyLabel(row)}
                  meta={fmt(row.scheduledAtIso ?? "")}
                  pill={
                    <StatusPill tone={scheduled ? "info" : "pending"}>
                      {scheduled ? "Scheduled" : "Pending"}
                    </StatusPill>
                  }
                  dataAttr="vendor-dashboard-attention-visit"
                />
              );
            }}
          />

          <AttentionGroup
            title="Payouts"
            href={`${BASE}/payments`}
            linkLabel="Payments →"
            dataAttr="vendor-dashboard-payments-link"
            badge={
              payoutItems.length > 0 ? (
                <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold tabular-nums text-[var(--status-pending-fg)]">
                  <span aria-hidden className="size-1.5 rounded-full bg-current" />
                  {payoutItems.length} pending
                </span>
              ) : null
            }
            items={payoutItems}
            keyForItem={(row) => row.id}
            renderRow={(row: DemoManagerWorkOrderRow) => (
              <IssueRow
                href={`${BASE}/payments`}
                dot={DOT_PENDING}
                title={row.title}
                subtitle={propertyLabel(row)}
                meta={row.cost || undefined}
                pill={<StatusPill tone="pending">Awaiting payout</StatusPill>}
                dataAttr="vendor-dashboard-attention-payout"
              />
            )}
          />

          <AttentionGroup
            title="Tasks"
            href={`${BASE}/tasks`}
            linkLabel="Tasks →"
            dataAttr="vendor-dashboard-tasks-link"
            badge={
              openTasks.length > 0 ? (
                <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold tabular-nums text-[var(--status-pending-fg)]">
                  <span aria-hidden className="size-1.5 rounded-full bg-current" />
                  {openTasks.length} open
                </span>
              ) : null
            }
            items={openTasks}
            keyForItem={(task) => `${task.managerUserId}:${task.id}`}
            renderRow={(task) => (
              <IssueRow
                href={`${BASE}/tasks`}
                dot={DOT_PENDING}
                title={task.title}
                subtitle={compactTaskLocationLabel(task) ?? undefined}
                meta={taskScheduleLabel(task)}
                dataAttr="vendor-dashboard-attention-task"
              />
            )}
          />

          <AttentionGroup
            title="Communication"
            href={`${BASE}/communication/active`}
            linkLabel="Communication →"
            dataAttr="vendor-dashboard-messages-inbox-link"
            items={inboxThreads}
            keyForItem={(thread) => thread.id}
            renderRow={(thread) => (
              <IssueRow
                href={`${BASE}/communication/active`}
                dot={DOT_INFO}
                title={thread.from || "Unknown sender"}
                subtitle={thread.subject || thread.preview || "—"}
                pill={<StatusPill tone="info">Unread</StatusPill>}
                dataAttr="vendor-dashboard-attention-inbox"
              />
            )}
          />
        </div>
        ) : null}
      </div>
    </ManagerPortalPageShell>
  );
}
