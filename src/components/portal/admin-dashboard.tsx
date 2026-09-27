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
import {
  AttentionPanel,
  KpiCard,
  UpcomingPanel,
  type AttentionRow,
  type UpcomingRow,
} from "@/components/portal/pro-dashboard-kpis";
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

  // Condensed top section — same shape as the manager dashboard's own
  // "Needs attention" + "Upcoming" side-by-side panels, fed by admin's own
  // metrics (captain: "redesign dashboard UI to match manager"). The dense
  // per-group listing further down (now "Everything open") is unchanged.
  const attentionRows: AttentionRow[] = [];
  if (pendingMeetingCount > 0) {
    const latest = upcomingMeetings.find((m) => m.kind === "pending");
    attentionRows.push({
      id: "meetings",
      title: `${pendingMeetingCount} meeting${pendingMeetingCount === 1 ? "" : "s"} to confirm`,
      detail: latest ? `${latest.label} · ${fmt(latest.start)}` : "Awaiting a time",
      actionLabel: "Confirm",
      href: "/admin/events",
      tone: "pending",
    });
  }
  if (inboxUnread > 0) {
    const latest = inboxPreview[0];
    attentionRows.push({
      id: "unread",
      title: `${inboxUnread} unread conversation${inboxUnread === 1 ? "" : "s"}`,
      detail: latest ? `Latest: ${latest.name || latest.email} — ${latest.topic || latest.body.slice(0, 60)}` : "Needs a reply",
      actionLabel: "Reply",
      href: "/admin/communication",
      tone: "danger",
    });
  }
  if (openFeedbackTotal > 0) {
    const latest = openFeedback[0];
    attentionRows.push({
      id: "feedback",
      title: `${openFeedbackTotal} feedback item${openFeedbackTotal === 1 ? "" : "s"} open`,
      detail: latest ? latest.title || "Untitled report" : `${feedbackTotal} on file`,
      actionLabel: "Review",
      href: "/admin/bugs-feedback",
      tone: "pending",
    });
  }

  const upcomingRows: UpcomingRow[] = upcomingMeetings.map((m) => ({
    id: m.id,
    kind: "Meeting",
    title: m.label,
    detail: m.kind === "pending" ? "Pending" : "Confirmed",
    at: m.startMs,
    href: "/admin/events",
  }));

  return (
    <ManagerPortalPageShell
      title="Dashboard"
      subtitle={portalDashboardWelcomeSubtitle(displayName)}
      hideTitleOnNative
    >
      <div className={PORTAL_DASHBOARD_STACK}>
        {/*
          Command center — restrained KPI stat row, the same `KpiCard` the
          manager dashboard uses. A 2-up grid on phone (matching
          `DashboardSkeleton`'s own shape-matched placeholder) instead of a
          4-wide horizontal-scroll row, whose third tile used to crop at the
          390px edge with no visible scroll affordance to hint more sat
          off-screen (AXI night sweep area 2f).
        */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiCard
            label="Live properties"
            value={String(listedProps)}
            unit={unlistedProps > 0 ? `${unlistedProps} unlisted` : undefined}
            detail={`${totalProps} total`}
            href="/admin/properties?tab=listed"
            dataAttr="admin-dashboard-kpi-properties"
          />
          <KpiCard
            label="Meetings"
            value={String(totalMeetings)}
            detail={pendingMeetingCount > 0 ? `${pendingMeetingCount} pending` : "None pending"}
            href="/admin/events"
            dataAttr="admin-dashboard-kpi-meetings"
          />
          <KpiCard
            label="Unread"
            value={String(inboxUnread)}
            detail={inboxUnread > 0 ? "Needs a reply" : "All caught up"}
            href="/admin/communication"
            dataAttr="admin-dashboard-kpi-inbox"
          />
          <KpiCard
            label="Open feedback"
            value={String(openFeedbackTotal)}
            detail={`${feedbackTotal} on file`}
            href="/admin/bugs-feedback"
            dataAttr="admin-dashboard-kpi-feedback"
          />
        </div>

        {/* What needs a decision now, and what the next couple of weeks holds. */}
        <div className="grid gap-3 lg:grid-cols-2">
          <AttentionPanel rows={attentionRows} emptyCopy="Nothing is waiting on you. Nice." />
          <UpcomingPanel
            // `cutoffMs` is `Date.now() - 30min`, set from a `useEffect` (never
            // read `Date.now()` directly during render — react-hooks/purity).
            rows={upcomingRows}
            nowMs={cutoffMs + 30 * 60 * 1000}
            calendarHref="/admin/events"
            emptyCopy="Nothing scheduled."
          />
        </div>

        {/* Everything open — the same dense issue-row groups as before, just relabeled to match the manager dashboard's own "Everything open" section. */}
        <div className="space-y-4 [html[data-native]_&]:space-y-3">
          <div className="flex items-center gap-2.5">
            <span aria-hidden className="text-primary text-xl leading-none [html[data-native]_&]:text-lg">
              ✦
            </span>
            <h2 className="text-xl font-bold leading-tight tracking-[-0.02em] text-foreground [html[data-native]_&]:text-lg">
              Everything open
            </h2>
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
