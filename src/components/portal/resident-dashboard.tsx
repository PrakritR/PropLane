"use client";

import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { SlidersHorizontal } from "lucide-react";
import { PORTAL_FILTER_ICON_CLASS } from "@/components/portal/filter-field-lists";
import { DashboardCustomizeModal } from "@/components/portal/dashboard-customize-modal";
import {
  ManagerPortalPageShell,
  PORTAL_DASHBOARD_STACK,
  PortalDashboardKpiRow,
  PortalDashboardKpiTile,
  formatCompactChargeLine,
} from "@/components/portal/portal-metrics";
import {
  PortalTableExpandChevron,
  isPortalRowClickIgnored,
  usePortalPreviewSlice,
} from "@/components/portal/portal-data-table";
import { useIsNativeApp } from "@/hooks/use-is-native-app";
import { useResidentDashboardVisibility } from "@/hooks/use-resident-dashboard-visibility";
import { useResidentPortalAxisContext } from "@/hooks/use-resident-portal-axis";
import { RESIDENT_DASHBOARD_SECTIONS, type ResidentDashboardSectionId } from "@/lib/resident-dashboard-preferences";
import { RESIDENT_INBOX_THREAD_FALLBACK } from "@/components/portal/resident-inbox-panel";
import { usePortalSession } from "@/hooks/use-portal-session";
import {
  chargeDueLabel,
  HOUSEHOLD_CHARGES_EVENT,
  isHouseholdChargeOverdue,
  readChargesForResident,
  syncHouseholdChargesFromServer,
} from "@/lib/household-charges";
import {
  LEASE_PIPELINE_EVENT,
  findLeaseForResidentEmail,
  residentCanViewLeaseRow,
  syncLeasePipelineFromServer,
  type LeasePipelineRow,
} from "@/lib/lease-pipeline-storage";
import {
  MANAGER_APPLICATIONS_EVENT,
  readManagerApplicationRows,
  syncManagerApplicationsFromServer,
} from "@/lib/manager-applications-storage";
import { getPropertyById, getRoomChoiceLabel } from "@/lib/rental-application/data";
import { applicationsForResidentEmail } from "@/lib/rental-application/application-policy";
import {
  applicationStageDisplayLabel,
  INCOMPLETE_APPLICATION_LABEL,
  isInProgressApplicationRow,
} from "@/lib/rental-application/in-progress-application";
import {
  MANAGER_WORK_ORDERS_EVENT,
  readManagerWorkOrderRows,
  syncManagerWorkOrdersFromServer,
} from "@/lib/manager-work-orders-storage";
import {
  readServiceRequestsForResident,
  SERVICE_REQUESTS_EVENT,
  syncServiceRequestsFromServer,
} from "@/lib/service-requests-storage";
import type { DemoApplicantRow, DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { ServiceRequest } from "@/lib/service-requests-storage";
import {
  countUnopenedPersistedInbox,
  loadPersistedInbox,
  PORTAL_INBOX_CHANGED_EVENT,
  RESIDENT_INBOX_STORAGE_KEY,
  syncPersistedInboxFromServer,
} from "@/lib/portal-inbox-storage";
import { formatRangeLabel } from "@/lib/demo-admin-scheduling";
import { residentTourDetailHref, residentTourListHref } from "@/lib/portal-detail-routes";
import { resolveResidentPortalNavStage } from "@/lib/resident-portal-nav";
import { residentTourBucketForView, sortResidentTourViews } from "@/lib/resident-tour-list";
import { stripPropertyRoomCountSuffix } from "@/lib/portal-mobile-preview";
import type { ResidentTourView } from "@/lib/tour-resident-link.server";

const BASE = "/resident";

/** Semantic status foreground tokens for the leading issue-row dots. */
const DOT_CONFIRMED = "var(--status-confirmed-fg)";

type AppStatus = "pending" | "approved" | "rejected";

type PillTone = "pending" | "success" | "danger" | "info" | "neutral";

type AttentionTone = "pending" | "success" | "danger" | "info";
const ATTENTION_TONE: Record<AttentionTone, { fg: string; bg: string }> = {
  danger: { fg: "var(--status-overdue-fg)", bg: "var(--status-overdue-bg)" },
  pending: { fg: "var(--status-pending-fg)", bg: "var(--status-pending-bg)" },
  info: { fg: "var(--status-approved-fg)", bg: "var(--status-approved-bg)" },
  success: { fg: "var(--status-confirmed-fg)", bg: "var(--status-confirmed-bg)" },
};

function sectionAccentDot(tone: AttentionTone): string {
  return ATTENTION_TONE[tone].fg;
}

/** Consistent circular count in attention group headers (including zero). */
function AttentionCountBadge({
  count,
  tone,
  isEmpty,
}: {
  count: number;
  tone: AttentionTone;
  isEmpty: boolean;
}) {
  const accent = ATTENTION_TONE[tone];
  return (
    <span
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold leading-none tabular-nums [html[data-native]_&]:size-[1.125rem] [html[data-native]_&]:text-[10px]"
      style={
        isEmpty
          ? {
              color: "color-mix(in srgb, var(--muted) 72%, transparent)",
              background: "color-mix(in srgb, var(--muted) 14%, var(--card))",
            }
          : { background: accent.bg, color: accent.fg }
      }
    >
      {count}
    </span>
  );
}

function tourWhenLabel(tour: ResidentTourView): string {
  const whenStart = tour.confirmedStart ?? tour.proposedStart;
  const whenEnd = tour.confirmedEnd ?? tour.proposedEnd;
  return whenStart && whenEnd ? formatRangeLabel(whenStart, whenEnd) : "Time to be confirmed";
}

/** Small theme-aware status pill (light/dark flip via `.portal-badge-*`). */
function StatusPill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  if (tone === "neutral") {
    return (
      <span className="inline-flex items-center whitespace-nowrap rounded-full border border-border bg-[var(--secondary)] px-2 py-0.5 text-[10px] font-semibold text-muted [html[data-native]_&]:text-[9px]">
        {children}
      </span>
    );
  }
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
      className="group flex items-center gap-3 px-3.5 py-2.5 transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--attn-section-bg)_40%,transparent)] [html[data-native]_&]:gap-2.5 [html[data-native]_&]:px-3 [html[data-native]_&]:py-2"
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
 * One "Needs attention" group — collapsible card with status rail, matching the
 * manager dashboard. Opens by default only when it has items.
 */
function AttentionGroup<T>({
  title,
  href,
  sectionId,
  tone,
  order = 0,
  badge,
  headerCount,
  items,
  emptyMessage,
  keyForItem,
  renderRow,
}: {
  title: string;
  href: string;
  sectionId: ResidentDashboardSectionId;
  tone: AttentionTone;
  order?: number;
  badge?: ReactNode;
  /** When set, shown in the header circle instead of `items.length` (e.g. total unread vs preview slice). */
  headerCount?: number;
  items: T[];
  emptyMessage: string;
  keyForItem: (item: T) => string;
  renderRow: (item: T, sectionTone: AttentionTone) => ReactNode;
}) {
  const { visible, overflow } = usePortalPreviewSlice(items);
  const { isNative } = useIsNativeApp();
  const count = headerCount ?? items.length;
  const isEmpty = count === 0;
  const accent = ATTENTION_TONE[tone];
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? !isEmpty;

  return (
    <div
      className="pl-attn-enter overflow-hidden rounded-xl border border-border bg-card"
      style={{
        animationDelay: `${Math.min(order, 8) * 55}ms`,
        borderLeftWidth: isEmpty ? undefined : 3,
        borderLeftColor: isEmpty ? undefined : accent.fg,
        background: isEmpty ? undefined : `color-mix(in srgb, ${accent.bg} 32%, var(--card))`,
        ["--attn-section-bg" as string]: accent.bg,
        ["--attn-section-fg" as string]: accent.fg,
      }}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        data-attr={`resident-dashboard-attention-toggle-${sectionId}`}
        onClick={() => setOverride(!open)}
        onKeyDown={(e) => {
          if (isPortalRowClickIgnored(e.target)) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOverride(!open);
          }
        }}
        className="flex cursor-pointer items-center gap-2.5 px-3.5 py-2.5 transition-colors hover:bg-[color-mix(in_srgb,var(--attn-section-bg)_45%,transparent)] [html[data-native]_&]:gap-2 [html[data-native]_&]:px-3 [html[data-native]_&]:py-2"
      >
        <span className="flex shrink-0 items-center self-center">
          <PortalTableExpandChevron expanded={open} />
        </span>
        <h3
          className="min-w-0 flex-1 self-center text-sm font-semibold leading-none tracking-[-0.01em] [html[data-native]_&]:text-[13px]"
          style={{ color: isEmpty ? "var(--muted)" : accent.fg }}
        >
          {title}
        </h3>
        <span className="flex shrink-0 items-center gap-1.5 self-center">
          <AttentionCountBadge count={count} tone={tone} isEmpty={isEmpty} />
          {badge ? <span className="inline-flex items-center">{badge}</span> : null}
        </span>
        <Link
          href={href}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Open ${title}`}
          data-attr="resident-dashboard-attention-link"
          className="ml-auto inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center self-center whitespace-nowrap px-2 text-xs font-semibold leading-none hover:underline underline-offset-2 [html[data-native]_&]:text-sm"
          style={{ color: isEmpty ? "var(--muted)" : accent.fg }}
        >
          →
        </Link>
      </div>
      {open ? (
        isEmpty ? (
          <p className="border-t border-border px-3.5 py-2.5 text-xs text-muted [html[data-native]_&]:px-3 [html[data-native]_&]:py-2">
            {emptyMessage}
          </p>
        ) : (
          <div className="border-t border-border">
            <div className="divide-y divide-border/80">
              {visible.map((item) => (
                <Fragment key={keyForItem(item)}>{renderRow(item, tone)}</Fragment>
              ))}
            </div>
            {overflow > 0 ? (
              <div className="border-t border-border/80 px-3.5 py-2 [html[data-native]_&]:px-3">
                <Link
                  href={href}
                  className="inline-block text-xs font-semibold hover:underline underline-offset-2"
                  style={{ color: accent.fg }}
                >
                  {isNative ? `View all (${count}) →` : `View all ${count} →`}
                </Link>
              </div>
            ) : null}
          </div>
        )
      ) : null}
    </div>
  );
}

/** Parse a "$1,200.00" balance label into a numeric dollar amount for KPI sums. */
function parseMoneyLabel(label: string): number {
  const n = Number(String(label).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function formatUsd(amount: number): string {
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function leaseBadge(row: LeasePipelineRow | null, approved: boolean): {
  label: string;
  tone: "emerald" | "amber" | "sky" | "slate" | "blue";
  cta: boolean;
} {
  if (!approved || !row) return { label: "Not started", tone: "slate", cta: false };
  if (!residentCanViewLeaseRow(row)) {
    if (row.status === "Voided") return { label: "Voided", tone: "slate", cta: false };
    return { label: "Being prepared", tone: "slate", cta: false };
  }
  switch (row.status) {
    case "Fully Signed": return { label: "Active ✓", tone: "emerald", cta: false };
    case "Resident Signature Pending": return { label: "Sign now", tone: "blue", cta: true };
    case "Manager Signature Pending": return { label: "Awaiting manager", tone: "sky", cta: false };
    default: return { label: row.status || "In progress", tone: "amber", cta: false };
  }
}

/** Map the legacy badge tone palette onto the shared status-pill tones. */
function pillToneForBadgeTone(tone: string): PillTone {
  switch (tone) {
    case "emerald": return "success";
    case "rose": return "danger";
    case "sky":
    case "blue": return "info";
    case "slate": return "neutral";
    default: return "pending";
  }
}

function applicationStatusBadge(row: DemoApplicantRow): { label: string; tone: "emerald" | "amber" | "rose" | "slate" } {
  if (row.bucket === "approved") return { label: "Approved", tone: "emerald" };
  if (row.bucket === "rejected") return { label: "Rejected", tone: "rose" };
  if (isInProgressApplicationRow(row)) return { label: INCOMPLETE_APPLICATION_LABEL, tone: "amber" };
  return { label: row.stage?.trim() || "Pending", tone: "amber" };
}

function applicationSubtitle(row: DemoApplicantRow): string {
  const property = row.property?.trim() || row.application?.propertyId?.trim() || "";
  const stage = applicationStageDisplayLabel(row);
  if (property && stage) return `${property} · ${stage}`;
  return property || stage || "Application";
}

type ServicePreviewItem =
  | { kind: "request"; id: string; row: ServiceRequest }
  | { kind: "work-order"; id: string; row: DemoManagerWorkOrderRow };

function servicePreviewItems(
  requests: ServiceRequest[],
  workOrders: DemoManagerWorkOrderRow[],
): ServicePreviewItem[] {
  const items: ServicePreviewItem[] = [];
  for (const row of requests.filter((r) => r.status === "pending")) {
    items.push({ kind: "request", id: `req-${row.id}`, row });
  }
  for (const row of workOrders.filter((r) => r.bucket === "open")) {
    items.push({ kind: "work-order", id: `wo-${row.id}`, row });
  }
  return items;
}

export function ResidentDashboard({
  applicationApproved = false,
  leaseSigned = false,
  initialApplicationId = null,
  displayName = "Resident",
  residentEmail = "",
  residentUserId = null,
  managerSubscriptionTier = null,
}: {
  applicationApproved?: boolean;
  leaseSigned?: boolean;
  initialApplicationId?: string | null;
  displayName?: string;
  residentEmail?: string;
  residentUserId?: string | null;
  managerSubscriptionTier?: "free" | "paid" | null;
}) {
  void initialApplicationId;
  void managerSubscriptionTier;
  const initialEmail = residentEmail.trim().toLowerCase();
  const session = usePortalSession({ userId: residentUserId, email: initialEmail || null });
  const email = session.email?.trim().toLowerCase() || initialEmail;
  const userId = session.userId ?? residentUserId;
  const { residentAxisId, profileManagerId, axisResolved } = useResidentPortalAxisContext();
  const { visibility, setVisible, reset } = useResidentDashboardVisibility(userId);
  const canUseServices = leaseSigned;
  const showHouseDetails = leaseSigned && visibility.houseDetails;
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const customizableSections = useMemo(
    () =>
      leaseSigned
        ? RESIDENT_DASHBOARD_SECTIONS
        : RESIDENT_DASHBOARD_SECTIONS.filter((section) => section.id !== "houseDetails"),
    [leaseSigned],
  );

  const [appStatus, setAppStatus] = useState<AppStatus>(applicationApproved ? "approved" : "pending");
  const [appProperty, setAppProperty] = useState<string | null>(null);
  const [appRoom, setAppRoom] = useState<string | null>(null);

  const [tick, setTick] = useState(0);
  const bump = () => setTick((n) => n + 1);
  const [clientReady, setClientReady] = useState(false);
  const [tours, setTours] = useState<ResidentTourView[]>([]);

  useEffect(() => {
    queueMicrotask(() => setClientReady(true));
  }, []);

  useEffect(() => {
    if (!clientReady || !email) return;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/portal-resident-tours", { credentials: "include" });
        const data = (await res.json().catch(() => ({}))) as { tours?: ResidentTourView[] };
        if (!res.ok || !alive) return;
        setTours(sortResidentTourViews(Array.isArray(data.tours) ? data.tours : []));
      } catch {
        if (alive) setTours([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [clientReady, email, tick]);

  useEffect(() => {
    if (!session.ready || !userId) return;
    const bump = () => setTick((n) => n + 1);
    void Promise.allSettled([
      syncManagerApplicationsFromServer({ force: true, selfScope: true }),
      syncLeasePipelineFromServer(),
      syncManagerWorkOrdersFromServer(),
      syncServiceRequestsFromServer({ force: true }),
      syncPersistedInboxFromServer(RESIDENT_INBOX_STORAGE_KEY),
      syncHouseholdChargesFromServer(false, { skipReconcile: true }),
    ]).then(bump);
    window.addEventListener(LEASE_PIPELINE_EVENT, bump);
    window.addEventListener(MANAGER_WORK_ORDERS_EVENT, bump);
    window.addEventListener(SERVICE_REQUESTS_EVENT, bump);
    window.addEventListener(HOUSEHOLD_CHARGES_EVENT, bump);
    window.addEventListener("storage", bump);
    const onInbox = (e: Event) => {
      const key = (e as CustomEvent<{ key?: string }>).detail?.key;
      if (!key || key === RESIDENT_INBOX_STORAGE_KEY) bump();
    };
    window.addEventListener(PORTAL_INBOX_CHANGED_EVENT, onInbox as EventListener);
    return () => {
      window.removeEventListener(LEASE_PIPELINE_EVENT, bump);
      window.removeEventListener(MANAGER_WORK_ORDERS_EVENT, bump);
      window.removeEventListener(SERVICE_REQUESTS_EVENT, bump);
      window.removeEventListener(HOUSEHOLD_CHARGES_EVENT, bump);
      window.removeEventListener("storage", bump);
      window.removeEventListener(PORTAL_INBOX_CHANGED_EVENT, onInbox as EventListener);
    };
  }, [session.ready, userId]);

  useEffect(() => {
    let alive = true;
    const apply = () => {
      const rows = readManagerApplicationRows();
      const row = email ? rows.find((r) => r.email?.trim().toLowerCase() === email) : undefined;
      if (!alive) return;
      if (row?.bucket === "approved" || row?.bucket === "rejected" || row?.bucket === "pending") {
        const resolvedProperty = (() => {
          const assignedPropertyId = row.assignedPropertyId?.trim() || row.propertyId?.trim() || row.application?.propertyId?.trim();
          if (assignedPropertyId) {
            const p = getPropertyById(assignedPropertyId);
            if (p) {
              const street = p.address.split(",")[0]?.trim();
              return street || p.buildingName || p.title || null;
            }
          }
          const fallback = row.property?.trim() || null;
          if (!fallback) return null;
          return fallback.split("·")[0]?.trim() || fallback;
        })();

        const resolvedRoom = (() => {
          const roomChoice = row.assignedRoomChoice?.trim() || row.application?.roomChoice1?.trim() || "";
          if (!roomChoice) return null;
          const roomLabel = getRoomChoiceLabel(roomChoice).trim();
          if (!roomLabel) return null;
          return roomLabel.split(" · ")[0]?.trim() || roomLabel;
        })();

        const finalBucket = applicationApproved && row.bucket === "pending" ? "approved" : row.bucket;
        setAppStatus(finalBucket);
        setAppProperty(resolvedProperty);
        setAppRoom(resolvedRoom);
      } else {
        setAppStatus("pending");
        setAppProperty(null);
        setAppRoom(null);
      }
    };
    apply();
    if (!session.ready || !userId) {
      return () => {
        alive = false;
      };
    }
    void syncManagerApplicationsFromServer({ force: true, selfScope: true }).then(() => { if (alive) apply(); });
    window.addEventListener(MANAGER_APPLICATIONS_EVENT, apply);
    window.addEventListener("storage", apply);
    return () => {
      alive = false;
      window.removeEventListener(MANAGER_APPLICATIONS_EVENT, apply);
      window.removeEventListener("storage", apply);
    };
  }, [applicationApproved, email, session.ready, userId]);

  const data = useMemo(() => {
    void tick;
    if (!clientReady) {
      return {
        leaseRow: null,
        lease: leaseBadge(null, appStatus === "approved"),
        inbox: 0,
        inboxThreads: [] as ReturnType<typeof loadPersistedInbox>,
        pendingCharges: [] as ReturnType<typeof readChargesForResident>,
        applicationRows: [] as ReturnType<typeof applicationsForResidentEmail>,
        workOrders: [] as DemoManagerWorkOrderRow[],
        serviceRequests: [] as ServiceRequest[],
        serviceItems: [] as ServicePreviewItem[],
      };
    }

    const leaseRow =
      email && axisResolved
        ? findLeaseForResidentEmail(email, { email, residentAxisId, profileManagerId })
        : null;
    const lease = leaseBadge(leaseRow, appStatus === "approved");

    const workOrders = email
      ? readManagerWorkOrderRows().filter(
          (r) =>
            r.residentEmail?.trim().toLowerCase() === email &&
            (r as { requestType?: string }).requestType !== "service",
        )
      : [];
    const serviceRequests = email ? readServiceRequestsForResident(email) : [];
    const serviceItems = servicePreviewItems(serviceRequests, workOrders);

    const inboxThreads = loadPersistedInbox(RESIDENT_INBOX_STORAGE_KEY, RESIDENT_INBOX_THREAD_FALLBACK).filter(
      (t) => t.folder === "inbox" && t.unread,
    );
    const inbox = countUnopenedPersistedInbox(RESIDENT_INBOX_STORAGE_KEY, RESIDENT_INBOX_THREAD_FALLBACK);

    const charges = email ? readChargesForResident(email, residentUserId) : [];
    const pendingCharges = charges
      .filter((c) => c.status === "pending")
      .sort((a, b) => {
        const aOverdue = isHouseholdChargeOverdue(a);
        const bOverdue = isHouseholdChargeOverdue(b);
        if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
        return 0;
      });
    return {
      leaseRow,
      lease,
      inbox,
      inboxThreads,
      pendingCharges,
      applicationRows: email ? applicationsForResidentEmail(email) : [],
      serviceItems,
    };
  }, [tick, email, appStatus, residentUserId, clientReady, axisResolved, residentAxisId, profileManagerId]);

  const {
    leaseRow,
    lease,
    inbox,
    inboxThreads,
    pendingCharges,
    applicationRows,
    serviceItems,
  } = data;
  const canUsePayments = applicationApproved || pendingCharges.length > 0;
  const pendingApplicationRows = applicationRows.filter((r) => r.bucket === "pending");
  const pendingApplicationCount = pendingApplicationRows.length;
  const pendingTours = useMemo(
    () =>
      sortResidentTourViews(tours).filter((tour) => residentTourBucketForView(tour) === "pending"),
    [tours],
  );
  const pendingTourCount = pendingTours.length;

  const welcomeName =
    displayName && displayName !== "Resident" ? displayName.split(/\s+/)[0] : null;
  void welcomeName;

  const communicationHref = `${BASE}/communication`;
  const overdueChargeCount = pendingCharges.filter((c) => isHouseholdChargeOverdue(c)).length;
  const totalBalanceDue = pendingCharges.reduce((sum, c) => sum + parseMoneyLabel(c.balanceLabel), 0);

  const navStage = resolveResidentPortalNavStage({
    leaseAccessUnlocked: leaseSigned,
    applicationApproved,
    hasCompletedApplicationSubmission: applicationRows.length > 0,
  });
  const showTourKpi =
    navStage === "pre_approval" || navStage === "application_submitted" || pendingTourCount > 0;
  const showApplicationKpi =
    navStage === "pre_approval" || navStage === "application_submitted";
  const showLeaseKpi = applicationApproved && !leaseSigned;
  const showPaymentsKpi = applicationApproved;
  const showServicesKpi = leaseSigned;
  const showInboxKpi = inbox > 0;

  const servicesHref = canUseServices ? `${BASE}/services` : `${BASE}/services`;
  const houseDetailsHref = `${BASE}/move-in`;
  const leaseUnlocked = applicationApproved;
  const leaseItems = leaseUnlocked && leaseRow ? [leaseRow] : [];
  const leaseDateRange = leaseRow?.application?.leaseStart
    ? `${leaseRow.application.leaseStart}${leaseRow.application.leaseEnd ? ` → ${leaseRow.application.leaseEnd}` : ""}`
    : null;
  const leaseSubtitle =
    leaseDateRange ||
    leaseRow?.unit ||
    (appProperty ? `${appProperty}${appRoom ? ` · ${appRoom}` : ""}` : undefined);
  const leaseEmptyMessage = !leaseUnlocked
    ? "Available after your application is approved."
    : appProperty
      ? `${appProperty}${appRoom ? ` · ${appRoom}` : ""}. Lease not started yet.`
      : "No lease on file yet.";

  const openServiceCount = canUseServices ? serviceItems.length : 0;
  const openCount =
    (visibility.tours ? pendingTourCount : 0) +
    (visibility.applications ? pendingApplicationCount : 0) +
    (visibility.lease && lease.cta ? 1 : 0) +
    (showHouseDetails ? 1 : 0) +
    (canUseServices && visibility.services ? openServiceCount : 0) +
    (canUsePayments && visibility.payments ? pendingCharges.length : 0) +
    (visibility.communication ? inbox : 0);

  return (
    <ManagerPortalPageShell
      title="Dashboard"
      hideTitleOnNative
      hideTitleOnMobileNav
    >
      <div className={`min-w-0 ${PORTAL_DASHBOARD_STACK}`}>
        {leaseSigned && showHouseDetails ? (
          <Link
            href={houseDetailsHref}
            data-attr="resident-dashboard-move-in-hero"
            className="mb-1 flex w-full items-center justify-between gap-3 rounded-2xl border border-primary/25 bg-[color-mix(in_srgb,var(--status-approved-bg)_55%,var(--card))] px-4 py-3.5 transition-colors hover:border-primary/40 [html[data-native]_&]:px-3.5 [html[data-native]_&]:py-3"
          >
            <span className="min-w-0">
              <span className="block text-sm font-bold text-foreground [html[data-native]_&]:text-[13px]">
                Move-in details
              </span>
              <span className="mt-0.5 block truncate text-xs text-muted [html[data-native]_&]:text-[11px]">
                {appProperty
                  ? `${appProperty}${appRoom ? ` · ${appRoom}` : ""}`
                  : "Placement, keys, and house information"}
              </span>
            </span>
            <span aria-hidden className="shrink-0 text-lg text-primary">
              ›
            </span>
          </Link>
        ) : null}
        <PortalDashboardKpiRow>
            {showTourKpi ? (
            <PortalDashboardKpiTile
              label="Tour pending"
              value={pendingTourCount}
              tone={pendingTourCount > 0 ? "warning" : "neutral"}
              emphasis={pendingTourCount > 0}
              href={residentTourListHref(BASE, "pending")}
              dataAttr="resident-dashboard-kpi-tour-pending"
            />
            ) : null}
            {showApplicationKpi ? (
            <PortalDashboardKpiTile
              label="Application pending"
              value={pendingApplicationCount}
              tone={pendingApplicationCount > 0 ? "warning" : "brand"}
              emphasis={pendingApplicationCount > 0}
              href={`${BASE}/applications`}
              dataAttr="resident-dashboard-kpi-application-pending"
            />
            ) : null}
            {showLeaseKpi ? (
            <PortalDashboardKpiTile
              label="Lease"
              value={lease.cta ? 1 : 0}
              tone={lease.cta ? "warning" : "brand"}
              emphasis={Boolean(lease.cta)}
              href={`${BASE}/lease`}
              dataAttr="resident-dashboard-kpi-lease"
            />
            ) : null}
            {showServicesKpi && canUseServices ? (
            <PortalDashboardKpiTile
              label="Services"
              value={openServiceCount}
              tone={openServiceCount > 0 ? "warning" : "neutral"}
              emphasis={openServiceCount > 0}
              href={servicesHref}
              dataAttr="resident-dashboard-kpi-services"
            />
            ) : null}
            {showPaymentsKpi && canUsePayments ? (
            <PortalDashboardKpiTile
              label="Balance due"
              value={formatUsd(totalBalanceDue)}
              tone={overdueChargeCount > 0 ? "danger" : totalBalanceDue > 0 ? "warning" : "success"}
              emphasis={overdueChargeCount > 0 || totalBalanceDue > 0}
              href={`${BASE}/payments`}
              dataAttr="resident-dashboard-kpi-balance"
            />
            ) : null}
            {showInboxKpi ? (
            <PortalDashboardKpiTile
              label="Unread messages"
              value={inbox}
              tone={inbox > 0 ? "brand" : "neutral"}
              emphasis={inbox > 0}
              href={communicationHref}
              dataAttr="resident-dashboard-kpi-inbox"
            />
            ) : null}
        </PortalDashboardKpiRow>

        {/* Needs attention — dense issue rows grouped under tiny uppercase labels. */}
        <div className="space-y-4 [html[data-native]_&]:space-y-3">
          <div className="flex items-center gap-2.5">
            <span aria-hidden className="text-primary text-xl leading-none [html[data-native]_&]:text-lg">
              ✦
            </span>
            <h2 className="text-xl font-bold leading-tight tracking-[-0.02em] text-foreground [html[data-native]_&]:text-lg">
              Needs attention
            </h2>
            {openCount > 0 ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-[var(--secondary)] px-2.5 py-0.5 text-[11px] font-medium text-muted">
                <span
                  aria-hidden
                  className="pl-attn-pulse size-1.5 rounded-full"
                  style={{ background: DOT_CONFIRMED }}
                />
                {openCount} open
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => setCustomizeOpen(true)}
              data-attr="resident-dashboard-customize-open"
              className="ml-auto inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-3 py-2 text-[11px] font-semibold text-muted transition-colors hover:border-primary/40 hover:text-foreground"
            >
              <SlidersHorizontal className={PORTAL_FILTER_ICON_CLASS} aria-hidden />
              <span className="[html[data-native]_&]:sr-only">Customize</span>
            </button>
          </div>

          {visibility.tours ? (
          <AttentionGroup
            title="Tour pending"
            href={residentTourListHref(BASE, "pending")}
            sectionId="tours"
            tone="pending"
            order={0}
            items={pendingTours}
            emptyMessage="No pending tour requests."
            keyForItem={(tour) => tour.inquiryId}
            renderRow={(tour, sectionTone) => (
              <IssueRow
                href={residentTourDetailHref(BASE, "pending", tour.inquiryId)}
                dot={sectionAccentDot(sectionTone)}
                title={stripPropertyRoomCountSuffix(tour.propertyTitle ?? "Property tour")}
                subtitle={tourWhenLabel(tour)}
                pill={<StatusPill tone="pending">Pending</StatusPill>}
                dataAttr="resident-dashboard-attention-tour"
              />
            )}
          />
          ) : null}

          {visibility.applications ? (
          <AttentionGroup
            title="Application pending"
            href={`${BASE}/applications`}
            sectionId="applications"
            tone="pending"
            order={1}
            items={pendingApplicationRows}
            emptyMessage="No pending applications."
            keyForItem={(row) => row.id}
            renderRow={(row, sectionTone) => {
              const badge = applicationStatusBadge(row);
              return (
                <IssueRow
                  href={`${BASE}/applications`}
                  dot={sectionAccentDot(sectionTone)}
                  title={row.name?.trim() || "Application"}
                  subtitle={applicationSubtitle(row)}
                  pill={<StatusPill tone={pillToneForBadgeTone(badge.tone)}>{badge.label}</StatusPill>}
                  dataAttr="resident-dashboard-attention-application"
                />
              );
            }}
          />
          ) : null}

          {visibility.lease ? (
          <AttentionGroup
            title="Lease"
            href={`${BASE}/lease`}
            sectionId="lease"
            tone={lease.cta ? "info" : "pending"}
            order={2}
            items={leaseItems}
            emptyMessage={leaseEmptyMessage}
            keyForItem={(row) => row.id}
            renderRow={(_row, sectionTone) => (
              <IssueRow
                href={`${BASE}/lease`}
                dot={sectionAccentDot(sectionTone)}
                title={lease.cta ? "Signature needed" : lease.tone === "emerald" ? "Lease active" : "Lease status"}
                subtitle={leaseSubtitle}
                meta={leaseRow?.signedRentLabel}
                pill={<StatusPill tone={pillToneForBadgeTone(lease.tone)}>{lease.label}</StatusPill>}
                dataAttr="resident-dashboard-attention-lease"
              />
            )}
          />
          ) : null}

          {showHouseDetails ? (
          <AttentionGroup
            title="House details"
            href={`${BASE}/move-in`}
            sectionId="houseDetails"
            tone="info"
            order={3}
            items={[{ id: "house-details" }]}
            emptyMessage="Open house details for move-in placement and keys."
            keyForItem={(item) => item.id}
            renderRow={() => (
              <IssueRow
                href={`${BASE}/move-in`}
                dot={sectionAccentDot("info")}
                title="House details"
                subtitle={
                  appProperty
                    ? `${appProperty}${appRoom ? ` · ${appRoom}` : ""}`
                    : "Move-in placement, keys, and house information"
                }
                pill={<StatusPill tone="success">Ready</StatusPill>}
                dataAttr="resident-dashboard-attention-house-details"
              />
            )}
          />
          ) : null}

          {canUseServices && visibility.services ? (
          <AttentionGroup
            title="Services"
            href={servicesHref}
            sectionId="services"
            tone="pending"
            order={4}
            items={serviceItems}
            emptyMessage="No open services right now."
            keyForItem={(item) => item.id}
            renderRow={(item, sectionTone) => {
              if (item.kind === "request") {
                const propertyName = getPropertyById(item.row.propertyId)?.buildingName?.trim() || "";
                return (
                  <IssueRow
                    href={servicesHref}
                    dot={sectionAccentDot(sectionTone)}
                    title={item.row.offerName?.trim() || "Add-on service"}
                    subtitle={propertyName || "Add-on service"}
                    pill={<StatusPill tone="pending">Pending</StatusPill>}
                    dataAttr="resident-dashboard-attention-service"
                  />
                );
              }
              return (
                <IssueRow
                  href={`${BASE}/services`}
                  dot={sectionAccentDot(sectionTone)}
                  title={item.row.title?.trim() || "Service"}
                  subtitle={[item.row.propertyName, item.row.unit].filter(Boolean).join(" · ") || "Maintenance"}
                  pill={<StatusPill tone="pending">Open</StatusPill>}
                  dataAttr="resident-dashboard-attention-service"
                />
              );
            }}
          />
          ) : null}

          {canUsePayments && visibility.payments ? (
          <AttentionGroup
            title="Pending & overdue payments"
            href={`${BASE}/payments`}
            sectionId="payments"
            tone={overdueChargeCount > 0 ? "danger" : "pending"}
            order={5}
            badge={
              overdueChargeCount > 0 ? (
                <StatusPill tone="danger">{overdueChargeCount} overdue</StatusPill>
              ) : null
            }
            items={pendingCharges}
            emptyMessage="No outstanding charges."
            keyForItem={(charge) => charge.id}
            renderRow={(charge, sectionTone) => {
              const overdue = isHouseholdChargeOverdue(charge);
              return (
                <IssueRow
                  href={`${BASE}/payments`}
                  dot={sectionAccentDot(sectionTone)}
                  title={charge.title || "Charge"}
                  subtitle={formatCompactChargeLine(
                    charge.title || "Charge",
                    charge.balanceLabel,
                    chargeDueLabel(charge),
                    { omitBalance: true },
                  )}
                  meta={charge.balanceLabel}
                  pill={
                    <StatusPill tone={overdue ? "danger" : "pending"}>
                      {overdue ? "Overdue" : "Pending"}
                    </StatusPill>
                  }
                  dataAttr="resident-dashboard-attention-payment"
                />
              );
            }}
          />
          ) : null}

          {visibility.communication ? (
          <AttentionGroup
            title="Communication"
            href={communicationHref}
            sectionId="communication"
            tone="info"
            order={6}
            headerCount={inbox}
            items={inboxThreads}
            emptyMessage="No unread messages. Communication is clear."
            keyForItem={(thread) => thread.id}
            renderRow={(thread, sectionTone) => (
              <IssueRow
                href={communicationHref}
                dot={sectionAccentDot(sectionTone)}
                title={thread.from || "Unknown sender"}
                subtitle={thread.subject || thread.preview || "—"}
                pill={<StatusPill tone="info">Unread</StatusPill>}
                dataAttr="resident-dashboard-attention-inbox"
              />
            )}
          />
          ) : null}
        </div>
      </div>

      <DashboardCustomizeModal
        open={customizeOpen}
        onClose={() => setCustomizeOpen(false)}
        sections={customizableSections}
        visibility={visibility}
        onToggle={(id, visible) => setVisible(id as ResidentDashboardSectionId, visible)}
        onReset={reset}
      />
    </ManagerPortalPageShell>
  );
}
