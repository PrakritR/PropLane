"use client";

import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useIsNativeApp } from "@/hooks/use-is-native-app";
import {
  ManagerPortalPageShell,
  portalDashboardWelcomeSubtitle,
  PortalDashboardSectionHeader,
  PORTAL_DASHBOARD_STACK,
} from "@/components/portal/portal-metrics";
import {
  PortalPreviewOverflowLink,
  PortalTableExpandChevron,
  usePortalPreviewSlice,
} from "@/components/portal/portal-data-table";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { readInboxMessages, syncInboxMessagesFromServer } from "@/lib/demo-admin-partner-inbox";
import { adminKpiCounts } from "@/lib/demo-admin-property-inventory";
import {
  getPartnerInquiryWindows,
  pendingInquiryCount,
  readPartnerInquiries,
  readPlannedEvents,
  syncScheduleRecordsFromServer,
} from "@/lib/demo-admin-scheduling";
import { ADMIN_UI_EVENT } from "@/lib/demo-admin-ui";
import { PROPERTY_PIPELINE_EVENT, syncPropertyPipelineFromServer } from "@/lib/demo-property-pipeline";
import { readBugFeedbackRows, syncBugFeedbackFromServer } from "@/lib/portal-bug-feedback";

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

/** Restrained KPI tile: big tabular number + small uppercase muted label. */
function KpiTile({
  label,
  value,
  sub,
  href,
  accent,
  dataAttr,
}: {
  label: string;
  value: string | number;
  sub?: string;
  href: string;
  accent?: boolean;
  dataAttr?: string;
}) {
  return (
    <Link
      href={href}
      data-attr={dataAttr}
      className="flex min-w-[8.75rem] flex-1 flex-col rounded-lg border border-border bg-card px-4 py-3.5 transition-colors duration-150 hover:border-primary/40 [html[data-native]_&]:min-w-[7.25rem] [html[data-native]_&]:rounded-lg [html[data-native]_&]:px-3.5 [html[data-native]_&]:py-3"
    >
      <span
        className={`text-[1.75rem] font-semibold leading-none tabular-nums tracking-[-0.02em] [html[data-native]_&]:text-[1.4rem] ${
          accent ? "text-[var(--status-overdue-fg)]" : "text-foreground"
        }`}
      >
        {value}
      </span>
      <span className="mt-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted [html[data-native]_&]:mt-1.5 [html[data-native]_&]:text-[9px]">
        {label}
      </span>
      {sub ? (
        <span className="mt-0.5 text-[11px] text-muted/80 [html[data-native]_&]:text-[10px]">{sub}</span>
      ) : null}
    </Link>
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
 * row limits + the overflow link are preserved).
 */
function AttentionGroup<T>({
  title,
  href,
  linkLabel,
  badge,
  items,
  emptyMessage,
  keyForItem,
  renderRow,
}: {
  title: string;
  href: string;
  linkLabel: string;
  badge?: ReactNode;
  items: T[];
  emptyMessage: string;
  keyForItem: (item: T) => string;
  renderRow: (item: T) => ReactNode;
}) {
  const { visible, overflow } = usePortalPreviewSlice(items);
  const { isNative } = useIsNativeApp();
  const isEmpty = items.length === 0;
  // null → follow "open when it has something in it", which stays reactive as
  // the async loads land; a boolean is staff's own tap and wins over it. Three
  // groups each printing a "nothing here" line is a wall of empty state on a
  // phone, and the header alone already says the group is empty.
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? !isEmpty;

  return (
    <div className="space-y-2 [html[data-native]_&]:space-y-1.5">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        data-attr="admin-dashboard-attention-toggle"
        onClick={() => setOverride(!open)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOverride(!open);
          }
        }}
        className="flex cursor-pointer items-center gap-2"
      >
        <PortalTableExpandChevron expanded={open} />
        <div className="min-w-0 flex-1">
          <PortalDashboardSectionHeader title={title} href={href} linkLabel={linkLabel} badge={badge} />
        </div>
      </div>
      {!open ? null : isEmpty ? (
        <p className="text-sm text-muted [html[data-native]_&]:text-xs">{emptyMessage}</p>
      ) : (
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

function fmt(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "soon";
  return formatPacificDateTime(d);
}

export function AdminDashboard({ displayName = "there" }: { displayName?: string }) {
  const [tick, setTick] = useState(0);
  const bump = () => setTick((n) => n + 1);
  const [cutoffMs, setCutoffMs] = useState(() => Date.now() - 30 * 60 * 1000);

  useEffect(() => {
    let cancelled = false;

    void Promise.allSettled([
      syncScheduleRecordsFromServer(),
      syncPropertyPipelineFromServer(),
      syncInboxMessagesFromServer({ force: true }),
      syncBugFeedbackFromServer({ force: true }),
    ]).then(() => {
      if (cancelled) return;
      setCutoffMs(Date.now() - 30 * 60 * 1000);
      bump();
    });

    window.addEventListener(PROPERTY_PIPELINE_EVENT, bump);
    window.addEventListener(ADMIN_UI_EVENT, bump);
    window.addEventListener("storage", bump);
    return () => {
      cancelled = true;
      window.removeEventListener(PROPERTY_PIPELINE_EVENT, bump);
      window.removeEventListener(ADMIN_UI_EVENT, bump);
      window.removeEventListener("storage", bump);
    };
  }, []);

  const data = useMemo(() => {
    void tick;
    const [, , listedProps, unlistedProps] = adminKpiCounts();
    const totalProps = listedProps + unlistedProps;

    const inboxMessages = readInboxMessages();
    const inboxUnread = inboxMessages.filter((m) => m.folder === "inbox" && !m.read).length;
    const inboxPreview = inboxMessages.filter((m) => m.folder === "inbox" && !m.read).slice(0, 5);

    const feedbackRows = readBugFeedbackRows();
    const feedbackTotal = feedbackRows.length;
    const openFeedbackAll = feedbackRows.filter((row) => row.status === "open" || row.status === "in_progress");
    const openFeedback = openFeedbackAll.slice(0, 5);

    const pendingMeetings = readPartnerInquiries()
      .filter((r) => r.status === "pending" && r.kind !== "tour")
      .flatMap((r) =>
        getPartnerInquiryWindows(r).map((w) => ({
          id: `${r.id}-${w.start}`,
          label: r.name,
          kind: "pending" as const,
          startMs: new Date(w.start).getTime(),
          start: w.start,
        })),
      );

    const confirmedMeetings = readPlannedEvents()
      .filter((e) => e.kind !== "tour")
      .map((e) => ({
        id: e.id,
        label: e.attendeeName ?? e.title ?? "Meeting",
        kind: "confirmed" as const,
        startMs: new Date(e.start).getTime(),
        start: e.start,
      }));

    const upcomingMeetings = [...pendingMeetings, ...confirmedMeetings]
      .filter((m) => Number.isFinite(m.startMs) && m.startMs >= cutoffMs)
      .sort((a, b) => a.startMs - b.startMs);

    const pendingMeetingCount = pendingInquiryCount();
    const confirmedMeetingCount = readPlannedEvents().filter((e) => e.kind !== "tour").length;
    const totalMeetings = pendingMeetingCount + confirmedMeetingCount;

    return {
      listedProps,
      unlistedProps,
      totalProps,
      inboxUnread,
      inboxPreview,
      feedbackTotal,
      openFeedback,
      openFeedbackTotal: openFeedbackAll.length,
      upcomingMeetings: upcomingMeetings.slice(0, 5),
      pendingMeetingCount,
      totalMeetings,
    };
  }, [tick, cutoffMs]);

  const {
    listedProps,
    unlistedProps,
    totalProps,
    inboxUnread,
    inboxPreview,
    feedbackTotal,
    openFeedback,
    openFeedbackTotal,
    upcomingMeetings,
    pendingMeetingCount,
    totalMeetings,
  } = data;

  const meetingsEmptyMessage =
    pendingMeetingCount > 0
      ? `${pendingMeetingCount} pending request${pendingMeetingCount === 1 ? "" : "s"}. No upcoming times on the calendar.`
      : totalMeetings > 0
        ? "No upcoming meetings on the calendar."
        : "No meeting requests yet.";

  const openCount = pendingMeetingCount + inboxUnread + openFeedbackTotal;

  return (
    <ManagerPortalPageShell
      title="Dashboard"
      subtitle={portalDashboardWelcomeSubtitle(displayName)}
      hideTitleOnNative
    >
      <div className={PORTAL_DASHBOARD_STACK}>
        {/* Command center — restrained KPI stat row (scrolls horizontally on narrow screens). */}
        <div className="-mx-1 overflow-x-auto px-1 pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="flex gap-2.5 [html[data-native]_&]:gap-2">
            <KpiTile
              label="Live properties"
              value={listedProps}
              sub={unlistedProps > 0 ? `${unlistedProps} unlisted · ${totalProps} total` : `${totalProps} total`}
              href="/admin/properties?tab=listed"
              dataAttr="admin-dashboard-kpi-properties"
            />
            <KpiTile
              label="Meetings"
              value={totalMeetings}
              sub={
                pendingMeetingCount > 0
                  ? `${pendingMeetingCount} pending`
                  : "None pending"
              }
              href="/admin/events"
              dataAttr="admin-dashboard-kpi-meetings"
            />
            <KpiTile
              label="Unread inbox"
              value={inboxUnread}
              href="/admin/communication"
              dataAttr="admin-dashboard-kpi-inbox"
            />
            <KpiTile
              label="Open feedback"
              value={openFeedbackTotal}
              sub={`${feedbackTotal} on file`}
              href="/admin/bugs-feedback"
              dataAttr="admin-dashboard-kpi-feedback"
            />
          </div>
        </div>

        {/* Needs attention — dense issue rows grouped under tiny uppercase labels. */}
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
            title="Meetings"
            href="/admin/events"
            linkLabel="Meetings →"
            badge={
              pendingMeetingCount > 0 ? (
                <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold tabular-nums text-[var(--status-pending-fg)]">
                  <span aria-hidden className="size-1.5 rounded-full bg-current" />
                  {pendingMeetingCount} pending
                </span>
              ) : null
            }
            items={upcomingMeetings}
            emptyMessage={meetingsEmptyMessage}
            keyForItem={(m) => m.id}
            renderRow={(m) => (
              <IssueRow
                href="/admin/events"
                dot={m.kind === "pending" ? DOT_PENDING : DOT_CONFIRMED}
                title={m.label}
                subtitle={fmt(m.start)}
                pill={
                  <StatusPill tone={m.kind === "pending" ? "pending" : "success"}>
                    {m.kind === "pending" ? "Pending" : "Confirmed"}
                  </StatusPill>
                }
                dataAttr="admin-dashboard-attention-meeting"
              />
            )}
          />

          <AttentionGroup
            title="Communication"
            href="/admin/communication"
            linkLabel="Communication →"
            items={inboxPreview}
            emptyMessage="No unread messages. Communication is clear."
            keyForItem={(message) => message.id}
            renderRow={(message) => (
              <IssueRow
                href="/admin/communication"
                dot={DOT_INFO}
                title={message.name || message.email}
                subtitle={message.topic || message.body.slice(0, 80)}
                pill={<StatusPill tone="info">Unread</StatusPill>}
                dataAttr="admin-dashboard-attention-inbox"
              />
            )}
          />

          <AttentionGroup
            title="Feedback"
            href="/admin/bugs-feedback"
            linkLabel="Feedback →"
            items={openFeedback}
            emptyMessage={`No open feedback. ${feedbackTotal} submission${feedbackTotal === 1 ? "" : "s"} on file.`}
            keyForItem={(row) => row.id}
            renderRow={(row) => (
              <IssueRow
                href="/admin/bugs-feedback"
                dot={DOT_PENDING}
                title={row.title || "Untitled report"}
                subtitle={`${row.reporterName || row.reporterEmail} · ${row.type === "bug" ? "Bug" : "Feedback"}`}
                pill={
                  <StatusPill tone="pending">
                    {row.status === "in_progress" ? "In progress" : "Open"}
                  </StatusPill>
                }
                dataAttr="admin-dashboard-attention-feedback"
              />
            )}
          />
        </div>
      </div>
    </ManagerPortalPageShell>
  );
}
