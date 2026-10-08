"use client";

import { Fragment, createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  ClipboardList,
  FileSignature,
  Home,
  MapPin,
  MessageSquare,
  SlidersHorizontal,
  Wallet,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { DashboardGlyphTile } from "@/components/portal/pro-dashboard-kpis";
import { DashboardCustomizeModal } from "@/components/portal/dashboard-customize-modal";
import { DashboardSkeleton } from "@/components/portal/dashboard-skeleton";
import {
  ManagerPortalPageShell,
  PORTAL_DASHBOARD_STACK,
  PortalDashboardKpiRow,
} from "@/components/portal/portal-metrics";
import {
  PortalTableExpandChevron,
  usePortalPreviewSlice,
} from "@/components/portal/portal-data-table";
import { useResidentDashboardVisibility } from "@/hooks/use-resident-dashboard-visibility";
import { useResidentPortalAxisContext } from "@/hooks/use-resident-portal-axis";
import { RESIDENT_DASHBOARD_SECTIONS, type ResidentDashboardSectionId } from "@/lib/resident-dashboard-preferences";
import { RESIDENT_INBOX_THREAD_FALLBACK } from "@/components/portal/resident-inbox-panel";
import { usePortalSession } from "@/hooks/use-portal-session";
import { ResidentInspectionNextSteps } from "@/components/portal/resident-inspection-next-steps";
import {
  chargeDueLabel,
  HOUSEHOLD_CHARGES_EVENT,
  isHouseholdChargeOverdue,
  isPendingUpfrontMoveInCharge,
  chargesImplyTenancy,
  readChargesForResident,
  syncHouseholdChargesFromServer,
} from "@/lib/household-charges";
import { residentVisibleCharges } from "@/lib/household-charge-visibility";
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
} from "@/lib/manager-applications-storage";
import { getPropertyById, getRoomChoiceLabel } from "@/lib/rental-application/data";
import { applicationsForResidentEmail } from "@/lib/rental-application/application-policy";
import {
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
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { stripPropertyRoomCountSuffix } from "@/lib/portal-mobile-preview";
import type { ResidentTourView } from "@/lib/tour-resident-link.server";
import {
  loadResidentToursForViewer,
  RESIDENT_TOURS_CHANGED_EVENT,
  residentToursViewerKey,
} from "@/lib/resident-tour-sync-client";
import {
  residentLifecycleSteps,
  resolveResidentLifecycleNextAction,
  type ResidentLifecycleStep,
} from "@/lib/resident-lifecycle-journey";
import { ResidentLifecycleCompactTracker } from "@/components/portal/resident-lifecycle-compact-tracker";
import { sumDueNowCents } from "@/lib/resident-due-now-balance";
import { aggregateApplicationFeeStatus } from "@/lib/resident-application-fee-status";
import { formatResidentRentLabel } from "@/lib/resident-rent-label";

import { refreshResidentDashboardApplications, refreshResidentDashboardServices } from "@/lib/resident-dashboard-sync-client";

const BASE = "/resident";

type AppStatus = "pending" | "approved" | "rejected";

type PillTone = "pending" | "success" | "danger" | "info" | "neutral";

type AttentionTone = "pending" | "success" | "danger" | "info";

/** The glyph every row in one group wears on its tile. */
const GroupGlyphContext = createContext<LucideIcon>(ClipboardList);

/**
 * The studio's stat card, the same hairline card as the manager's: a muted
 * label over a 26px figure. The figure is amber when something waits on the
 * resident, red when overdue, ink when there is nothing to do.
 */
export function ResidentKpiTile({
  label,
  value,
  href,
  tone = "neutral",
  dataAttr,
}: {
  label: string;
  value: string | number;
  href: string;
  tone?: "neutral" | "warning" | "danger";
  dataAttr?: string;
}) {
  const color =
    tone === "danger" ? "var(--status-overdue-fg)" : tone === "warning" ? "var(--status-pending-fg)" : "var(--foreground)";
  return (
    <Link
      href={href}
      data-attr={dataAttr}
      className="flex min-w-0 w-full flex-col rounded-[10px] border border-border bg-card px-4 py-3.5 transition-colors hover:border-foreground/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 [html[data-native]_&]:px-3 [html[data-native]_&]:py-2.5"
    >
      <span className="line-clamp-2 text-[13px] font-[550] text-muted">{label}</span>
      <span
        className="my-1 block whitespace-nowrap text-[26px] font-[650] leading-[1.15] tracking-[-0.03em] [html[data-native]_&]:text-[22px]"
        style={{ color }}
      >
        {value}
      </span>
    </Link>
  );
}

function tourWhenLabel(tour: ResidentTourView): string {
  const whenStart = tour.confirmedStart ?? tour.proposedStart;
  const whenEnd = tour.confirmedEnd ?? tour.proposedEnd;
  return whenStart && whenEnd ? formatRangeLabel(whenStart, whenEnd) : "Time to be confirmed";
}

/** Status is a plain colored fact; the row itself carries no badge or chip. */
export function StatusPill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  const color = tone === "neutral"
    ? "var(--muted)"
    : tone === "success"
      ? "var(--status-confirmed-fg)"
      : tone === "danger"
        ? "var(--status-overdue-fg)"
        : tone === "info"
          ? "var(--status-approved-fg)"
          : "var(--status-pending-fg)";
  return (
    <span className="whitespace-nowrap text-[12.5px] font-semibold" style={{ color }}>
      {children}
    </span>
  );
}

/** One item: tinted glyph tile · title + place line · meta · status word. */
export function IssueRow({
  href,
  tone = "info",
  title,
  subtitle,
  meta,
  pill,
  dataAttr,
}: {
  href: string;
  tone?: AttentionTone;
  title: string;
  subtitle?: string;
  meta?: string | null;
  pill?: ReactNode;
  dataAttr?: string;
}) {
  const Glyph = useContext(GroupGlyphContext);
  return (
    <Link
      href={href}
      data-attr={dataAttr}
      className="group flex items-center gap-2.5 px-3.5 py-2.5 transition-colors duration-150 hover:bg-[var(--secondary)] [html[data-native]_&]:gap-2 [html[data-native]_&]:px-3 [html[data-native]_&]:py-2"
    >
      <DashboardGlyphTile icon={Glyph} tone={tone} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-foreground">{title}</span>
        {subtitle ? <span className="block truncate text-[12.5px] text-muted">{subtitle}</span> : null}
      </span>
      {meta ? (
        <span className="hidden shrink-0 whitespace-nowrap text-[12.5px] tabular-nums text-muted sm:block">{meta}</span>
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
 * One group inside the "Needs attention" box — a quiet 34px header (glyph ·
 * title · count · status words · →) over its rows, matching the manager
 * dashboard. Opens by default only when it has items.
 */
export function AttentionGroup<T>({
  title,
  href,
  sectionId,
  icon,
  tone,
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
  /** The glyph on the group header and on every row's tile. */
  icon: LucideIcon;
  tone: AttentionTone;
  badge?: ReactNode;
  /** When set, shown as the header count instead of `items.length` (e.g. total unread vs preview slice). */
  headerCount?: number;
  items: T[];
  emptyMessage: string;
  keyForItem: (item: T) => string;
  renderRow: (item: T, sectionTone: AttentionTone) => ReactNode;
}) {
  const { visible } = usePortalPreviewSlice(items);
  const count = headerCount ?? items.length;
  const isEmpty = count === 0;
  const Icon = icon;
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? !isEmpty;

  return (
    <div className="border-b border-border last:border-b-0">
      <div className="flex min-h-[34px] items-center gap-2 border-b border-border bg-[var(--secondary)]/60 px-3.5 text-[13px] font-semibold text-foreground [html[data-native]_&]:gap-2 [html[data-native]_&]:px-3">
        <button
          type="button"
          aria-expanded={open}
          data-attr={`resident-dashboard-attention-toggle-${sectionId}`}
          onClick={() => setOverride(!open)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 self-stretch text-left"
        >
          <span className="flex shrink-0 items-center self-center">
            <PortalTableExpandChevron expanded={open} />
          </span>
          <Icon className="size-3.5 shrink-0 text-muted" aria-hidden />
          <h3
            className="min-w-0 truncate text-[13px] font-semibold leading-none"
            style={isEmpty ? { color: "var(--muted)" } : undefined}
          >
            {title}
          </h3>
          <span className="text-[12.5px] font-medium tabular-nums text-muted/70">{count}</span>
          {badge ? <span className="inline-flex items-center">{badge}</span> : null}
        </button>
        <Link
          href={href}
          aria-label={`Open ${title}`}
          data-attr="resident-dashboard-attention-link"
          className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center self-center whitespace-nowrap px-2 text-xs font-semibold leading-none text-muted hover:text-primary [html[data-native]_&]:text-sm"
        >
          →
        </Link>
      </div>
      {open ? (
        isEmpty ? (
          <p className="px-3.5 py-2.5 text-[12.5px] text-muted [html[data-native]_&]:px-3 [html[data-native]_&]:py-2">
            {emptyMessage}
          </p>
        ) : (
          <GroupGlyphContext.Provider value={icon}>
            <div className="divide-y divide-border">
              {visible.map((item) => (
                <Fragment key={keyForItem(item)}>{renderRow(item, tone)}</Fragment>
              ))}
            </div>
          </GroupGlyphContext.Provider>
        )
      ) : null}
    </div>
  );
}

function formatUsd(amount: number): string {
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
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

/** The home an application is for, as a short place line. */
function applicationRowProperty(row: DemoApplicantRow): string | null {
  const id = row.propertyId?.trim() || row.application?.propertyId?.trim() || "";
  const fromCatalog = id ? getPropertyById(id) : undefined;
  const label = fromCatalog?.buildingName?.trim() || fromCatalog?.title?.trim() || row.property?.split("·")[0]?.trim() || "";
  return label || null;
}

function applicationStatusBadge(row: DemoApplicantRow): { label: string; tone: "emerald" | "amber" | "rose" | "slate" } {
  if (row.bucket === "approved") return { label: "Approved", tone: "emerald" };
  if (row.bucket === "rejected") return { label: "Rejected", tone: "rose" };
  if (isInProgressApplicationRow(row)) return { label: INCOMPLETE_APPLICATION_LABEL, tone: "amber" };
  return { label: row.stage?.trim() || "Pending", tone: "amber" };
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

/**
 * C118 — one journey timeline, one button. The four cards below (Tour,
 * Application, Lease, Payments) still carry their own detail rows, but a
 * resident should never have to open all four just to learn what to do
 * next; this reads the same underlying state and always resolves to
 * exactly one next step.
 */
export function ResidentJourneyBanner({
  steps,
  action,
}: {
  steps: ResidentLifecycleStep[];
  action: ReturnType<typeof resolveResidentLifecycleNextAction>;
}) {
  if (action.title === "You're all caught up") return null;
  return (
    <Link
      href={action.href}
      data-jr-banner
      data-attr="resident-dashboard-journey"
      className="flex w-full flex-col gap-3 rounded-[10px] border px-4 py-3.5 transition-colors [html[data-native]_&]:px-3.5 [html[data-native]_&]:py-3"
      style={{
        borderColor: action.urgent ? "var(--status-overdue-border, var(--status-overdue-fg))" : "var(--border)",
        background: action.urgent ? "var(--status-overdue-bg)" : "var(--card)",
      }}
    >
      <div className="mb-3" data-attr="resident-dashboard-journey-steps">
        <ResidentLifecycleCompactTracker steps={steps} />
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between [html[data-native]_&]:flex-col [html[data-native]_&]:items-stretch">
        <span className="min-w-0">
          <span
            className="block truncate text-lg font-semibold [html[data-native]_&]:text-base"
            style={{ color: action.urgent ? "var(--status-overdue-fg)" : "var(--foreground)" }}
          >
            {action.title}
          </span>
          {action.detail ? (
            <span className="mt-0.5 block truncate text-xs text-muted [html[data-native]_&]:text-[11px]">
              {action.detail}
            </span>
          ) : null}
        </span>
        <span
          className="shrink-0 whitespace-nowrap rounded-full px-3.5 py-2 text-sm font-semibold text-white"
          style={{ background: action.urgent ? "var(--status-overdue-fg)" : "var(--btn-primary)" }}
          data-attr="resident-dashboard-journey-cta"
        >
          {action.ctaLabel}
        </span>
      </div>
    </Link>
  );
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
  const [clientReady, setClientReady] = useState(false);
  const [tourState, setTourState] = useState<{ viewerKey: string; tours: ResidentTourView[] }>({
    viewerKey: "",
    tours: [],
  });
  const tourViewerKey = residentToursViewerKey(userId ?? "", email ?? "");
  const tours = useMemo(
    () => (tourState.viewerKey === tourViewerKey ? tourState.tours : []),
    [tourState, tourViewerKey],
  );
  // The body below is almost entirely `condition ? <Card/> : null` — with no
  // loading gate at all it used to render a fully blank page (no skeleton,
  // no cards) until the client mount tick and the portal session both
  // resolved, which was visibly slower than the header/nav on a phone.
  const dashboardReady = clientReady && session.ready;

  useEffect(() => {
    queueMicrotask(() => setClientReady(true));
  }, []);

  useEffect(() => {
    if (!clientReady || !email || !userId) return;
    // `/demo`'s Tours row isn't part of the seeded Seattle Homes resident
    // story (Dana Reyes is already leased) — never fetch this auth-gated
    // route from the sandbox; `tours` already defaults to `[]`.
    if (isDemoModeActive()) return;
    let alive = true;
    const refresh = (force = false) => {
      void loadResidentToursForViewer(userId, email, force).then((rows) => {
        if (alive && rows) {
          setTourState({ viewerKey: tourViewerKey, tours: sortResidentTourViews(rows) });
        }
      });
    };
    const refreshAfterWrite = () => refresh(true);
    const refreshOnFocus = () => refresh();
    refresh();
    window.addEventListener(RESIDENT_TOURS_CHANGED_EVENT, refreshAfterWrite);
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      alive = false;
      window.removeEventListener(RESIDENT_TOURS_CHANGED_EVENT, refreshAfterWrite);
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [clientReady, email, tourViewerKey, userId]);

  useEffect(() => {
    if (!session.ready || !userId) return;
    const bump = () => setTick((n) => n + 1);
    void Promise.allSettled([
      syncLeasePipelineFromServer(),
      syncManagerWorkOrdersFromServer(),
      refreshResidentDashboardServices(userId),
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

  const applicationMountRead = useRef("");
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
    const mountKey = JSON.stringify([userId, email]);
    if (applicationMountRead.current !== mountKey) {
      applicationMountRead.current = mountKey;
      void refreshResidentDashboardApplications(userId).then(() => { if (alive) apply(); });
    }
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
        hasTenancyCharges: false,
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
    // Tenancy is decided on everything the resident is billed, but what the
    // dashboard SHOWS (count, balance, rows) is the same visibility set the
    // Payments tab and the assistant use — a not-yet-due recurring charge stays
    // off every resident surface until it is close to due.
    const hasTenancyCharges = chargesImplyTenancy(charges.filter((c) => c.status === "pending"));
    const pendingCharges = residentVisibleCharges(charges)
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
      hasTenancyCharges,
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
    hasTenancyCharges,
    applicationRows,
    serviceItems,
  } = data;
  // "This person has charges" is not authorization. It used to be, so an
  // applicant who had been wrongly billed a move-in schedule saw a "Pending &
  // overdue payments" group linking to /resident/payments — which the stage
  // guard then bounced straight back here. An application or holding fee is
  // what a prospect owes, so only a tenancy charge unlocks the group.
  const canUsePayments = applicationApproved || hasTenancyCharges;
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

  const communicationHref = `${BASE}/communication`;
  const overdueChargeCount = pendingCharges.filter((c) => isHouseholdChargeOverdue(c)).length;
  const totalBalanceDue = sumDueNowCents(pendingCharges) / 100;

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
  const leaseEmptyMessage = !leaseUnlocked
    ? "Available after your application is approved."
    : appProperty
      ? `${appProperty}${appRoom ? ` · ${appRoom}` : ""}. Lease not started yet.`
      : "No lease on file yet.";

  // C118 — the one journey timeline this whole dashboard resolves to.
  const feeStatus = useMemo(
    () => aggregateApplicationFeeStatus(applicationRows, email ?? ""),
    [applicationRows, email],
  );
  // The resident has signed once the lease waits on the manager's countersignature
  // (or is fully signed); move-in costs are payable from that moment.
  const residentSigned = leaseSigned || leaseRow?.status === "Manager Signature Pending";
  const moveInDue = sumDueNowCents(pendingCharges.filter(isPendingUpfrontMoveInCharge)) / 100;
  const lifecycleInput = useMemo(
    () => ({
      applicationFeePaid: feeStatus.paid || !feeStatus.needsPayment,
      applicationSubmitted: applicationRows.some((row) => !isInProgressApplicationRow(row)),
      applicationApproved,
      residentSignedLease: residentSigned,
      managerCountersigned: leaseSigned,
      moveInChargesPaid: moveInDue <= 0 && residentSigned,
      movedIn: leaseSigned && moveInDue <= 0 && showHouseDetails,
      applicationFeeDeclined: feeStatus.declined,
      basePath: BASE,
      moveInTotalLabel: moveInDue > 0 ? formatUsd(moveInDue) : undefined,
    }),
    [
      feeStatus,
      applicationRows,
      applicationApproved,
      residentSigned,
      leaseSigned,
      moveInDue,
      showHouseDetails,
    ],
  );
  const journeySteps = useMemo(() => residentLifecycleSteps(lifecycleInput), [lifecycleInput]);
  const journeyAction = useMemo(
    () => resolveResidentLifecycleNextAction(lifecycleInput),
    [lifecycleInput],
  );

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
      title={leaseSigned ? `Welcome home${welcomeName ? `, ${welcomeName}` : ""}.` : `Welcome${welcomeName ? `, ${welcomeName}` : ""}.`}
      hideTitleOnNative
      hideTitleOnMobileNav
    >
      <div className={`min-w-0 ${PORTAL_DASHBOARD_STACK}`}>
        {!dashboardReady ? (
          <DashboardSkeleton />
        ) : (
        <>
        <ResidentJourneyBanner steps={journeySteps} action={journeyAction} />
        {leaseSigned && showHouseDetails ? (
          <Link
            href={houseDetailsHref}
            data-attr="resident-dashboard-move-in-hero"
            className="flex w-full items-center justify-between gap-3 rounded-[10px] border border-primary/20 bg-accent px-4 py-3.5 transition-colors hover:border-primary/40 [html[data-native]_&]:px-3.5 [html[data-native]_&]:py-3"
          >
            <span className="min-w-0">
              <span className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-primary">
                Your home
              </span>
              <span className="mt-0.5 block truncate text-lg font-semibold text-foreground [html[data-native]_&]:text-base">
                {appProperty || "Move-in details"}
              </span>
            </span>
            <span aria-hidden className="shrink-0 text-lg text-primary">
              ›
            </span>
          </Link>
        ) : null}
        {leaseSigned ? <ResidentInspectionNextSteps userId={userId} basePath={BASE} /> : null}
        <div className="[html[data-native]_&]:[&_.plp-stats]:flex-col [html[data-native]_&]:[&_.plp-stats]:gap-2">
        <PortalDashboardKpiRow>
            {showTourKpi ? (
            <ResidentKpiTile
              label="Tour pending"
              value={pendingTourCount}
              tone={pendingTourCount > 0 ? "warning" : "neutral"}
              href={residentTourListHref(BASE, "pending")}
              dataAttr="resident-dashboard-kpi-tour-pending"
            />
            ) : null}
            {showApplicationKpi ? (
            <ResidentKpiTile
              label="Application pending"
              value={pendingApplicationCount}
              tone={pendingApplicationCount > 0 ? "warning" : "neutral"}
              href={`${BASE}/applications`}
              dataAttr="resident-dashboard-kpi-application-pending"
            />
            ) : null}
            {showLeaseKpi ? (
            <ResidentKpiTile
              label="Lease"
              value={lease.cta ? 1 : 0}
              tone={lease.cta ? "warning" : "neutral"}
              href={`${BASE}/lease`}
              dataAttr="resident-dashboard-kpi-lease"
            />
            ) : null}
            {showServicesKpi && canUseServices ? (
            <ResidentKpiTile
              label="Services"
              value={openServiceCount}
              tone={openServiceCount > 0 ? "warning" : "neutral"}
              href={servicesHref}
              dataAttr="resident-dashboard-kpi-services"
            />
            ) : null}
            {showPaymentsKpi && canUsePayments ? (
            <div className="plp-stats">
              <ResidentKpiTile
                label="Balance due"
                value={formatUsd(totalBalanceDue)}
                tone={overdueChargeCount > 0 ? "danger" : totalBalanceDue > 0 ? "warning" : "neutral"}
                href={`${BASE}/payments`}
                dataAttr="resident-dashboard-kpi-balance"
              />
            </div>
            ) : null}
            {showInboxKpi ? (
            <ResidentKpiTile
              label="Unread messages"
              value={inbox}
              tone={inbox > 0 ? "warning" : "neutral"}
              href={communicationHref}
              dataAttr="resident-dashboard-kpi-inbox"
            />
            ) : null}
        </PortalDashboardKpiRow>
        </div>

        {/* Needs attention — one hairline box, its groups under quiet headers. */}
        <section className="overflow-hidden rounded-[10px] border border-border bg-card">
          <div className="flex items-center gap-2 border-b border-border px-3.5 py-[11px]">
            <h2 className="min-w-0 truncate text-sm font-[650] text-foreground">Needs attention</h2>
            {openCount > 0 ? (
              <span className="text-[12.5px] font-medium tabular-nums text-muted/70">{openCount}</span>
            ) : null}
            <PortalIconAction
              icon={SlidersHorizontal}
              label="Customize"
              onClick={() => setCustomizeOpen(true)}
              data-attr="resident-dashboard-customize-open"
              className="ml-auto"
            />
          </div>

          {visibility.tours ? (
          <AttentionGroup
            title="Tour pending"
            href={residentTourListHref(BASE, "pending")}
            sectionId="tours"
            icon={MapPin}
            tone="pending"
            items={pendingTours}
            emptyMessage="No pending tour requests."
            keyForItem={(tour) => tour.inquiryId}
            renderRow={(tour, sectionTone) => (
              <IssueRow
                href={residentTourDetailHref(BASE, "pending", tour.inquiryId)}
                tone={sectionTone}
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
            icon={ClipboardList}
            tone="pending"
            items={pendingApplicationRows}
            emptyMessage="No pending applications."
            keyForItem={(row) => row.id}
            renderRow={(row, sectionTone) => {
              const badge = applicationStatusBadge(row);
              return (
                <IssueRow
                  href={`${BASE}/applications`}
                  tone={sectionTone}
                  title={applicationRowProperty(row) || row.name?.trim() || "Application"}
                  subtitle={applicationRowProperty(row) ? row.name?.trim() || undefined : undefined}
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
            icon={FileSignature}
            tone="info"
            items={leaseItems}
            emptyMessage={leaseEmptyMessage}
            keyForItem={(row) => row.id}
            renderRow={() => (
              <IssueRow
                href={`${BASE}/lease`}
                tone={lease.tone === "emerald" ? "success" : lease.cta ? "info" : "pending"}
                title={lease.cta ? "Signature needed" : lease.tone === "emerald" ? "Lease active" : "Lease status"}
                subtitle={appProperty ? `${appProperty}${appRoom ? ` · ${appRoom}` : ""}` : undefined}
                meta={formatResidentRentLabel(leaseRow?.signedRentLabel) || leaseDateRange || leaseRow?.unit || undefined}
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
            icon={Home}
            tone="info"
            items={[{ id: "house-details" }]}
            emptyMessage="Open house details for move-in placement and keys."
            keyForItem={(item) => item.id}
            renderRow={() => (
              <IssueRow
                href={`${BASE}/move-in`}
                tone="info"
                title="House details"
                subtitle={appProperty ? `${appProperty}${appRoom ? ` · ${appRoom}` : ""}` : undefined}
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
            icon={Wrench}
            tone="pending"
            items={serviceItems}
            emptyMessage="No open services right now."
            keyForItem={(item) => item.id}
            renderRow={(item, sectionTone) => {
              if (item.kind === "request") {
                const propertyName = getPropertyById(item.row.propertyId)?.buildingName?.trim() || "";
                return (
                  <IssueRow
                    href={servicesHref}
                    tone={sectionTone}
                    title={item.row.offerName?.trim() || "Add-on service"}
                    subtitle={propertyName || undefined}
                    pill={<StatusPill tone="pending">Pending</StatusPill>}
                    dataAttr="resident-dashboard-attention-service"
                  />
                );
              }
              return (
                <IssueRow
                  href={`${BASE}/services`}
                  tone={sectionTone}
                  title={item.row.title?.trim() || "Service"}
                  subtitle={[item.row.propertyName, item.row.unit].filter(Boolean).join(" · ") || undefined}
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
            icon={Wallet}
            tone={overdueChargeCount > 0 ? "danger" : "pending"}
            badge={
              overdueChargeCount > 0 ? (
                <StatusPill tone="danger">{overdueChargeCount} overdue</StatusPill>
              ) : null
            }
            items={pendingCharges}
            emptyMessage={
              leaseSigned
                ? "No outstanding charges."
                : "Payments will appear here after your application is approved and your lease is signed."
            }
            keyForItem={(charge) => charge.id}
            renderRow={(charge, sectionTone) => {
              const overdue = isHouseholdChargeOverdue(charge);
              return (
                <IssueRow
                  // C248: `?pay=<chargeId>` skips list -> record -> Pay —
                  // resident-payments-panel.tsx opens the pay confirmation
                  // for this exact charge as soon as the page loads.
                  href={`${BASE}/payments?pay=${encodeURIComponent(charge.id)}`}
                  tone={sectionTone}
                  title={charge.title || "Charge"}
                  subtitle={overdue ? "Overdue" : chargeDueLabel(charge)}
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
            icon={MessageSquare}
            tone="info"
            headerCount={inbox}
            items={inboxThreads}
            emptyMessage="No unread messages. Communication is clear."
            keyForItem={(thread) => thread.id}
            renderRow={(thread, sectionTone) => (
              <IssueRow
                href={communicationHref}
                tone={sectionTone}
                title={thread.subject || thread.from || "Unknown sender"}
                subtitle={thread.preview || (thread.subject ? thread.from : undefined) || undefined}
                pill={<StatusPill tone="info">Unread</StatusPill>}
                dataAttr="resident-dashboard-attention-inbox"
              />
            )}
          />
          ) : null}
        </section>
        </>
        )}
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
